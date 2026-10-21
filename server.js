const express = require("express");
const { spawn } = require("child_process");
const path = require("path");

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
      return res.status(422).json({ error: "Could not read this link. It may be private or unsupported." });
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

// Stream the file to the browser
app.get("/api/download", rateLimit(10), (req, res) => {
  const url = validateUrl(req.query.url);
  const type = req.query.type === "audio" ? "audio" : "video";
  const title = safeName(req.query.title);
  if (!url) return res.status(400).send("Invalid link.");

  let args;
  if (type === "audio") {
    args = ["--no-playlist", "-f", "bestaudio", "-x", "--audio-format", "mp3", "--audio-quality", "0", "-o", "-", "--", url];
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Content-Disposition", `attachment; filename="${title}.mp3"`);
  } else {
    // single progressive mp4 so it can be streamed
    args = ["--no-playlist", "-f", "best[ext=mp4]/best", "-o", "-", "--", url];
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", `attachment; filename="${title}.mp4"`);
  }

  const p = spawn("yt-dlp", args);
  const timer = setTimeout(() => p.kill("SIGKILL"), 10 * 60_000);

  p.stdout.pipe(res);
  p.on("error", () => {
    clearTimeout(timer);
    if (!res.headersSent) res.status(500).send("yt-dlp is not installed on the server.");
  });
  p.on("close", () => {
    clearTimeout(timer);
    res.end();
  });
  req.on("close", () => p.kill("SIGKILL"));
});

app.listen(PORT, () => {
  console.log(`Downloader running at http://localhost:${PORT}`);
});
