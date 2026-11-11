# PR #35 RT-01／RT-02 追加監査修正報告

本書はRT修正時点の検証記録。後続のF-04所有者契約の修正と全回帰再実行は [F-04修正報告](coordination-pr35-owner-binding-correction.md) を参照する。既存F-01〜F-03・RT-01／RT-02の契約と試験は維持している。

作業開始HEADは `22f522ff58bf9a0cb02b44874b6579f424070ae8`。追補の監査対象 `995c186e123e0b96d2a072db09b6d5acf1f0c078` に続くF-01〜F-03修正を含む最新PRブランチに追加した。基準mainは `e4de47b6f5290ec566e26c6a7ffd22ae1e82ab5a`。検証日: 2026-11-11（Asia/Tokyo）。最終HEADは自己参照を避け、既存Draft PR #35本文に完全なSHAを記載する。

## 修正と契約

| 指摘 | 修正 | 維持する動作 |
| --- | --- | --- |
| RT-01 | 現在のレビュー対象を不変Artifact/Review履歴とControlから導出し、ID・Version・Digest・Owner・期待Control Revisionを一致検査。ReviewとControlを同じCOMMITで更新。旧Artifactや古いRevisionは部分書込みなしで拒否。計画修正の開始・未完成・失敗・取消・Timeoutでは元のGateを保持 | 現在対象のOwnerによる受諾・却下・置換、完成新版の公開による対象交代。受諾だけでは実行Grantなし。実行承認・開始は別操作 |
| RT-02 | STOPを通常のPLAN認可から分離。現在の認証・Workflow VIEW ACL・有効Leaseに加え、Invocationのowner_id本人または検証済みRECOVERY_ADMINを要求。DB確定後だけAbort通知。ACK喪失時は今回の同じ不変STOP Receiptを再読取りして確認 | 本人の停止、PLAN/EXECUTE撤回後もVIEWを持つ本人の停止、明示的管理者停止。開始済みUsage回収、未知処理の保全、単回送信 |

`recordReview(ref, decision, credential, expectedControlRevision)` の第4引数を必須にした。`ContinuationInspection.review.target` は照会したArtifactが現在対象で、操作者がOwnerの場合だけ返す。古いAliceの照会からBobの現在対象を返さない。受諾もControl Revisionを1進めるため、同じRevisionによる二重判断は成立しない。実行用入力へのpreviousArtifact混入と、別の対象が待っているときの旧Artifactによる修正・採用も拒否する。

レビュー待ちの間は独立したArtifactを新規公開できず、修正の未完成時には旧Artifactが残り、完成新版の公開と旧版のSUPERSEDED・新しいGateは原子的。この不変条件のもとで、Workflowの最新の不変Artifactと最新Reviewから対象を導出する。最新履歴が不整合なら拒否し、古い対象へのフォールバックはしない。Schema 9とMigration 001〜009の生成SQLは今回変更していない。

STOPの拒否ではInvocation、Receipt、Auditを変更しない。停止状態とReceipt/AuditのCOMMITが成功した後、親Contextを外してローカルAbortを通知する。COMMIT前障害では通知しない。COMMIT ACK喪失は同じReceiptの完全一致によって確認し、別のReceiptや未確認の書込みで代用しない。別DB接続から確定したSTOPも応答回収時と計画反映Transactionで検査し、新しいRead/Model・Artifact公開を防ぐ。先にUsageだけ確定した場合も、元のレビューを保持し、未適用応答を自動再送しない。

主な変更は `recoveryContinuationCoordinator`、`recoveryContinuationPlanner`、`planningArtifactStore`、`continuationTypes` / `index`。既存のPermit、Invocation DebitとLedgerの原子性、Usage、Application Receipt、Lease/Generation、Audit、同期Timeout、F-01実入力ACL、F-02対象限定反映、F-03保存済み質問は維持する。4C・実Provider接続は追加しない。

## 再現条件と結果

既存 `continuationFixture` を利用し、実DurableDatabase、Lease、Trigger、Audit、Model Ledger、合成Providerまで通した。共有Workflowは `run`、Alice/BobはIdentity Verifierが発行した `RECOVERY_OPERATOR`、管理者は明示的な `RECOVERY_ADMIN`。未認証の自己申告Roleは受け付けない。通常の計画RoleにはOperatorを登録し、RT-02の攻撃前提ではAliceのVIEW/PLANを許可、EXECUTEを拒否。BobのInvocationは正規Leaseで開始済み。AliceがBobのinspectを拒否される対照も検査した。

受領できた追補はMarkdown本文のみで、本文が参照する別添 `.test.ts` は今回のアップロードには含まれていなかった。記載シナリオに基づき `coordination-pr35-redteam-regressions.test.ts` を既存fixtureと最終APIで作成して実行した。抽出SQLite試験や本番への侵入試験の実施とは区別する。

修正前の最新HEADで6試験を実行し、**0 pass / 6 fail / skip・cancelled・todo 0**。検出内容は、同一Ownerと別Ownerの旧A再却下によるB Gate解除、needs_inputと取消で旧Gate消失、PLANのみのAliceによるBob停止、STOP Rollback後のAbort通知。旧APIは第4引数を無視するため、同じテスト本文で再現できた。

修正後のRT回帰は **37件**。次の認可・順序・障害を固定した。

| 試験 | 期待・確認内容 |
| --- | --- |
| A却下→独立B→A再却下（同一/別Owner） | BのGate・Review・全DB表・外部カウンタ不変。正しいOwnerのB却下だけ解除 |
| 現在対象の受諾/却下/置換 | Revisionを1消費。受諾時はGate保持・追加Grantなし・Action 0。古いRevisionの再送はDB不変 |
| Version/Digest/Revision不一致・Revision欠落 | Review/Control/Auditの部分更新なし |
| 旧Artifactの修正・採用、実行入力へのpreviousArtifact混入 | Plan保存前に拒否。正常な完成新版は旧版をSUPERSEDEDにして新Gateへ交代 |
| needs_input・不正応答・Unknown・取消・Timeout | 元のGate保持、通常Runner開始拒否。質問本文の保存と再照会契約を維持 |
| Reviewの別接続競合・Audit障害・COMMIT前障害/ACK喪失 | 期待Revisionに対する判断は1件。ReviewとControlが共に保存されるか、共に未保存 |
| PLANだけの非Owner・未認証・偽Admin・Viewer・VIEW拒否・別Workflow・不存在・Leaseなし | Invocation/Receipt/AuditとProvider Signalは不変 |
| Owner・PLAN/EXECUTE撤回後のOwner・明示Admin | DRAININGとSTOP Receipt。Usage回収、Artifact公開なし、新しい外部Callなし |
| STOPの別接続競合・重複・Audit障害・COMMIT前障害/ACK喪失 | STOP Receipt 1件、Abort 1回。RollbackではSignal不変。Abort listenerにDB権限を渡さない |
| 別接続STOP後のread_requests応答、Usage確定後のSTOP | 新規Read/Modelと修正Artifact公開なし、元のGate保持、開始済みUsage保存 |

別接続競合は同じ正規Leaseを使う同一プロセス内の2つのDB接続へ競合要求を投入した。実プロセス間のLease/開始競合は既存Suiteでも再実行する。レビューとSTOPのCOMMIT直前/直後に実子プロセスをSIGKILLする4境界を追加。継続Crashは36境界、Migration DDL/COMMITは別の4境界。再起動後に同じ保存IDを要求しても外部カウンタ不変、Review/Control、STOP/Invocation/Audit、Artifact/APPLIEDの整合を検査する。

開発中の最初の修正バッチは35件中33 pass / 2 fail。STOPの所有者列をactor_idと参照した実装誤りを、既存Schemaのowner_idへ修正した。試験の期待値や認可を緩めていない。その後、RT35件＋既存F回帰20件の55件、RT35件＋Crash36件の71件、RT37件＋正常計画/採用/Hold回帰の82件がすべて成功した。

## 最終一式の検証

全体・各Suite・ビルドの実行HEADは `1cb76ecda94a0a2c060a0299ed0ff9ae38fd676c`。Linux 6.18.57 x86_64 / Node v24.19.0 / npm 11.9.0 / SQLite 3.53.3。

初回の一式では実行試験とビルドが成功し、型検査だけExit 2。追加テストの応答引数がunknownだったことと、意図的な不正Artifact fixtureに型境界を明示していなかったことの2件を修正した。型注釈だけを変更した `8cf497b32365f151aa44a612883288ab0848f07a` で型検査はExit 0、RT37件も全pass。TypeScriptでコメントを除いて生成したJavaScriptが変更前後で完全一致することを検査した（SHA-256: `ca2fe54ec96e9530cacba5811fb12f67c7b076cc3f50237cff246d137016717e`）。Productionコード・Assertion・実行時の入力は不変。以後の変更は設計・検証文書のみ。

| コマンド | ファイル数 | ケース数 | pass | fail | skip | cancelled | todo | Exit |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `npm test` | 71 | 1498 | 1498 | 0 | 0 | 0 | 0 | 0 |
| `npm run test:durable` | 11 | 163 | 163 | 0 | 0 | 0 | 0 | 0 |
| `npm run test:durable-execution` | 7 | 111 | 111 | 0 | 0 | 0 | 0 | 0 |
| `npm run test:recovery-reader` | 25 | 495 | 495 | 0 | 0 | 0 | 0 | 0 |
| `npm run test:runtime-lease` | 5 | 46 | 46 | 0 | 0 | 0 | 0 | 0 |
| `npm run test:model-call-ledger` | 4 | 103 | 103 | 0 | 0 | 0 | 0 | 0 |
| `npm run test:recovery-authorization` | 3 | 90 | 90 | 0 | 0 | 0 | 0 | 0 |
| `npm run test:recovery-execution` | 5 | 119 | 119 | 0 | 0 | 0 | 0 | 0 |
| `npm run test:recovery-dispatch` | 4 | 106 | 106 | 0 | 0 | 0 | 0 | 0 |
| `npm run test:recovery-continuation` | 7 | 92 | 92 | 0 | 0 | 0 | 0 | 0 |
| `npm run test:planning-only` | 4 | 52 | 52 | 0 | 0 | 0 | 0 | 0 |
| `npm run test:hold-lifecycle` | 1 | 5 | 5 | 0 | 0 | 0 | 0 | 0 |
| `npm run test:macp` | 1 | 9 | 9 | 0 | 0 | 0 | 0 | 0 |
| `npm run typecheck` | — | — | — | — | — | — | — | 0 |
| `npm run build` | — | — | — | — | — | — | — | 0 |

`npm test` は **71ファイル・1,498件すべて成功**、fail/skip/cancelled/todo 0。MACPは別途9件成功。各subsetは全体の内数なので合算しません。MACPは固定commit `e88937d0c8132ae7d18098a24d01ee28bffda655` と既存のローカル合成環境で検証しました。

表は各コマンドの最終結果で、15コマンドともExit 0。全体の実行試験で失敗・skip・期待値緩和はない。型検査の初回失敗と型注釈修正後の再検証は上記の履歴に記録した。0〜8→9、新規DB・データ入りv8、Migration競合・DDL障害・SIGKILL、001〜008生成SQLの固定SHA-256、既存の全安全契約の回帰を含む。基準mainのserviceソース108ファイルのGit Blob SHA一致を確認した旧Runtimeで、Schema9をSCHEMA_UNSUPPORTEDとして拒否し、Migration Ledger不変であることも独立して確認した。

依存関係・lockfileは変更なし。型検査とAPIキー追加なしのビルドは成功し、Viteの既存500 KiB超チャンク警告は残る。作業差分・staged差分・基準mainからHEADのgit diff --check、公開差分の秘密情報パターン・既知資格情報値・実DB/WAL/SHM・ログ・生成物・バイナリ混入検査を実施し、検出なし。資格情報値をログや成果物には出力していない。


## 未検証・引継ぎ

本番Provider、Production Identity/ACLサービス・UI、公開HTTP API、ネットワークRead、Windowsネイティブ安全Readは未接続・未検証。実Provider・実業務Executor・実運用DBへの攻撃や変更は行っていない。既存のFail Closedを維持し、合成試験を実接続の侵入試験完了と扱わない。Unknown、失われた本文、Crash後Intentの外部照合は4Cへ保全し、自動再送や推測精算を追加しない。

既存Draft PR #35への追加のみ。main直接Push、新しい分割PR、自動マージは行わない。最終HEAD・全コマンドの結果・未検証事項は同PR本文でも確認できる。
