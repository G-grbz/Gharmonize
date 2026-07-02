import fs from "node:fs";
import dotenv from "dotenv";

const defaultEnv = process.env.ENV_DEFAULT_PATH;
const userEnv = process.env.ENV_USER_PATH;
const desktopDataDir = process.env.GHARMONIZE_DESKTOP_DATA_DIR;

if (userEnv && fs.existsSync(userEnv)) {
  dotenv.config({ path: userEnv, override: true });
  console.log("✅ [bootstrap] Loaded user env:", userEnv);
}

if (defaultEnv && fs.existsSync(defaultEnv)) {
  dotenv.config({ path: defaultEnv, override: false });
  console.log("✅ [bootstrap] Loaded default env:", defaultEnv);
}

if (desktopDataDir) {
  process.env.DATA_DIR = desktopDataDir;
}

await import("./app.js");

console.log("🔥 BOOTSTRAP ACTIVE", process.platform, process.env.AUTOMIX_ALL_TIMEOUT_MS);
