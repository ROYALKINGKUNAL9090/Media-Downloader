const express = require("express");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ---------- helpers ----------

function validateUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (!["http:", "https:"].includes(u.protocol)) return null;
  const h = u.hostname.toLowerCase();
  // block local / private targets
  if (
    h === "localhost" ||
    h.endsWith(".local") ||
    /^127\./.test(h) ||
    /^10\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(h) ||
    h === "0.0.0.0" ||
    h === "::1"
  ) {
    return null;
  }
  return u.toString();
}

// very simple in-memory rate limiter (per IP, per minute)
const hits = new Map();
function rateLimit(max) {
  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip;
    const list = (hits.get(key) || []).filter((t) => now - t < 60_000);
    if (list.length >= max) {
      return res.status(429).json({ error: "Too many requests. Try again in a minute." });
    }
    list.push(now);
    hits.set(key, list);
    next();
  };
}

function safeName(s) {
  return (s || "download").replace(/[^\w\-. ]+/g, "").trim().slice(0, 80) || "download";
}

function cleanup(dir) {
  fs.rm(dir, { recursive: true, force: true }, () => {});
}

// run a command and collect output
function run(cmd, args, cb) {
  const p = spawn(cmd, args);
  let out = "";
  let err = "";
  p.stdout.on("data", (d) => (out += d));
  p.stderr.on("data", (d) => (err += d));
  p.on("error", (e) => cb(e, out, err));
  p.on("close", (code) => cb(code === 0 ? null : new Error("exit " + code), out, err));
  return p;
}

// ---------- image helpers ----------

const IMG_EXTS = ["jpg", "jpeg", "png", "webp", "gif"];
const BROWSER_UA =
  "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36";

// find the image link inside yt-dlp's JSON (first item if it is a carousel)
function pickImageUrl(j) {
  if (!j) return null;
  if (Array.isArray(j.entries) && j.entries.length) return pickImageUrl(j.entries[0]);
  if (j.url && IMG_EXTS.includes(String(j.ext || "").toLowerCase())) return j.url;
  if (Array.isArray(j.formats)) {
    const f = j.formats
      .filter((x) => x && x.url && IMG_EXTS.includes(String(x.ext || "").toLowerCase()))
      .pop();
    if (f) return f.url;
  }
  if (j.thumbnail) return j.thumbnail;
  if (Array.isArray(j.thumbnails) && j.thumbnails.length) {
    return j.thumbnails[j.thumbnails.length - 1].url;
  }
  return null;
}

function decodeHtml(s) {
  return String(s).replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

// read the page and return its preview image + title (og:image / og:title)
async function findPageImage(pageUrl) {
  const safe = validateUrl(pageUrl);
  if (!safe) return null;
  const r = await fetch(safe, {
    headers: { "User-Agent": BROWSER_UA, "Accept-Language": "en-US,en;q=0.9" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) return null;
  const html = (await r.text()).slice(0, 600_000);
  const meta = (prop) => {
    const a = html.match(new RegExp('<meta[^>]+property=["\']' + prop + '["\'][^>]+content=["\']([^"\']+)["\']', "i"));
    const b = html.match(new RegExp('<meta[^>]+content=["\']([^"\']+)["\'][^>]+property=["\']' + prop + '["\']', "i"));
    const m = a || b;
    return m ? decodeHtml(m[1]) : null;
  };
  const image = meta("og:image");
  if (!image) return null;
  return { image, title: meta("og:title") || "Image" };
}

// download an image into memory (only real images, max 20 MB)
async function fetchImage(imgUrl) {
  const safe = validateUrl(imgUrl);
  if (!safe) throw new Error("blocked image link");
  const r = await fetch(safe, {
    headers: { "User-Agent": BROWSER_UA },
    signal: AbortSignal.timeout(25_000),
  });
  if (!r.ok) throw new Error("image server said " + r.status);
  const type = (r.headers.get("content-type") || "").split(";")[0].trim();
  if (!type.startsWith("image/")) throw new Error("link is not an image");
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > 20 * 1024 * 1024) throw new Error("image too big");
  return { buf, type };
}

// ---------- routes ----------

// Get title, thumbnail, duration
app.post("/api/info", rateLimit(20), (req, res) => {
  const url = validateUrl(req.body && req.body.url);
  if (!url) return res.status(400).json({ error: "Please enter a valid link." });

  const p = spawn("yt-dlp", ["--no-playlist", "--dump-single-json", "--no-warnings", "--", url]);
  let out = "";
  let err = "";
  const timer = setTimeout(() => p.kill("SIGKILL"), 30_000);

  p.stdout.on("data", (d) => (out += d));
  p.stderr.on("data", (d) => (err += d));
  p.on("error", () => {
    clearTimeout(timer);
    res.status(500).json({ error: "yt-dlp is not installed on the server." });
  });
  p.on("close", async (code) => {
    clearTimeout(timer);
    if (code !== 0) {
      console.error("yt-dlp error:", err);
      const reason = err.trim().split("\n").pop() || "unknown";

      // Image-only posts (no video): try to find the picture on the page itself.
      // Not for YouTube, and not when the real problem is a login / bot block.
      const host = new URL(url).hostname;
      const isYouTube = /youtube\.com|youtu\.be/i.test(host);
      const blocked = /sign in|not a bot|login required|cookies|rate-limit/i.test(err);
      if (!isYouTube && !blocked) {
        try {
          const page = await findPageImage(url);
          if (page) {
            return res.json({
              title: page.title,
              thumbnail: page.image,
              site: host.replace(/^www\./, ""),
              imageOnly: true,
            });
          }
        } catch (e) {
          console.error("image fallback error:", e.message);
        }
      }
      return res.status(422).json({ error: "Reason: " + reason });
    }
    try {
      const j = JSON.parse(out);
      res.json({
        title: j.title,
        thumbnail: j.thumbnail,
        duration: j.duration,
        uploader: j.uploader,
        site: j.extractor_key,
      });
    } catch {
      res.status(500).json({ error: "Unexpected response from downloader." });
    }
  });
});

// Download the picture of a post (image posts, or the cover of a video)
app.get("/api/image", rateLimit(10), (req, res) => {
  const url = validateUrl(req.query.url);
  const title = safeName(req.query.title);
  if (!url) return res.status(400).send("Invalid link.");

  const p = spawn("yt-dlp", ["--playlist-items", "1", "--dump-single-json", "--no-warnings", "--", url]);
  let out = "";
  let err = "";
  const timer = setTimeout(() => p.kill("SIGKILL"), 30_000);
  p.stdout.on("data", (d) => (out += d));
  p.stderr.on("data", (d) => (err += d));

  const sendImage = async (imgUrl) => {
    const { buf, type } = await fetchImage(imgUrl);
    const ext = type.includes("png") ? "png" : type.includes("webp") ? "webp" : type.includes("gif") ? "gif" : "jpg";
    res.setHeader("Content-Type", type);
    res.setHeader("Content-Disposition", `attachment; filename="${title}.${ext}"`);
    res.setHeader("Content-Length", buf.length);
    res.end(buf);
  };

  const viaPage = async () => {
    const page = await findPageImage(url);
    if (!page) throw new Error("no image found on this page");
    await sendImage(page.image);
  };

  p.on("error", () => {
    clearTimeout(timer);
    if (!res.headersSent) res.status(500).send("yt-dlp is not installed on the server.");
  });

  p.on("close", async (code) => {
    clearTimeout(timer);
    try {
      if (code === 0) {
        const imgUrl = pickImageUrl(JSON.parse(out));
        if (imgUrl) return await sendImage(imgUrl);
      } else {
        console.error("image info error:", err);
      }
      await viaPage();
    } catch (e) {
      console.error("image error:", e.message);
      if (!res.headersSent) res.status(404).send("Could not get the image. " + e.message);
    }
  });
});

// Download to a temp folder, fix the audio, then send the file
app.get("/api/download", rateLimit(10), (req, res) => {
  const url = validateUrl(req.query.url);
  const type = req.query.type === "audio" ? "audio" : "video";
  const title = safeName(req.query.title);
  if (!url) return res.status(400).send("Invalid link.");

  const dir = path.join(os.tmpdir(), "dl-" + crypto.randomBytes(8).toString("hex"));
  fs.mkdirSync(dir, { recursive: true });
  const outTemplate = path.join(dir, "raw.%(ext)s");

  let args;
  let ext;
  let mime;
  if (type === "audio") {
    args = [
      "--no-playlist", "-f", "bestaudio/best",
      "-x", "--audio-format", "mp3", "--audio-quality", "0",
      "-o", outTemplate, "--", url,
    ];
    ext = "mp3";
    mime = "audio/mpeg";
  } else {
    // best video + best audio, prefer h264 + aac (plays everywhere), up to 1080p
    args = [
      "--no-playlist",
      "-f", "bv*+ba/b",
      "-S", "res:1080,vcodec:h264,acodec:aac",
      "--merge-output-format", "mp4",
      "-o", outTemplate, "--", url,
    ];
    ext = "mp4";
    mime = "video/mp4";
  }

  const p = spawn("yt-dlp", args);
  let err = "";
  p.stderr.on("data", (d) => (err += d));
  const timer = setTimeout(() => p.kill("SIGKILL"), 10 * 60_000);

  let aborted = false;
  req.on("close", () => {
    if (!res.writableEnded) {
      aborted = true;
      p.kill("SIGKILL");
    }
  });

  function fail(msg) {
    cleanup(dir);
    if (!res.headersSent) res.status(500).send(msg);
  }

  function send(file) {
    res.setHeader("Content-Type", mime);
    res.setHeader("Content-Disposition", `attachment; filename="${title}.${ext}"`);
    res.setHeader("Content-Length", fs.statSync(file).size);
    const stream = fs.createReadStream(file);
    stream.pipe(res);
    const done = () => cleanup(dir);
    stream.on("close", done);
    res.on("close", done);
  }

  p.on("error", () => {
    clearTimeout(timer);
    fail("yt-dlp is not installed on the server.");
  });

  p.on("close", (code) => {
    clearTimeout(timer);
    if (aborted) return cleanup(dir);

    const raw = path.join(dir, "raw." + ext);
    if (code !== 0 || !fs.existsSync(raw)) {
      console.error("download error:", err);
      const reason = err.trim().split("\n").pop() || "unknown";
      return fail("Download failed. Reason: " + reason);
    }

    if (type === "audio") return send(raw);

    // Video: make sure the audio is AAC (works on every phone / tablet player)
    const fixed = path.join(dir, "fixed.mp4");
    run(
      "ffmpeg",
      [
        "-y", "-i", raw,
        "-map", "0:v:0?", "-map", "0:a:0?",
        "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
        "-movflags", "+faststart",
        fixed,
      ],
      (e, _o, ffErr) => {
        if (aborted) return cleanup(dir);
        if (e || !fs.existsSync(fixed)) {
          console.error("ffmpeg error:", ffErr);
          return send(raw); // fall back to the original file
        }
        // log whether the final file really has audio
        run(
          "ffprobe",
          ["-v", "error", "-select_streams", "a", "-show_entries", "stream=codec_name", "-of", "csv=p=0", fixed],
          (_e2, probeOut) => {
            console.log("audio streams in final file:", probeOut.trim() || "NONE");
            send(fixed);
          }
        );
      }
    );
  });
});

app.listen(PORT, () => {
  console.log(`Downloader running at http://localhost:${PORT}`);
});
