# SaveAnyClip

A simple website to download video (MP4) or audio (MP3) from social media links, powered by [yt-dlp](https://github.com/yt-dlp/yt-dlp).

## Requirements

- Node.js 18+
- `yt-dlp` installed and on your PATH
- `ffmpeg` installed (needed for MP3 conversion)
- `gallery-dl` installed for Instagram downloads (Docker installs it automatically)

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
server.js          Express API (/api/info, /api/image, /api/download)
public/index.html  Frontend page
```

## Deploying

This needs a real server (VPS, Railway, Render, etc.), not a static host, because it runs yt-dlp and ffmpeg.
The Docker image switches yt-dlp to the latest `master` channel build during image creation. Rebuild the image to pick up newer builds. For a manually installed yt-dlp binary, use `yt-dlp --update-to master` to switch to and update to the latest master build.
For a native installation, install gallery-dl with `pipx install gallery-dl` so the Instagram download endpoint is available.

## Notes

- Only download content you own or have permission to save.
- Rate limiting is built in (in-memory). Add a proper limiter and a queue before going public.
- Private/local addresses are blocked to prevent server-side request abuse.
