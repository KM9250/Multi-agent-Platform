# PR #35 F-01〜F-03 監査修正報告

本書はF-01〜F-03修正時点の検証記録。後続のRT-01／RT-02修正と全Suite再実行は [追加監査修正報告](coordination-pr35-redteam-corrections.md) を参照する。F-01〜F-03の契約・回帰は維持している。

監査基準HEAD: `995c186e123e0b96d2a072db09b6d5acf1f0c078`。基準main: `e4de47b6f5290ec566e26c6a7ffd22ae1e82ab5a`。同じ `codex/coord-5c-4b-2b` ブランチに追加する。検証日: 2026-11-11（Asia/Tokyo）。最終HEADは文書自身のSHAの循環を避け、PR本文に完全な値を記載する。

## 修正内容

| 指摘 | 修正と維持した境界 |
| --- | --- |
| F-01 | 実Payloadの初回参照と取得済みReadを合わせて現在の送信許可を検査する。ReadのResource ID/Digest/Revision/観測時刻を保持し、予約前・Intent後・外部入口直前に確認。同じ集合をArtifact/質問の出所に使用する。予約前の撤回では追加Debit/Usageなし。Intent後は外部送信0、確定した予約と不確定状態を保持し、再送しない |
| F-02 | 期限Triggerが既存の非公開4B-1 Scopeの正確なLedger更新許可を検査する。新しい認証・承認済みREFLECT_RECORDED_RESULTに限り、現在Lease/Plan/Grant/Workflow/Action/Attempt/Result Digest/Taskイベントと一致する反映を許可。旧Step期限は不変で、旧Invocation・通常Store・直接SQL・自己申告Scopeは拒否。Grant消費・Task反映・FINALIZED・Receipt・Auditは原子的で、Executor再実行0 |
| F-03 | 検証済み質問を専用planning_input_requestsへ保存する。初回結果と独立Reader/再接続で同じinputRequestを返し、state=AWAITING_INPUTを明示。所有者本人＋現在Workflow ACLを検査。質問・参照Journal・APPLIED・STOPPED/PLAN_INCOMPLETE・Receipt/Auditを同時COMMIT。表示でModel/Read/prepare/Actionを実行せず、回答は新しい明示要求と予算で処理 |

Schemaは未マージの9を修正し、旧Migration 001〜008の生成SQLは変更していない。質問表はSTRICT、追記専用Scope、FK、APPLIEDへの遅延複合FK、128 KiB上限を持つ。質問は最大20問・各4,096文字、秘密パターン・Credential・Host分類検査を受ける。Journal/Auditに本文やRaw Provider Responseを保存しない。完成Planのレビュー、内容受諾、実行承認・開始の意味は維持する。

主な変更: `recoveryContinuationCoordinator`（実Payload検査・質問保存/照会）、`continuationSchema`（限定期限例外・質問表）、`continuationTypes`/`index`（DTO）、`planningArtifactStore`（質問の検証済み読取り）、`recoveryContinuationReader`（参照だけのTimeline）。`safeRecoveryActions` / `executionReader` / `db` の既存認可Scopeは再利用し、新しい一般的なScope発行口を作っていない。

## 修正前の再現と追加試験

添付の3試験を監査基準HEADにそのまま追加して実行した結果は **3ケース、0 pass / 3 fail / skip・cancelled・todo 0**。F-01は撤回後のAを含む3回目の要求を検出、F-02は期限後の認可済みResult反映で拒否、F-03は初回結果に質問本文がないことを検出した。添付のSQL probeは独立Trigger検証であり、この実リポジトリの結果とは区別した。

修正後、同じ3試験は成功。追加の境界試験を含む `coordination-pr35-audit-regressions.test.ts` は **20ケースすべて成功**。次を含む。

- Aを送った要求中に権限撤回→BのRead成功→次の要求を予約前に停止。Model Debit/Usageは2回分、Read2回、Action/prepare0。
- Intent確定後の撤回と親Scope外の外部入口直前の撤回。外部送信せず、追加予約を保持。再照会・同じIDでの開始要求から再送しない。
- 最後の許可検査が送信期限を超えて同期的に遅延した場合と、検査中に認証済み停止要求が入る場合も、追加Provider呼出し0。検査後にLease・ACTIVE状態・受付/送信期限・AbortSignalを再確認する。
- 許可がある場合のRead成功と、実Payloadのメタデータ・Artifact出所の一致。
- RESULT_RECORDEDで中断→元Application期限経過→新規4B-1承認→Task反映1件、追加Executor0回。Workflow/Action/Attempt/Result Digest/参照を変えた更新はScope内でも拒否。
- 4B-1のCOMMIT前障害とACK喪失で、Grant・Ledger・Taskイベント・Receipt・Auditの整合を確認。
- 2つの既知質問を初回・独立Reader・別接続で取得。未認証、別Actor（管理者を含む）、別WorkflowのACLは拒否。
- 質問保存/APPLIED/終了を含むTransaction失敗、COMMIT ACK喪失、秘密・Host拒否・件数/文字数上限、明示的な次の入力と独立予算。

質問COMMIT前後の実子プロセスSIGKILLを既存Crash Suiteへ追加した。継続Crashは32境界、MigrationのDDL/COMMITは別の4境界で、合計36境界。再起動後の同じIDによる要求で外部カウンタが増えず、質問→APPLIEDと終了が全て保存されるか、全て未保存であることを確認した。

関連する計画・Crash・Migrationの先行バッチは102ケースすべて成功。新規DBと0〜8→9で質問表のSTRICT・空状態を検査し、データ入りv8、DDL失敗、Migrationの実SIGKILL、001〜008の固定SHA-256検査も維持している。

修正版Schema 9の新規DBを作り、基準mainの実際の旧Runtimeで開く独立検査も再実行した。`SCHEMA_UNSUPPORTED` で拒否し、Migration Ledgerを変更しないことを確認した。

追加試験の開発中に1回、17ケース中16 pass / 1 failとなった。別Workflow用fixtureが作成時刻1に対して既定のwall time予算を使い、正しく予算超過拒否されていたため、合成fixtureに明示的な有限wall time上限を指定した。実装のBudget検査や既存Assertionは緩めていない。その後、入口直前の検査を追加した18ケースが成功。依存関係・lockfile変更なし。

最初の全体回帰は1,455ケース中1,451 pass / 4 fail、skip/cancelled/todo 0。`test:durable` も同じ原因で162 pass / 1 failとなった。既存の破損データ注入用SQLite接続に `map_safe_recovery_write` が未登録で、破損投入SQLのコンパイル時に失敗した。試験専用接続へ常に0（拒否）を返す5引数関数を登録し、Production Scope、Trigger、既存Assertionを変更せず対応した。関連2ファイル79ケースは修正後すべて成功。全体と失敗したDurable subsetを通常コマンドで再実行し、下表には最終結果だけを記載する。

上記修正後に全体1,455ケースが成功した後、F-01で追加した最後のHost許可検査が遅延する場合・検査中に停止される場合を調べた。追加の2試験は0 pass / 2 fail、skip/cancelled/todo 0で、検査後の外部入口へ進めることを再現した。許可検査後にLease・ACTIVE状態・受付/送信期限・単調時計・AbortSignalを再確認するよう修正。同じ2試験と計画Suiteを含む72ケースがすべて成功した。追加変更を含む固定HEADで指定15コマンドを改めて一式実行し、その最終結果を下表に記載する。

## 最終一式の検証

Linux 6.18.57 x86_64 / Node v24.19.0 / npm 11.9.0 / SQLite 3.53.3。実Provider・実業務Executor・実運用DBを使わない合成試験。最終一式のソース・試験HEADは `8d199a486c0fadc4d6c8fba6248b69bfe15cdcc7`。以後の変更は設計・検証文書だけ。

| コマンド | ファイル数 | ケース数 | pass | fail | skip | cancelled | todo | Exit |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `npm test` | 70 | 1457 | 1457 | 0 | 0 | 0 | 0 | 0 |
| `npm run test:durable` | 11 | 163 | 163 | 0 | 0 | 0 | 0 | 0 |
| `npm run test:durable-execution` | 7 | 111 | 111 | 0 | 0 | 0 | 0 | 0 |
| `npm run test:recovery-reader` | 25 | 491 | 491 | 0 | 0 | 0 | 0 | 0 |
| `npm run test:runtime-lease` | 5 | 46 | 46 | 0 | 0 | 0 | 0 | 0 |
| `npm run test:model-call-ledger` | 4 | 103 | 103 | 0 | 0 | 0 | 0 | 0 |
| `npm run test:recovery-authorization` | 3 | 90 | 90 | 0 | 0 | 0 | 0 | 0 |
| `npm run test:recovery-execution` | 5 | 119 | 119 | 0 | 0 | 0 | 0 | 0 |
| `npm run test:recovery-dispatch` | 4 | 106 | 106 | 0 | 0 | 0 | 0 | 0 |
| `npm run test:recovery-continuation` | 7 | 88 | 88 | 0 | 0 | 0 | 0 | 0 |
| `npm run test:planning-only` | 4 | 52 | 52 | 0 | 0 | 0 | 0 | 0 |
| `npm run test:hold-lifecycle` | 1 | 5 | 5 | 0 | 0 | 0 | 0 | 0 |
| `npm run test:macp` | 1 | 9 | 9 | 0 | 0 | 0 | 0 | 0 |
| `npm run typecheck` | — | — | — | — | — | — | — | 0 |
| `npm run build` | — | — | — | — | — | — | — | 0 |

全体は70ファイル・1,457ケース、全pass、fail/skip/cancelled/todo 0。MACPは別途9ケース成功。型検査・ビルドも成功した。

各subsetはnpm testの内数であり、合算しない。MACPは固定commit `e88937d0c8132ae7d18098a24d01ee28bffda655`、既存のローカルvenvによる合成環境で成功した。既存の通常npmコマンド設定を維持し、skipの追加や既存テスト削除は行っていない。Viteの既存500 KiB超チャンク警告は残る。

## 制約・提出

本番Provider、Production Identity UI、ネットワークRead、Windowsネイティブは今回も未検証・未接続。既存のFail Closedを維持する。4C、外部照合、未知処理の再送、推測精算は追加しない。旧版で本文が保存されなかった質問をModel再生成で埋め戻す処理も追加しない。未マージSchema 9の修正として、新規DB・0〜8からの移行を検証し、実運用DBへMigrationしていない。

作業差分・staged差分・基準mainから最終HEADの差分検査と、公開差分の秘密情報・実DB/WAL/SHM・ログ・生成物・ローカル専用ファイルの混入検査を実施し、混入は検出されなかった。修正と結果は既存Draft PR #35へ追加し、main直接Push、新しい分割PR、自動マージは行わない。
