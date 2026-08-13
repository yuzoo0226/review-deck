import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";

const exec = promisify(execFile);

// 報告資料を「誰が書いたか」を transcript から特定する。
// レビューを返す送り先を自動で選ぶために使う。台帳に書き戻してキャッシュするので、
// 走査が走るのは報告1件につき最初の1回だけ。
//
// 資料はサブエージェント（報告書係）が書くことが多いので、
// <projects>/<dir>/<親セッションID>/subagents/agent-*.jsonl も対象にし、
// 見つかったら親セッションを返す（返信は親セッションのペインに送るため）。

const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

// パスから {sessionId, agentId} を取り出す
function idsFromPath(projectsDir, file) {
  const rel = path.relative(projectsDir, file);
  const parts = rel.split(path.sep);
  // <dir>/<sessionId>.jsonl
  if (parts.length === 2 && parts[1].endsWith(".jsonl")) {
    return { projectDir: parts[0], sessionId: parts[1].replace(/\.jsonl$/, ""), agentId: null };
  }
  // <dir>/<sessionId>/subagents/agent-<agentId>.jsonl
  if (parts.length === 4 && parts[2] === "subagents") {
    return {
      projectDir: parts[0],
      sessionId: parts[1],
      agentId: parts[3].replace(/^agent-/, "").replace(/\.jsonl$/, ""),
    };
  }
  return null;
}

// その transcript が「この資料を書いた」記録を持つか（単に言及しただけと区別する）。
// 最初に書いた時刻を返す（後から他のセッションが触っても、作った人の手柄を奪わないため）。
async function firstWriteAt(file, needle) {
  let lines = "";
  try {
    const { stdout } = await exec("grep", ["-F", "-m", "80", "--", needle, file], { maxBuffer: 8 * 1024 * 1024 });
    lines = stdout;
  } catch {
    return null; // マッチ 0 件でも grep は非0を返す
  }
  let first = null;
  for (const line of lines.split("\n")) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const content = rec.message?.content;
    if (rec.type !== "assistant" || !Array.isArray(content)) continue;
    for (const b of content) {
      if (b.type !== "tool_use") continue;
      const input = b.input || {};
      const wrote = (WRITE_TOOLS.has(b.name) && String(input.file_path || "").includes(needle))
        // ヒアドキュメントや python でファイルを書く場合もある
        || (b.name === "Bash" && String(input.command || "").includes(needle));
      if (!wrote) continue;
      const ts = Date.parse(rec.timestamp || "") || 0;
      if (first === null || ts < first) first = ts;
    }
  }
  return first;
}

export async function findReportOrigin(claudeDir, reportsDir, report) {
  if (!report.file) return null;
  const projectsDir = path.join(claudeDir, "projects");
  const grepFiles = async (needle) => {
    try {
      const { stdout } = await exec("grep", ["-rlF", "--include=*.jsonl", "--", needle, projectsDir],
        { maxBuffer: 4 * 1024 * 1024, timeout: 60000 });
      return stdout.split("\n").filter(Boolean);
    } catch {
      return [];
    }
  };
  // まず絶対パスで探し、見つからなければファイル名だけで探す
  // （別の場所で作ってから移動した資料もあるため）
  let needle = path.join(reportsDir, report.file);
  let files = await grepFiles(needle);
  if (!files.length) {
    needle = report.file;
    files = await grepFiles(needle);
  }
  if (!files.length) return null;

  const cands = [];
  for (const f of files) {
    const ids = idsFromPath(projectsDir, f);
    if (!ids) continue;
    let mtimeMs = 0;
    try {
      mtimeMs = (await fs.stat(f)).mtimeMs;
    } catch {
      /* 消えた */
    }
    cands.push({ ...ids, file: f, mtimeMs, wroteAt: await firstWriteAt(f, needle) });
  }
  if (!cands.length) return null;

  // 「実際に書いた」記録がある方を優先し、その中では最初に書いた人（＝作成者）を採る。
  // 書いた記録が無いもの同士は、新しく触った方を採る。
  cands.sort((a, b) =>
    (b.wroteAt ? 1 : 0) - (a.wroteAt ? 1 : 0)
    || (a.wroteAt && b.wroteAt ? a.wroteAt - b.wroteAt : b.mtimeMs - a.mtimeMs));
  const best = cands[0];
  return {
    sessionId: best.sessionId,
    agentId: best.agentId,
    projectDir: best.projectDir,
    matchedBy: best.wroteAt ? "write" : "mention",
    foundAt: new Date().toISOString(),
  };
}
