# Review Deck

Claude Code が書いた報告資料（md / Artifact 用 html）をブラウザで読み、本文に部分コメントを付けて、
**そのままレビューを書いたセッションへ返す**ための最小構成ビューア。
[agent-deck](../agent-deck) からレビュー機能だけを抽出したもの。依存ゼロ（Node 標準ライブラリのみ）。

## 起動

```bash
node server.js          # ローカルのみ → http://127.0.0.1:8788/
npm run start:lan       # 同一ネットワーク（スマホ）からも → 起動ログの URL を開く（トークン認証が自動で有効）
```

環境変数:

| 変数 | 既定 | 意味 |
|---|---|---|
| `REVIEW_PORT` | `8788` | ポート |
| `REVIEW_HOST` | `127.0.0.1` | バインド先。`0.0.0.0` でトークン認証が有効になる |
| `REVIEW_DIR` | `./reports` | 報告資料と台帳（`reports.json`）を置くディレクトリ |
| `REVIEW_TOKEN` | 自動生成（`data/token.txt`） | LAN 公開時のトークン固定用 |

**このアプリは tmux にキーを送れる**（レビュー送信）。信頼できるネットワークでのみ公開すること。

## ワークフロー

1. Claude Code のセッションが報告資料を書き、`<REVIEW_DIR>/reports.json` に `status: "unread"` で登録する
   （規約は同梱の **submit-report skill**）。一覧に「未読」として並ぶ。
   - 既読セクションは見出しの「隠す / 表示する」ボタンで折りたためる（選択は localStorage に保存）。
2. 「📄 資料を開く」でサイドピークに表示する。
   - **本文をドラッグ選択すると「💬 コメントする」が出る**。コメントした箇所は黄色くハイライトされ、
     右のマージンに一覧が並ぶ（編集・対応済み・削除・すべて対応済み）。
   - ハイライトはテキストノード単位で囲むので、`<strong>` や表のセルをまたぐ選択でも付く。
     閉じて開き直しても復元される（空白ゆらぎ・先頭一致で追従）。
   - 同じ報告に **md と html が両方ある場合**、ヘッダのボタンで切り替えられる（同じ basename を自動で束ねる）。
     html は sandbox 付き iframe でそのまま描画し、中の文字を選択してコメントできる。
   - **mermaid 図は既定で図として描画**され、「📝 図をソースで見る」でソース表示に切り替えられる
     （図の中身にコメントを付けたいとき用）。mermaid はローカル同梱なのでオフラインでも動く。
   - マージン下部の「報告全体へのコメント」で全体所見も書ける（保存すると既読になる）。
3. **「レビューを Claude に返す」**: 未対応コメントを `/review-comments <報告ID>` 形式
   （`@ 位置` / `| 引用` / `→ コメント`）にまとめ、送り先セッションを選んで tmux ペインへ注入する。
   - 送り先は**その資料を書いたセッションが自動で選ばれる**（サブエージェント作ならその親）。
     transcript を走査して特定し、結果は台帳の `origin` に焼き付けるので走査は報告1件につき1回。
   - 送れた時点で既読になる（コメントを書いただけでは未読のまま）。
4. 受け取った側は **review-comments skill** の手順で対応し、資料を直したら台帳を `unread` に戻す
   （`reviewResponse` に対応要約が入り、一覧に「↻ レビュー反映済み」が付く）。

## 同梱している skill

```
skills/review-comments/SKILL.md   レビューコメントを受け取って対応する手順（受信側）
skills/submit-report/SKILL.md     報告資料を台帳に登録する手順（送信側）
```

新しい環境で使うときは次のリンクを張る:

```bash
ln -s "$PWD/skills/review-comments" ~/.claude/skills/review-comments
ln -s "$PWD/skills/submit-report" ~/.claude/skills/submit-report
```

※ agent-deck の `review-comments` skill を既にリンクしている場合は名前が衝突する。
どちらの台帳を使うかで片方だけリンクすること（メッセージに台帳パスが入るので、
このリポジトリ版の skill は agent-deck から来たレビューもおおむね解釈できる）。

## 台帳（reports.json）の形式

```json
[
  {
    "id": "sample-20260813",
    "title": "報告のタイトル",
    "date": "2026-08-13",
    "artifactUrl": "https://…（無ければ null）",
    "file": "2026-08-13-sample.md",
    "status": "unread",
    "review": null,
    "comments": [
      { "id": "c…", "quote": "引用文", "text": "コメント", "resolved": false,
        "occurrence": 1, "occurrenceTotal": 1, "loc": { "file": "…", "line": 12 } }
    ],
    "origin": { "sessionId": "…", "agentId": null },
    "reviewResponse": "2026-08-13 指摘3件に対応（…）"
  }
]
```

`comments` と `origin` はこのアプリが書き込む。書き換え前の内容は `reports/.bak/` に30世代退避される。

## 構成

```
server.js           HTTP / SSE / 更新ループ（fs.watch + 3s ポーリング）
lib/config.js       定数（パス・ポート）
lib/reports.js      報告台帳の読み書き（コメント・既読・origin・バックアップ）
lib/quoteLocate.js  引用文 → 資料の「ファイル:行」解決（空白ゆらぎ・複数出現対応）
lib/reportOrigin.js 資料を書いたセッションの特定（transcript の Write 記録から）
lib/sessions.js     ~/.claude/sessions スキャナ + /proc 生死判定
lib/reply.js        tmux send-keys によるレビュー注入（ブラケットペースト）
public/index.html   一覧 + サイドピーク + コメント UI（1枚完結）
public/vendor/      mermaid（ローカル同梱）
```

## API

- `GET /api/state` — 報告一覧 + 生きているセッション（SSE `/events` と同形）
- `GET /api/report-file?file=<name>.md` — 報告資料を取得（報告ディレクトリ配下のみ）
- `POST /api/report {id, status?|review?}` — 既読/未読・全体レビュー更新
- `POST /api/report/comment {id, quote, text, ...}` — コメント追加（`action: edit|resolve|delete|resolve-all|locate` で操作）
- `GET /api/report-origin?id=...` — 資料を書いたセッションを特定（台帳にキャッシュ）
- `POST /api/reply {sessionId, text}` — tmux ペインへレビュー注入（ペイン不明時 409）
