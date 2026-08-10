import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const LOG_FILE = path.join(os.homedir(), ".codemon", "debug.log");
let debugEnabled = false;

export function enableDebug() {
  debugEnabled = true;
  const dir = path.dirname(LOG_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function timestamp() {
  return new Date().toISOString();
}

function write(level: string, msg: string, data?: unknown) {
  if (!debugEnabled) return;
  const line = `[${timestamp()}] [${level}] ${msg}${data !== undefined ? " " + JSON.stringify(data) : ""}\n`;
  fs.appendFileSync(LOG_FILE, line);
}

export const logger = {
  debug: (msg: string, data?: unknown) => write("DEBUG", msg, data),
  info: (msg: string, data?: unknown) => write("INFO", msg, data),
  warn: (msg: string, data?: unknown) => write("WARN", msg, data),
  error: (msg: string, data?: unknown) => write("ERROR", msg, data),
};
