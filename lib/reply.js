import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getPpid } from "./sessions.js";

const exec = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// セッションのプロセスを含むペインを探す。
// claude をシェル経由で起動した場合は pane_pid == 親になるため、自分と先祖の両方を見る。
async function ancestors(pid, depth = 4) {
  const chain = [pid];
  let cur = pid;
  for (let i = 0; i < depth; i++) {
    try {
      const p = await getPpid(cur);
      if (!p || p === 1 || chain.includes(p)) break;
      chain.push(p);
      cur = p;
    } catch {
      break;
    }
  }
  return chain;
}

export async function findPane(pid) {
  const chain = await ancestors(pid);
  let out;
  try {
    // pane_id（%12 のような不変ID）を使う。session:window.pane はペインが閉じると
    // 番号が振り直されるため、別ペインへ送ってしまう危険がある。
    ({ stdout: out } = await exec("tmux", [
      "list-panes",
      "-a",
      "-F",
      "#{pane_pid}\t#{pane_id}\t#{session_name}:#{window_index}.#{pane_index}\t#{pane_current_command}",
    ]));
  } catch {
    return null; // tmux なし / server 不在
  }
  const panes = out.split("\n").filter(Boolean).map((l) => l.split("\t"));
  // 近い先祖から順に探す（遠い先祖が別セッションのペインに当たる誤爆を防ぐ）
  for (const pidInChain of chain) {
    const hit = panes.find((p) => Number(p[0]) === pidInChain);
    if (hit) return { target: hit[1], label: hit[2], cmd: hit[3] };
  }
  return null;
}

// tmux send-keys で claude の入力欄へテキストを注入する。
// -l でリテラル送信、Enter は別送。
export async function sendReply(pid, text) {
  const pane = await findPane(pid);
  if (!pane) {
    return { ok: false, code: 409, reason: "tmuxペインが見つかりません（tmux外セッション）。ターミナルで直接貼り付けてください。" };
  }
  if (pane.cmd !== "claude") {
    return { ok: false, code: 409, reason: `ペイン ${pane.label || pane.target} の前面プロセスが claude ではありません (${pane.cmd})。` };
  }
  const normalized = String(text).replace(/\r/g, "").replace(/[ \t]+$/gm, "").trim();
  if (!normalized) return { ok: false, code: 400, reason: "空のメッセージは送れません。" };
  // 複数行はブラケットペーストで送る（改行をそのまま届ける。素で送ると改行で送信されてしまう）
  const payload = normalized.includes("\n") ? `\x1b[200~${normalized}\x1b[201~` : normalized;
  await exec("tmux", ["send-keys", "-t", pane.target, "-l", "--", payload]);
  await sleep(250);
  await exec("tmux", ["send-keys", "-t", pane.target, "Enter"]);
  return { ok: true, pane: pane.label || pane.target };
}
