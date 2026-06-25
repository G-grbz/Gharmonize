# syntax=docker/dockerfile:1
FROM node:22-bookworm AS base

WORKDIR /usr/src/app

ARG DEBIAN_FRONTEND=noninteractive

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        ca-certificates \
        tzdata \
        intel-media-va-driver \
        libva-drm2 \
        vainfo \
        xz-utils \
        unzip; \
    \
    rm -rf /var/lib/apt/lists/*

COPY package*.json ./

RUN set -eux; \
    export NPM_CONFIG_LOGLEVEL=warn; \
    export NPM_CONFIG_IGNORE_SCRIPTS=true; \
    export NPM_CONFIG_UPDATE_NOTIFIER=false; \
    if [ -f package-lock.json ]; then \
      npm ci --omit=dev; \
    else \
      npm install --omit=dev; \
    fi; \
    rm -rf /root/.npm

COPY . .

ENV NODE_ENV=production \
    PORT=5174 \
    GHARMONIZE_WEB_BINARIES=1 \
    GHARMONIZE_WEB_BINARIES_IN_DOCKER=1 \
    GHARMONIZE_WEB_CACHE_DIR=/opt/gharmonize/cache/binaries \
    DISABLE_QSV_IN_DOCKER=1 \
    DISABLE_VAAPI_IN_DOCKER=1

RUN mkdir -p uploads outputs temp local-inputs cookies && chmod -R 0775 /usr/src/app

EXPOSE 5174

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 5174) + '/').then((res) => process.exit(res.ok ? 0 : 1)).catch(() => process.exit(1))"]

CMD ["node", "app.js"]
