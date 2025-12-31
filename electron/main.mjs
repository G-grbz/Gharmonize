import { app, BrowserWindow, Menu, shell, dialog, session, ipcMain, clipboard, Notification, Tray } from 'electron'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import net from 'node:net'
import fs from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { FFMPEG_BIN, FFPROBE_BIN, MKVMERGE_BIN, YTDLP_BIN, DENO_BIN } from '../modules/binaries.js';

const execFileAsync = promisify(execFile);
const HOST = '127.0.0.1'
const PORT = process.env.PORT || '5174'

let tray = null;
let trayMenu = null;
let mainWindowRef = null;
let keepAliveInTray = false;
let isQuitting = false;
let isHidingToTray = false;
let creatingWindowPromise = null;
let showOnWindowReady = false;

async function cleanupWindowsRunEntries() {
  if (process.platform !== 'win32') return;
  const suspectNames = [
    'com.gharmonize.app',
    'Gharmonize',
    'Gharmonize Desktop',
    'Gharmonize.exe'
  ];

  const keepName = 'electron.app.Gharmonize';

  for (const name of suspectNames) {
    if (name === keepName) continue;
    try {
      await execFileAsync('reg', [
        'delete',
        'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
        '/v',
        name,
        '/f'
      ], { windowsHide: true });
      console.log('[autostart] deleted Run entry:', name);
    } catch {
    }
  }
}

function createWindowOnce() {
  if (mainWindowRef && !mainWindowRef.isDestroyed()) return mainWindowRef;
  if (creatingWindowPromise) return creatingWindowPromise;
  creatingWindowPromise = Promise.resolve().then(() => {
    const win = createWindow();
    mainWindowRef = win;
    return win;
  }).finally(() => {
    creatingWindowPromise = null;
  });
  return creatingWindowPromise;
}

function resolveTrayIcon() {
  const base = app.isPackaged ? app.getAppPath() : process.cwd();
  if (process.platform === 'win32') return path.join(base, 'build', 'icon.ico');
  return path.join(base, 'build', 'icon.png');
}

function showMainWindow(win) {
  if (!win || win.isDestroyed()) return;

  try { win.restore?.(); } catch {}
  try { win.show(); } catch {}
  try { win.focus(); } catch {}
  try { win.setAlwaysOnTop(true); } catch {}
  setTimeout(() => {
    try { win.setAlwaysOnTop(false); } catch {}
    try { win.focus(); } catch {}
  }, 120);
}

function getPrefsPath() {
  return path.join(app.getPath('userData'), 'preferences.json');
}

async function loadPrefs() {
  try {
    const p = getPrefsPath();
    if (!fs.existsSync(p)) return {};
    return JSON.parse(await fs.promises.readFile(p, 'utf8'));
  } catch (e) {
    console.warn('Could not load prefs:', e.message);
    return {};
  }
}

async function savePrefs(prefs) {
  try {
    await fs.promises.writeFile(getPrefsPath(), JSON.stringify(prefs, null, 2));
  } catch (e) {
    console.warn('Could not save prefs:', e.message);
  }
}

async function loadLanguageDict(lang) {
  try {
    let filePath;
    if (app.isPackaged) {
      filePath = path.join(process.resourcesPath, 'app.asar', 'public', 'lang', `${lang}.json`);
    } else {
      filePath = path.join(process.cwd(), 'public', 'lang', `${lang}.json`);
    }

    if (!fs.existsSync(filePath)) {
      if (lang !== 'en') return await loadLanguageDict('en');
      throw new Error('English fallback also failed');
    }

    const data = await fs.promises.readFile(filePath, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.warn(`Could not load language file for ${lang}:`, error.message);
    if (lang !== 'en') {
      try { return await loadLanguageDict('en'); } catch {}
    }
    return {};
  }
}

let currentLanguage = 'en';
let currentDict = {};

async function initializeLanguage() {
  try {
    const prefs = await loadPrefs();
    if (prefs.language) {
      currentLanguage = prefs.language;
    } else {
      const systemLanguage = app.getLocale() || 'en';
      const supportedLangs = ['en', 'tr', 'de', 'fr'];
      currentLanguage = supportedLangs.includes(systemLanguage) ? systemLanguage : 'en';
    }
    currentDict = await loadLanguageDict(currentLanguage);
  } catch (e) {
    console.warn('Language init failed:', e.message);
    currentDict = await loadLanguageDict('en');
  }
}

function t(key, fallback = key) {
  const value = currentDict[key];
  if (value === undefined) return fallback;
  return value;
}

function getLinuxAutostartDesktopPath() {
  return path.join(app.getPath('home'), '.config', 'autostart', 'Gharmonize.desktop');
}

function buildLinuxDesktopFile(prefs = {}) {
  const appImage = process.env.APPIMAGE;
  const execPath = appImage || process.execPath;
  const execQuoted = execPath.includes(' ') ? `"${execPath}"` : execPath;
  const args = [];
  if (prefs.autoStart) args.push('--autostart');
  if (prefs.autoStart && prefs.startMinimized) args.push('--hidden');

  const tryExecLine = appImage
    ? `TryExec=${execPath}`
    : `TryExec=${process.execPath}`;

  return [
    '[Desktop Entry]',
    'Type=Application',
    'Version=1.0.8',
    'Name=Gharmonize',
    'GenericName=Media Toolkit',
    'Comment=Gharmonize',
    'Icon=gharmonize',
    tryExecLine,
    `Exec=env GHARMONIZE_AUTOSTART=1 ${execQuoted}${args.length ? ' ' + args.join(' ') : ''}`,
    'Terminal=false',
    'Categories=AudioVideo;Utility;',
    'StartupNotify=true',
    'StartupWMClass=Gharmonize',
    'X-GNOME-Autostart-enabled=true',
    'X-GNOME-Autostart-Delay=3',
    'X-KDE-autostart-after=panel'
  ].join('\n');
}

async function applyLinuxAutostart(enabled) {
  const desktopPath = getLinuxAutostartDesktopPath();
  const dir = path.dirname(desktopPath);
  await fs.promises.mkdir(dir, { recursive: true });

  if (enabled) {
    const prefs = await loadPrefs();
    await fs.promises.writeFile(desktopPath, buildLinuxDesktopFile(prefs), 'utf8');
  } else {
    if (fs.existsSync(desktopPath)) await fs.promises.unlink(desktopPath);
  }
}

async function applyAutoStartFromPrefs() {
  const prefs = await loadPrefs();
  if (prefs.autoStart === undefined) return;

  if (process.platform === 'win32' || process.platform === 'darwin') {
    const open = !!prefs.autoStart;
    const args = [];
    if (open) args.push('--autostart');
    if (open && prefs.startMinimized) args.push('--hidden');

    app.setLoginItemSettings({
      openAtLogin: open,
      path: process.execPath,
      args
    });
  } else {
    try {
      await applyLinuxAutostart(!!prefs.autoStart);
    } catch (e) {
      console.warn('Linux autostart apply failed:', e.message);
    }
  }
}

async function syncKeepAliveFlagFromPrefs() {
  const prefs = await loadPrefs();
  keepAliveInTray = !!prefs.alwaysMinimizeToTray;
}

async function setAutoStartEnabled(enabled) {
  const prefs = await loadPrefs();
  prefs.autoStart = !!enabled;

  if (!prefs.autoStart) prefs.startMinimized = false;

  prefs.updated = new Date().toISOString();
  await savePrefs(prefs);

  if (process.platform === 'win32' || process.platform === 'darwin') {
    const open = !!enabled;
    const args = [];
    if (open) args.push('--autostart');
    if (open && prefs.startMinimized) args.push('--hidden');

    app.setLoginItemSettings({
      openAtLogin: open,
      path: process.execPath,
      args
    });
  } else {
    try {
      await applyLinuxAutostart(!!enabled);
    } catch (e) {
      console.warn('Linux autostart setup failed:', e.message);
    }
  }
}

function isLaunchedByAutoStart() {
  if (process.platform === 'win32') {
    if (process.argv.includes('--autostart') || process.argv.includes('--hidden')) return true;
    try { return !!app.getLoginItemSettings().wasOpenedAtLogin; } catch { return false; }
  }
  return process.env.GHARMONIZE_AUTOSTART === '1';
}

async function refreshTrayMenu() {
  if (!tray || !mainWindowRef) return;

  const prefs = await loadPrefs();

  trayMenu = Menu.buildFromTemplate([
    {
      label: t('tray.show', 'Show'),
      click: () => showMainWindow(mainWindowRef)
    },
    {
      label: t('tray.autostart', 'Start on login'),
      type: 'checkbox',
      checked: !!prefs.autoStart,
      click: async (menuItem) => {
        await setAutoStartEnabled(menuItem.checked);
        await refreshTrayMenu();
      }
    },
    {
      label: t('tray.startMinimized', 'Start minimized (tray)'),
      type: 'checkbox',
      enabled: !!prefs.autoStart,
      checked: !!prefs.startMinimized,
      click: async (menuItem) => {
        const p = await loadPrefs();
        p.startMinimized = !!menuItem.checked;
        p.updated = new Date().toISOString();
        await savePrefs(p);
        await refreshTrayMenu();
      }
    },
    {
      label: t('tray.alwaysToTray', 'Always minimize to tray'),
      type: 'checkbox',
      checked: !!prefs.alwaysMinimizeToTray,
      click: async (menuItem) => {
        const p = await loadPrefs();
        p.alwaysMinimizeToTray = !!menuItem.checked;
        p.updated = new Date().toISOString();
        await savePrefs(p);

        keepAliveInTray = !!p.alwaysMinimizeToTray;

        await refreshTrayMenu();
      }
    },
    { type: 'separator' },
    {
      label: t('tray.quit', 'Quit'),
      click: async () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);

  tray.setContextMenu(null);
  tray.setContextMenu(trayMenu);
  tray.setToolTip(t('tray.tooltip', 'Gharmonize'));
}

async function ensureTray(win) {
  if (tray) return tray;

  mainWindowRef = win;

  tray = new Tray(resolveTrayIcon());
  tray.setToolTip('Gharmonize');

  await refreshTrayMenu();

  tray.on('click', () => {
    if (!mainWindowRef || mainWindowRef.isDestroyed()) return;
    if (mainWindowRef.isVisible()) mainWindowRef.hide();
    else showMainWindow(mainWindowRef);
  });

  tray.on('double-click', () => showMainWindow(mainWindowRef));
  tray.on('right-click', () => tray.popUpContextMenu());
  tray.on('mouse-up', (event) => {
    if (event.button === 2) tray.popUpContextMenu();
  });

  return tray;
}

function resolveIcon() {
  if (process.platform === 'win32') {
    return app.isPackaged
      ? path.join(process.resourcesPath, 'build', 'icon.ico')
      : path.join(process.cwd(), 'build', 'icon.ico');
  }
  if (process.platform === 'linux') {
    return app.isPackaged
      ? path.join(process.resourcesPath, 'build', 'icon.png')
      : path.join(process.cwd(), 'build', 'icon.png');
  }
  return undefined;
}

function isPortReady(port, host = HOST, timeout = 400) {
  return new Promise((resolve) => {
    const s = new net.Socket()
    const done = ok => { try { s.destroy() } catch {} ; resolve(ok) }
    s.setTimeout(timeout)
    s.once('connect', () => done(true))
    s.once('timeout', () => done(false))
    s.once('error', () => done(false))
    s.connect(port, host)
  })
}

async function waitForServer(port, retries = 75, delayMs = 200) {
  for (let i = 0; i < retries; i++) {
    if (await isPortReady(port)) return;
    await new Promise(r => setTimeout(r, delayMs))
  }
  throw new Error(`Server not reachable on ${HOST}:${port}`)
}

function checkDesktopBinaries() {
  const missing = [];
  const tools = [
    { name: 'ffmpeg', bin: FFMPEG_BIN },
    { name: 'ffprobe', bin: FFPROBE_BIN },
    { name: 'mkvmerge', bin: MKVMERGE_BIN },
    { name: 'yt-dlp', bin: YTDLP_BIN },
    { name: 'deno', bin: DENO_BIN }
  ];

  for (const tool of tools) {
    const exists = fs.existsSync(tool.bin);
    if (!exists) missing.push(tool);
  }

  if (missing.length > 0) {
    const list = missing.map(t => `${t.name}: ${t.bin}`).join('\n');
    throw new Error(`Missing required binaries:\n${list}`);
  }
}

async function startServerIfPackaged() {
  if (!app.isPackaged) return;

  const serverPath = path.join(process.resourcesPath, 'app.asar', 'bootstrap.mjs')
  const defaultEnv = path.join(process.resourcesPath, 'app.asar', '.env.default')
  const userEnv = path.join(app.getPath('userData'), '.env')
  const dataDir = app.getPath('userData')

  process.env.ENV_DEFAULT_PATH = defaultEnv
  process.env.ENV_USER_PATH = userEnv
  process.env.DATA_DIR = dataDir

  try {
    if (!fs.existsSync(userEnv) && fs.existsSync(defaultEnv)) {
      fs.mkdirSync(path.dirname(userEnv), { recursive: true })
      fs.copyFileSync(defaultEnv, userEnv)
    }
  } catch {}

  const serverUrl = pathToFileURL(serverPath).href
  await import(serverUrl)
  await waitForServer(PORT)
}

function attachDownloads(win) {
  const ses = win.webContents.session || session.defaultSession;
  ses.removeAllListeners('will-download');

  ses.on('will-download', (event, item) => {
    item.once('done', async (_ev, state) => {
      if (state !== 'completed') return;
    });
  });
}

function getNavState(webContents) {
  const nav = webContents.navigationHistory;
  if (nav && typeof nav.canGoBack === 'function' && typeof nav.canGoForward === 'function') {
    return { canGoBack: nav.canGoBack(), canGoForward: nav.canGoForward() };
  }
  return { canGoBack: webContents.canGoBack(), canGoForward: webContents.canGoForward() };
}

function buildAndShowContextMenu(win, params) {
  const wc = win.webContents;
  const { canGoBack, canGoForward } = getNavState(wc);

  const isEditable = params.isEditable;
  const hasSelection = params.selectionText && params.selectionText.trim().length > 0;
  const hasLink = params.linkURL && params.linkURL.length > 0;
  const isImage = params.mediaType === 'image' && params.srcURL;

  const template = [];

  template.push(
    { label: t('contextMenu.back', 'Back'), role: 'back', enabled: canGoBack },
    { label: t('contextMenu.forward', 'Forward'), role: 'forward', enabled: canGoForward },
    { type: 'separator' },
    { label: t('contextMenu.reload', 'Reload'), role: 'reload' },
    { type: 'separator' }
  );

  if (isEditable) {
    template.push(
      { label: t('contextMenu.undo', 'Undo'), role: 'undo' },
      { label: t('contextMenu.redo', 'Redo'), role: 'redo' },
      { type: 'separator' },
      { label: t('contextMenu.cut', 'Cut'), role: 'cut' },
      { label: t('contextMenu.copy', 'Copy'), role: 'copy' },
      { label: t('contextMenu.paste', 'Paste'), role: 'paste' },
      { label: t('contextMenu.pasteAndMatchStyle', 'Paste and Match Style'), role: 'pasteAndMatchStyle' },
      { label: t('contextMenu.selectAll', 'Select All'), role: 'selectAll' },
      { type: 'separator' }
    );
  } else if (hasSelection) {
    template.push({ label: t('contextMenu.copy', 'Copy'), role: 'copy' }, { type: 'separator' });
  }

  if (hasLink) {
    template.push({
      label: t('contextMenu.openLinkInBrowser', 'Open link in browser'),
      click: () => shell.openExternal(params.linkURL)
    });
    template.push({ type: 'separator' });
  }

  if (isImage) {
    template.push(
      { label: t('contextMenu.saveImageAs', 'Save image as...'), click: () => wc.downloadURL(params.srcURL) },
      { label: t('contextMenu.copyImage', 'Copy image'), click: () => wc.copyImageAt(params.x, params.y) },
      { label: t('contextMenu.copyImageAddress', 'Copy image address'), click: () => clipboard.writeText(params.srcURL) }
    );
    template.push({ type: 'separator' });
  }

  if (!app.isPackaged || process.env.NODE_ENV === 'development') {
    template.push({ label: t('contextMenu.inspect', 'Inspect'), click: () => wc.inspectElement(params.x, params.y) });
  }

  const menu = Menu.buildFromTemplate(template);
  menu.popup({ window: win });
}

function createAppMenu(win) {
  const template = [];

  template.push({
    label: 'Help',
    submenu: [
      {
        label: 'About Gharmonize',
        click: () => {
          dialog.showMessageBox(win, {
            type: 'info',
            title: 'About Gharmonize',
            message: 'Gharmonize',
            detail: [
              'Gharmonize is licensed under the MIT License.',
              '',
              'This application bundles the following third-party command-line tools:',
              '- FFmpeg / FFprobe',
              '- MKVToolNix tools',
              '- yt-dlp',
              '',
              'More details and source code:',
              'https://github.com/G-grbz/Gharmonize'
            ].join('\n')
          });
        }
      },
      { type: 'separator' },
      { label: 'Open GitHub (Project Page)', click: () => shell.openExternal('https://github.com/G-grbz/Gharmonize') }
    ]
  });

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function shouldStartHidden() {
  const prefs = await loadPrefs();
  if (process.argv.includes('--hidden')) return true;
  const auto = isLaunchedByAutoStart();
  if (auto && prefs.startMinimized) return true;

  return false;
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 720,
    minWidth: 720,
    minHeight: 480,
    title: 'Gharmonize',
    icon: resolveIcon(),
    autoHideMenuBar: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      enableRemoteModule: false,
      sandbox: false,
      preload: path.join(path.dirname(fileURLToPath(import.meta.url)), 'preload.mjs')
    },
    show: false
  });

  win.webContents.on('context-menu', (event, params) => {
    event.preventDefault();
    buildAndShowContextMenu(win, params);
  });

  win.on('close', async (e) => {
    if (isQuitting || isHidingToTray) return;

    e.preventDefault();

    try {
      const prefs = await loadPrefs();

      if (prefs.alwaysMinimizeToTray) {
        isHidingToTray = true;
        await ensureTray(win);
        win.hide();
        isHidingToTray = false;
        return;
      }
      isQuitting = true;
      app.quit();
    } catch (err) {
      console.error('Close handler crashed:', err);
      isQuitting = true;
      app.quit();
    }
  });

  win.once('ready-to-show', async () => {
    await ensureTray(win);

    const startHidden = await shouldStartHidden();
    if (startHidden) {
      win.hide();
    } else {
      win.show();
      win.focus();
      win.setMenuBarVisibility(true);
    }
  });

  attachDownloads(win);
  createAppMenu(win);

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('did-finish-load', () => {
    win.webContents.executeJavaScript(`
      const originalSetLang = window.i18n?.setLang;
      if (originalSetLang) {
        window.i18n.setLang = async function(lang) {
          const result = await originalSetLang.call(this, lang);
          if (window.electronAPI) {
            window.electronAPI.updateLanguage(lang);
          }
          return result;
        };
      }

      setTimeout(() => {
        const currentLang = localStorage.getItem('lang') || 'en';
        if (window.electronAPI) {
          window.electronAPI.updateLanguage(currentLang);
        }
      }, 500);

      document.addEventListener('i18n:applied', (event) => {
        const lang = event.detail?.lang;
        if (lang && window.electronAPI) {
          window.electronAPI.updateLanguage(lang);
        }
      });
    `).catch(console.error);
  });

  win.loadURL(`http://${HOST}:${PORT}`).catch(console.error);

  return win;
}

ipcMain.handle('update-language', async (_event, lang) => {
  try {
    if (!['en', 'tr', 'de', 'fr'].includes(lang)) {
      throw new Error(`Unsupported language: ${lang}`);
    }

    const prefs = await loadPrefs();
    prefs.language = lang;
    prefs.updated = new Date().toISOString();
    await savePrefs(prefs);

    currentLanguage = lang;
    currentDict = await loadLanguageDict(lang);

    await refreshTrayMenu();

    return { success: true, language: lang };
  } catch (e) {
    console.error('Language update failed:', e);
    return { success: false, error: e.message };
  }
});

ipcMain.handle('get-current-language', async () => {
  return { language: currentLanguage };
});

const gotLock = app.requestSingleInstanceLock();
console.log('[boot] argv:', process.argv);

if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', async (_event, _commandLine, _workingDirectory) => {
    try {
      if (mainWindowRef && !mainWindowRef.isDestroyed()) {
        showMainWindow(mainWindowRef);
      } else {
        showOnWindowReady = true;
      }
    } catch (e) {
      console.error('second-instance handler failed:', e);
    }
  });
}

app.whenReady().then(async () => {
  await cleanupWindowsRunEntries();
  await initializeLanguage();
  await applyAutoStartFromPrefs();
  await syncKeepAliveFlagFromPrefs();

  app.setAppUserModelId('com.gharmonize.app');

  try {
    if (app.isPackaged) checkDesktopBinaries();
    await startServerIfPackaged();
    const win = await createWindowOnce();
    if (showOnWindowReady) {
      showOnWindowReady = false;
      showMainWindow(win);
    }
  } catch (error) {
    console.error('❌ Failed to start Gharmonize:', error);
    dialog.showErrorBox(
      'Startup Error',
      `Failed to start Gharmonize:\n\n${error.message}\n\nPlease check the bundled binaries folder (resources/bin).`
    );
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('window-all-closed', () => {
  if (keepAliveInTray && tray && !isQuitting) return;

  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  isQuitting = true;
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});
