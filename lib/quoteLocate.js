import fs from "node:fs/promises";
import path from "node:path";

// 引用文が資料のどこかを「ファイル:行」で特定する。
// 同じ文言が複数ある資料では引用だけでは箇所が定まらないので、
// ブラウザ側が数えた occurrence（本文の何個目の出現か）で絞り込む。

// 行から markdown / html の飾りを落として、地の文だけにする
function stripMarkup(line, kind) {
  let s = line;
  if (kind === "html") s = s.replace(/<[^>]*>/g, " ");
  return s
    .replace(/^\s{0,3}#{1,6}\s+/, "")
    .replace(/^\s{0,3}>\s?/, "")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\*\*|__|~~|[*_`]/g, "")
    .replace(/\|/g, " ");
}

const norm = (s) => s.replace(/\s+/g, " ").trim();
// 照合用は空白を全部落とす。ブラウザの選択（タグを跨ぐと空白が入らない）と
// ソース（タグ・改行・インデントで空白が入る）のゆらぎを吸収するため
const squash = (s) => s.replace(/\s+/g, "");

// 全行を1本のテキストに畳みつつ、各文字がどの行から来たかを覚えておく
function flatten(text, kind) {
  const lines = text.split("\n");
  let flat = "";
  const lineOf = [];
  for (let i = 0; i < lines.length; i++) {
    const piece = squash(stripMarkup(lines[i], kind));
    if (!piece) continue;
    // サロゲートペアで行対応がずれないよう、コードポイントではなく UTF-16 単位で数える
    for (let k = 0; k < piece.length; k++) lineOf.push(i + 1);
    flat += piece;
  }
  return { flat, lineOf, lines };
}

// 一致した位置の直前にある見出しを拾う（「どの節の話か」を人が読んで分かるように）
function headingAbove(lines, lineNo, kind) {
  for (let i = Math.min(lineNo, lines.length) - 1; i >= 0; i--) {
    const raw = lines[i];
    const md = /^\s{0,3}(#{1,6})\s+(.+?)\s*$/.exec(raw);
    if (md) return { level: md[1].length, text: norm(stripMarkup(md[2], kind)) };
    const html = /<h([1-6])[^>]*>(.*?)<\/h\1>/i.exec(raw);
    if (html) return { level: Number(html[1]), text: norm(html[2].replace(/<[^>]*>/g, "")) };
  }
  return null;
}

// 報告資料のうち行番号を返す対象。html しか無ければ html を使うが、md があればそちらを優先する
async function pickSource(dir, file) {
  const base = String(file || "").replace(/\.(md|html?)$/i, "");
  if (!base) return null;
  for (const name of [`${base}.md`, file]) {
    if (!name) continue;
    try {
      const full = path.join(dir, path.basename(name));
      return { file: path.basename(name), text: await fs.readFile(full, "utf8"), kind: /\.html?$/i.test(name) ? "html" : "md" };
    } catch {
      /* 次の候補へ */
    }
  }
  return null;
}

/**
 * @returns {{file,line,endLine,total,occurrence,heading,exact}|null}
 */
export async function locateQuote(dir, file, quote, occurrence = 1) {
  const raw = squash(String(quote || ""));
  if (raw.length < 2) return null;
  const src = await pickSource(dir, file);
  if (!src) return null;
  const { flat, lineOf, lines } = flatten(src.text, src.kind);

  // 完全一致で見つからなければ、先頭だけで引き直す（資料が少し編集されていても効く）
  const cands = raw.length >= 16 ? [raw, raw.slice(0, 24), raw.slice(0, 12)] : [raw];
  for (const cand of cands) {
    const hits = [];
    for (let from = 0; ; ) {
      const at = flat.indexOf(cand, from);
      if (at < 0) break;
      hits.push(at);
      from = at + 1;
    }
    if (!hits.length) continue;
    const idx = Math.min(Math.max(1, Number(occurrence) || 1), hits.length) - 1;
    const at = hits[idx];
    const line = lineOf[at] || 1;
    const endLine = lineOf[Math.min(at + cand.length - 1, lineOf.length - 1)] || line;
    return {
      file: src.file,
      line,
      endLine,
      total: hits.length,
      occurrence: idx + 1,
      heading: headingAbove(lines, line, src.kind)?.text || null,
      exact: cand === raw,
    };
  }
  return null;
}
