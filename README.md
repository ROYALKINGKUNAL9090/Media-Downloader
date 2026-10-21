# SaveAnyClip

A simple website to download video (MP4) or audio (MP3) from social media links, powered by [yt-dlp](https://github.com/yt-dlp/yt-dlp).

## Requirements

- Node.js 18+
- `yt-dlp` installed and on your PATH
- `ffmpeg` installed (needed for MP3 conversion)

Install them:

```bash
# macOS
brew install yt-dlp ffmpeg

# Ubuntu / Debian
sudo apt install ffmpeg
pip install -U yt-dlp

# Windows
winget install yt-dlp ffmpeg
```

## Run

```bash
npm install
npm start
```

Open http://localhost:3000

## Project structure

```
server.js          Express API (/api/info, /api/download)
public/index.html  Frontend page
```

## Deploying

This needs a real server (VPS, Railway, Render, etc.), not a static host, because it runs yt-dlp and ffmpeg.
Keep yt-dlp updated (`yt-dlp -U`), since platforms change often.

## Notes

- Only download content you own or have permission to save.
- Rate limiting is built in (in-memory). Add a proper limiter and a queue before going public.
- Private/local addresses are blocked to prevent server-side request abuse.
