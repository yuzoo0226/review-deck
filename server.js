import http from "node:http";
import os from "node:os";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG } from "./lib/config.js";
import { scanSessions } from "./lib/sessions.js";
import { sendReply } from "./lib/reply.js";
import { readReports, updateReport, addComment, mutateComment, setCommentLoc, setReportOrigin, ledgerPath } from "./lib/reports.js";
import { findReportOrigin } from "./lib/reportOrigin.js";
import { locateQuote } from "./lib/quoteLocate.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// LAN 公開時（127.0.0.1 以外にバインド）はトークン必須。
// このアプリは tmux へキー送信できるので、無認証で外に出さない。
const LAN_MODE = CONFIG.HOST !== "127.0.0.1" && CONFIG.HOST !== "localhost";
// 再起動してもブックマークが切れないよう、生成したトークンは保存して使い回す
function persistentToken() {
  try {
    const t = fs.readFileSync(CONFIG.TOKEN_FILE, "utf8").trim();
    if (t) return t;
  } catch {
    /* 初回 */
  }
  const t = crypto.randomBytes(8).toString("hex");
  fs.mkdirSync(path.dirname(CONFIG.TOKEN_FILE), { recursive: true });
  fs.writeFileSync(CONFIG.TOKEN_FILE, t + "\n", { mode: 0o600 });
  return t;
}
const TOKEN = process.env.REVIEW_TOKEN || (LAN_MODE ? persistentToken() : null);

function cookieToken(header = "") {
  const m = header.match(/(?:^|;\s*)reviewtoken=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}
function isAuthed(req, url) {
  if (!LAN_MODE) return true;
  return (url.searchParams.get("token") || cookieToken(req.headers.cookie)) === TOKEN;
}
function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === "IPv4" && !i.internal)
    .map((i) => i.address);
}

/* ---------- 状態（報告一覧 + 生きているセッション） ---------- */
let currentState = null;
let lastComparable = "";
const sseClients = new Set();

function broadcast(state) {
  const payload = `event: state\ndata: ${JSON.stringify(state)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch {
      sseClients.delete(res);
    }
  }
}

let refreshing = false;
async function refresh() {
  if (refreshing) return; // 直列実行（並行I/O競合を作らない）
  refreshing = true;
  try {
    const [reports, sessions] = await Promise.all([
      readReports(CONFIG.REPORTS_DIR),
      scanSessions(CONFIG.CLAUDE_DIR),
    ]);
    const state = {
      generatedAt: Date.now(),
      reportsDir: CONFIG.REPORTS_DIR,
      ledger: ledgerPath(CONFIG.REPORTS_DIR),
      reports,
      sessions,
    };
    const comparable = JSON.stringify({ ...state, generatedAt: 0 });
    if (comparable !== lastComparable) {
      lastComparable = comparable;
      currentState = state;
      broadcast(state);
    } else {
      currentState = state;
    }
  } catch (e) {
    console.error("refresh failed:", e);
  } finally {
    refreshing = false;
  }
}

const getSession = (sessionId) => (currentState?.sessions || []).find((s) => s.sessionId === sessionId);

// fs.watch は dirty → debounce 付き refresh のみ（イベント内でI/Oしない）
function watchDir(dir, debounceMs) {
  try {
    let timer = null;
    fs.watch(dir, () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(refresh, debounceMs);
    });
  } catch (e) {
    console.error(`watch failed for ${dir}:`, e.message);
  }
}

function json(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) {
    chunks.push(c);
    if (chunks.reduce((n, b) => n + b.length, 0) > 1e6) throw new Error("body too large");
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  try {
    if (!isAuthed(req, url)) {
      res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<meta charset="utf-8"><body style="font-family:sans-serif;padding:2em;line-height:1.7">
        <h2>🔒 トークンが必要です</h2>
        <p>サーバ起動時にターミナルへ表示された URL（<code>?token=…</code> 付き）を開いてください。</p></body>`);
      return;
    }

    if (req.method === "GET" && url.pathname === "/") {
      const html = await fsp.readFile(path.join(__dirname, "public", "index.html"), "utf8");
      const headers = { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" };
      // 以後の API 呼び出し・SSE でトークンを持ち回れるよう Cookie に載せる
      if (LAN_MODE && url.searchParams.get("token") === TOKEN) {
        headers["Set-Cookie"] = `reviewtoken=${encodeURIComponent(TOKEN)}; Path=/; Max-Age=31536000; SameSite=Lax`;
      }
      res.writeHead(200, headers);
      res.end(html);
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/vendor/")) {
      const name = path.basename(url.pathname); // ディレクトリ外は basename で遮断
      try {
        const body = await fsp.readFile(path.join(__dirname, "public", "vendor", name));
        res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "max-age=86400" });
        res.end(body);
      } catch {
        json(res, 404, { error: "not found" });
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/state") {
      if (!currentState) await refresh();
      json(res, 200, currentState);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/report-file") {
      // 報告ディレクトリ配下の md / html のみ（ディレクトリ外は basename で遮断）
      const name = path.basename(url.searchParams.get("file") || "");
      if (!/\.(md|html?)$/i.test(name)) return json(res, 400, { error: "md / html のみ参照できます" });
      try {
        const body = await fsp.readFile(path.join(CONFIG.REPORTS_DIR, name), "utf8");
        json(res, 200, { file: name, kind: /\.html?$/i.test(name) ? "html" : "md", markdown: body });
      } catch {
        json(res, 404, { error: `見つかりません: ${name}` });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/report/comment") {
      const { id, anchorIndex, quote, text, kind, commentId, action, occurrence, occurrenceTotal, heading } = await readBody(req);
      // 同じ文言が複数ある資料でも箇所が一意に伝わるよう、「ファイル:行」を台帳に焼き付ける
      const report = (currentState?.reports || []).find((r) => r.id === id);
      const resolveLoc = async (q) =>
        report?.file ? await locateQuote(CONFIG.REPORTS_DIR, report.file, q, occurrence).catch(() => null) : null;
      let result;
      if (action === "locate") {
        // 位置を持たない既存コメント用（ビューが囲めた場所から後追いで付ける）
        const c = report?.comments?.find((x) => x.id === commentId);
        result = c
          ? await setCommentLoc(CONFIG.REPORTS_DIR, id, commentId, {
              loc: await resolveLoc(c.quote), occurrence, occurrenceTotal, heading,
            })
          : null;
      } else if (action) {
        result = await mutateComment(CONFIG.REPORTS_DIR, id, commentId, action, text);
      } else {
        result = await addComment(CONFIG.REPORTS_DIR, id, {
          anchorIndex, quote, text, kind, occurrence, occurrenceTotal, heading, loc: await resolveLoc(quote),
        });
      }
      if (!result) return json(res, 400, { error: "コメントを保存できませんでした（本文または引用が空、または対象が見つかりません）" });
      json(res, 200, { ok: true, result });
      refresh();
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/report") {
      const { id, status, review } = await readBody(req);
      const updated = await updateReport(CONFIG.REPORTS_DIR, id, { status, review });
      if (!updated) return json(res, 404, { error: `report not found: ${id}` });
      json(res, 200, { ok: true, report: updated });
      refresh();
      return;
    }

    // 報告資料を書いたセッション（サブエージェントが書いた場合はその親）を特定する。
    // 一度特定したら台帳に焼き付けるので、transcript の走査は報告1件につき1回。
    if (req.method === "GET" && url.pathname === "/api/report-origin") {
      const id = url.searchParams.get("id") || "";
      const report = (currentState?.reports || []).find((r) => r.id === id);
      if (!report) return json(res, 404, { error: "報告が見つかりません" });
      let origin = report.origin || null;
      if (!origin) {
        origin = await findReportOrigin(CONFIG.CLAUDE_DIR, CONFIG.REPORTS_DIR, report);
        if (origin) await setReportOrigin(CONFIG.REPORTS_DIR, id, origin);
      }
      const live = origin ? getSession(origin.sessionId) : null;
      json(res, 200, { origin, alive: !!live, name: live?.name || null });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/reply") {
      const { sessionId, text } = await readBody(req);
      if (!currentState) await refresh();
      const session = getSession(sessionId);
      if (!session) return json(res, 404, { error: "セッションが見つかりません（終了した可能性）" });
      const result = await sendReply(session.pid, text);
      if (!result.ok) return json(res, result.code, { error: result.reason });
      json(res, 200, { ok: true, pane: result.pane });
      return;
    }

    if (req.method === "GET" && url.pathname === "/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write("retry: 3000\n\n");
      if (!currentState) await refresh();
      if (currentState) res.write(`event: state\ndata: ${JSON.stringify(currentState)}\n\n`);
      sseClients.add(res);
      req.on("close", () => sseClients.delete(res));
      return;
    }

    json(res, 404, { error: "not found" });
  } catch (e) {
    json(res, 500, { error: e.message });
  }
});

fs.mkdirSync(CONFIG.REPORTS_DIR, { recursive: true });
watchDir(CONFIG.REPORTS_DIR, 500);
watchDir(path.join(CONFIG.CLAUDE_DIR, "sessions"), 300);
setInterval(refresh, CONFIG.POLL_MS);
setInterval(() => {
  for (const res of sseClients) {
    try {
      res.write(": ping\n\n");
    } catch {
      sseClients.delete(res);
    }
  }
}, 25000);

server.listen(CONFIG.PORT, CONFIG.HOST, () => {
  console.log(`Review Deck: http://${CONFIG.HOST}:${CONFIG.PORT}/`);
  console.log(`報告ディレクトリ: ${CONFIG.REPORTS_DIR}`);
  if (LAN_MODE) {
    console.log("\n📱 同一ネットワークからは以下を開いてください（トークン必須）:");
    for (const ip of lanAddresses()) console.log(`   http://${ip}:${CONFIG.PORT}/?token=${TOKEN}`);
    console.log(`\n   トークン: ${TOKEN}（固定したい場合は REVIEW_TOKEN 環境変数で指定）`);
    console.log("   ※ このアプリは tmux にキーを送れるため、信頼できるネットワークでのみ公開すること\n");
  }
});
refresh();
