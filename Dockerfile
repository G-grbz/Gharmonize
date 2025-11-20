# syntax=docker/dockerfile:1
FROM node:20-bookworm AS base

WORKDIR /usr/src/app

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        ffmpeg \
        curl \
        python3 \
        ca-certificates \
        tzdata \
        intel-media-va-driver \
        libva-drm2 \
        vainfo; \
    rm -rf /var/lib/apt/lists/*; \
    curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
      -o /usr/local/bin/yt-dlp; \
    chmod a+rx /usr/local/bin/yt-dlp; \
    echo "yt-dlp version:" && /usr/local/bin/yt-dlp --version; \
    echo "ffmpeg version:" && ffmpeg -version; \
    echo "FFmpeg NVENC/QSV encoders:" && ffmpeg -hide_banner -encoders | grep -E 'nvenc|_qsv' || true

COPY package*.json ./

RUN set -eux; \
    export NPM_CONFIG_LOGLEVEL=warn; \
    export NPM_CONFIG_IGNORE_SCRIPTS=true; \
    if [ -f package-lock.json ]; then \
      npm ci --omit=dev; \
    else \
      npm install --omit=dev; \
    fi; \
    npm cache clean --force

COPY . .

ENV NODE_ENV=production \
    PORT=5174 \
    YTDLP_BIN=/usr/local/bin/yt-dlp \
    DISABLE_QSV_IN_DOCKER=1 \
    DISABLE_VAAPI_IN_DOCKER=1

RUN mkdir -p uploads outputs temp local-inputs cookies && chmod -R 0775 /usr/src/app

EXPOSE 5174

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD curl -fsS http://127.0.0.1:5174/ >/dev/null || exit 1

CMD ["node", "app.js"]
