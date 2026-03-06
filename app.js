import dotenv from "dotenv";
import net from "node:net";
import express from 'express'
import multer from 'multer'
import path from 'path'
import fs from 'fs'
import crypto from 'crypto'
import { fileURLToPath } from 'url'
import { exec } from 'child_process'
import formatsRoute from './routes/formats.js'
import { getBinariesInfo } from './modules/binariesInfo.js';
import spotifyRoute from './routes/spotify.js'
import playlistRoute from './routes/playlist.js'
import jobsRoute from './routes/jobs.js'
import downloadRoute from './routes/download.js'
import { sendError } from './modules/utils.js'
import discRouter from './routes/disc.js'
import {
  FFMPEG_BIN,
  YTDLP_BIN,
  FFPROBE_BIN,
  MKVMERGE_BIN,
  DENO_BIN,
  initializeDynamicBinaries
} from './modules/binaries.js'

const defaultEnv = process.env.ENV_DEFAULT_PATH
const userEnv = process.env.ENV_USER_PATH

if (defaultEnv && fs.existsSync(defaultEnv)) {
  dotenv.config({ path: defaultEnv })
  console.log('✅ Loaded default environment:', defaultEnv)
}
if (userEnv && fs.existsSync(userEnv)) {
  dotenv.config({ path: userEnv, override: true })
  console.log('✅ Loaded user environment overrides:', userEnv)
} else {
  const localEnv = path.join(process.cwd(), '.env')
  if (fs.existsSync(localEnv)) {
    dotenv.config({ path: localEnv, override: true })
    console.log('✅ Loaded local .env file:', localEnv)
  }
}

try {
  await initializeDynamicBinaries()
} catch (err) {
  console.warn('⚠️ Dynamic binary init failed, fallback active:', err?.message || err)
}

const { default: settingsRoute } = await import('./modules/settings.js')
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const app = express()

const BASE_DIR = process.env.DATA_DIR || process.cwd()
const UPLOAD_DIR = path.resolve(BASE_DIR, 'uploads')
const OUTPUT_DIR = path.resolve(BASE_DIR, 'outputs')
const TEMP_DIR = path.resolve(BASE_DIR, 'temp')
const LOCAL_INPUTS_DIR = process.env.LOCAL_INPUT_DIR
  ? path.resolve(process.env.LOCAL_INPUT_DIR)
  : path.resolve(BASE_DIR, 'local-inputs')

for (const dir of [UPLOAD_DIR, OUTPUT_DIR, TEMP_DIR, LOCAL_INPUTS_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

const isElectron = !!process.versions.electron;
const isPackagedElectron =
  isElectron &&
  defaultEnv &&
  defaultEnv.includes('app.asar');

let rawCookiesEnv = process.env.YTDLP_COOKIES || '';

if (!rawCookiesEnv) {
  const cookieDir = path.join(BASE_DIR, 'cookies');

  try {
    fs.mkdirSync(cookieDir, { recursive: true });
  } catch (err) {
    console.warn('🍪 Cookie klasörü oluşturulamadı:', err.message);
  }

  process.env.YTDLP_COOKIES = path.join(cookieDir, 'cookies.txt');
  console.log('🍪 YTDLP_COOKIES (default → BASE_DIR/cookies):', process.env.YTDLP_COOKIES);
  console.log('🍪 Cookie file exists?:', fs.existsSync(process.env.YTDLP_COOKIES));
} else if (rawCookiesEnv.startsWith('./')) {
  process.env.YTDLP_COOKIES = path.join(BASE_DIR, rawCookiesEnv.slice(2));
  console.log('🍪 YTDLP_COOKIES (relative → BASE_DIR):', process.env.YTDLP_COOKIES);
  console.log('🍪 Cookie file exists?:', fs.existsSync(process.env.YTDLP_COOKIES));
}

// Handles check dependencies in application bootstrap and route wiring.
function checkDependencies() {
  return new Promise((resolve) => {
    const results = { ytDlp: false, ffmpeg: false, deno: false }

    exec(`"${YTDLP_BIN}" --version`, (error, stdout) => {
      if (!error && stdout.trim()) {
        results.ytDlp = true
        console.log(`✅ yt-dlp OK (${YTDLP_BIN}) — ${stdout.trim().split('\n')[0]}`)
      } else {
        console.log(`❌ yt-dlp is NOT available at ${YTDLP_BIN}`)
      }

      exec(`"${FFMPEG_BIN}" -version`, (error, stdout) => {
        if (!error && stdout.includes('ffmpeg version')) {
          results.ffmpeg = true
          const version = stdout.match(/ffmpeg version (\S+)/)?.[1] || 'unknown'
          console.log(`✅ ffmpeg OK (${FFMPEG_BIN}) — version ${version}`)
        } else {
          console.log(`❌ ffmpeg is NOT available at ${FFMPEG_BIN}`)
        }

        exec(`"${DENO_BIN}" --version`, (error, stdout) => {
          if (!error && stdout.trim()) {
            results.deno = true
            const firstLine = stdout.trim().split('\n')[0]
            console.log(`✅ deno OK (${DENO_BIN}) — ${firstLine}`)
          } else {
            console.log(`❌ deno is NOT available at ${DENO_BIN}`)
          }
          resolve(results)
        })
      })
    })
  })
}

// Runs startup diagnostics for application bootstrap and route wiring.
async function runStartupDiagnostics() {
  console.log('\n🔎 Startup Diagnostics')
  console.log('────────────────────────────────────────────────')

  console.log(`🍪 Cookies file: ${process.env.YTDLP_COOKIES || '(not set)'}`);

  const inDocker = fs.existsSync('/.dockerenv')
  console.log(`🧠 Node.js: ${process.version} (${process.platform}/${process.arch})`)
  console.log(`📦 Base Directory: ${BASE_DIR}`)
  console.log(`📂 Working Directory: ${process.cwd()}`)
  console.log(`🐳 Running Inside Docker: ${inDocker ? 'YES' : 'NO'}`)

  const execPromise = (cmd) =>
    new Promise((resolve) => {
      exec(cmd, (err, stdout, stderr) => {
        resolve({ err, stdout: stdout || '', stderr: stderr || '' })
      })
    })

  const bins = {
    'yt-dlp': YTDLP_BIN || 'yt-dlp',
    ffmpeg: FFMPEG_BIN || 'ffmpeg',
    ffprobe: FFPROBE_BIN || 'ffprobe',
    mkvmerge: MKVMERGE_BIN || 'mkvmerge',
    deno: DENO_BIN || 'deno'
  }

  // Handles check bin in application bootstrap and route wiring.
  const checkBin = async (name, bin, args = '--version') => {
    const { err, stdout, stderr } = await execPromise(`"${bin}" ${args}`)
    if (err) {
      console.log(`❌ ${name} NOT FOUND at ${bin}`)
      if (stderr.trim()) console.log(`   ↳ stderr: ${stderr.trim().split('\n')[0]}`)
      return
    }
    console.log(`✅ ${name} OK (${bin}) — ${stdout.trim().split('\n')[0]}`)
  }

  console.log('\n🧩 Binary / Version Checks')
  console.log('────────────────────────────────────────────────')
  await checkBin('yt-dlp', bins['yt-dlp'])
  await checkBin('ffmpeg', bins.ffmpeg, '-version')
  await checkBin('ffprobe', bins.ffprobe, '-version')
  await checkBin('mkvmerge', bins.mkvmerge, '--version')
  await checkBin('deno', bins.deno, '--version')

  console.log('\n🎛 FFmpeg Hardware Encoder Support')
  console.log('────────────────────────────────────────────────')

  const enc = await execPromise(`"${bins.ffmpeg}" -hide_banner -encoders`)
  if (enc.err) {
    console.log('⚠️  Unable to retrieve encoder list.')
  } else {
    const matches = enc.stdout.split('\n').filter((l) => /nvenc|qsv|vaapi/i.test(l))
    if (matches.length === 0) {
      console.log('ℹ️ No NVENC/QSV/VAAPI encoders found.')
    } else {
      console.log('✅ Hardware encoder lines:')
      matches.forEach((l) => console.log('   ' + l.trim()))
    }
  }

  console.log('\n🖥 VAAPI / GPU Check (vainfo)')
  console.log('────────────────────────────────────────────────')

  const vainfo = await execPromise('vainfo')
  if (vainfo.err) {
    console.log('ℹ️ vainfo unavailable or not supported.')
    if (vainfo.stderr.trim()) {
      console.log(`   ↳ ${vainfo.stderr.trim().split('\n').slice(0, 2).join(' / ')}`)
    }
  } else {
    console.log('✅ vainfo output:')
    vainfo.stdout.split('\n').slice(0, 5).forEach((l) => console.log('   ' + l))
  }

  console.log('\n✅ Diagnostics completed.')
  console.log('────────────────────────────────────────────────\n')
}

app.use(express.json({ limit: '10mb' }))
app.use(express.static(path.join(__dirname, 'public')))

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) =>
    cb(null, `${crypto.randomBytes(8).toString('hex')}_${file.originalname}`)
})
export const upload = multer({
  storage,
  limits: { fileSize: 1000 * 1024 * 1024 }
})

app.use(formatsRoute)
app.use(spotifyRoute)
app.use(playlistRoute)
app.use(jobsRoute)
app.use(discRouter)
app.use(downloadRoute)
app.use('/api', settingsRoute)

app.get('/api/version', (req, res) => {
  try {
    const packagePath = path.resolve(__dirname, 'package.json');
    const packageData = JSON.parse(fs.readFileSync(packagePath, 'utf8'));

    res.json({
      version: packageData.version,
      name: packageData.name
    });
  } catch (error) {
    console.error('Package.json could not be read:', error);
    res.json({
      version: '1.2.0',
      name: 'Gharmonize'
    });
  }
});

app.get('/api/binaries', async (req, res) => {
  try {
    const info = await getBinariesInfo();
    res.json(info);
  } catch (err) {
    console.error('Binaries info error:', err);
    res.status(500).json({
      error: 'BINARIES_INFO_FAILED',
      message: err.message || 'Binaries info failed'
    });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
})

app.use((err, req, res, next) => {
  if (err?.code === 'LIMIT_FILE_SIZE') {
    return sendError(res, 'INTERNAL', 'File too large', 413)
  }
  if (err) {
    console.error('Unhandled error:', err)
    return sendError(res, 'INTERNAL', err.message || 'Internal server error', 500)
  }
  next()
})

const PORT = Number(process.env.PORT || 5174)

const server = app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`)
  console.log(`📁 Base Directory: ${BASE_DIR}`)
  console.log(`📁 Uploads: ${UPLOAD_DIR}`)
  console.log(`📁 Outputs: ${OUTPUT_DIR}`)
  console.log(`📁 Temp: ${TEMP_DIR}`)
  console.log(`📁 Local Inputs: ${LOCAL_INPUTS_DIR}`)
})

server.on('error', (err) => {
  console.error('❌ [server] listen error:', err)
})

setImmediate(async () => {
  try {
    const results = await checkDependencies()
    console.log('⚠️ Dependency Status:')
    console.log(`   ${results.ytDlp ? '✅' : '❌'} yt-dlp`)
    console.log(`   ${results.ffmpeg ? '✅' : '❌'} ffmpeg`)
    console.log(`   ${results.deno ? '✅' : '❌'} deno`)

    await runStartupDiagnostics()
  } catch (e) {
    console.error('⚠️ Startup checks failed:', e?.message || e)
  }
})
