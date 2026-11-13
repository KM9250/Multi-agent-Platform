# PR #36 F-02 再監査修正記録

再監査基準HEAD: `87ef2b50b9dc9d4548d5965039b70a2a82a96870`。基準main: `89d431e20cf1f6617d4095b9a8722d86fb711d1d`。最終全Suite実行ソース: `da9577022ea48d4c20ea8650a3be180560f4f49d`。このソース以後の今回の変更は文書のみ。公開時の最終HEADは既存Draft PR #36本文と完了報告に記録する。記録日: 2026-11-13（Asia/Tokyo）。

F-01／RT-01／RT-02の境界は[前回記録](coordination-reconciliation-pr36-corrections.md)どおり維持する。今回の製品変更は `db.ts` だけで、Schema 10、Contract `COORD-5C-4C:RECONCILIATION:1`、Migration 001〜010、依存・lockfileは変更していない。Bによる既存の正規Ledger遷移を保ち、旧Generation・過去Journalの書換えや通常精算の単一正本の変更は行わない。

## 原因と限定したScope移行

Controlled DispatchのTransaction Bは、最後にControlled Receipt用のSQL Scopeを残す。COMMIT前のNormal fact participantが矛盾を保存しようとすると、Reconciliation Scopeの排他条件がこれを拒否し、取得済みResultを含めたBがRollbackしていた。

`persistDispatchResult()` の後でだけ呼ぶ非公開 `#finishControlledResult()` を追加した。現在のTransaction／Lease／Workflow／Runtime／Generation、RESULT段階、Actor、Receipt用Scope、INSERTであること、他Scopeがないことを確認する。保存済みReceipt行が許可済みSQLベクトルと一致し、既存 `inspectDispatchInTransaction()` が捕捉済みIntent・Receipt、Result・Evidence・Grant消費・必須Auditの整合性を検証でき、収集期限内であることを確認してからControlled Scopeだけを終了する。

続くDB所有のNormal fact participantが専用Scopeを取得し、Result／Evidence／Controlled ReceiptとDispute／Case／Control／Hold／必要なDrain／Auditを同一Transactionに保存する。`!#controlledScope` の排他条件は残し、4B-1／Model Applicationとの包括的な例外や、公開Scope／forceフラグ／任意callbackは追加していない。この移行中に外部Adapterは呼ばない。`#controlledCommand` はCOMMITまで保持するため、後段のSQL例外を呼出元が握り潰してもB全体を毒化する。

Abort通知の経路は前回RT-01から変更していない。COMMIT確認後にScopeを破棄し、親Scope外で通知する。Rollbackでは通知しない。新しいControlled fixtureにはActive Invocationを捏造しておらず、実InvocationのDrain通知／親Scope外の権限検査は既存RT-01回帰で確認する。

Task反映・新しい承認・再開許可は別のままである。矛盾保存はGrantを追加消費せず、Aで消費済みのGrant／Send Permitを維持する。BのRollback後は保存済みIntentを照会し、ACK喪失後は保存済みReceiptを照会する。Result再保存、元Action／Model／Verifier再実行、Hold自動解除は行わない。

## 修正前の実測

添付 `controlled_scope_probe_result.json` は、監査側がNode 22.16.0／SQLite 3.49.1で行った抽出ハーネスの報告として扱った。当方のリポジトリ統合試験数には含めない。本文が参照するテスト案 `.test.ts` 自体は添付されていないため、文書の条件を既存 `dispatchFixture` と登録済みEd25519合成Verifierに実装した。

基準HEADで最初の3件を実行し、2 pass／1 fail。実際の公開 `executeControlledDispatch()` がExecutorのPromise応答を待つ間に、同じAttemptの署名済み・完全・最終事実を `ReconciliationEvidenceService` で保存した。矛盾する結果だけが `#setReconciliationScope()` の `INTEGRITY_ERROR` で失敗し、同値・Verificationなしは成功した。通常 `recordResult()` 直接呼出しで代用していない。

基準HEADを `git archive` した製品ソースに完成した試験・fixture 4ファイルだけを重ね、全23件を再比較した。15 pass／8 fail、skip／cancelled／todoは0。8件は矛盾正常保存、Normal側の握り潰し注入、COMMIT失敗注入、ACK喪失、競合再要求、逆向き矛盾、実Crash前後である。Normal／COMMIT注入とCrashは旧Scope拒否で指定境界へ到達せず、部分COMMITを観測したという意味ではない。失敗件数を独立した脆弱性件数として数えない。

同じ基準ソースで追加観測したところ、B直前から全DB表が不変で、Result／Receipt／Disputeは各0、Executor 1回、Verifier 1回、GrantはCONSUMED、LedgerはDISPATCH_RESERVED、再要求はINTENT_RECORDEDだった。取得済み結果を失う問題と、Aの単回実行を区別した。

## 追加統合回帰23件

実装: [統合試験](../test/coordination-reconciliation-redteam-pr36-controlled.test.ts)、[共通fixture](../test/reconciliation-controlled-fixture.ts)、[実プロセス子](../test/reconciliation-controlled-child.ts)。既存の全体／reconciliation／reconciliation-redteamに自動で入り、`test:recovery-dispatch` にも同ファイルを追加した。

| 条件 | 件数 | 確認した結果 |
| --- | ---: | --- |
| 同Attemptの矛盾／同値／Verificationなし | 3 | BのResult・Receiptを保持。矛盾だけDispute／CaseとControl改訂・Auditを同時保存。ReaderにDISPUTED。Task ASSIGNED、Hold HELD、Grant単回消費、Journal不変。 |
| 未検証候補／Partial／Pending／署名対象の別Attempt／別Workflow／正規検証済みの別Workflow | 6 | 対象外の事実から誤Disputeを作らない。対象不一致の拒否は開始済み検証Jobと開始Auditだけを許し、課金・Grant・業務・事実保存を含む他の全表は不変。 |
| Controlled Audit拒否／必須Audit欠落／Dispute／Case／Control／Reconciliation Audit拒否／両Scope段階の握り潰したSQL拒否／COMMIT失敗 | 9 | B直前から全表が不変。Aと消費済みGrantを保持。Controlled Audit欠落時はNormal participantの書込みへ到達しない。故障除去後の再要求もIntent照会だけで再送・B再保存なし。 |
| COMMIT ACK喪失 | 1 | Result・Receipt・Dispute・Case・Control・Auditが揃った状態をReaderで回復。同一Receipt、再要求の全表不変、Executor／Verifier各1回。 |
| 応答待ち／検証中と完了後の同Plan並行再要求 | 1 | 待機中4要求は既存Intent、完了後4要求は同じReceipt。追加Send Permit・Grant消費・実行なし。 |
| NOT_EXECUTED_FINALとsucceededの逆向き矛盾 | 1 | Resultを失わず同一COMMITでDispute、Task未反映・Hold維持。 |
| BのCOMMIT直前／直後で実プロセスをSIGKILL | 2 | 直前はB全体Rollback、直後はB全体確定。別プロセスで再要求・認証付きReader照会し全表不変、Task ASSIGNED。Executor内とVerifier内から追記する外部カウンタは各1のまま。timeout killは失敗扱い。 |

すべて一時SQLite・実Lease／Identity／Grant／Trigger／Auditを使用する。拒否はエラーだけを確認せず、全表比較または許可する検証開始記録を明示した全表比較で課金・Grant・業務の先行変更を検出する。元Executorの計画・検証メソッドは呼ばず、Evidence Verifierとの呼出しを区別する。

## 実装中の検出と訂正

最初の修正ではReceiptの検索に存在しない `intentId` を使い、3件の統合と型検査が失敗した。既存 `operationId`／`operation_id` に訂正した。その後の21件版は18 pass／3 failで、拒否済み検証にも正規の開始Job／Auditが残る契約を全表不変と誤って扱った2件と、別Workflow fixtureでControlled Bindingを通常Executor Registryとして渡した1件が失敗した。型検査も後者を検出した。開始記録だけを厳密に許す比較と正しいRegistryに訂正し、失敗時も待機Promiseを片付けるfixtureにした。Gateや製品の拒否条件は緩めていない。

最終23件はすべて成功した。途中の失敗・再実行・抽出試験・重複するSuiteを最終成功件数へ合算しない。

## 最終検証

全体 **1,756/1,756件成功**（前回1,733件に対して23件追加）。追加F-02は23/23、照合251/251、監査・レッドチーム135/135、Controlled Dispatch129/129。既存のCrash・競合・Migrationを含む。4C Migration専用24件も成功。すべてfail／skip／cancelled／todoは0。サブセットは重複するため合算しない。

| コマンド | tests / pass | Exit | 秒 |
| --- | ---: | ---: | ---: |
| `npm test` | 1756 / 1756 | 0 | 135.480 |
| `npm run test:durable` | 163 / 163 | 0 | 36.195 |
| `npm run test:durable-execution` | 111 / 111 | 0 | 32.519 |
| `npm run test:recovery-reader` | 495 / 495 | 0 | 52.989 |
| `npm run test:runtime-lease` | 46 / 46 | 0 | 7.514 |
| `npm run test:model-call-ledger` | 103 / 103 | 0 | 6.799 |
| `npm run test:recovery-authorization` | 90 / 90 | 0 | 5.582 |
| `npm run test:recovery-execution` | 119 / 119 | 0 | 8.981 |
| `npm run test:recovery-dispatch` | 129 / 129 | 0 | 11.942 |
| `npm run test:recovery-continuation` | 92 / 92 | 0 | 29.479 |
| `npm run test:planning-only` | 52 / 52 | 0 | 3.164 |
| `npm run test:hold-lifecycle` | 5 / 5 | 0 | 0.978 |
| `npm run test:reconciliation` | 251 / 251 | 0 | 29.672 |
| `npm run test:reconciliation-redteam` | 135 / 135 | 0 | 9.393 |
| `npm run test:macp` | 9 / 9 | 0 | 1.349 |
| `npm run typecheck` | — | 0 | 3.053 |
| `npm run build` | — | 0 | 2.071 |
| `git diff --check` | — | 0 | 0.003 |
| `git diff --cached --check` | — | 0 | 0.002 |
| `git diff --check 87ef2b50b9dc9d4548d5965039b70a2a82a96870..HEAD` | — | 0 | 0.002 |
| `git diff --check 89d431e20cf1f6617d4095b9a8722d86fb711d1d..HEAD` | — | 0 | 0.010 |

上記21コマンドはすべてExit 0。Vite buildの既存500 kB超chunk警告は残る。型検査・ビルド・差分検査は試験件数に含めない。文書確定後にも差分検査を再実行した。

Linux 6.18.57／Node v24.19.0／npm 11.9.0／SQLite 3.53.3。MACP固定参照 `e88937d0c8132ae7d18098a24d01ee28bffda655` のローカルFastAPI／SQLite／SSEを使用する。全Suite実行SHAと公開時の文書込み最終HEADを区別する。

既存F-01／RT-01／RT-02、PR #35監査・レッドチーム、4B-1／Model Application Scope、4B-2A単調時計Timeout、Continuation、独立プロセス競合、Migration 0〜9→10、旧Runtime拒否、旧SQLハッシュ不変の回帰を維持する。

## 公開差分と未実施範囲

公開差分のパス・内容走査とレビューで、秘密情報・実データ・実証拠・DB/WAL/SHM・鍵・ログ・バイナリ生成物の混入がないことを確認した。試験鍵は実行時だけ生成し、ログ・基準ソース展開・DB・外部Counterは無視対象の `work/` または一時ディレクトリに置く。依存・lockfileは不変。文書追加後もmain基準の公開差分全体を走査し、最終テストSHAからは文書だけの差分であることを確認した。

本番Provider／Executorの証跡・請求・相関契約、Production Identity／ACL、管理API／UI、Windowsのプロセス試験は未接続または未実施で、成功件数に含めない。未対応接続はFail Closedのまま。合成VerifierやローカルCounterは実Provider照合・完全な外部Exactly-onceの保証ではない。

元Action／Modelの再送、未知Usageのゼロ補完、回答推測復元、WorkflowResume、Hold自動解除は追加していない。既存Draft PR #36のみを更新し、mainへの直接Push、新規分割PR、自動マージは行わない。
