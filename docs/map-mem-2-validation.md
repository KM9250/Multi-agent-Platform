# MEM-2 検証記録

初回実装の検証日 2026-11-24。基準は `cd1ffca5474902b7b90381e598f0741737e482f7`。一時Rootに作った合成データを使い、Linux上のNode.js 24.22.3、SQLite 3.54.1、Chromiumで確認した。実Providerへの送信は0件。

## PR #40 監査修正の再検証　2026-11-25

監査基準は `c154e404318d5033483d20da88e42e905af23af8`。着手時のPR先端も同じだった。添付監査証跡の17ファイルを同梱のSHA-256一覧と照合し、そこで報告された現象を回帰fixtureで再現した。Linux、Node.js 24.22.3、SQLite 3.54.1、Chromium 156を使った。資料、アカウント、Vault、費用枠は合成したものを用いた。模擬送信の試験ではGoogle向けの通信をfetch境界で置換し、実Provider呼出しは0件だった。

| 指摘 | 監査時の再現と修正後の確認 |
| --- | --- |
| F-01 | 正式な `server/cli.ts search-sync` を模擬文書送信中にSIGKILLし、Intentを残した。別CLIは生存中のlockで拒否され、台帳はそのまま。終了とPIDを確認してfixtureのlockを片付け、CLIだけで再起動したところ、旧操作は同一IDの `OUTCOME_UNKNOWN` に変わった。8,192 Tokenと820費用単位（micros）の予約を予算に含め、新しい明示操作の成功後にBackupが成立した。元の世代とChunkから旧文書操作IDを再現して再実行を試みると、送信前に `operation_already_recorded` で拒否された。再度の通常同期は再送0件。未送信予約、重複拒否、未復旧IntentのBackup拒否は既存試験でも確認した。 |
| F-02 | 両用途で作成したVectorが、監査版ではQuery-onlyへの切替と通常同期で消えることを再現した。修正後は正式CLIの通常同期、HTTP検索による自動同期、Denseだけが見つける原本の取得まで同じVectorとReceiptを維持した。新しい `maxCalls=1` は最初のQueryだけに使い、別requestIdの次のQueryは送信前に拒否。新旧の費用とUsageを個別に照合した。 |
| F-02の失効・移行 | 元操作の状態・用途、SourceRef、送信本文Digest、数値・空間、別世代への転記、対象Scopeの拡大を検査した。長さが変わらないVault編集でも検証に失敗し、Queryを送信しなかった。構築途中の権限・Profile変更、Rollback不適合、Coverage件数・容量上限も検証した。監査コミットの実装で作ったSchema 5のDBを6へ移行し、同じCursor・Vectorを利用できた。旧BackupのRestoreでは費用台帳を保持し、Profile停止と旧Cursor無効化を確認した。 |
| F-03 | ArchiveとMemoryのHTTP検索で、別Room 80件→対象Room 1件→別Room 80件を再現した。HTTP側の時計を同期時点に固定した。別Roomだけなら通常の0件、対象変更が中間に入ると同期前は0件でも `partial / INDEX_LAGGING`、同期後は原本が1件で `ready`。同じRoomの権限外資料、古い公開版を含むMessageの削除、別Roomだけに属するPersonaの削除も検査した。無効Cursorは再同期、鮮度索引の読取り障害は確認不能、認証・閲覧拒否は元のステータスを保持することを子プロセス経由で確認した。 |
| F-04と状態の組合せ | Profileなしの一致・0件、停止中、文書用途のみ、明示Lexicalを検査した。通常時は `ready`・外部呼出し0件。明示Hybridの用途不許可、現在予算の超過、模擬Providerの503では理由を返した。503時は `degraded` でLexicalの原本を表示し、実行済みの模擬呼出し1件とUsage不明を記録。未反映とDense不可の併発時は `partial` と両方の理由を保持した。Chromiumでは通常の0件、縮退時の利用方式、部分結果0件の再検索案内、別タブのログアウトとブラウザへの非永続化を確認した。 |

`EXPLAIN QUERY PLAN` は、ArchiveのMessageで `search_message_changes`（Workspace・Room・チェックポイント）、SegmentでMessage・版の複合索引を利用した。Persona削除はRoom所属を起点に `search_persona_deletions` を照合する。Memoryは `memory_documents_room` から読取り可能なノートを調べ、`memory_change_note` でノートID・連番を範囲検索する。両経路の回帰試験は全表走査のない実行計画を検査する。同じRoomに大量の未処理履歴がある場合はその分の照合時間がかかるため、鮮度確認を取消・期限付きLexical子プロセスで実行する。

| 修正後に実行したコマンド | 結果 |
| --- | --- |
| `npm test` | 2,279件成功、失敗・Skip各0件。535.13秒。 |
| `npm run test:search` | 49件成功、失敗・Skip各0件。75.92秒。全体試験と重複する。 |
| `npm run typecheck`、`npm run build` | いずれも終了コード0。 |
| `npm run test:search-browser` | ビルド済みアプリとChromiumで成功。記録した外部Provider呼出し0件。 |
| `git diff --check` | 空白・パッチ形式の指摘0件。 |

今回の追加・変更試験は `test/search-cli-recovery.test.ts`、`test/search-dense.test.ts`、`test/search-vector-reuse.test.ts`、`test/search-index.test.ts`、`test/search-sources.test.ts`、`test/search-persona-delete.test.ts`、`test/search-freshness-{http,worker}.test.ts`、`test/search-migration.test.ts`、`test/integration/search-browser.integration.ts` と既存のMigration・Backup試験で再現できる。実Provider・実データ移行・実機のBackup／Restore・TLSは今回未実施。初回の実施記録にあるMACP単独・DATA-1／MEM-1の専用Browser試験も今回の再実行範囲外とした。

### 監査修正後のHTTP共存測定

同じ実装で `npm run --silent bench:search-coexist -- 100000 10` を2回実行した。10万Message、過去5千版、Denseなしの合成データで、通常保存・COORD heartbeatと同時に、認証済みloopback HTTPから各方式を10回検索した。初回構築後のキャッシュは保持した。10回の分位であるため、ここでのp95は各方式で最も遅い1回である。

| 条件 | 日付なしHTTP p50／p95 | 前後7日HTTP p50／p95 | 通常保存 p95 | heartbeat間隔 p95 |
| --- | ---: | ---: | ---: | ---: |
| 監査前の初回提出時 | 431／718 ms | 473／715 ms | 12.07 ms | 58.04 ms |
| 修正後、全体試験と並行 | 656／1,227 ms | 958／1,349 ms | 25.38 ms | 72.51 ms |
| 修正後、全体試験の終了後 | 257／316 ms | 314／405 ms | 5.21 ms | 54.38 ms |

両方の修正後測定で、21応答すべてが意図した引用を検証し、原本の除外・外部呼出し・保存失敗・heartbeat失敗は各0件だった。保存が並行した20応答は `partial / INDEX_LAGGING`、1応答が `ready`。単独測定では主世代の構築71.64秒、1件差分0.66秒、検索中の保存73件、索引容量360,763,392 bytes、サーバー・Workerスレッドのサンプル最大RSSは335,319,040 bytesだった。暫定目標の1秒を下回ったのは単独測定で、全体試験と同居した測定では超過した。環境負荷と試行数が異なるため、この差をコード変更だけには帰属できない。[試験と並行した測定](benchmarks/map-mem-2-audit-coexist-shared.json) · [単独測定](benchmarks/map-mem-2-audit-coexist-isolated.json)

追加の負荷確認では、同じRoomの閲覧できない変更10万件に対して未反映なし、末尾に読める1件を入れると未反映ありを各10回検出した。前者の検索子プロセス起動を含むp95は1.68秒、並行して計った親プロセスの20 msタイマー間隔はp95 34.8 msだった。これは大きな滞留を処理するコストを調べた合成試験であり、上表の通常のHTTP検索とは測定範囲が異なる。

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

## 初回実装の受入試験

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

## 初回実装の性能測定

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
