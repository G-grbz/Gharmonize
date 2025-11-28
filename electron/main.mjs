import { app, BrowserWindow, Menu, shell, dialog, session, ipcMain, clipboard, Notification } from 'electron'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import net from 'node:net'
import fs from 'node:fs'
import { FFMPEG_BIN, FFPROBE_BIN, MKVMERGE_BIN, YTDLP_BIN } from '../modules/binaries.js';

const HOST = '127.0.0.1'
const PORT = process.env.PORT || '5174'

async function loadLanguageDict(lang) {
  try {
    let filePath;
    if (app.isPackaged) {
      filePath = path.join(process.resourcesPath, 'app.asar', 'public', 'lang', `${lang}.json`);
    } else {
      filePath = path.join(process.cwd(), 'public', 'lang', `${lang}.json`);
    }

    console.log(`Loading language file: ${filePath}`);

    if (!fs.existsSync(filePath)) {
      console.warn(`Language file not found: ${filePath}`);
      if (lang !== 'en') {
        return await loadLanguageDict('en');
      }
      throw new Error('English fallback also failed');
    }

    const data = await fs.promises.readFile(filePath, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.warn(`Could not load language file for ${lang}:`, error.message);

    if (lang !== 'en') {
      try {
        return await loadLanguageDict('en');
      } catch (fallbackError) {
        console.error('English fallback also failed:', fallbackError);
      }
    }

    return {};
  }
}

let currentLanguage = 'en';
let currentDict = {};

async function initializeLanguage() {
  try {
    const userDataPath = app.getPath('userData');
    const prefsFile = path.join(userDataPath, 'preferences.json');

    if (fs.existsSync(prefsFile)) {
      const prefsData = await fs.promises.readFile(prefsFile, 'utf8');
      const prefs = JSON.parse(prefsData);
      currentLanguage = prefs.language || 'en';
      console.log(`Loaded language preference: ${currentLanguage}`);
    } else {
      const systemLanguage = app.getLocale() || 'en';
      const supportedLangs = ['en', 'tr', 'de', 'fr'];
      currentLanguage = supportedLangs.includes(systemLanguage) ? systemLanguage : 'en';
      console.log(`Using system language: ${currentLanguage}`);
    }

    currentDict = await loadLanguageDict(currentLanguage);
    console.log(`Language dictionary loaded for: ${currentLanguage}`);
  } catch (error) {
    console.warn('Could not load language preferences:', error.message);
    currentDict = await loadLanguageDict('en');
  }
}

function t(key, fallback = key) {
  const value = currentDict[key];
  if (value === undefined) {
    console.warn(`Translation key not found: ${key}`);
    return fallback;
  }
  return value;
}

function resolveIcon() {
  if (process.platform === 'win32') {
    const iconPath = app.isPackaged
      ? path.join(process.resourcesPath, 'build', 'icon.ico')
      : path.join(process.cwd(), 'build', 'icon.ico')
    console.log('Windows icon path:', iconPath)
    console.log('Icon exists:', fs.existsSync(iconPath))
    return iconPath
  }
  if (process.platform === 'linux') {
    const iconPath = app.isPackaged
      ? path.join(process.resourcesPath, 'build', 'icon.png')
      : path.join(process.cwd(), 'build', 'icon.png')
    console.log('Linux icon path:', iconPath)
    console.log('Icon exists:', fs.existsSync(iconPath))
    return iconPath
  }
  return undefined
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
    if (await isPortReady(port)) {
      console.log(`✅ Server is ready on ${HOST}:${port}`)
      return
    }
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
    { name: 'yt-dlp', bin: YTDLP_BIN }
  ];

  console.log('🔍 Checking bundled binaries:');
  for (const tool of tools) {
    const exists = fs.existsSync(tool.bin);
    console.log(`   ${tool.name}: ${tool.bin} -> ${exists ? '✅' : '❌'}`);
    if (!exists) {
      missing.push(tool);
    }
  }

  if (missing.length > 0) {
    const list = missing.map(t => `${t.name}: ${t.bin}`).join('\n');
    throw new Error(`Missing required binaries:\n${list}`);
  }
}

async function startServerIfPackaged() {
  if (!app.isPackaged) {
    console.log('🛠️  Development mode - using external server')
    return
  }

  console.log('📦 Packaged mode - starting embedded server')
  const serverPath = path.join(process.resourcesPath, 'app.asar', 'app.js')
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
      console.log('ℹ️  Created user .env at', userEnv)
    }
  } catch (err) {
    console.warn('⚠️  Could not create user .env:', err.message)
  }

  try {
    const serverUrl = pathToFileURL(serverPath).href
    await import(serverUrl)
    console.log('✅ Embedded server started')
    await waitForServer(PORT)
  } catch (error) {
    console.error('❌ Failed to start embedded server:', error)
    throw error
  }
}

function attachDownloads(win) {
  const ses = win.webContents.session || session.defaultSession;

  ses.removeAllListeners('will-download');

  ses.on('will-download', (event, item) => {
    const filename = item.getFilename() || 'download';
    console.log('📥 Download started:', filename, '→', item.getURL());

    item.once('done', (ev, state) => {
      const savePath = typeof item.getSavePath === 'function'
        ? item.getSavePath()
        : null;

      if (state === 'completed') {
  console.log('✅ Download completed:', filename, savePath ? `→ ${savePath}` : '');

  if (Notification.isSupported()) {
        const lines = [];
        lines.push(filename);
        const locationLabel = t('download.locationLabel', 'Saved to:');

        const dirPath = savePath
          ? path.dirname(savePath)
          : app.getPath('downloads');

        const dirName = path.basename(dirPath) || dirPath;
        lines.push(`${locationLabel} ${dirName}`);

        const notifOptions = {
          title: t('download.completedTitle', 'Download completed'),
          body: lines.join('\n'),
        };

        if (savePath) {
          notifOptions.actions = [
            {
              type: 'button',
              text: t('download.openFile', 'Open file'),
            },
            {
              type: 'button',
              text: t('download.openFolder', 'Open folder'),
            },
          ];
          notifOptions.closeButtonText = t('download.dismiss', 'Close');
        }

        const notif = new Notification(notifOptions);

        if (savePath) {
          notif.on('click', () => {
            shell.showItemInFolder(savePath);
          });

          notif.on('action', (_event, index) => {
            if (index === 0) {
              shell.openPath(savePath);
            } else if (index === 1) {
              shell.showItemInFolder(savePath);
            }
          });
        }

        notif.show();
      }
    } else {
        console.log(`❌ Download failed: ${state} (${filename})`);

        if (Notification.isSupported()) {
          const notif = new Notification({
            title: t('download.failedTitle', 'Download failed'),
            body: `${filename}\n${t('download.failedBody', 'The download could not be completed.')} (${state})`,
          });
          notif.on('click', () => {
            if (win && !win.isDestroyed()) {
              win.show();
              win.focus();
            }
          });
          notif.show();
        }
      }
    });
  });
}

function getNavState(webContents) {
  const nav = webContents.navigationHistory;
  if (nav && typeof nav.canGoBack === 'function' && typeof nav.canGoForward === 'function') {
    return {
      canGoBack: nav.canGoBack(),
      canGoForward: nav.canGoForward()
    };
  }

  return {
    canGoBack: webContents.canGoBack(),
    canGoForward: webContents.canGoForward()
  };
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
    {
      label: t('contextMenu.back', 'Back'),
      role: 'back',
      enabled: canGoBack
    },
    {
      label: t('contextMenu.forward', 'Forward'),
      role: 'forward',
      enabled: canGoForward
    },
    { type: 'separator' },
    {
      label: t('contextMenu.reload', 'Reload'),
      role: 'reload'
    },
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
    template.push(
      { label: t('contextMenu.copy', 'Copy'), role: 'copy' },
      { type: 'separator' }
    );
  }

  if (hasLink) {
    template.push(
      {
        label: t('contextMenu.openLinkInBrowser', 'Open link in browser'),
        click: () => shell.openExternal(params.linkURL)
      }
    );
    template.push({ type: 'separator' });
  }

  if (isImage) {
    template.push(
      {
        label: t('contextMenu.saveImageAs', 'Save image as...'),
        click: () => wc.downloadURL(params.srcURL)
      },
      {
        label: t('contextMenu.copyImage', 'Copy image'),
        click: () => wc.copyImageAt(params.x, params.y)
      },
      {
        label: t('contextMenu.copyImageAddress', 'Copy image address'),
        click: () => clipboard.writeText(params.srcURL)
      }
    );
    template.push({ type: 'separator' });
  }

  if (!app.isPackaged || process.env.NODE_ENV === 'development') {
    template.push(
      {
        label: t('contextMenu.inspect', 'Inspect'),
        click: () => wc.inspectElement(params.x, params.y)
      }
    );
  }

  const menu = Menu.buildFromTemplate(template);
  menu.popup({ window: win });
}

function createAppMenu(win) {
  const template = [];
  if (process.platform === 'darwin') {
    template.push({
      label: app.name,
      submenu: [
        { role: 'about', label: 'About Gharmonize' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    });
  }

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
              '- MKVToolNix tools (mkvmerge, mkvextract, mkvinfo, mkvpropedit)',
              '- yt-dlp',
              '',
              'These tools are licensed under their respective open-source licenses',
              '(GPL/LGPL or The Unlicense). For detailed license information, please',
              'refer to the LICENSES.md file and the license texts shipped with the',
              'application under the build/licenses/ directory (or equivalent path',
              'in the installed build).',
              '',
              'More details and source code:',
              'https://github.com/G-grbz/Gharmonize'
            ].join('\n')
          });
        }
      },
      { type: 'separator' },
      {
        label: 'Open GitHub (Project Page)',
        click: () => {
          shell.openExternal('https://github.com/G-grbz/Gharmonize');
        }
      }
    ]
  });

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
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

  win.once('ready-to-show', () => {
    win.show();
    win.focus();

  win.setMenuBarVisibility(true);
  });

  win.webContents.on('context-menu', (event, params) => {
    event.preventDefault();
    buildAndShowContextMenu(win, params);
  });

  attachDownloads(win);
  createAppMenu(win);

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('did-finish-load', () => {
    console.log('Window loaded, setting up language listeners...');

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
        console.log('Current language from localStorage:', currentLang);
        if (window.electronAPI) {
          window.electronAPI.updateLanguage(currentLang);
        }
      }, 1000);

      document.addEventListener('i18n:applied', (event) => {
        const lang = event.detail?.lang;
        console.log('i18n:applied event received with lang:', lang);
        if (lang && window.electronAPI) {
          window.electronAPI.updateLanguage(lang);
        }
      });

      console.log('Language listeners setup completed');
    `).catch(console.error);
  });

  win.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
    console.error('Failed to load:', errorDescription);
  });

  win.loadURL(`http://${HOST}:${PORT}`).catch(console.error);

  return win;
}

ipcMain.handle('update-language', async (event, lang) => {
  try {
    console.log(`Updating language to: ${lang}`);

    if (!['en', 'tr', 'de', 'fr'].includes(lang)) {
      throw new Error(`Unsupported language: ${lang}`);
    }

    currentLanguage = lang;
    currentDict = await loadLanguageDict(lang);
    const userDataPath = app.getPath('userData');
    const prefsFile = path.join(userDataPath, 'preferences.json');
    const prefs = {
      language: lang,
      updated: new Date().toISOString()
    };

    await fs.promises.writeFile(prefsFile, JSON.stringify(prefs, null, 2));
    console.log(`Language preferences saved: ${prefsFile}`);

    return { success: true, language: lang };
  } catch (error) {
    console.error('Language update failed:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-current-language', async () => {
  return { language: currentLanguage };
});

app.whenReady().then(async () => {
  console.log('🚀 Gharmonize starting...');

  await initializeLanguage();

  app.setAppUserModelId('com.gharmonize.app');

  try {
    if (app.isPackaged) {
      checkDesktopBinaries();
    }

    await startServerIfPackaged();
    const mainWindow = createWindow();
    console.log('✅ Gharmonize started successfully');

    if (!app.isPackaged) {
      mainWindow.webContents.openDevTools();
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
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  console.log('👋 Gharmonize shutting down...');
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});
