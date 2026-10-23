RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        python3 \
        ffmpeg \
        curl \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp

    /usr/local/bin/yt-dlp

    docker build -t media-downloader .

    docker run --rm media-downloader yt-dlp --version

    curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
chmod a+rx /usr/local/bin/yt-dlp
yt-dlp --version

pip install yt-dlp

RUN npm install\
COPY . .

RUN npm install

COPY . .
