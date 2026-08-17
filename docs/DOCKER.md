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

### 4. Docker image

The default compose file uses the published Gharmonize image:

```yaml
image: ggrbz/gharmonize:latest
```

### 5. Start the stack

```bash
docker compose pull
docker compose up -d
```

### 6. Open the UI

* `http://localhost:5174` — classic Web UI
* `http://localhost:5174/ytlive.html` — YTLive music UI (see [YTLIVE.md](YTLIVE.md))

To use the classic UI's in-place **Retag** output mode for MP3, FLAC, and M4A files, set `MUSIC_DIR` to the host music directory before starting Compose. The directory is mounted read/write at `/music`; Gharmonize's web directory picker is restricted to that mount.

```bash
MUSIC_DIR=/home/your-user/Music docker compose up -d
```

Because retagging replaces metadata and embedded cover art in the original files, the container user (`PUID`/`PGID`) must have write permission on this directory.

### 7. Runtime binaries in Docker

The provided `docker-compose.yml` enables runtime binary management inside the container:

* Gharmonize checks binaries automatically when the app starts
* Missing or outdated tools can be downloaded / refreshed automatically
* Downloaded runtime binaries are cached under `/opt/gharmonize/cache`

If a refresh fails, Gharmonize keeps the currently resolved binaries as a fallback instead of hard-failing the whole app. See [BINARY_MANAGEMENT.md](BINARY_MANAGEMENT.md) for details.

---

## Optional: NVIDIA / NVENC in Docker

If you want NVENC inside Docker, install the NVIDIA driver and the NVIDIA Container Toolkit on the host first.

Then update `docker-compose.yml`:

* Comment out or remove `user: "${PUID:-1000}:${PGID:-1000}"`
* Enable `user: "0:0"`
* Enable `privileged: true`
* Enable `runtime: nvidia`
* Enable `NVIDIA_VISIBLE_DEVICES=all`
* Enable `NVIDIA_DRIVER_CAPABILITIES=compute,video,utility`

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
      - RETAG_ROOTS=/music
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
  -e RETAG_ROOTS=/music \
  -v /opt/gharmonize/uploads:/usr/src/app/uploads \
  -v /opt/gharmonize/outputs:/usr/src/app/outputs \
  -v /opt/gharmonize/temp:/usr/src/app/temp \
  -v /opt/gharmonize/cache:/usr/src/app/cache \
  -v /opt/gharmonize/local-inputs:/usr/src/app/local-inputs \
  -v /home/your-user/Music:/music \
  -v /opt/gharmonize/cookies:/usr/src/app/cookies \
  -v /opt/gharmonize/.env:/usr/src/app/.env \
  -v /home:/home:ro \
  -v /run/media:/run/media:ro \
  ggrbz/gharmonize:latest
```

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
  -e RETAG_ROOTS=/music \
  -v /opt/gharmonize/uploads:/usr/src/app/uploads \
  -v /opt/gharmonize/outputs:/usr/src/app/outputs \
  -v /opt/gharmonize/temp:/usr/src/app/temp \
  -v /opt/gharmonize/cache:/usr/src/app/cache \
  -v /opt/gharmonize/local-inputs:/usr/src/app/local-inputs \
  -v /home/your-user/Music:/music \
  -v /opt/gharmonize/cookies:/usr/src/app/cookies \
  -v /opt/gharmonize/.env:/usr/src/app/.env \
  -v /home:/home:ro \
  -v /run/media:/run/media:ro \
  ggrbz/gharmonize:latest
```

> Do not forget to set `ADMIN_PASSWORD` and `APP_SECRET` in `/opt/gharmonize/.env`.
