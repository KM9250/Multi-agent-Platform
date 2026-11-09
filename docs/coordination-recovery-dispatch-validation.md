# COORD-5C-4B-2A 検証報告

基準main: `07c9e2e5739aed3f6c181bd3c16b387e7367c2bd`。作業ブランチ: `codex/coord-5c4b2a-prepared-dispatch`。最終HEADの完全なSHAはDraft PR本文に記載する（この報告を含むコミット自身のSHAを文書へ埋め込む循環を避ける）。検証日: 2026-11-09。

Schema **8** / Migration **008_bounded_recovery_execution** / Contract **COORD-5C-4B2:CONTROLLED_EXECUTION:1**。有効化した操作は **ALLOW_PREPARED_DISPATCHのみ**。詳細設計・API・時間設定・制約は [coordination-recovery-dispatch.md](coordination-recovery-dispatch.md) を参照。

## 検証環境と結果

Linux x64、kernel `6.18.57`、Node `v24.22.1`、SQLite `3.53.4`。すべて独立した一時DBと合成データを使用。既存運用DBへのMigration、実Executor・Model APIへの呼出しは行っていない。

下表の「ファイル」はテスト実行対象ファイル数、「ケース」はNode test runnerの実ケース数。サブセットSuiteを集約Suiteへ重複加算しない。**重複なしの全体は57ファイル・1,290ケース、追加専用試験はその内数の4ファイル・104ケース**。

| 通常コマンド | ファイル | pass | fail | skip |
| --- | ---: | ---: | ---: | ---: |
| `npm test` | 57 | 1290 | 0 | 0 |
| `npm run test:durable` | 11 | 163 | 0 | 0 |
| `npm run test:durable-execution` | 7 | 111 | 0 | 0 |
| `npm run test:recovery-reader` | 18 | 401 | 0 | 0 |
| `npm run test:runtime-lease` | 5 | 46 | 0 | 0 |
| `npm run test:model-call-ledger` | 4 | 103 | 0 | 0 |
| `npm run test:recovery-authorization` | 3 | 90 | 0 | 0 |
| `npm run test:recovery-execution` | 5 | 119 | 0 | 0 |
| `npm run test:recovery-dispatch` | 4 | 104 | 0 | 0 |

`npm ci`、`npm run typecheck`、`npm run build`、`git diff --check`、`git diff --cached --check`、基準mainから最終HEADへの`git diff --check`も成功。npmのキャッシュは作業用ディレクトリを指定。最終ビルドはAPIキーを渡さず実行し、生成物をコミットしない。Viteの既存500 KiB超チャンク警告は残るがビルドは成功。全Suiteでcancelled/todoも0。追加引数なしで各通常コマンドを実行し、既存の並列数設定を維持した。

## 受入条件の証拠

| 条件 | 実装・検証 |
| --- | --- |
| Aの成功COMMIT確認なしに送信しない | DBの非公開fenced transaction経路の正常return後だけPermit発行。A ACK喪失試験ではIntent/消費済みGrantあり、外部呼出し0回。公開Transactionメソッド差替えに依存しない試験も実施 |
| Intent照会でPermitを再生成しない | 再要求・別接続・実子プロセス再起動から保存状態のみ返す。A後Crash、別DB/Lease DTO、SQL観測の試験で再送なし |
| 同一AttemptのExecutor入口は最大1回 | 同期throw、Timeout・不確定結果、再入、二重要求、別Plan、2接続、2 Nodeプロセス競合を検証。独立した外部カウンタファイルで回数をAssert |
| Grant消費とDispatch予約が原子的 | AのLedger/Grant/Intent/リンク/Audit障害と捕捉SQL例外で全体Rollback。消費Grantのリンク欠落も拒否。再検証・監査readback後にCOMMIT |
| 対象AttemptのResult/Evidenceだけ保存可能 | 非公開SinkとAttempt別Evidenceリンク。別Action、存在しない別Attempt Evidence、普通のwithOwner、直接recordResult、直接SQL、PLAN Application・内部保存参加関数からの迂回を拒否 |
| Bは外部成功・Task完了・Hold解除と同義ではない | 正常failed/succeededはResult保存のみ。Safety Hold/uncertain/不正形式/Timeout/AbortはReviewまたは未確定Intent。元HoldとJournal、Task ASSIGNEDの不変性をAssert |
| 旧Generation・期限切れ・別DBを拒否 | Lease喪失中のEvidence/Result保存、コピーDBのLease、回収期限超過、送信前期限切れ・Abort、開始後Grant失効、遅延応答を検証 |
| 正常/不確定結果を区別して監査 | Intentと結果Receiptを別記録。Audit削除・Digest破損をReaderが拒否。再起動した別プロセスでは未確定IntentをOUTCOME_UNKNOWNと診断。Action TimelineにPlan/承認者/実行者/Attempt/Runtimeを表示 |
| 4A/4B-1/通常PLANと権限を混同しない | 旧契約のID/Grant流用を拒否。通常のScopeから新Scopeを作れない。4B-1の新規承認によるResult反映後も過去Dispatch Receiptを照会可能 |
| 継続/Resume/Hold解除を追加しない | モデル・Runnerの呼出し経路なし。Model/PLAN/VERIFYの回数0、Hold原本不変、4B-1 Hold TransitionにControlled Operationを混入しない |

## Crash・Migration試験

実Node子プロセスをLinux **SIGKILL**で強制終了。A COMMIT直前・直後、外部入口直前・直後、Evidence保存後、B COMMIT直前・直後の7境界で検証した。終了後は別プロセスで再照会・再要求し、独立したファイルの外部実行回数が増えないことを確認。例外throwだけをCrashの代用にしていない。

A前CrashはGrant/Intent/Ledger/Auditを全Rollback。A後・送信前Crashは外部0回のままIntentを保全。外部入口後Crashは外部1回のまま保全。EvidenceだけのCrashでは未確定Evidenceが残る。B前CrashはBの全書込みをRollback、B後CrashはResult/Receiptを再照会するだけ。前段のEvidenceはBとは別Transactionである。

Schema 0〜7から8、データ入りSchema 7、Migration 008のDDL例外、DDL直前・直後とCOMMIT直前・直後のSIGKILLを試験。旧Migration 001〜007について、基準mainから実際に生成したSQLのSHA-256を固定し、全件のバイト一致を検証。過去の監査列をそのまま比較し、新しい参照列がNULLで追加されることも検証した。既存テストの削除・Skip追加・Crash境界緩和は行っていない。

## 変更範囲と公開前確認

新設: `controlledRecoveryTypes.ts`、`controlledRecoverySchema.ts`、`controlledRecoveryPlanner.ts`、`recoveryDispatchCoordinator.ts`、`recoveryDispatchStore.ts`、`recoveryDispatchReader.ts`。DB内部の権限管理、Evidence Store参加処理、共通予約参加処理、Recovery Reader/Audit/Timeline、Schema/index/typesを更新。新規試験4ファイルと子プロセス/fixtureの2ファイル、`test:recovery-dispatch`スクリプトを追加した。

既存Migration関連試験9ファイルは最新Schemaの期待値を8へ更新し、過去データの比較と障害境界を維持。設計書とこの報告を含め、変更は合計34ファイル。公開用差分・ステージ済みファイルを検査し、秘密鍵/APIキー/Token形式、設定済み秘密値、SQLite実体・sidecar、ログ、アーカイブ、ローカル専用ファイルの混入は検出されなかった。登録情報はテスト用の合成値のみであり、実DB・実業務データを含めていない。

## 制約と申し送り

保証は正規Coordinatorによる同一Attemptの`Executor.execute()`開始が最大1回であること。Executor内部や外部システムのExactly-once、COMMITから呼出しまでの競合窓消滅は保証しない。Timeout/Abortは副作用の取消証明ではない。保存不能のIntentは再送せず、4C等の独立した結果照合へ引き継ぐ。

Windowsネイティブと他Node/SQLite版、実Identity Provider、実Executorアダプタの統合は未検証。Node版によってCOMMIT終了状態の観測が使えない場合、ACK喪失時に接続を閉じるFail Closed経路となるため、新しい認証付きReaderで履歴を確認する。結果回収窓はLeaseを延長しない。既定の開始60秒・実行30秒・保存猶予30秒、Evidence 16件/合計1 MiBの根拠と上限は設計書に記載した。

4B-2BのContinuation/PLAN/VERIFY/Resume/Hold解除、4Cの未知Usage精算は追加していない。2AのGrantをそれらの権限へ拡張しない。Draft PRの監査後にマージを判断し、mainへの直接Push・自動マージは行わない。
