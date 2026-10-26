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

function isBlockedHost(hostname) {
  const host = hostname.toLowerCase();
  const normalized = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;

  if (
    normalized === "localhost" ||
    normalized.endsWith(".local") ||
    normalized === "0.0.0.0" ||
    normalized === "::1" ||
    normalized === "[::1]"
  ) {
    return true;
  }

  return (
    /^127\./.test(normalized) ||
    /^10\./.test(normalized) ||
    /^192\.168\./.test(normalized) ||
    /^169\.254\./.test(normalized) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(normalized) ||
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(normalized)
  );
}

function validateUrl(raw) {
  if (typeof raw !== "string") return null;

  const value = raw.trim();
  if (!value) return null;

  let u;
  try {
    u = new URL(value);
  } catch {
    return null;
  }

  if (!["http:", "https:"].includes(u.protocol)) return null;
  if (isBlockedHost(u.hostname)) return null;

  return u.toString();
}

// very simple in-memory rate limiter (per IP, per minute)
const hits = new Map();
function rateLimit(max) {
  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip || "unknown";
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
  return String(s || "download")
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/[^\w\-. ]+/g, "")
    .trim()
    .slice(0, 80) || "download";
}

function cleanup(dir) {
  fs.rm(dir, { recursive: true, force: true }, () => {});
}

// run a command and collect output
function run(cmd, args, cb) {
  const p = spawn(cmd, args);
  let out = "";
  let err = "";
  let settled = false;
  const finish = (error) => {
    if (settled) return;
    settled = true;
    cb(error, out, err);
  };
  p.stdout.on("data", (d) => (out += d));
  p.stderr.on("data", (d) => (err += d));
  p.on("error", finish);
  p.on("close", (code) => finish(code === 0 ? null : new Error("exit " + code)));
  return p;
}

function getYtDlpArgs(extraArgs = []) {
  const args = [...extraArgs];
  const options = [];

  const cookieFile = process.env.YOUTUBE_COOKIES_FILE;
  const browser = process.env.YOUTUBE_COOKIES_BROWSER;

  if (cookieFile && fs.existsSync(cookieFile)) {
    options.push("--cookies", cookieFile);
  } else if (browser) {
    options.push("--cookies-from-browser", browser);
  }

  // This often helps with YouTube anti-bot restrictions
  options.push("--extractor-args", "youtube:player_client=android");

  // yt-dlp stops parsing options after `--`, so insert options before the URL.
  const separator = args.indexOf("--");
  args.splice(separator === -1 ? args.length : separator, 0, ...options);

  return args;
}

// ---------- image helpers ----------

const IMG_EXTS = ["jpg", "jpeg", "png", "webp", "gif"];
const BROWSER_UA =
  "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36";

function imageExtMatches(url, ext) {
  const e = String(ext || "").toLowerCase();
  return IMG_EXTS.includes(e) || /\.(jpe?g|png|webp|gif)(?:[?#]|$)/i.test(String(url || ""));
}

// find the image link inside yt-dlp's JSON (first item if it is a carousel)
function pickImageUrl(j) {
  if (!j) return null;
  if (Array.isArray(j.entries) && j.entries.length) return pickImageUrl(j.entries[0]);
  if (j.url && imageExtMatches(j.url, j.ext)) return j.url;
  if (Array.isArray(j.formats)) {
    const f = j.formats
      .filter((x) => x && x.url && imageExtMatches(x.url, x.ext))
      .pop();
    if (f) return f.url;
  }
  if (j.thumbnail) return j.thumbnail;
  if (Array.isArray(j.thumbnails) && j.thumbnails.length) {
    return j.thumbnails[j.thumbnails.length - 1].url;
  }
  return null;
}

function hasVideoContent(j) {
  if (!j) return false;
  if (j.vcodec && j.vcodec !== "none") return true;
  if (Array.isArray(j.formats) && j.formats.some((f) => f && f.vcodec && f.vcodec !== "none")) {
    return true;
  }
  return Array.isArray(j.entries) && j.entries.some(hasVideoContent);
}

function decodeHtml(s) {
  return String(s || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
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
    const a = html.match(
      new RegExp(
        '<meta[^>]+property=["\']' + prop + '["\'][^>]+content=["\']([^"\']+)["\']',
        "i"
      )
    );
    const b = html.match(
      new RegExp(
        '<meta[^>]+content=["\']([^"\']+)["\'][^>]+property=["\']' + prop + '["\']',
        "i"
      )
    );
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


// Download Instagram post/reel media using gallery-dl, without changing yt-dlp
// behavior for YouTube or other supported platforms.
app.get("/api/instagram-download", rateLimit(5), async (req, res) => {
  const url = validateUrl(req.query.url);
  if (!url) return res.status(400).send("Invalid link.");

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return res.status(400).send("Invalid link.");
  }

  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  if (host !== "instagram.com" && !host.endsWith(".instagram.com")) {
    return res.status(400).send("Please enter an Instagram link.");
  }

  const dir = path.join(os.tmpdir(), "ig-" + crypto.randomBytes(8).toString("hex"));
  fs.mkdirSync(dir, { recursive: true });

  const p = spawn("gallery-dl", [
    "--directory", dir,
    "--filename", "{num:>03}_{filename}.{extension}",
    "--no-mtime",
    url,
  ], { stdio: ["ignore", "pipe", "pipe"] });

  let err = "";
  let settled = false;
  const timer = setTimeout(() => p.kill("SIGKILL"), 5 * 60_000);

  const finishError = (status, message) => {
    cleanup(dir);
    if (!res.headersSent) res.status(status).send(message);
  };

  p.stderr.on("data", (d) => { err += d.toString(); });
  p.on("error", () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    finishError(500, "Instagram downloader (gallery-dl) is not installed on the server.");
  });

  p.on("close", async (code) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);

    if (code !== 0) {
      console.error("gallery-dl Instagram error:", err);
      const reason = err.trim().split(/\r?\n/).filter(Boolean).slice(-1)[0];
      return finishError(422,
        "Instagram download failed. The post may be private, login-restricted, unsupported, or temporarily blocked." +
        (reason ? " Details: " + reason : ""));
    }

    try {
      const files = [];
      const walk = (folder) => {
        for (const item of fs.readdirSync(folder, { withFileTypes: true })) {
          const full = path.join(folder, item.name);
          if (item.isDirectory()) walk(full);
          else if (item.isFile()) files.push(full);
        }
      };
      walk(dir);

      if (!files.length) return finishError(404, "No media files were downloaded from this Instagram post.");

      const safeTitle = safeName(req.query.title || "instagram-post");
      if (files.length === 1) {
        const file = files[0];
        const ext = path.extname(file).toLowerCase();
        const mime = ({
          ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
          ".webp": "image/webp", ".gif": "image/gif", ".mp4": "video/mp4",
          ".mov": "video/quicktime"
        })[ext] || "application/octet-stream";
        res.setHeader("Content-Type", mime);
        res.setHeader("Content-Disposition", `attachment; filename="${safeTitle}${ext}"`);
        res.setHeader("Content-Length", fs.statSync(file).size);
        const stream = fs.createReadStream(file);
        stream.on("error", () => { cleanup(dir); if (!res.headersSent) res.status(500).end("Could not read downloaded file."); });
        stream.on("close", () => cleanup(dir));
        return stream.pipe(res);
      }

      // Multiple images/videos (carousel) are returned as a ZIP archive.
      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", `attachment; filename="${safeTitle}.zip"`);
      const archive = require("archiver")("zip", { zlib: { level: 6 } });
      archive.on("error", (e) => {
        console.error("Instagram archive error:", e.message);
        cleanup(dir);
        if (!res.headersSent) res.status(500).end("Could not package Instagram media.");
      });
      res.on("close", () => cleanup(dir));
      archive.pipe(res);
      for (const file of files) archive.file(file, { name: path.relative(dir, file) });
      await archive.finalize();
    } catch (e) {
      console.error("Instagram download processing error:", e.message);
      finishError(500, "Could not prepare Instagram download.");
    }
  });
});

// ---------- routes ----------

// Get title, thumbnail, duration
app.post("/api/info", rateLimit(20), (req, res) => {
  const url = validateUrl(req.body && req.body.url);
  if (!url) return res.status(400).json({ error: "Please enter a valid link." });

  const p = spawn("yt-dlp", getYtDlpArgs([
    "--no-playlist",
    "--dump-single-json",
    "--no-warnings",
    "--",
    url,
  ]));

  let out = "";
  let err = "";
  let settled = false;
  const timer = setTimeout(() => p.kill("SIGKILL"), 30_000);

  p.stdout.on("data", (d) => (out += d));
  p.stderr.on("data", (d) => (err += d));
  p.on("error", () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    res.status(500).json({ error: "yt-dlp is not installed on the server." });
  });

  p.on("close", async (code) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);

    if (code !== 0) {
      console.error("yt-dlp error:", err);
      const reason = err.trim().split("\n").pop() || "unknown";

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
        imageOnly: Boolean(pickImageUrl(j) && !hasVideoContent(j)),
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

  const p = spawn("yt-dlp", getYtDlpArgs([
    "--playlist-items", "1",
    "--dump-single-json",
    "--no-warnings",
    "--",
    url,
  ]));

  let out = "";
  let err = "";
  let settled = false;
  const timer = setTimeout(() => p.kill("SIGKILL"), 30_000);

  p.stdout.on("data", (d) => (out += d));
  p.stderr.on("data", (d) => (err += d));

  const sendImage = async (imgUrl) => {
    const { buf, type } = await fetchImage(imgUrl);
    const ext = type.includes("png")
      ? "png"
      : type.includes("webp")
      ? "webp"
      : type.includes("gif")
      ? "gif"
      : "jpg";

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
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (!res.headersSent) res.status(500).send("yt-dlp is not installed on the server.");
  });

  p.on("close", async (code) => {
    if (settled) return;
    settled = true;
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
    args = getYtDlpArgs([
      "--no-playlist",
      "-f", "bestaudio/best",
      "-x", "--audio-format", "mp3", "--audio-quality", "0",
      "--print", "after_move:filepath",
      "-o", outTemplate, "--", url,
    ]);
    ext = "mp3";
    mime = "audio/mpeg";
  } else {
    args = getYtDlpArgs([
      "--no-playlist",
      "-f", "bv*+ba/b",
      "-S", "res:1080,vcodec:h264,acodec:aac",
      "--merge-output-format", "mp4",
      "--print", "after_move:filepath",
      "-o", outTemplate, "--", url,
    ]);
    ext = "mp4";
    mime = "video/mp4";
  }

  const p = spawn("yt-dlp", args);
  let out = "";
  let err = "";
  p.stdout.on("data", (d) => (out += d));
  p.stderr.on("data", (d) => (err += d));
  const timer = setTimeout(() => p.kill("SIGKILL"), 10 * 60_000);

  let aborted = false;
  res.on("close", () => {
    if (!res.writableEnded) {
      aborted = true;
      p.kill("SIGKILL");
    }
  });

  function fail(msg) {
    cleanup(dir);
    if (!res.headersSent) res.status(500).send(msg);
  }

  let settled = false;

  function send(file) {
    const outputExt = type === "audio" ? ext : (path.extname(file).slice(1).toLowerCase() || ext);
    const outputMime = type === "audio"
      ? mime
      : ({ mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", mkv: "video/x-matroska" }[outputExt] || "application/octet-stream");
    res.setHeader("Content-Type", outputMime);
    res.setHeader("Content-Disposition", `attachment; filename="${title}.${outputExt}"`);
    res.setHeader("Content-Length", fs.statSync(file).size);
    const stream = fs.createReadStream(file);
    stream.pipe(res);
    const done = () => cleanup(dir);
    stream.on("close", done);
    res.on("close", done);
  }

  p.on("error", () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    fail("yt-dlp is not installed on the server.");
  });

  p.on("close", (code) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (aborted) return cleanup(dir);

    const printedPath = out.trim().split(/\r?\n/).pop();
    const raw = printedPath && path.resolve(printedPath).startsWith(dir + path.sep)
      ? path.resolve(printedPath)
      : path.join(dir, "raw." + ext);
    if (code !== 0 || !fs.existsSync(raw)) {
      console.error("download error:", err);
      const reason = err.trim().split("\n").pop() || "unknown";
      return fail("Download failed. Reason: " + reason);
    }

    if (type === "audio") return send(raw);

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
          return send(raw);
        }

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
