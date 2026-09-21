---
name: submit-report
description: 作成した報告資料（md / Artifact 用 html）を Review Deck の台帳（reports.json）に登録し、ユーザがブラウザでレビューできるようにする。「報告を登録して」「レビューに出して」「report deck に載せて」「レビュー依頼」と言われたら、または報告資料を書き上げた周の締めで使う。
---

# submit-report: 報告を Review Deck に登録する

Review Deck は `<REPORTS_DIR>/reports.json`（台帳）を監視していて、エントリを追加すると
ブラウザの一覧に「未読」として並ぶ。ユーザは資料を開いて本文にコメントを付け、
`/review-comments <報告ID>` の形でこのセッションへレビューを返してくる（対応手順は review-comments skill）。

`REPORTS_DIR` は Review Deck の起動設定（環境変数 `REVIEW_DIR`、既定はリポジトリ内 `reports/`）。
分からなければユーザに確認するか、動いているサーバの起動ログ「報告ディレクトリ:」を見る。

## 手順

1. **資料を保存する**: md を `<REPORTS_DIR>/YYYY-MM-DD-<slug>.md` に置く。
   - ビジュアル版を作る場合は**同じ basename** で `<REPORTS_DIR>/YYYY-MM-DD-<slug>.html` に置く
     （同名の md/html は Review Deck が自動で「テキスト版 / ビジュアル版」として束ねる）。
   - mermaid 図は ```mermaid フェンス（md）または `<pre class="mermaid">`（html）で書く。
     Review Deck が図として描画し、ソース表示にも切り替えられる。
   - **画像・PDF を載せる場合**は `<REPORTS_DIR>/assets/<id>/` に**コピー**し、資料からは相対パスで参照する
     （Review Deck は `<REPORTS_DIR>` の外のファイルを配信しないので、絶対パスや他ディレクトリへの参照は表示されない）。
     - md: 画像は `![図1: キャプション](assets/<id>/fig.png)`、PDF は `![資料名](assets/<id>/doc.pdf)` を**1行で**書く
       （ビューアごと埋め込まれる。文中に書くとリンクになる）。alt はキャプションとして本文に出る。
     - html: `<img src="assets/<id>/fig.png">`。PDF は `<a href="assets/<id>/doc.pdf">` で張る
       （`<iframe>`/`<embed>` で埋め込んでも sandbox 内では表示できず「開く」カードに置き換わる）。
     - 使える形式: png / jpg / gif / webp / svg / pdf / mp4。
2. **Artifact 化する（任意）**: Artifact ツールで公開し URL を得る。更新時は**同じファイルパスで republish** して URL を保つ。
3. **台帳に登録する**: `<REPORTS_DIR>/reports.json`（無ければ `[]` で作る）に追記する:

   ```json
   {
     "id": "<slug>-<YYYYMMDD>",
     "title": "報告のタイトル",
     "date": "YYYY-MM-DD",
     "artifactUrl": "https://…（無ければ null）",
     "file": "YYYY-MM-DD-<slug>.md",
     "status": "unread",
     "review": null
   }
   ```

   - `id` は台帳内で一意にする。レビューが `/review-comments <id>` で返ってくるときの鍵。
   - `file` はファイル名のみ（パスを含めない）。md と html があるなら md を書く。
4. **ユーザに知らせる**: 登録した旨と、Review Deck の URL・報告タイトルを1行で伝える。

## 注意

- `status` を勝手に `read` にしない（既読にするのはユーザの操作）。
- レビュー対応で資料を更新したときだけ `status: "unread"` に戻し、`reviewResponse` に対応要約を書く（review-comments skill の手順）。
- コメントは同じ台帳の `comments: [...]` に Review Deck が書き込む。**手で消さない**。
- 台帳は JSON 配列。壊すと一覧が全部消えるので、編集後に `python3 -m json.tool` 等で構文を確認する
  （直前の内容は `<REPORTS_DIR>/.bak/` に30世代残る）。
