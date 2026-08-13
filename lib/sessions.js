import fs from "node:fs/promises";
import path from "node:path";

// ~/.claude/sessions/<PID>.json を走査して、生きている Claude Code セッションを列挙する。
// レビューの送り先（tmux ペイン）を選ぶためだけに使う。

// /proc/<pid>/stat の comm 括弧対策: 最後の ')' 以降を分割。starttime は分割後 index 19
async function readProcStat(pid) {
  const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
  const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  return { state: rest[0], ppid: rest[1], starttime: rest[19] };
}

export async function isAlive(pid, procStart) {
  try {
    const { starttime } = await readProcStat(pid);
    return !procStart || starttime === String(procStart);
  } catch {
    return false;
  }
}

export async function getPpid(pid) {
  const { ppid } = await readProcStat(pid);
  return Number(ppid);
}

export async function scanSessions(claudeDir) {
  const dir = path.join(claudeDir, "sessions");
  const sessions = [];
  let files = [];
  try {
    files = await fs.readdir(dir);
  } catch {
    return sessions;
  }
  for (const f of files.filter((f) => f.endsWith(".json"))) {
    try {
      const raw = JSON.parse(await fs.readFile(path.join(dir, f), "utf8"));
      if (!raw.pid || !raw.sessionId) continue;
      // `claude -p` などプログラム実行のセッションはターミナルの部屋ではないので除外する
      if (raw.entrypoint && raw.entrypoint !== "cli") continue;
      if (!(await isAlive(raw.pid, raw.procStart))) continue;
      sessions.push({
        pid: raw.pid,
        sessionId: raw.sessionId,
        cwd: raw.cwd,
        name: raw.name || raw.sessionId.slice(0, 8),
        status: raw.status || "idle", // busy | idle | waiting
      });
    } catch {
      /* 壊れた/消えたファイルはスキップ */
    }
  }
  return sessions;
}
