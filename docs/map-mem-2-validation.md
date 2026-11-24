# MEM-2 検証記録

検証日 2026-11-24。基準は `cd1ffca5474902b7b90381e598f0741737e482f7`。一時Rootに作った合成データを使い、Linux上のNode.js 24.22.3、SQLite 3.54.1、Chromiumで確認した。実Providerへの送信は0件。

## 再現コマンド

履歴互換試験は過去にリリースしたコミットから旧版を展開する。Git履歴を取得したチェックアウトで実行する。ブラウザ試験はビルド出力を使う。Chromiumは `CHROMIUM_PATH` で指定できる。

```bash
npm ci
npm run typecheck
npm run build
npm test
npm run test:search
npm run test:app-data-browser
npm run test:memory-browser
npm run test:search-browser
MAP_SEARCH_BENCH_MESSAGES=100000 MAP_SEARCH_BENCH_TRIALS=30 npm run bench:search
npm run bench:search-coexist -- 100000 10
```

## 受入試験

| 対象 | 確認した境界・条件 |
| --- | --- |
| S-01～S-06、S-08 | ログインしたHTTPクライアントから二つの検索対象を切替。11月11日に弱い一致が110件あるRoomで、前後7暦日を指定すると11月5日と9日の原文を取得。厳密指定では11日のみ。テスト実行日に登録・訂正した資料も元の `occurredAt` を使用。 |
| S-07、S-09～S-11 | IANA暦日の23時間・25時間の日、月末・年末・閏日、不正日付。206版を超える会話履歴の走査。全半角、1～2文字、ID、英日混在、後半だけのヒット。絵文字・CRLF・結合文字を含む原文のUTF-16範囲と引用を照合。 |
| R-01～R-04 | 同じMessageに属するpublic/private Segment、privateだけの発言、別Persona・Room、共有ノートのみ読めるActor。SQLiteと参照Backendに共通の試験を適用し、権限外候補によるTop-Kの押出しを検査。 |
| R-05～R-09 | 検索中の権限撤回、送信Intent確定直後の権限・Profile・原文変更、Watcherより先に行われたVault編集、未反映の訂正・削除。偽の権限を書いたfrontmatterでも元のScopeが保たれる。Profileなしで保存・検索しても外部送信は0件。 |
| C-01～C-05、C-08 | 同じページの再送、同一TransactionでのCursor確定、初回途中の削除と訂正、実プロセスの異常終了と再起動、旧世代への切戻し、索引消去後の引用再現。SQLiteの書込みロックと `max_page_count` を使って容量不足を発生させ、原本と旧Cursorを確認。 |
| C-06、C-07 | 予算予約確定直後・送信Intent確定直後・模擬Provider呼出し中のプロセス終了、重複操作の再照会、結果不明の予約保持。復元後のProfile停止、費用台帳と復元記録の照合、旧世代・Cursorの無効化。 |
| P-01～P-04 | Denseの件数・バイト数を独立して超過させ、Query送信を止める。有効な実プロセスIDを使って取消後の終了を確認。非有限・ゼロ・次元違いのVectorを拒否。保存とCOORD heartbeatの共存は下記のHTTP測定。 |
| B-01、B-02 | ログイン済みChromiumでprivate原文を検索・展開。Room変更後の遅延応答、再読込、再同期、他タブからのログアウトを検査。ブラウザのストレージ・キャッシュ、Service Worker、配信bundle、外部リクエストを確認。 |
| 旧版互換 | App Schema 1～4から5への移行、再起動による二重適用防止、旧Backup形式の読取り、MEM-1の系譜・実使用権限・公開状態の回帰。PR #39のF-01～F-07を含む。 |

通常試験、検索専用試験、Browser試験は一部で同じ振る舞いを検証する。件数はコマンドごとに読む。

| コマンド | 結果 |
| --- | --- |
| `npm test`（既定の並列度2） | 2,260件成功、失敗・Skip各0件、439.75秒 |
| `npm run typecheck`、`npm run build` | 両方成功 |
| `npm run test:search` | 35件成功、失敗・Skip各0件 |
| `npm run test:app-data-browser`、`npm run test:memory-browser`、`npm run test:search-browser` | Chromium 156で3スイート成功 |
| `npm run test:macp`、`npm run test:notification-macp` | それぞれ9件・8件成功、失敗・Skip各0件 |

MACPの検証は既存手順の固定コミット `e88937d0c8132ae7d18098a24d01ee28bffda655` と一時SQLiteを使い、認証付きloopback FastAPIおよびSSEを経由した。Python 3.12.14、FastAPI 0.141.1、uvicorn 0.52.1。[MACP試験環境の手順](coordination-macp-integration.md)

## 性能測定

**索引単体**は10万Message・5千の過去版、計10万5千Segment（平均26.77 UTF-16単位）を使用した。SQLite内の合成認可条件で各30回実行した。構築76.73秒、検証4.41秒、1件の差分5.33 ms、DBは260,468,736 bytes、プロセスの最大RSSは257,376,256 bytesだった。HTTP・実セッション・原本再読取りを含む値は次の共存測定を参照。[索引単体の生データ](benchmarks/map-mem-2-lexical.json)

| 索引単体の検索 | p50 | p95 |
| --- | ---: | ---: |
| 日付なし・短語と長語 | 353.65 ms | 480.51 ms |
| 厳密日付 | 16.50 ms | 22.00 ms |
| 前後7日 | 432.27 ms | 691.45 ms |
| 固有ID | 0.22 ms | 0.33 ms |

合成した日本語3問では、保存した正解SourceRefがすべて上位10件に入った。これはLexical用fixtureの回帰結果である。実際の問い合わせ分布に対するRecallやEmbeddingモデルの比較には、別途、日本語実データの正解集合を用いる。[正解集合](../test/fixtures/search-quality.json)

**HTTPとCOORDの共存測定**では、10万Message・5千の過去版、平均35.89 UTF-16単位のpublic原文を用いた。使い回したセッションからloopback HTTPで検索し、毎回の検索子プロセス起動と原文再検証を含めた。構築後のOSキャッシュを保持した状態で、同じ検索語を各10回実行した。[HTTP共存測定の生データ](benchmarks/map-mem-2-coexist.json)

| HTTPの操作・条件 | p50 | p95 |
| --- | ---: | ---: |
| 日付なしの原文検索 | 431.25 ms | 718.33 ms |
| 前後7日の原文検索 | 473.07 ms | 715.43 ms |
| 検索と並行した同じRoomへの通常保存（113件） | 2.87 ms | 12.07 ms |
| 同じ期間のCOORD heartbeat間隔（設定50 ms） | 50.39 ms | 58.04 ms |

主パーティションの構築は93.15秒、同じ世代への1件の差分同期は1.02秒。2パーティションを含む派生容量は361,426,944 bytesで、サーバーとWorkerスレッドのサンプリング最大RSSは346,857,472 bytes（検索子プロセスは集計外）だった。最大同時索引Worker数は1、待機時間の合計は93.14秒、取消から実終了までは267 ms。通常保存・heartbeatの失敗は各0件だった。

差分確認用の1要求を含めた21応答のうち、完全な反映状態の表示は2件、書込みが並行し部分結果と表示したものが19件。21応答すべてで意図した原本を再検証し、除外は0件だった。索引遅延を示した応答を含むp95であり、全21要求が最新状態まで反映したときの応答時間を示す値ではない。実行環境でのこの短い合成負荷に限った測定で、本稼働の性能判定は対象機器で行う。

## 実Providerと本稼働の確認

Google向けHTTP要求は文書とQueryを別々に検査した。模擬応答によるHybridのHTTP試験では、Lexical一致のない公開ノートから原文と引用を取得した。実Googleの認証、モデル品質、実Usage・実費と外部待ち時間を含むHybrid p95は未測定。参照Backendとの契約試験はSQLite実装に適用した。Qdrant、CohereのEmbeddingと実Rerankerは評価候補に残る。[Google Embeddingガイド](https://ai.google.dev/gemini-api/docs/embeddings) · [REST仕様](https://ai.google.dev/api/embeddings)

MEM-2は検索と引用までを監査対象にする。対象機器での全文・日付p95 1秒、Hybrid p95 3秒、実データの移行、Backup／Restoreと再構築費用、COORD共存負荷、TLS、RPO／RTO、長時間運用は本稼働前に判定する。[設計・Host操作・MEM-3への引継ぎ](map-mem-2.md)
