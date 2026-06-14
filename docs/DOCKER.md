# Docker Deployment

Docker deployment is provided as an **alternative** setup. It does **not** currently provide full parity with local / desktop usage (see [INSTALLATION.md](INSTALLATION.md) for the recommended path).

---

## Quick Start (Docker Compose)

### 1. Clone the repository

```bash
git clone https://github.com/G-grbz/Gharmonize
cd Gharmonize
```

### 2. Prepare folders and files

The commands below use `/opt/gharmonize`. If you prefer another location, update both the shell commands and the bind mounts in `docker-compose.yml`.

```bash
sudo mkdir -p /opt/gharmonize/{uploads,outputs,temp,cache,cookies,local-inputs}
sudo touch /opt/gharmonize/.env
sudo chmod -R a+rw /opt/gharmonize
```

### 3. Configure `.env`

Set at least `ADMIN_PASSWORD` and `APP_SECRET` inside `/opt/gharmonize/.env`. See [CONFIGURATION.md](CONFIGURATION.md) for the full variable reference.

Generate a random `APP_SECRET` with:

```bash
openssl rand -hex 32
```

### 4. Choose the Docker image tag

The default compose file in this branch uses:

```yaml
image: ggrbz/gharmonize:latest
```

Available tags:

- `ggrbz/gharmonize:latest` — the regular published image
- `ggrbz/gharmonize:testing` — the test-stage image

### 5. Start the stack

```bash
docker compose pull
docker compose up -d
```

### 6. Open the UI

- `http://localhost:5174` — classic Web UI
- `http://localhost:5174/ytlive.html` — YTLive music UI (see [YTLIVE.md](YTLIVE.md))

### 7. Runtime binaries in Docker

The provided `docker-compose.yml` enables runtime binary management inside the container:

- Gharmonize checks binaries automatically when the app starts
- Missing or outdated tools can be downloaded / refreshed automatically
- Downloaded runtime binaries are cached under `/opt/gharmonize/cache`

If a refresh fails, Gharmonize keeps the currently resolved binaries as a fallback instead of hard-failing the whole app. See [BINARY_MANAGEMENT.md](BINARY_MANAGEMENT.md) for details.

> `docker-compose.yml` uses `ggrbz/gharmonize:latest` by default. Switch it to `ggrbz/gharmonize:testing` if you want the test-stage image.

---

## Optional: NVIDIA / NVENC in Docker

If you want NVENC inside Docker, install the NVIDIA driver and the NVIDIA Container Toolkit on the host first.

Then update `docker-compose.yml`:

- Comment out or remove `user: "${PUID:-1000}:${PGID:-1000}"`
- Enable `user: "0:0"`
- Enable `privileged: true`
- Enable `runtime: nvidia`
- Enable `NVIDIA_VISIBLE_DEVICES=all`
- Enable `NVIDIA_DRIVER_CAPABILITIES=compute,video,utility`

Relevant compose section:

```yaml
services:
  web:
    image: ggrbz/gharmonize:latest
    container_name: Gharmonize
    user: "0:0"
    privileged: true
    runtime: nvidia
    group_add:
      - "${RUN_MEDIA_GID:-65534}"
    environment:
      - NVIDIA_VISIBLE_DEVICES=all
      - NVIDIA_DRIVER_CAPABILITIES=compute,video,utility
      - NODE_ENV=production
      - PORT=${PORT:-5174}
      - YTDLP_EXTRA=--force-ipv4
      - GHARMONIZE_WEB_BINARIES_IN_DOCKER=1
      - GHARMONIZE_WEB_CACHE_DIR=/usr/src/app/cache/binaries
      - PUID=${PUID:-1000}
      - PGID=${PGID:-1000}
      - DATA_DIR=/usr/src/app
      - OUTPUTS_DISPLAY_DIR=/opt/gharmonize/outputs
```

After the edit:

```bash
docker compose up -d
```

> On some hosts, NVENC inside Docker only works reliably when the container runs with the root user plus the `privileged` and `runtime: nvidia` settings above.

---

## Alternative Installation Using `docker run`

### 1. Prepare folders and files

```bash
sudo mkdir -p /opt/gharmonize/{uploads,outputs,temp,cache,cookies,local-inputs}
sudo touch /opt/gharmonize/.env
sudo chmod -R a+rw /opt/gharmonize
```

### 2. Run the container

```bash
docker run -d \
  --name Gharmonize \
  --restart unless-stopped \
  --user 1000:1000 \
  --group-add 65534 \
  -p 5174:5174 \
  -e NODE_ENV=production \
  -e PORT=5174 \
  -e YTDLP_EXTRA=--force-ipv4 \
  -e GHARMONIZE_WEB_BINARIES_IN_DOCKER=1 \
  -e GHARMONIZE_WEB_CACHE_DIR=/usr/src/app/cache/binaries \
  -e PUID=1000 \
  -e PGID=1000 \
  -e DATA_DIR=/usr/src/app \
  -e OUTPUTS_DISPLAY_DIR=/opt/gharmonize/outputs \
  -v /opt/gharmonize/uploads:/usr/src/app/uploads \
  -v /opt/gharmonize/outputs:/usr/src/app/outputs \
  -v /opt/gharmonize/temp:/usr/src/app/temp \
  -v /opt/gharmonize/cache:/usr/src/app/cache \
  -v /opt/gharmonize/local-inputs:/usr/src/app/local-inputs \
  -v /opt/gharmonize/cookies:/usr/src/app/cookies \
  -v /opt/gharmonize/.env:/usr/src/app/.env \
  -v /home:/home:ro \
  -v /run/media:/run/media:ro \
  ggrbz/gharmonize:latest
```

To use the test-stage image, replace the final image reference with `ggrbz/gharmonize:testing`.

### 3. NVIDIA / NVENC Variant

For NVIDIA, do **not** keep the non-root `--user 1000:1000` setting. Use the container as root and enable NVIDIA runtime access:

```bash
docker run -d \
  --name Gharmonize \
  --restart unless-stopped \
  --user 0:0 \
  --privileged \
  --runtime=nvidia \
  -p 5174:5174 \
  -e NVIDIA_VISIBLE_DEVICES=all \
  -e NVIDIA_DRIVER_CAPABILITIES=compute,video,utility \
  -e NODE_ENV=production \
  -e PORT=5174 \
  -e YTDLP_EXTRA=--force-ipv4 \
  -e GHARMONIZE_WEB_BINARIES_IN_DOCKER=1 \
  -e GHARMONIZE_WEB_CACHE_DIR=/usr/src/app/cache/binaries \
  -e PUID=1000 \
  -e PGID=1000 \
  -e DATA_DIR=/usr/src/app \
  -e OUTPUTS_DISPLAY_DIR=/opt/gharmonize/outputs \
  -v /opt/gharmonize/uploads:/usr/src/app/uploads \
  -v /opt/gharmonize/outputs:/usr/src/app/outputs \
  -v /opt/gharmonize/temp:/usr/src/app/temp \
  -v /opt/gharmonize/cache:/usr/src/app/cache \
  -v /opt/gharmonize/local-inputs:/usr/src/app/local-inputs \
  -v /opt/gharmonize/cookies:/usr/src/app/cookies \
  -v /opt/gharmonize/.env:/usr/src/app/.env \
  -v /home:/home:ro \
  -v /run/media:/run/media:ro \
  ggrbz/gharmonize:latest
```

> Do not forget to set `ADMIN_PASSWORD` and `APP_SECRET` in `/opt/gharmonize/.env`.
