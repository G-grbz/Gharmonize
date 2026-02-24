# syntax=docker/dockerfile:1
FROM node:20-bookworm AS base

WORKDIR /usr/src/app

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        curl \
        wget \
        python3 \
        ca-certificates \
        tzdata \
        intel-media-va-driver \
        libva-drm2 \
        vainfo \
        fuse3 \
        xz-utils \
        unzip \
        gnupg; \
    \
    YTDLP_VERSION=2025.12.08; \
    curl -L "https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/yt-dlp" \
      -o /usr/local/bin/yt-dlp; \
    chmod a+rx /usr/local/bin/yt-dlp; \
    \
    FFMPEG_URL="https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz"; \
    cd /tmp; \
    curl -L "$FFMPEG_URL" -o ffmpeg.tar.xz; \
    tar -xJf ffmpeg.tar.xz; \
    cd ffmpeg-master-latest-linux64-gpl; \
    cp -a bin/ffmpeg bin/ffprobe /usr/local/bin/; \
    chmod a+rx /usr/local/bin/ffmpeg /usr/local/bin/ffprobe; \
    cd /; \
    rm -rf /tmp/ffmpeg*; \
    \
    mkdir -p /etc/apt/keyrings; \
    wget -O /etc/apt/keyrings/gpg-pub-moritzbunkus.gpg \
      https://mkvtoolnix.download/gpg-pub-moritzbunkus.gpg; \
    echo "deb [signed-by=/etc/apt/keyrings/gpg-pub-moritzbunkus.gpg] https://mkvtoolnix.download/debian/ bookworm main" \
      > /etc/apt/sources.list.d/mkvtoolnix.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends mkvtoolnix; \
    \

    DENO_VERSION=2.6.0; \
    cd /tmp; \
    curl -L "https://github.com/denoland/deno/releases/download/v${DENO_VERSION}/deno-x86_64-unknown-linux-gnu.zip" \
      -o deno.zip; \
    unzip -o deno.zip -d /usr/local/bin; \
    chmod a+rx /usr/local/bin/deno; \
    rm -f deno.zip; \
    \
    rm -rf /var/lib/apt/lists/*; \
    \
    echo "yt-dlp version:" && /usr/local/bin/yt-dlp --version; \
    echo "ffmpeg version:" && ffmpeg -version; \
    echo "ffprobe version:" && ffprobe -version; \
    echo "mkvmerge version:" && mkvmerge --version; \
    echo "deno version:" && deno --version; \
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
    FFMPEG_BIN=/usr/local/bin/ffmpeg \
    FFPROBE_BIN=/usr/local/bin/ffprobe \
    MKVMERGE_BIN=/usr/bin/mkvmerge \
    DENO_BIN=/usr/local/bin/deno \
    DISABLE_QSV_IN_DOCKER=1 \
    DISABLE_VAAPI_IN_DOCKER=1

RUN mkdir -p uploads outputs temp local-inputs cookies && chmod -R 0775 /usr/src/app

EXPOSE 5174

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD curl -fsS http://127.0.0.1:5174/ >/dev/null || exit 1

CMD ["node", "app.js"]
