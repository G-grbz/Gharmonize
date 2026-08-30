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
sudo chown -R ${PUID:-1000}:${PGID:-1000} /opt/gharmonize
sudo chmod 700 /opt/gharmonize
```

### 3. Configure `.env`

Gharmonize creates a random initial admin credential on first start. The supplied Compose files keep the application root filesystem read-only and place both the master key and one-time credential in the writable cache volume. Read `/opt/gharmonize/cache/INITIAL_ADMIN_PASSWORD.txt` once, change the password from Settings, and then remove that file.

The supplied Compose files also keep `/tmp` mounted with `noexec`. Managed yt-dlp uses `/usr/src/app/temp/binary-tmp` as its executable runtime extraction directory, so the `/tmp` hardening can remain enabled without breaking the standalone yt-dlp binary.


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

The standard Compose files do **not** request an NVIDIA runtime or GPU. This keeps the default Docker deployment portable on hosts without NVIDIA hardware or the NVIDIA Container Toolkit.

For NVIDIA/NVENC, install and configure the **NVIDIA Container Toolkit** on the Docker host first. For a local source build, load the normal local Compose file and then layer the supplied NVIDIA override on top of it:

```bash
docker compose \
  -f docker-compose.local.yml \
  -f docker-compose-local-nvidia.yml \
  up -d --build
```

`docker-compose-local-nvidia.yml` is an **override file**, not a standalone Compose stack. It only augments the `web` service defined by `docker-compose.local.yml`, so do **not** run it by itself and keep it **after** the base file in the command.

The override contains all NVIDIA-specific settings (`gpus: all`, `runtime: nvidia`, the NVIDIA environment variables, root user, and privileged mode). Do not add those settings to `docker-compose.local.yml`; without the override, the local Compose stack does not request NVIDIA devices or the NVIDIA container runtime.

> On some hosts, NVENC inside Docker only works reliably when the container runs with the root user plus the `privileged` and NVIDIA runtime settings provided by the override. Files created on host bind mounts may therefore be owned by root.

---

## Alternative Installation Using `docker run`

### 1. Prepare folders and files

```bash
sudo mkdir -p /opt/gharmonize/{uploads,outputs,temp,cache,cookies,local-inputs}
sudo touch /opt/gharmonize/.env
sudo chown -R ${PUID:-1000}:${PGID:-1000} /opt/gharmonize
sudo chmod 700 /opt/gharmonize
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
  --gpus all \
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

> Do not publish `.env`, `.gharmonize-key`, cookie files, or `INITIAL_ADMIN_PASSWORD.txt`. For remote access, terminate HTTPS at a trusted reverse proxy and configure `TRUSTED_PROXY_CIDRS`.
