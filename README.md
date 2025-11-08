
<div align="center">

# <img width="128" height="128" alt="Gharmonize Logo" src="https://github.com/user-attachments/assets/adf9d2f8-a99b-43c8-9c37-d4a47f5b1e3f" /> 
# Gharmonize -  YouTube / Spotify Downloader & Converter
<img width="1280" height="720" alt="1" src="https://github.com/user-attachments/assets/65d49371-7844-471f-9486-3680fe2a763e" />
</div>
 

# 🇬🇧 English

## 📘 Table of Contents

* [Overview](#overview)
* [Features](#features)
* [Requirements](#requirements)
* [Environment Variables (.env)](#environment-variables-env)
* [Quick Start (Local – Node & npm)](#quick-start-local--node--npm)
* [Quick Start (Docker Compose)](#quick-start-docker-compose)
* [Notes & Troubleshooting](#notes--troubleshooting)
* [License](#license)

---

## Overview

**Gharmonize** is a Node.js + ffmpeg powered server that can:

* Parse YouTube / YouTube Music links (single, playlist, automix)
* Map Spotify tracks, playlists, and albums to YouTube and download
* Convert to **mp3 / flac / wav / ogg**, or save **mp4** without re-encoding
* Embed tags & cover art when available
* Provide a minimal web UI and JSON API

---

## Features

* **yt-dlp** integration (SABR / 403 workarounds)
* **ffmpeg** conversion with reliability
* **Multer** for file uploads
* **Docker** image & Compose setup
* **Spotify Web API** support (playlist / album / track)
* **Settings API** for runtime config changes

---

## Requirements

| Requirement      | Version  | Description              |
| ---------------- | -------- | ------------------------ |
| Node.js          | >= 20    | Required                 |
| ffmpeg           | Any      | Included in Docker image |
| yt-dlp           | Latest   | Included in Docker image |
| Spotify API Keys | Optional | For Spotify mapping      |

---

## Environment Variables (.env)

Create a `.env` file in the project root:

```dotenv
SPOTIFY_CLIENT_ID=
SPOTIFY_CLIENT_SECRET=

# YouTube behavior
YT_USE_MUSIC=1
YT_FORCE_IPV4=1
YT_403_WORKAROUNDS=0
YT_LANG=en-US
YT_DEFAULT_REGION=
YT_ACCEPT_LANGUAGE="en-US,en;q=0.8"

# yt-dlp tweaks
YTDLP_UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
YTDLP_COOKIES=./cookies/cookies.txt
YTDLP_COOKIES_FROM_BROWSER=chrome
YTDLP_EXTRA="--http-chunk-size 16M --concurrent-fragments 1"
YT_STRIP_COOKIES=1

# App auth & behavior
ADMIN_PASSWORD=123456
APP_SECRET=
PREFER_SPOTIFY_TAGS=1
TITLE_CLEAN_PIPE=1

# Spotify region preferences
SPOTIFY_MARKET=US
SPOTIFY_FALLBACK_MARKETS=TR,GB,DE,FR

# Server
PORT=5174
```

---

## Quick Start (Local – Node & npm)

#### 1. Clone the Repository and Enter the Directory

```bash
git clone https://github.com/G-grbz/Gharmonize
cd Gharmonize
```

#### 2. Create the .env File

To enable UI configuration, fill in `ADMIN_PASSWORD` and `APP_SECRET`. You can generate a secure `APP_SECRET` using the following command:

```bash
openssl rand -hex 32
```

---

#### 3. Installation Commands

**Linux**

```bash
BUILD_ELECTRON=1 npm i
```

**Windows (CMD)**

```cmd
set BUILD_ELECTRON=1
npm i
```

---

#### Default .env Locations (AppImage or .exe only)

These paths are **not** general application directories. They are automatically created only when running the AppImage or Windows .exe builds, and they store the default-generated `.env` file:

* **Windows:** `C:\Users\<Username>\AppData\Roaming\Gharmonize`
* **Linux:** `~/.config/Gharmonize/`
* **Default Password** `123456`

You can change env variables in the Settings panel. Windows users should add the location of the ffmpeg and yt-dlp files to the env variable.

---

#### Run Without Building

```bash
npm start
```

---

#### Build Commands

**To build AppImage (Linux only):**

```bash
npm run desktop:build:appimage
```

**To build NSIS (Windows Installer only):**

```bash
npm run desktop:build:nsis
```

> **Note:** If you choose *Install for all users* (which installs under *Program Files*), you must manually create the folders `temp`, `outputs`, and `uploads` inside the installation directory and grant read/write permissions. Alternatively, install to a custom directory outside *Program Files* or *Program Files (x86)*.

**To build Portable (Windows standalone version):**

```bash
npm run desktop:build:portable
```

**To build both Windows versions (NSIS + Portable):**

```bash
npm run desktop:build:all
```

## Quick Start (Docker Compose)

1. Clone the repository and navigate to the project directory:

   ```bash
   git clone https://github.com/G-grbz/Gharmonize
   cd Gharmonize
   ```

2. Create a `.env` file. (To manage environment settings via the UI, include `ADMIN_PASSWORD` and `APP_SECRET` fields. Generate `APP_SECRET` using the following command:)

   ```bash
   openssl rand -hex 32
   ```

3. Run the application with Docker Compose:

   ```bash
   docker compose up -d --build
   ```

4. Open in your browser: [http://localhost:5174](http://localhost:5174)

---


## Notes & Troubleshooting

* **yt-dlp not found** → Install yt-dlp or use Docker image.
* **403 / SABR issues** → Adjust flags like `--http-chunk-size`, use cookies if needed.
* **Spotify personalized Mix not supported** → Copy items to a normal playlist.
* **Uploads limit** → 100MB max (configurable in `app.js`).

---

## License

**MIT License**
This project is licensed under the MIT License.

You are free to use, copy, modify, merge, publish, and distribute this software, provided that:

You credit the original author clearly.

A link to the original repository is included when possible.

Any modifications or changes are clearly indicated.

This software is provided “as is”, without warranty of any kind. Use it at your own responsibility.

---

# 🇹🇷 Türkçe

## 📘 İçindekiler

* [Genel Bakış](#genel-bakış)
* [Özellikler](#özellikler)
* [Gereksinimler](#gereksinimler)
* [Ortam Değişkenleri (.env)](#ortam-değişkenleri-env)
* [Hızlı Başlangıç (Yerel – Node & npm)](#hızlı-başlangıç-yerel--node--npm)
* [Hızlı Başlangıç (Docker Compose)](#hızlı-başlangıç-docker-compose)
* [Notlar ve Sorun Giderme](#notlar-ve-sorun-giderme)
* [Lisans](#lisans)

---

## Genel Bakış

**Gharmonize**, Node.js + ffmpeg tabanlı bir sunucudur ve:

* YouTube / YouTube Music bağlantılarını (tek video, oynatma listesi, automix) işler
* Spotify parça, albüm ve oynatma listelerini YouTube’a eşleyip indirir
* **mp3 / flac / wav / ogg** formatlarına dönüştürür veya **mp4**’ü yeniden encode etmeden kaydeder
* Etiket ve kapak görseli ekler (uygunsa)
* Basit bir web arayüzü ve JSON API sunar

---

## Özellikler

* **yt-dlp** entegrasyonu (SABR / 403 hataları için çözümler)
* **ffmpeg** ile güvenilir dönüştürme
* **Multer** ile dosya yükleme
* **Docker** imajı ve Compose kurulumu
* **Spotify Web API** desteği (oynatma listesi, albüm, parça)
* **Settings API** ile çalışma anında yapılandırma değişikliği

---

## Gereksinimler

| Gereksinim              | Sürüm     | Açıklama                |
| ----------------------- | --------- | ----------------------- |
| Node.js                 | >= 20     | Gerekli                 |
| ffmpeg                  | Herhangi  | Docker imajında dahil   |
| yt-dlp                  | Güncel    | Docker imajında dahil   |
| Spotify API Anahtarları | Opsiyonel | Spotify eşleştirme için |

---

## Ortam Değişkenleri (.env)

Proje kök dizininde `.env` dosyası oluşturun:

```dotenv
SPOTIFY_CLIENT_ID=
SPOTIFY_CLIENT_SECRET=
YT_USE_MUSIC=1
YT_FORCE_IPV4=1
YT_403_WORKAROUNDS=0
YT_LANG=en-US
YT_DEFAULT_REGION=
YT_ACCEPT_LANGUAGE="en-US,en;q=0.8"
YTDLP_UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
YTDLP_COOKIES=./cookies/cookies.txt
YTDLP_COOKIES_FROM_BROWSER=chrome
YTDLP_EXTRA="--http-chunk-size 16M --concurrent-fragments 1"
YT_STRIP_COOKIES=1
ADMIN_PASSWORD=123456
APP_SECRET=
PREFER_SPOTIFY_TAGS=1
TITLE_CLEAN_PIPE=1
SPOTIFY_MARKET=US
SPOTIFY_FALLBACK_MARKETS=TR,GB,DE,FR
PORT=5174
```

---

## Hızlı Başlangıç (Yerel – Node & npm)

#### 1. Repoyu İndirin ve Dizine Geçin

```bash
git clone https://github.com/G-grbz/Gharmonize
cd Gharmonize
```

#### 2. .env Dosyasını Oluşturun

UI üzerinden ayarları düzenleyebilmek için `ADMIN_PASSWORD` ve `APP_SECRET` alanlarını doldurun. `APP_SECRET` değerini oluşturmak için şu komutu kullanabilirsiniz:

```bash
openssl rand -hex 32
```

---

#### 3. Kurulum Komutları

**Linux**

```bash
BUILD_ELECTRON=1 npm i
```

**Windows (CMD)**

```cmd
set BUILD_ELECTRON=1
npm i
```

---

#### Varsayılan .env Konumları (sadece AppImage veya .exe için)

Bu dizinler uygulama verileri için değil, AppImage veya Windows .exe sürümleri çalıştırıldığında varsayılan .env dosyasının otomatik olarak oluşturulacağı konumlardır:

* **Windows:** `C:\Users\<KullanıcıAdı>\AppData\Roaming\Gharmonize`
* **Linux:** `~/.config/Gharmonize/`
* **Varsayılan şifre** `123456`

Ayarlar panelinden ortam değişkenlerini değiştirebilirsiniz. Windows kullanıcıları, ffmpeg ve yt-dlp dosyalarının konumunu ortam değişkenine eklemelidir.

---

#### Derlemeden Çalıştırmak İçin

```bash
npm start
```

---

#### Derleme Komutları

**Sadece AppImage (Linux) oluşturmak için:**

```bash
npm run desktop:build:appimage
```

**Sadece NSIS (Windows Kurulum) oluşturmak için:**

```bash
npm run desktop:build:nsis
```

> **Not:** Eğer kurulumu *bu bilgisayardaki tüm kullanıcılar için* seçerseniz (yani *Program Files* dizinine kurulum yaparsanız), kurulum dizininde manuel olarak `temp`, `outputs` ve `uploads` klasörlerini oluşturmalı ve bu klasörlere okuma/yazma izni vermelisiniz. Alternatif olarak, *Program Files* veya *Program Files (x86)* dışında bir dizine kurulum yapabilirsiniz.

**Sadece Portable (taşınabilir sürüm) oluşturmak için:**

```bash
npm run desktop:build:portable
```

**Her iki Windows sürümünü (NSIS + Portable) birlikte oluşturmak için:**

```bash
npm run desktop:build:all
```

---

## Hızlı Başlangıç (Docker Compose)

1. Repoyu indirin ve dizine geçin:

   ```bash
   git clone https://github.com/G-grbz/Gharmonize
   cd Gharmonize
   ```

2. `.env` dosyasını oluşturun. (UI üzerinden düzenleme yapabilmek için `ADMIN_PASSWORD` ve `APP_SECRET` alanlarını girin. `APP_SECRET` değerini oluşturmak için aşağıdaki komutu kullanabilirsiniz:)

   ```bash
   openssl rand -hex 32
   ```

3. Uygulamayı Docker Compose ile başlatın:

   ```bash
   docker compose up -d --build
   ```

4. Tarayıcıda açın: [http://localhost:5174](http://localhost:5174)

---

## Notlar ve Sorun Giderme

* **yt-dlp bulunamadı** → Yerel kullanımda yt-dlp kurulu olmalı.
* **403 / SABR hataları** → `YTDLP_EXTRA` veya çerez kullanımı işe yarar.
* **Spotify kişiselleştirilmiş Mix** → API desteklemez, oynatma listesine dönüştürün.
* **Yükleme sınırı** → 100MB, `app.js` üzerinden değiştirilebilir.

---

## Lisans

**MIT Lisansı**
Orijinal yazar belirtilmek şartıyla kullanma, değiştirme ve dağıtım serbesttir. Bu yazılım, hiçbir garanti olmaksızın "olduğu gibi" sunulmaktadır. Yazılımı kullanmak kendi sorumluluğunuzdadır.
