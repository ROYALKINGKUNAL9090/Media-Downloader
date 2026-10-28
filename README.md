# SaveAnyClip

A simple website to download video (MP4) or audio (MP3) from social media links, powered by [yt-dlp](https://github.com/yt-dlp/yt-dlp).

## Requirements

- Node.js 18+
- `yt-dlp` installed and on your PATH
- Deno installed and on your PATH (needed by yt-dlp for current YouTube video extraction)
- `ffmpeg` installed (needed for MP3 conversion)
- `gallery-dl` installed for Instagram downloads (Docker installs it automatically)

Install them:

```bash
# macOS
brew install yt-dlp ffmpeg

# Ubuntu / Debian
sudo apt install ffmpeg
pip install -U yt-dlp
curl -fsSL https://deno.land/install.sh | sh

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
The Docker image downloads the latest yt-dlp stable release during image creation. Rebuild the image to pick up newer releases. This avoids making an additional GitHub API request during the build, which can fail when rate-limited.
For a native installation, install gallery-dl with `pipx install gallery-dl` so the Instagram download endpoint is available.

## Notes

- Only download content you own or have permission to save.
- Rate limiting is built in (in-memory). Add a proper limiter and a queue before going public.
- Private/local addresses are blocked to prevent server-side request abuse.
