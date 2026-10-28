FROM node:20-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        python3 \
        pipx \
        ffmpeg \
        curl \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && curl --fail --location --retry 3 https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp \
    && pipx install gallery-dl \
    && yt-dlp --update-to master

ENV PATH="/root/.local/bin:${PATH}"

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "server.js"]
