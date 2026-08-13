import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export const CONFIG = {
  PORT: Number(process.env.REVIEW_PORT || 8788),
  HOST: process.env.REVIEW_HOST || "127.0.0.1",
  // 報告資料と台帳（reports.json）を置くディレクトリ
  REPORTS_DIR: path.resolve(process.env.REVIEW_DIR || path.join(APP_DIR, "reports")),
  CLAUDE_DIR: path.join(os.homedir(), ".claude"),
  TOKEN_FILE: path.join(APP_DIR, "data", "token.txt"),
  POLL_MS: 3000,
};
