# PR #36 監査修正記録

これは `87ef2b50b9dc9d4548d5965039b70a2a82a96870` 提出時のF-01／RT-01／RT-02の記録である。これらを維持した追加F-02修正と最新の全検証は[F-02修正記録](coordination-reconciliation-pr36-f02.md)を参照。「この後の変更は文書のみ」は当時の提出範囲を指す。

監査基準HEAD: `2baf04df3532f240a87178cf336f89bc42f05de3`。基準main: `89d431e20cf1f6617d4095b9a8722d86fb711d1d`。修正ソース: `d377dd312832209d8e5bf39b58326d1decc0a2cd`。この後の変更は文書のみ。公開時の最終HEADはPR本文に記録する。Branchは既存の `codex/coord-5c-4c-evidence-reconciliation`。記録日: 2026-11-12（Asia/Tokyo）。

この文書のF-01／RT-01／RT-02はPR #36の監査IDで、PR #35の同名IDとは別である。Schema 10、Contract `COORD-5C-4C:RECONCILIATION:1`を維持し、Migration 001〜010・依存・lockfileを変更していない。

## 修正した契約

| ID | 原因 | 修正した境界 |
| --- | --- | --- |
| F-01 | Task反映にも元Verificationの現在の期限を要求し、採用済みOutcomeからの正規経路が閉じていた。 | `APPLY_RECONCILED_ACTION_RESULT`だけは、同じAttempt／Verification／Source Effectに結び付いた、期限内にCOMMIT済みのOutcome Receiptを履歴として検証する。現在のBinding・明示的失効・Dispute・対象Digest・ACL・Lease・Task／Session／Workflow・新Plan／Grantは引き続き検証する。 |
| RT-01 | Verification保存時にだけ通常事実との矛盾を調べ、逆順の通常Settlement／Action結果保存に検査がなかった。 | DB所有TransactionのCOMMIT前に、新しく保存されたNORMAL正本／Action結果を識別し、同じAttemptの保存済み・完全・最終・検証済みReceiptと照合する。通常事実とDispute／Case／Hold／必要なDrain／Auditを同一COMMITにする。 |
| RT-02 | 初回の正常返却だけが出力検査を通らず、キャッシュにもVIEW_CASEの確認不足があった。 | 初回、キャッシュ、ACK復旧、明示的`readVerification`は同じ出力ヘルパーを使う。現在のIdentity、VIEW_CASE、本文Ownerに対するUSE_EVIDENCE、返すReceipt全体へのOUTPUT検査を毎回行う。 |

F-01の採用期限は、最初の肯定的解決に対する期限である。未採用の期限切れVerificationを採用できるようにはしていない。採用済みOutcomeと元Verificationは上書きせず、新しい証拠版や別Source Effectで代用しない。後から提出された未検証候補の版だけで採用済み事実を無効化せず、検証済み矛盾・現在の信頼失効は適用拒否へ接続する。APPLYの作成・承認・適用で同じ検査を行い、承認者の現在ACLも再検査する。最後の期限確認は新しいPlan／Grant／Actorを対象とし、元Verification／Invocation／Generationを変更しない。APPLY Receiptは元Outcome Receiptまで検証し、両方を後続の履歴Readerから読める。

RT-01のDB participantはDTOや公開の汎用書込みCapabilityではない。通常事実の前後差分をDBが識別し、同じTransactionで固定行Scopeを使う。Audit Actor `system:normal-fact`は通常事実の整合性検査を示し、人間の承認を装わない。未検証候補・Partial Claim・別AttemptからHoldを変更せず、Grantも消費しない。既存の正本一意制約と通常Settlement Triggerは変更していない。通常Usageはその値のままJournalとNORMAL正本に一度だけ記録し、異なる検証値は元Receiptに保持する。高低の選択、合算、上書き、差額相殺はしない。同じDisputeの再追加は抑止する。現在の有効会計・Gate・Readerは従来の共通Dispute投影を使う。

Normal factの変更がない候補受付やReaderから、過去の矛盾を修復する書込みはしない。新たにCOMMITする通常事実が対象であり、旧版で既に見逃されたDBを自動走査・変更するMigrationは追加していない。明示的な後続Verificationは従来どおり矛盾検出を行う。

Abortは通常事実とDisputeのCOMMITを確認し、Transaction／固定行Scopeを破棄した後、外部callbackの書込み禁止境界から通知する。実行中InvocationはDRAININGにし、自動再開・Hold解除・再送はしない。Rollbackでは通知しない。COMMIT ACKを失ってもSQLiteがTransaction終了を確認した場合だけ通知し、再精算は保存済み通常Receiptで回復する。

RT-02で表示を拒否しても、正常COMMITしたVerificationと有限Jobは保持する。表示拒否は固定コード `RECOVERY_UNAUTHORIZED` で返し、生Claim・証拠・資格情報・callback例外をエラーに含めない。ACK喪失から保存済みReceiptを発見した場合も、表示検査を省略しない。出力許可を持つActorは同じ保存IDを読め、Verifierと元Action／Modelを呼び直さない。OUTPUT検査はClaimだけでなくReceiptのメタデータも含む。

## 実DBでの修正前後比較

添付文書内のテスト案ファイル自体はアップロードされていないため、文書の再現条件を既存fixtureに実装した。一時SQLite、実DurableDatabase／Lease／ACL／Grant／SQL Trigger／AuditとNode標準Ed25519署名を使った。抽出した判定ロジックや観測用スタブを、統合試験の代用にはしていない。

監査HEAD上で最初の11件を実行し、6 pass／5 failを観測した。失敗は、採用済みActionの期限後APPLY、Verification先行時の異なるModel Usage、同じ逆順のAction事実、初回OUTPUT拒否、初回VIEW_CASE拒否である。同値・通常事実先行の6件は正常対照として成功した。同じ11件は修正後11 passになった。

さらに監査HEADを`git archive`した無変更の製品ソースへ、完成した試験5ファイルだけを重ねて再比較した。67件中42 pass／25 fail、skip／cancelled／todoは0。25は失敗したAssertionの件数で、25個の独立した脆弱性ではない。ACK拒否4件は旧版でもデータを返さず、`DATABASE_ERROR`が表示拒否コードと不一致だった。期限後APPLYの旧版Crashケースは適用入口で拒否されてSIGKILL境界へ到達しないため、旧版の部分COMMITを観測したという意味ではない。完成後の同一試験は最終全体回帰に含めた。

| 試験と場所 | 観測内容 |
| --- | --- |
| [追加監査回帰](../test/coordination-reconciliation-redteam-pr36.test.ts): `PR36 F-01` | 実時間の期限超過後、新Plan／GrantでTask反映1回。未採用・失効・Dispute・別Verification／Source Effect・別Attemptを副作用なしで拒否。旧Ledger／期限・Outcome Receiptを保持。Audit障害Rollback、COMMIT ACK喪失、Grant単回消費、元外部0。 |
| 同ファイル: `PR36 RT-01: … first` | Model／Action各々の両到着順×同値／異値。異値はDispute・HELD・Reader義務・新規実行拒否、同値は誤Disputeなし。NORMAL正本とUsageは1件、負けたGrantはAUTHORIZEDのまま。 |
| 同ファイル: `PR36 RT-01: CANDIDATE／PARTIAL／OTHER_TARGET` | 未検証・不完全・別対象の事実だけでは別AttemptのHold／Controlを変更しない。 |
| 同ファイル: `PR36 RT-01: normal Settlement conflict …` | Auditの実SQLite Trigger障害で通常Usage・Dispute・HoldをRollback。ACK喪失では保存済み正本を回復。再試行でDispute／Journalを重複させない。 |
| 同ファイル: `PR36 RT-01: conflicting normal response …` | 実Bounded Invocationの通常応答で矛盾を検出。DB確定後のDrain通知とInvocation controllerのAbortを観測し、通知中の親DB書込みを拒否。Providerは1回、Task／Planning artifactは適用しない。 |
| 同ファイル: `PR36 RT-02` | 初回／キャッシュ／明示読取／ACKで現在のVIEW_CASE／USE_EVIDENCE／OUTPUTを確認。NORMALIZED段階での権限変更、分類callback例外、Receiptメタデータ拒否、許可後の同一ID読取。Verifierは1回、元外部0、保存済み事実・全表は再照会で不変。 |
| [既存プロセス競合への追加](../test/coordination-reconciliation-process.test.ts): `PR36 RT-01 different Usage` | 独立接続・NodeプロセスのNORMAL先行は500 micro-USDを記録し、先行Verificationの400との矛盾を保持。RECONCILED先行は400を確定し、旧通常WriterはLease fencingで拒否。両ケースで正本1件、敗者Grant未消費。fenceで拒否した旧Writerを「採用済みの通常事実」とは数えない。 |
| [Crashへの追加](../test/coordination-reconciliation-crash.test.ts): `PR36 F-01/CR-07 … expired-apply` | 期限後APPLYの実SIGKILL前後でTaskイベント・Grant・Application Receipt・Control／Auditの全体Rollback／COMMITを検証。再起動は認証付き読取だけ。 |
| [通常精算Crash](../test/coordination-reconciliation-pr36-process.test.ts): `PR36 RT-01: real SIGKILL …` | 通常Usage 500とDispute／Case／Hold／Auditが、COMMIT前後のSIGKILLで一括Rollback／確定。Grant／照合Usage不変、再起動照会で追加実行なし。 |

プロセス競合は非移譲Leaseの実契約を使い、同時に有効な二人のOwnerを偽装していない。完全な外部Exactly-onceの証明ではない。

## 実装中の試験修正

- 追加33件の最初の実行は32 pass／1 fail。OTHER_TARGET fixtureが、未完了Modelの存在下で別Modelを新規予約しようとして既存Gateに拒否された。先行する別Targetを正規に通常精算してから対象Modelを作る手順へ訂正した。Gateは緩めていない。
- Active通知試験の最初の実行では存在しない正本の数値列を参照して失敗したため、既存`usage_json`から実Usageを確認するよう訂正した。
- 続く全体実行は1,734件中1,733 pass／1 fail。Providerのper-call signalは通常の後片付けでもAbortされるため、そのListenerでInvocationがDRAININGであると仮定したAssertionが非同期に失敗した。実Drain通知内のInvocation controllerを観測するよう訂正し、通知1回、COMMIT済みDB、外部権限境界を確認した。この修正による製品コードの緩和はない。追加監査回帰34件は全件成功した。

これらの失敗・重複実行を最終成功件数へ合算しない。

## 最終検証

全体1,733件成功。初回提出1,693件に対して追加40件。照合専用228件（うち監査・レッドチーム112件）、Crash／Process系33件、Migration24件を含む。これらは重複するサブセットであり、合算しない。全Suiteのfail／skip／cancelled／todoは0。下表は同じ修正ソースで実行した実測値。

| コマンド | 試験ファイル数 | tests / pass / fail / skipped / cancelled / todo | Exit | 秒 |
| --- | ---: | --- | ---: | ---: |
| `npm test` | 82 | 1733 / 1733 / 0 / 0 / 0 / 0 | 0 | 133.743 |
| `npm run test:durable` | 11 | 163 / 163 / 0 / 0 / 0 / 0 | 0 | 36.186 |
| `npm run test:durable-execution` | 7 | 111 / 111 / 0 / 0 / 0 / 0 | 0 | 32.555 |
| `npm run test:recovery-reader` | 25 | 495 / 495 / 0 / 0 / 0 / 0 | 0 | 54.114 |
| `npm run test:runtime-lease` | 5 | 46 / 46 / 0 / 0 / 0 / 0 | 0 | 7.503 |
| `npm run test:model-call-ledger` | 4 | 103 / 103 / 0 / 0 / 0 / 0 | 0 | 6.747 |
| `npm run test:recovery-authorization` | 3 | 90 / 90 / 0 / 0 / 0 / 0 | 0 | 5.783 |
| `npm run test:recovery-execution` | 5 | 119 / 119 / 0 / 0 / 0 / 0 | 0 | 9.128 |
| `npm run test:recovery-dispatch` | 4 | 106 / 106 / 0 / 0 / 0 / 0 | 0 | 11.266 |
| `npm run test:recovery-continuation` | 7 | 92 / 92 / 0 / 0 / 0 / 0 | 0 | 28.847 |
| `npm run test:planning-only` | 4 | 52 / 52 / 0 / 0 / 0 / 0 | 0 | 3.241 |
| `npm run test:hold-lifecycle` | 1 | 5 / 5 / 0 / 0 / 0 / 0 | 0 | 1.060 |
| `npm run test:reconciliation` | 10 | 228 / 228 / 0 / 0 / 0 / 0 | 0 | 29.254 |
| `npm run test:reconciliation-redteam` | 2 | 112 / 112 / 0 / 0 / 0 / 0 | 0 | 6.167 |
| `npm run test:macp` | 1 | 9 / 9 / 0 / 0 / 0 / 0 | 0 | 1.187 |
| `npm run typecheck` | — | 静的検査／ビルド／差分検査（試験件数なし） | 0 | 3.177 |
| `npm run build` | — | 静的検査／ビルド／差分検査（試験件数なし） | 0 | 1.947 |
| `git diff --check` | — | 静的検査／ビルド／差分検査（試験件数なし） | 0 | 0.003 |
| `git diff --cached --check` | — | 静的検査／ビルド／差分検査（試験件数なし） | 0 | 0.002 |
| `git diff --check 2baf04df3532f240a87178cf336f89bc42f05de3..HEAD` | — | 静的検査／ビルド／差分検査（試験件数なし） | 0 | 0.003 |
| `git diff --check 89d431e20cf1f6617d4095b9a8722d86fb711d1d..HEAD` | — | 静的検査／ビルド／差分検査（試験件数なし） | 0 | 0.008 |

Vite buildは成功し、既存の500 kB超chunk警告を出力した。文書確定後にも作業差分・ステージ差分・両基準との差分検査を実行した。

Linux／Node v24.19.0／npm 11.9.0／SQLite 3.53.3。MACPは固定参照 `e88937d0c8132ae7d18098a24d01ee28bffda655` のローカルFastAPI・SQLite・SSEを使用した。既存のPR #35監査／レッドチーム、4B-2A単調時計Timeout、Migration 0〜9→10、旧Runtime拒否、001〜009 SQLハッシュ不変を維持する。

## 公開差分と未実施範囲

公開差分のパス・内容走査とレビューで、秘密情報・実証拠・DB/WAL/SHM・鍵・ログ・バイナリ生成物の混入がないことを確認した。鍵は合成試験時に生成し、ログ・基準ソースの一時展開・DBは公開対象外の`work/`または一時ディレクトリだけに保存する。

本番GPT/Gemini/Claude／Executorの証跡・請求契約、Production Identity／ACL、管理API／UI、Windowsプロセス試験は未接続または未実施で、成功件数に含めない。元Action／Modelの再送、推測によるUsage補完や回答復元、WorkflowResume、Hold自動解除は追加しない。mainへの直接Push、新しい分割PR、自動マージは行わない。
