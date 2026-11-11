# PR #35 F-04 計画専用開始者の所有者契約修正

検証日: 2026-11-12（Asia/Tokyo）。基準HEADは `f514f01891751a88c208c0de62ac6d6e4c1b1049`、基準mainは `e4de47b6f5290ec566e26c6a7ffd22ae1e82ab5a`。既存Draft PR #35に追加する。最終HEADは自己参照を避け、PR本文に完全なSHAを記載する。

## 原因と最小修正

RECOVERY + PLANNING_ONLYでは別Operator/Adminによる開始が許され、質問のOwnerは開始者、PlanのcreatedByは作成者となっていた。質問・Usage・APPLIED・終了が確定した後、Readerが所有者不一致を拒否するため、初回取得と正規再照会が失敗していた。

`recoveryContinuationCoordinator.start()` のPLANNING_ONLYでは、OriginにかかわらずPlan作成者本人だけを許可する。既存Receiptを返す読取り経路と、Lease付き開始Transactionの両方で確認する。後者の検査はGrant消費・Resume・Invocation作成・モデル予約/呼出しより前に行う。読取りの間に状況が変わってもTransaction側の検査を省略しない。

USER_REQUESTのplanningRoles、RECOVERYのOperator/Admin、必要な承認・ACL・Lease・Budgetの検査は維持する。管理者停止と代理開始を混同しない。質問ReaderのOwner検査、ArtifactのOwner、レビューGate、STOPの認可、BOUNDED_CONTINUATION等の開始認可は変更しない。Migration 001〜009、Schema 9、依存関係・lockfileも変更しない。

## 統合再現・追加試験

添付のJSONは抽出した開始分岐と実Readerの単独試験の証拠として確認した。リポジトリ全体の統合試験と同一視せず、既存continuationFixtureを使い、実DurableDatabase・Lease・Grant・Trigger・Audit・合成Providerを通す `coordination-pr35-owner-binding.test.ts` を追加した。今回のアップロードは追補MarkdownとJSON 2件で、追補が参照する別添TypeScript試験案は含まれていない。

添付記録のintegrity、executionIntegrity、recoveryHoldLifecycle、planningArtifactStoreの4モジュールは、修正後も記載されたGit Blob SHAと一致している。単独試験23件を新たに実行したとは扱わず、以下に今回の統合実行結果を記載する。

前提は、共有Workflow `run` が正規のRecovery Hold下でSUSPENDED、作成者AliceがRECOVERY_OPERATOR、別開始者BobがRECOVERY_OPERATORまたはRECOVERY_ADMIN、別の正規Approverが承認済み。Workflow ACLは両者に許可し、明示Resumeと有効Leaseを用意する。planningRolesは既定のAdmin限定のままとし、RECOVERY本人のOperator開始を不必要に狭めていないことも確認する。

修正前に7試験を実行し、**3 pass / 4 fail / skip・cancelled・todo 0**。THINK_ONLY/PLAN_READ_ONLY × 別Operator/Adminの4組すべてで、要求がエラーになった時点では次の副作用が発生していた。

| 観測 | 修正前 | 修正後 |
| --- | --- | --- |
| モデル呼出し | 1回 | 0回 |
| Grant | CONSUMED | AUTHORIZEDのまま |
| Invocation | 1件作成 | 未作成 |
| 保存質問 | 1件作成 | 未作成 |
| Workflow | Resume済み、RUNNING | SUSPENDEDのまま、Snapshot不変 |
| Ledger・Receipt・Audit等 | 書込み済み | 全永続表の比較で不変 |

修正後は同じ7試験が全pass。4組それぞれで拒否後の同一Plan・同一GrantをAliceが開始し、検証済み質問のOwner=Alice、初回結果・同一接続の再照会・開始要求の再送・別DB接続のReaderで同じinputRequestを返すことを確認した。Bobおよび別Adminによる質問照会は引き続き拒否する。再照会でモデル/Read/Actionは追加されず、保存状態も変わらない。

残る3試験は、両ModeのUSER_REQUESTで作成者/指定planningRole検査を維持することと、別Adminによる承認済みBOUNDED_CONTINUATIONが正常完了することを確認する。後者はAction 1回の正常系であり、PLANNING_ONLY以外の開始権限を狭めていない対照である。

新規7件＋通常監査20件＋レッドチーム37件の先行検証は **64/64 pass**。F-01の実入力ACL、F-02の期限後の対象限定復旧、F-03の保存質問、RT-01の現在対象/期待Revisionと未完成修正の旧Gate維持、RT-02の本人/Admin停止・COMMIT後Abortを含む。独立したコードレビューでも、Readerや既存Role/STOPの権限緩和は確認されなかった。

## 一式の検証結果

実装・試験HEADは `807e812f7d69b6ba20f123feac63c0014327e878`。以後の変更は設計・検証文書のみ。

| コマンド | ファイル数 | ケース数 | pass | fail | skip | cancelled | todo | Exit |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `npm test` | 72 | 1505 | 1505 | 0 | 0 | 0 | 0 | 0 |
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

全体は **72ファイル・1,505件すべて成功**、fail/skip/cancelled/todo 0。MACPは別途9件成功。各subsetは全体の内数なので合算しない。型検査・ビルドを含む全15コマンドのExitは0。

Linux 6.18.57 x86_64 / Node v24.19.0 / npm 11.9.0 / SQLite 3.53.3。MACPは固定commit e88937d0c8132ae7d18098a24d01ee28bffda655と既存の合成環境で実行した。

既存の継続Crash36境界＋Migration4境界、別接続競合と実プロセスLease競合、0〜8→9・データ入りv8、DDL障害、001〜008 SQLの固定ハッシュを再検証した。基準mainの旧RuntimeがSchema9をSCHEMA_UNSUPPORTEDとして拒否し、Migration Ledgerを変更しない独立検査も成功した。既存Crash/Migration/監査テストの削除・skip・期待値緩和はない。

依存関係・lockfileは変更なし。APIキー追加なしのビルドは成功し、Viteの既存500 KiB超チャンク警告は残る。作業差分・staged差分・基準mainからHEADのgit diff --checkと、公開差分の秘密情報・実DB/WAL/SHM・ログ・生成物混入検査に成功した。


## 未検証事項と提出

本番Provider、Production Identity/ACLサービス・UI、公開HTTP API、ネットワークRead、Windowsネイティブ安全Readは今回も未接続・未検証。実Provider・実業務Executor・実運用DBを使用せず、既存のFail Closedを維持する。4C、代理開始の委任契約、既に旧実装で保存された不整合質問の移行・補修は追加しない。Readerの整合性・所有者検査を弱めて既存不整合を読み出す処理もない。

既存Draft PR #35への追加のみ。main直接Push、新規分割PR、自動マージは行わない。
