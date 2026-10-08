import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { initializeRuntimeEnvironment } from '../modules/runtimeEnvironment.js';

app.setName('Gharmonize');
if (app.isPackaged) {
  const profileDir = app.getPath('userData');
  const defaultEnv = path.join(process.resourcesPath, 'app.asar', '.env.default');
  const userEnv = path.join(profileDir, '.env');
  fs.mkdirSync(profileDir, { recursive: true });
  if (!fs.existsSync(userEnv) && fs.existsSync(defaultEnv)) {
    try { fs.copyFileSync(defaultEnv, userEnv, fs.constants.COPYFILE_EXCL); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  process.env.ENV_DEFAULT_PATH = defaultEnv;
  process.env.ENV_USER_PATH = userEnv;
  process.env.GHARMONIZE_DESKTOP_DATA_DIR = profileDir;
  initializeRuntimeEnvironment({ desktopDataDir: profileDir });
} else {
  // desktop:dev must resolve the same .env/storage as its npm start server.
  initializeRuntimeEnvironment();
}
