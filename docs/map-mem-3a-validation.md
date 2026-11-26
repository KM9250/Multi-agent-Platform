# MEM-3A 検証記録

基準SHA: `b21e6760f04ce42b2135619e8524188f887b5fc6`。2026-11-26のclean全体試験 `npm test` は2,351成功・0失敗・0skip、431.744秒。実行ログは `work/npm-test-clean.log`。提出HEADはPR本文と最終報告に記録する。全体試験後の限定修正は下記の対象試験で確認しており、全体試験をその後の全差分へ再実行したという意味ではない。

## Schema・運用の対象試験

`test/context-migration.test.ts` は基準リリースを `git archive` で展開し、その実装からSchema6のDB、承認済みNote、旧Manifest、旧Profile、Backup、paused restore reportを作成する。

| 確認項目 | 結果 |
| --- | --- |
| read-onlyで旧DBを自動移行しない | 成功 |
| migration7 COMMIT前失敗時にSchema6 catalogue・旧receiptを保持 | 成功 |
| 二度の再起動でもmigration7は1回、旧JSON・digest・承認は不変 | 成功 |
| 旧paused restoreのMemory台帳digestを移行receiptで照合し再開 | 成功 |
| Schema6 BackupからSchema7へ復元し、Backup元bytesは不変 | 成功 |

実行コマンド: `node --experimental-transform-types --loader ./test/ts-loader.mjs --test test/context-migration.test.ts`。2026-11-26実行、5成功・0失敗・0skip、2.345秒。外部Provider呼出し0件。合成Providerと一時Rootのみ使用した。

`test/context-backup.test.ts` は、実際の公開Note検索で生成したanswerから後日の `/memory` へ接続し、160件の由来権限を持つNOTEの未完了frontierをBackupへ含める。復元直後にfrontierの全列とPENDING状態を照合し、資格情報の再設定・明示resume後に複数sliceを進め、`DONE / notes_done=1` を確認した。検索の `OUTCOME_UNKNOWN` と親binding、既存回答Manifestは同じ記録を保全し、未消費回答予約だけを解放した。未知Summary参照、既存Callと異なるPlanへの付替え、復元後のGeneration台帳変更は拒否する。

| 対象コマンド | 成功 / 失敗 / skip | 時間 |
| --- | ---: | ---: |
| `node --experimental-transform-types --loader ./test/ts-loader.mjs --test test/search-migration.test.ts test/app-data-backup.test.ts test/memory-backup-compat.test.ts test/context-migration.test.ts` | 16 / 0 / 0 | 5.356秒 |
| `node --experimental-transform-types --loader ./test/ts-loader.mjs --test test/app-data-crash.test.ts test/context-backup.test.ts` | 30 / 0 / 0 | 33.601秒 |
| `node --experimental-transform-types --loader ./test/ts-loader.mjs --test test/context-backup.test.ts test/app-data-backup.test.ts`（新Manifestとcurrencyの復元検査を含む） | 10 / 0 / 0 | 4.608秒 |
| `node --experimental-transform-types --loader ./test/ts-loader.mjs --test test/context-backup.test.ts`（最後のPlan／Run付替え拒否と同一Run通貨整合追加後） | 3 / 0 / 0 | 3.815秒 |
| `node --experimental-transform-types --loader ./test/ts-loader.mjs --test test/context-backup.test.ts test/context-migration.test.ts`（stable Call／権限keysetとSearch Profile版binding追加後） | 8 / 0 / 0 | 4.212秒 |
| `node --experimental-transform-types --loader ./test/ts-loader.mjs --test test/context-citations.test.ts test/context-http.test.ts` | 6 / 0 / 0 | 5.838秒 |
| `node --experimental-transform-types --loader ./test/ts-loader.mjs --test test/context-router.test.ts test/context-packing.test.ts` | 8 / 0 / 0 | 2.391秒 |
| `node --experimental-transform-types --loader ./test/ts-loader.mjs --test test/memory-source-validation.test.ts`（ファイル異常をSOURCE_CHANGEDへ正規化した後） | 3 / 0 / 0 | 1.350秒 |
| `node --experimental-transform-types --loader ./test/ts-loader.mjs --test test/context-citations.test.ts test/memory-context-lineage.test.ts`（明示再生成の出典Revisionを追加確認） | 18 / 0 / 0 | 3.378秒 |
| `node --experimental-transform-types --loader ./test/ts-loader.mjs --test test/context-ancestor-boundaries.test.ts test/context-packing.test.ts`（全体試験後の原文範囲・非供給祖先変更の回帰） | 4 / 0 / 0 | 3.330秒 |
| `node --experimental-transform-types --loader ./test/ts-loader.mjs --test test/memory-context-lineage.test.ts test/memory-source-validation.test.ts`（stable Call／権限keysetとrowid再採番後の再開を含む） | 16 / 0 / 0 | 5.590秒 |
| `node --experimental-transform-types --loader ./test/ts-loader.mjs --test --test-concurrency=2 test/search-ai-context.test.ts test/search-sources.test.ts test/search-index.test.ts test/search-dense.test.ts test/search-vector-reuse.test.ts test/context-budget.test.ts test/context-budget-generation.test.ts test/memory-source-validation.test.ts`（検索のasync祖先検証を接続した後） | 55 / 0 / 0 | 25.545秒 |
| `npm run test:context-browser` | 終了コード0 | 4.749秒 |

Crash試験は既存migration 1〜6と新migration7のCOMMIT直前・直後を実プロセスSIGKILLで止める。再起動後のcatalogue、適用回数、外部キーを確認し、新4テーブルと `notes_done` が同じmigration境界で現れることも照合した。GenerationのIntent／応答／保存境界、2プロセスの同一Run実行、添付の途中停止も既存試験を維持する。

Context Browser試験は専用の `test:context-browser` 入口を追加した。合成Provider呼出し2件、実Provider0件。回答Revision・receiptに結び付けたalias、供給資料と引用資料の区別、現在権限での原文取得、Session/Room切替の破棄を対象とする。

出典の追加回帰では原資料を変更してから明示再生成し、新回答Revision・新receiptに新しい出典が結び付くこと、旧出典を新回答へ継承しないこと、旧Revisionのsidecar参照を混在させないことを確認した。祖先原本検証の3件は、同期callbackの外で検証状態を再利用できないこと、yieldした先行ページの同一長さ編集を検出すること、bytes検証後も登録grant撤回をwriter内で拒否することを検査する。

## Generation境界と既存連携

writer外の祖先ファイル検証を接続した後、次を実行した。

```bash
node --experimental-transform-types --loader ./test/ts-loader.mjs --test \
  test/context-generation.test.ts test/app-data-generation.test.ts \
  test/context-budget-generation.test.ts test/app-data-audit-pr38.test.ts \
  test/app-data-crash.test.ts
```

106成功・0失敗・0skip、30.636秒。固定Sourceの変更をprepare後、Intent前、送信直前、応答後、保存前に検出する試験と、PR #38の入力・履歴窓・先頭固定・再生成、旧Intentからの再送禁止、Usage保全、Schema7のCrash回復を含む。祖先は32件ずつwriter外でlive hashを確認し、dev・inode・ctime・mtime・sizeを最後に再照合する。検証済み状態はその同期callbackだけで有効で、writer内のDB・ACL・採用Note自身の現物確認を省略しない。

Router／packing試験では、6つのルーティング受入例、用途除外、明示値と既定値、相対日付snapshot、年なし日付、512 UTF-16制限、surrogate pair・CRLF、Indexなしでの固定Plan再現、明示原文の容量不足を確認した。日付条件の検証は既存SearchDateを使用する。

全体試験後の限定回帰では、原文・引用の明示要求は検索chunkからSource原本全体へ範囲を拡張し、token枠またはcitation APIの4,096 UTF-16上限を超えると切断せず `CONTEXT_LIMIT` になることを確認した。供給Note自体が不変でも、供給されていない祖先Noteの変更をIntent前に検出するとProvider送信0件、応答後に検出すると完了Usage 15を保持して公開出力0件になり、ともに `CONTEXT_CHANGED` で終了した。ログは `work/context-final-boundaries.log`。

Profile変更の競合試験では、先頭回答の完了後にAI対象Personaを拡張しても、後続PersonaのQueryは送信せずLexicalへ降格し、3件の回答予約が開始時のProfile版を維持した。NOTE frontierの再開試験ではreceipt・authorityのrowidを再採番してから再起動し、stable Call IDと権限keysetで検証を完了した。

検索側の限定修正では、Memory検索の最終resolve、Index worker、書込み可能DBのDense coverageにもwriter外の祖先検証を接続した。55件の再試験で、検証状態は同期writer内だけで有効なこと、破棄・取消、同期／非同期のページとDense coverageの一致を確認した。同期API、read-only worker、既存Crash hook、手動Document送信前の確認を維持し、型検査と差分の空白検査も成功した。

| コマンド | 成功 / 失敗 / skip | 時間 |
| --- | ---: | ---: |
| `npm test`（clean全体実行） | 2,351 / 0 / 0 | 431.744秒 |
| `npm run typecheck`（最終実装の型検査） | 終了コード0 | 8.845秒 |
| `npm run build` | 終了コード0 | 2.640秒 |
| `npm run test:macp` | 9 / 0 / 0 | 1.438秒 |
| `npm run test:notification-macp` | 8 / 0 / 0 | 4.230秒 |
| `npm run test:app-data-browser` | 終了コード0 | 15.936秒 |
| `npm run test:memory-browser` | 終了コード0 | 20.721秒 |
| `npm run test:search-browser` | 終了コード0 | 8.124秒 |
| `npm run test:context-browser` | 終了コード0 | 4.749秒 |

MACPは既存のloopback統合試験、Browserは合成Providerを使用した。COORD Schema 11と既存のMACP契約は変更していない。

## 長いlineageとHTTP共存

PR #39 F-06の実リリースSchema2直接更新、Schema3での旧保留からの回復、再起動、別Root復元を再実行し成功した（70.09秒）。186／185／185 verification batchesで、187 Provider Call、6 publication receipts、7 Note versionsを保全した。F-07の実撤回grant継続検証と旧Schema移行も成功した（0.868秒）。これらは合成Providerによる旧データfixtureであり、実利用者データの移行ではない。

`node --experimental-transform-types --loader ./test/ts-loader.mjs test/bench/memory-context-lineage.bench.ts 160 6` で、先行answer160件、Note6段、最終173 CALL／6 NOTEの混合lineageを測定した。44 sliceで872 ms、slice時間p50 7.38／p95 23.39／最大28.34 ms。認証付き通常messages HTTPを15回実行し、p50 43.87／p95・最大105.16 ms、event-loop間隔p95 51.54／最大54.03 msだった。

1 sliceのCALL増分は最大4、NOTE権限処理は32件まで。`EXPLAIN QUERY PLAN` はCALL／NOTE frontierとcandidate依存の索引検索を示し、通常HTTPや新しい回答ごとにRoom全履歴を同期走査する処理は追加していない。対象試験と同時に共有環境で測定した値であり、対象運用機器の性能保証ではない。実Provider呼出し0件。[測定データ](benchmarks/map-mem-3a-lineage-coexist.json)

上記のDAG探索・永続frontier測定とは別に、writer外の祖先現物検証を次で測定した。

```bash
node --experimental-transform-types --loader ./test/ts-loader.mjs \
  test/bench/memory-note-validation.bench.ts 1024 5
```

Node.js 24.19.0で1,024 NOTEの合成依存をあらかじめ作り、5つの実行境界で毎回すべての原本bytes・digestを読み直した。32件ページごとにyieldし、最終secure stat照合をwriter外で完了してから同期writerへ入る。

| 対象 | 件数 | p50 | p95 | 最大 |
| --- | ---: | ---: | ---: | ---: |
| 祖先現物の検証全体 | 5境界 | 262.29 ms | 360.87 ms | 360.87 ms |
| 同期writer境界 | 5境界 | 6.74 ms | 7.05 ms | 7.05 ms |
| 認証付き通常messages HTTP | 54回 | 13.89 ms | 45.45 ms | 87.61 ms |
| event-loop間隔 | — | — | 34.90 ms | 79.89 ms |

`EXPLAIN QUERY PLAN` はcandidate・NOTE・resource IDのkeyset範囲索引とNoteのscope索引を使用した。全祖先を一度展開して作った合成依存の検証コストを分離した測定であり、DAG探索性能や対象機器での本番遅延を保証する値ではない。実Provider呼出し0件。[1,024 NOTE測定データ](benchmarks/map-mem-3a-note-validation.json)

## 受入条件と試験の対応

| 境界 | 主な再現試験 |
| --- | --- |
| Router、日付、再送、再生成、固定Sourceの変更、UTF-16と容量 | `context-router.test.ts`、`context-generation.test.ts`、`context-packing.test.ts` |
| HumanとAIの分離、TopK前の公開範囲、seq上限、Worker／Dense、private・未来変更のfreshness分離 | `search-ai-context.test.ts`、既存`search-*.test.ts` |
| 親Run／Profile予算、明示通貨、Usage不明、取消、結果不明、再起動 | `context-budget.test.ts`、`context-budget-generation.test.ts` |
| NOTEの多段失効、実使用grant、登録者、永続frontier、循環・異版矛盾 | `memory-context-lineage.test.ts`、`memory-source-validation.test.ts`、既存F-06／F-07試験 |
| 回答Revisionのsidecar、認可付き原文、セッション破棄 | `context-citations.test.ts`、`context-http.test.ts`、`integration/context-browser.integration.ts` |
| Schema6移行、旧Backup、新binding・未完了frontier、Crash回復 | `context-migration.test.ts`、`context-backup.test.ts`、`app-data-crash.test.ts`、既存Migration／Backup試験 |

表の試験パスは `test/` 配下。対象スイートは一部で全体試験と重複するため、件数は実行コマンド単位で読む。`git diff --check`も成功した。

提出直前の再確認では、型検査8.845秒、ビルド2.640秒、会話Browser15.936秒、Memory Browser20.721秒、検索Browser8.124秒、Context Browser4.749秒で、すべて終了コード0だった。Memory原文・citationのHTTP入口でも、認可を確認してから同じ短期の祖先検証を使う。`test/search-http.test.ts test/context-citations.test.ts test/context-http.test.ts` の最終対象は7成功・0失敗・0skip、6.190秒。Memory Browserの競合表示確認は、同じ文言のstatusとalertを区別して操作結果のstatusを検査する。これらも合成データで、実Provider呼出し0件。

## 未実施の本稼働Gate

実Providerへの接続・実Usage・請求額、実データ移行、対象機器でのBackup／Restore、実TLSは本実装の受入範囲外であり未実施。MEM-3B／3C完了後の本稼働Gateへ引き継ぐ。合成試験の成功を本稼働確認済みとは報告しない。
