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
  p.on("close", (code) => {
    clearTimeout(timer);
    if (code !== 0) {
      console.error("yt-dlp error:", err);
      const reason = err.trim().split("\n").pop() || "unknown";
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

// Download to a temp folder (so video + audio can be merged), then send the file
app.get("/api/download", rateLimit(10), (req, res) => {
  const url = validateUrl(req.query.url);
  const type = req.query.type === "audio" ? "audio" : "video";
  const title = safeName(req.query.title);
  if (!url) return res.status(400).send("Invalid link.");

  const dir = path.join(os.tmpdir(), "dl-" + crypto.randomBytes(8).toString("hex"));
  fs.mkdirSync(dir, { recursive: true });
  const outTemplate = path.join(dir, "file.%(ext)s");

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
    // best video + best audio, merged into one mp4 by ffmpeg
    args = [
      "--no-playlist",
      "-f", "bv*[height<=1080]+ba/b[height<=1080]/bv*+ba/b",
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

  p.on("error", () => {
    clearTimeout(timer);
    cleanup(dir);
    if (!res.headersSent) res.status(500).send("yt-dlp is not installed on the server.");
  });

  p.on("close", (code) => {
    clearTimeout(timer);
    if (aborted) return cleanup(dir);

    const file = path.join(dir, "file." + ext);
    if (code !== 0 || !fs.existsSync(file)) {
      console.error("download error:", err);
      cleanup(dir);
      const reason = err.trim().split("\n").pop() || "unknown";
      return res.status(500).send("Download failed. Reason: " + reason);
    }

    res.setHeader("Content-Type", mime);
    res.setHeader("Content-Disposition", `attachment; filename="${title}.${ext}"`);
    res.setHeader("Content-Length", fs.statSync(file).size);

    const stream = fs.createReadStream(file);
    stream.pipe(res);
    const done = () => cleanup(dir);
    stream.on("close", done);
    res.on("close", done);
  });
});

app.listen(PORT, () => {
  console.log(`Downloader running at http://localhost:${PORT}`);
});
