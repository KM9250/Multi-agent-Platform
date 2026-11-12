# COORD-5C-4C レッドチーム検証

対象契約は `COORD-5C-4C:RECONCILIATION:1`、基準は `89d431e20cf1f6617d4095b9a8722d86fb711d1d`。最終実行SHAと全Suiteの結果は [検証記録](coordination-reconciliation-validation.md) を参照する。

## 試験境界と観測方法

[合成Fixture](../test/reconciliation-fixture.ts) は一時SQLite、実DurableDatabase、実Lease/Generation、実Grant、実SQL Trigger、実Auditを使う。鍵はNode標準暗号APIのEd25519で試験ごとに生成する。固定した公開鍵、Source system、合成account、test environmentで、canonical JSONのReceipt payload全体の署名を検証する。証拠本文が鍵、Algorithm、信頼Sourceを選ぶことはできない。Process試験の鍵素材は一時ディレクトリだけに保存し、Production exportやリポジトリへ含めない。

通常の操作者は検証された `RECOVERY_OPERATOR`、別の承認者は `RECOVERY_APPROVER`。必要な試験だけ別Admin、Viewer、同一人物の別credentialを生成する。IDを知ることと対象ACLを持つことを分け、Policyの安定したcallbackが返す現在のACLを変更して失効を試す。callback関数そのもののすり替えも別ケースで拒否する。

以下で **R** は `assertRefusedWithoutEffects` による、全ユーザー永続表の前後完全一致、Workflow snapshot一致、Action/Model/Lookup/Verifierカウンタ不変を指す。Plan/Applyの認可拒否ではGrantも未消費である。**V** はVerifier検証の拒否で、受付済み候補を保持し、有限のVerification Jobと開始Auditを除く全永続表が一致し、Action/Model/Lookupが0である。検証作業の記録を業務成功・精算・Grant消費に数えない。正常対照は同じFixtureの固定鍵Receiptを検証し、別ApproverのGrantで作成者本人が適用できることを確認する。

主な実装試験は [通常・異常系](../test/coordination-reconciliation.test.ts)、[レッドチーム](../test/coordination-reconciliation-redteam.test.ts)。以下のテスト名はファイル内のIDと先頭フレーズで検索できる。抽出したロジックだけのassertや、旧mainに新APIが存在しないことを攻撃検出の代替にしない。

## RT-C01〜RT-C20 の対応

| ID | 事前権限・攻撃対象・入力 | 期待と実観測 | 正常対照・実テスト・層 |
|---|---|---|---|
| RT-C01 | 提出権とAttempt IDを持つOperatorが `verified:true`、偽Verifier ID、管理者確認済みDTOを提出。事実台帳・認可Scopeの偽造を狙う。 | V。信頼Verification、Usage正本、Grantを生成せず、候補IDをVerification IDとしてPlanへ渡してもR。 | 固定鍵署名を持つEV-02は成功。`self-declared verified/admin/Verifier DTO`、実DB統合。 |
| RT-C02 | 正規署名を持つ外部Receiptのsummaryに「承認済み」「このツールを呼べ」を含める。証拠本文から承認・再送を誘発する。 | Verificationはデータとして保存可能だがGrant・Operationは0、TaskはASSIGNED、Executorは0。未承認ApplyはR。RunnerへはID/Digest/outcomeの固定投影だけを渡し、summary/署名/生本文を含めない。 | 同じ正規Receiptから明示Plan/Grantを経たOutcomeは成功。`instructions in signed evidence`、`runner facts contain authorized normalized references only`、実DB統合。モデルのPrompt Injection成功率は測定しない。 |
| RT-C03 | 合成Operatorが他workflow/target/attempt、他account/environment/source/domainの署名済み証跡を貼り付ける。別対象の予約解放を狙う。 | 各フィールドの変更を独立に試してV。対象正本0、予約維持。類似時刻・同額で対象を補完しない。 | 無改変ReceiptのEV-02が成功。`valid signature with a different ...`、`signed receipt for another ...`、実DB統合。 |
| RT-C04 | 正当な証跡のJSON順序や署名を変えて再提出し、別Workflow/Actionへ同じ外部Effectを割り当てる。 | Source Effect Keyは同一。既計上Attemptまたは別対象の新PlanをRで拒否。正本/Outcomeは各1。 | 別Source Effectの初回正常適用が対照。`reordered and re-signed receipt`、`same stable Source Effect cannot be assigned`、実DB統合。 |
| RT-C05 | 有効署名でpending/partial Usageや対象違いを提出。署名の真正性から完全性を飛躍させる。 | pending/partial事実は保持できるがPlan拒否R、予約全量維持。対象違いはV。0補完・部分解放なし。 | COMPLETE/FINAL/対象一致のUsageで1000予約→400確定・予約0。`signed pending usage`、EV-07/US-02、実DB統合。 |
| RT-C06 | 正規の消費済みPlanを再送し、新Operation IDを追加引数として渡す。 | 元Receiptだけを返し全表・カウンタ不変。公開DB commandへoperationId/force等を追加する経路はR。 | 初回だけCOMMITTED。`repeated plan with caller-selected replacement Operation ID`、`direct command extra ...`、実DB統合。 |
| RT-C07 | 承認後にVerifier関数/Registry binding/Policy版/証拠版を差替える。 | すべて適用前に拒否R。未消費Grantと元Ledgerを保持する。候補新版は追記で旧本文も保持。 | 同じBinding/Policy/Versionの正常適用。`replacing verifier implementation`、`removing trusted verifier binding`、`policy revision`、EV-03、実DB統合。 |
| RT-C08 | Actor/ApproverのUSE/APPLY権、保存候補の送信権、モデルへのsend ACLを途中で失効させる。 | 取得済み候補でもVerifier結果回収をVで拒否。ApplyはR。Approverの現在のUSEも検査。新Model予約後の送信権撤回では呼出し0・Usage0、予約は送信前取消。結果参照の読取りも現在ACLで拒否する。 | 同じActor/Grantの許可状態なら成功。`revoking access while the verifier waits`、`approver losing current claim-use ACL`、`current send ACL is checked after reserving`、実DB統合。 |
| RT-C09 | Getter/toJSON/Thenable/Proxy、深すぎるJSON、循環、過大候補、外部応答Accessorを使う。 | 候補はR、Verifier応答はV。Accessor・Proxy trap・thenの実行カウンタは0。非有限数値も保存前に拒否。 | plain JSONの正常Receipt。`candidate is refused before accessors`、`malicious ... verifier output`、実DB統合。 |
| RT-C10 | 登録Verifierが同じDBのStoreへ再入し、ModelをSETTLEDへ直接書き換える、または通常は有効なWorkflowCancelledを要求する。 | 書込みはRECOVERY_UNAUTHORIZEDで拒否。元LedgerはDISPATCH_INTENT、Usage正本0、Workflow不変。正規の検証結果だけを別の保存段階で記録でき、親Scopeを再利用しない。 | 再入を含まないVerifierが同じ結果を保存。取消WriterはVerifier外では成功する正常対照付き。`verifier runs outside parent DB mutation scope`、`verifier cannot invoke a normally valid Workflow cancellation`、実DB統合。任意OS権限の隔離保証ではない。 |
| RT-C11 | 生SQL/通常Lease/PLAN applicationからGrant・Evidence・Verification・PlanをUPDATE/DELETE。検査SQL、逃がしたTransaction、余分なforce/sql/callback、Task eventの偽参照も試す。 | R。SQL失敗をcatchしてもTransactionは毒化されCOMMIT不可。検査SQLは0を返しScopeを作らない。逃がしたTransactionは無効。偽reconciled resultRef/evidenceRefsでTaskは変化しない。 | 正規4C participantによる同種変更とTask適用は成功。`ordinary SQL scope`、`inspection SQL`、`direct command extra`、`ordinary Task... smuggle`、実DB統合。 |
| RT-C12 | Viewer/OperatorがAPPROVEを要求、別Operator/Adminが他者のPlanを開始、Adminが本文を要求。 | R。本人開始をGrant/会計変更より先に確認。Adminも本文ACLがなければ読めない。VIEW/PLANだけでは精算・他者閲覧へ進めない。 | 同一Planを正規Approver＋作成者で成功させる。AU-04/AU-10、`cannot approve a reconciliation`、実DB統合。 |
| RT-C13 | Approver Aが別Role/別credentialで二人分の承認を作る。 | Aは一人。2人PolicyでApplyはR。Actor Bを加えると一度成功。 | A+Bの独立Actorが対照。`two credentials and roles belonging to one actor`、実DB統合。 |
| RT-C14 | 同期CPU占有でtimer callbackを遅らせる、Caller abort後に遅延結果を返す。 | 単調時刻・実時刻の上限またはAbortを回収時にも確認してV。遅延結果に保存能力を与えない。 | 時間内の通常Verifier成功。`synchronous verifier CPU delay`、`caller cancellation during verification`、実DB統合。 |
| RT-C15 | 本文にURL/path/redirect/authorizationなど外部参照を入れ、任意読取りを誘導する。 | JSON候補として保存される場合も収集器として解釈せず、固定署名VerifierではV。Lookup/ネットワーク呼出し0。未対応Lookup契約はRegistry検査で拒否。 | 明示的に渡した固定署名本文は検証可能。`never interpreted as an evidence collection instruction`、実DB統合。実SSRF侵入試験ではない。 |
| RT-C16 | 提出権を持つActorが未検証矛盾や大量候補を送る。 | 未検証候補だけではControl/Hold/会計/Grantを変更しない。有限件数上限の次の提出をRで拒否する。 | 同じ上限内の正常候補は保存可能。`finite candidate quota`、`unverified contradictory candidate`、実DB統合。 |
| RT-C17 | 2つの正規Planまたは通常Settlementと4Cが同じAttemptを競合処理。 | authority/Usageが1、成功Operationが1、敗者Grantは未消費。通常先行・4C先行を両方確認。 | 両経路を個別に先行させた正常対照。US-07/08/10、CR-09/10、実DB統合と独立Nodeプロセス。Process境界は[Crash/競合試験](../test/coordination-reconciliation-process.test.ts)。 |
| RT-C18 | 古いLease/GenerationのWriterを復帰させ、旧通常応答または旧Grantを使う。 | R。現在Leaseを持つ新しい独立Verifier＋新承認だけがUsageを追記できる。元LedgerのGenerationは不変。検証待機中の交代でも遅延結果保存不可。 | 新Generationの正規4C精算が対照。US-13、`old generation approval`、`lease generation transition during verifier wait`、実DB統合とCR-08 Process試験。 |
| RT-C19 | 「該当なし」の署名を未実施確定として使い、遅れて送られ得る要求を再送可能にする。 | requestClosed/exhaustiveがないNOT_EXECUTED_FINALはV。Source終端を証明する正常証拠は事実記録できるが、元Attemptの再送はR。 | signed exhaustive source final rejectionが対照。EV-08/09、`lookup absence cannot prove final non-execution`、実DB統合。 |
| RT-C20 | 新しい検証済み矛盾の後、古い正規署名Receiptを再提出してDisputeを消そうとする。 | Dispute/Case/Controlを追記、Holdを維持、元会計・Receiptを保持。古いClaimでもPlanはR。Audit障害では新Verification/Dispute/Holdを部分COMMITしない。 | 矛盾前の初回正規精算と、矛盾のない再照会が対照。`later verified contradiction`、IN-07 Audit fault、実DB統合。Active InvocationのDrain/AbortはCR-06独立プロセス試験。 |

## 実行中に検出した問題と修正確認

最初の通常・レッドチーム実行は90件中81成功・9失敗だった。Action Ledgerに存在しないRuntime/Generation列からPlanを組み立てたため、正常Action系が拒否されていた。正規Dispatch Auditから元Generationを検証して固定する修正後、正常対照を再実行した。

次の実行は94件中91成功・3失敗だった。Task適用時に既存Seedの不変列までUPDATE対象に含めた問題と、封鎖済みAttemptの再送拒否前にGateがHold/Auditを追記した問題を修正した。残る1件は試験がPolicy callback関数そのものを置換していたため、意図した「現在ACLの変更」と区別し、安定したcallback内部のACLを変更するFixtureへ修正した。Assertionの緩和やSkip追加は行っていない。

その後、98件、107件、117件、119件、120件の段階的な拡張実行で各全件成功を確認した。これらは重複する途中実行なので合算しない。最終結果・追加Process試験数・最終SHAは検証記録を正とする。従来PR #35のF-01〜F-04/RT-01/RT-02を含む回帰は削除しない。今回の新API試験を、旧mainにあった脆弱性の再現件数とは表現しない。

## 残余範囲

合成Verifierの成功はGPT/Gemini/Claude、実Executor、実請求APIの出所・課金・相関・最終性を保証しない。本番Registry、Identity、対象ACL、固定価格表、実ProviderのToken包含関係・内部Retry・要求終端化・遅延証跡については別接続検証が必要である。任意コード実行/OS/DB管理権限を奪われた環境の隔離、完全な外部Exactly-once、実モデルへの全Prompt Injection耐性は主張しない。未接続の能力はFail Closedで、未検証案件の予約・義務・履歴を維持する。Linuxの独立Process試験とWindowsの未実施を混同しない。
