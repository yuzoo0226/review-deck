import fs from "node:fs/promises";
import path from "node:path";

// 報告台帳: <REPORTS_DIR>/reports.json
// entry: { id, title, date, artifactUrl, file,
//          status: "unread"|"read", review: string|null, reviewedAt,
//          comments: [...], origin: {...}, reviewResponse }
// 登録は報告を書いた Claude セッションが行い、status/review はこのアプリから更新する。

export const ledgerPath = (reportsDir) => path.join(reportsDir, "reports.json");

export async function readReports(reportsDir) {
  try {
    const list = JSON.parse(await fs.readFile(ledgerPath(reportsDir), "utf8"));
    if (!Array.isArray(list)) return [];
    // 同じ報告の別形式（テキスト版 .md / ビジュアル版 .html）を拾って一緒に返す
    let dirFiles = [];
    try {
      dirFiles = await fs.readdir(reportsDir);
    } catch {
      /* 一覧が取れなくても致命的ではない */
    }
    for (const r of list) {
      const base = String(r.file || "").replace(/\.(md|html?)$/i, "");
      r.variants = base
        ? dirFiles.filter((f) => f.replace(/\.(md|html?)$/i, "") === base)
            .map((f) => ({ file: f, kind: /\.html?$/i.test(f) ? "html" : "md" }))
            .sort((a, b) => (a.kind === "md" ? -1 : 1))
        : [];
    }
    return list.sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
  } catch {
    return [];
  }
}

export async function updateReport(reportsDir, id, patch) {
  const list = await readJson(reportsDir);
  const r = list?.find((x) => x.id === id);
  if (!r) return null;
  if (patch.status === "read" || patch.status === "unread") r.status = patch.status;
  if (typeof patch.review === "string") {
    r.review = patch.review.trim() || null;
    r.reviewedAt = r.review ? new Date().toISOString() : null;
    if (r.review) r.status = "read"; // レビューを書いたら既読
  }
  await writeJson(reportsDir, list);
  return r;
}

// 報告資料の「部分コメント」。引用文で本文に紐づける。
// occurrence = 同じ文言が資料内に複数あるときの「何個目か」。loc = {file,line,...}（quoteLocate が解決した位置）
export async function addComment(reportsDir, id, { anchorIndex, quote, text, occurrence, occurrenceTotal, heading, loc }) {
  const list = await readJson(reportsDir);
  const r = list?.find((x) => x.id === id);
  if (!r) return null;
  if (!Array.isArray(r.comments)) r.comments = [];
  const comment = {
    id: `c${Date.now().toString(36)}`,
    anchorIndex: Number(anchorIndex) || 0,
    quote: String(quote || "").slice(0, 120),
    text: String(text || "").trim(),
    occurrence: Number(occurrence) > 0 ? Number(occurrence) : 1,
    occurrenceTotal: Number(occurrenceTotal) > 0 ? Number(occurrenceTotal) : 1,
    heading: heading ? String(heading).slice(0, 120) : null,
    loc: loc || null,
    createdAt: new Date().toISOString(),
    resolved: false,
  };
  if (!comment.text) return null;
  r.comments.push(comment);
  // コメントを書いただけでは既読にしない。Claude にレビューを返した時点で既読になる
  await writeJson(reportsDir, list);
  return r.comments;
}

// 位置情報を持たない既存コメントに、あとから「ファイル:行」を焼き付ける
export async function setCommentLoc(reportsDir, id, commentId, { loc, occurrence, occurrenceTotal, heading }) {
  const list = await readJson(reportsDir);
  const c = list?.find((x) => x.id === id)?.comments?.find((x) => x.id === commentId);
  if (!c) return null;
  c.loc = loc || null;
  if (Number(occurrence) > 0) c.occurrence = Number(occurrence);
  if (Number(occurrenceTotal) > 0) c.occurrenceTotal = Number(occurrenceTotal);
  if (heading && !c.heading) c.heading = String(heading).slice(0, 120);
  await writeJson(reportsDir, list);
  return list.find((x) => x.id === id).comments;
}

export async function mutateComment(reportsDir, id, commentId, action, text) {
  const list = await readJson(reportsDir);
  const r = list?.find((x) => x.id === id);
  if (!r?.comments) return null;
  if (action === "resolve-all") {
    for (const c of r.comments) c.resolved = true;
    await writeJson(reportsDir, list);
    return r.comments;
  }
  const i = r.comments.findIndex((c) => c.id === commentId);
  if (i < 0) return null;
  if (action === "delete") r.comments.splice(i, 1);
  else if (action === "resolve") r.comments[i].resolved = !r.comments[i].resolved;
  else if (action === "edit") {
    const t = String(text || "").trim();
    if (!t) return null;
    r.comments[i].text = t;
    r.comments[i].editedAt = new Date().toISOString();
  }
  await writeJson(reportsDir, list);
  return r.comments;
}

// 「この資料を書いたのは誰か」を台帳に焼き付ける（transcript の走査は報告1件につき1回で済む）
export async function setReportOrigin(reportsDir, id, origin) {
  const list = await readJson(reportsDir);
  const r = list?.find((x) => x.id === id);
  if (!r) return null;
  r.origin = origin; // {sessionId, agentId, projectDir, matchedBy, foundAt}
  await writeJson(reportsDir, list);
  return r.origin;
}

async function readJson(reportsDir) {
  try {
    return JSON.parse(await fs.readFile(ledgerPath(reportsDir), "utf8"));
  } catch {
    return null;
  }
}
async function writeJson(reportsDir, list) {
  await backupLedger(reportsDir);
  await fs.writeFile(ledgerPath(reportsDir), JSON.stringify(list, null, 2) + "\n");
}

// 台帳を書き換える前に、直前の内容を .bak/ に退避する（誤削除からの復旧用・30世代）
async function backupLedger(reportsDir) {
  const src = ledgerPath(reportsDir);
  const dir = path.join(reportsDir, ".bak");
  try {
    const body = await fs.readFile(src, "utf8");
    await fs.mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    await fs.writeFile(path.join(dir, `reports-${stamp}.json`), body);
    const files = (await fs.readdir(dir)).filter((f) => f.startsWith("reports-")).sort();
    for (const old of files.slice(0, Math.max(0, files.length - 30))) {
      await fs.unlink(path.join(dir, old)).catch(() => {});
    }
  } catch {
    /* 台帳がまだ無い場合は何もしない */
  }
}
