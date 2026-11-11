# COORD-5C-4B-2B 検証報告

この文書は初回PR #35提出時（`995c186e123e0b96d2a072db09b6d5acf1f0c078`）の結果を保持する。F-01〜F-03修正後の最新結果は [監査修正報告](coordination-pr35-audit-corrections.md) を参照。

基準main: `e4de47b6f5290ec566e26c6a7ffd22ae1e82ab5a`。ブランチ: `codex/coord-5c-4b-2b`。検証日: 2026-11-11。最終HEADは、この報告を含むコミット自身のSHAを埋め込む循環を避け、Draft PR本文に完全な値を記載する。

設計・API・制約: [coordination-recovery-continuation.md](coordination-recovery-continuation.md)。Schema9 / 009_bounded_continuation_hold_lifecycle / COORD-5C-4B2B:BOUNDED_EXECUTION:1。

## 実行環境

Linux `6.18.57` x86_64、Node `v24.19.0`、npm `11.9.0`、SQLite `3.53.3`。一時DB・合成データ・合成Provider/Executorを使用。実運用DBへMigrationせず、有料モデル呼出しや実業務Actionを行っていない。Windowsネイティブは未検証。安全なローカルReadはLinuxのみ対応し、その他のOSでは拒否する。

## 通常コマンドの結果

各subsetは `npm test` の内数であり、重複加算しない。MACPは別のローカル統合試験。ファイル数とケース数を区別する。

| コマンド | ファイル数 | ケース数 | pass | fail | skip | cancelled | todo | Exit |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `npm test` | 69 | 1435 | 1435 | 0 | 0 | 0 | 0 | 0 |
| `npm run test:durable` | 11 | 163 | 163 | 0 | 0 | 0 | 0 | 0 |
| `npm run test:durable-execution` | 7 | 111 | 111 | 0 | 0 | 0 | 0 | 0 |
| `npm run test:recovery-reader` | 25 | 489 | 489 | 0 | 0 | 0 | 0 | 0 |
| `npm run test:runtime-lease` | 5 | 46 | 46 | 0 | 0 | 0 | 0 | 0 |
| `npm run test:model-call-ledger` | 4 | 103 | 103 | 0 | 0 | 0 | 0 | 0 |
| `npm run test:recovery-authorization` | 3 | 90 | 90 | 0 | 0 | 0 | 0 | 0 |
| `npm run test:recovery-execution` | 5 | 119 | 119 | 0 | 0 | 0 | 0 | 0 |
| `npm run test:recovery-dispatch` | 4 | 106 | 106 | 0 | 0 | 0 | 0 | 0 |
| `npm run test:recovery-continuation` | 7 | 86 | 86 | 0 | 0 | 0 | 0 | 0 |
| `npm run test:planning-only` | 4 | 52 | 52 | 0 | 0 | 0 | 0 | 0 |
| `npm run test:hold-lifecycle` | 1 | 5 | 5 | 0 | 0 | 0 | 0 | 0 |
| `npm run test:macp` | 1 | 9 | 9 | 0 | 0 | 0 | 0 | 0 |
| `npm run typecheck` | — | — | — | — | — | — | — | 0 |
| `npm run build` | — | — | — | — | — | — | — | 0 |

全体は69ファイル、1,435ケース。新規3コマンドは合計12ファイル、143ケースで、全体に含まれる。全コマンドを既存の通常設定で実行し、skip/cancelled/todoは0。型検査・ビルドも成功した。

最終一式の検証対象ソース・試験commitは `7a0c6753013707dc8e7a91f15a63ec4dbd48166e`。以後の変更は本設計・検証文書だけで、最終HEADはPR本文に記載する。

`git diff --check`、`git diff --cached --check`、基準mainからHEADへの `git diff --check` を実施。公開前の差分検査でCredential/APIキー、実DB/WAL/SHM、ログ、キャッシュ、生成dist、取得repo/venv等の混入は検出されなかった。

`npm ci` は初回、既定npmキャッシュの権限不足で失敗。`npm ci --cache /workspace/.npm-cache` で成功した。依存関係・lockfileは変更していない。型検査とAPIキー設定を追加しないビルドを実施。Viteの既存500 KiB超チャンク警告は残る。

MACPは固定commit `e88937d0c8132ae7d18098a24d01ee28bffda655` を別の一時作業領域へ取得し、ローカルvenvのFastAPI/SQLite/SSEで既存統合スクリプトを実行した。`MACP_REPO_PATH` と `MACP_PYTHON` を明示し、外部本番サービスを使わず9ケース成功。通常のnpm testにこの9件を合算しない。

## 試験マトリクスと証拠

| 指示書ID | 主な自動試験と確認内容 |
| --- | --- |
| P01–P03、P07–P08、P11、P13 | planning-only: 専用出力、Action/prepare 0、Artifact/APPLIED/COMPLETED/Review Gate、Read後の計画完成、全Summary状態、未完成時の停止 |
| P04–P06 | planning-only-boundaries / continuation-authorization: traversal/Root/symlink/UNC/ADS/サイズ/変更検出、未登録URL・偽Read Registry・宛先拒否、文書中命令が権限を変更しない |
| P09–P10 | planning-only-adoption: 内容受諾→別実行Plan→Grant→開始の分離、旧版・Policy・Provider/Executor・参照変更の拒否、登録直前の再検証 |
| P12 | planning-only-adoption / boundaries: 独立Snapshot計画が元Workflow・元Usageを変更しない。通常要求へResumeを混入しても拒否 |
| P14–P15、I02–I03、I05、I07 | planning-only-atomic / continuation-crash: 予約・Debit・Intent・Artifact・Usage・APPLIEDの原子性、開始／Artifact ACK喪失時の再送なし |
| A01–A04 | continuation-authorization / continuation / adoption: 契約・Mode・Origin、信頼したRole、人数不足、自己承認、取消、期限、Binding変更、開始対取消 |
| I01、I18 | continuation-race / planning-only-boundaries / crash: 2接続・2実Nodeプロセス、ACTIVE/DRAINING最大1、再起動・別DB・再要求で権限再発行なし |
| I04–I10 | continuation / boundaries: Round・Model・Action・Readの枠、2Round目の2Action拒否、WorkflowとInvocation双方のToken/費用、整数境界、総出力Usage、Unknown予約保持、元wall time維持 |
| I11–I12 | boundaries / adoption: Provider/Executor/prepare/Thenableの親Scope非伝播、直接SQL/Store再入拒否、対象限定Evidence、参照変更拒否 |
| I13–I14 | continuation-boundaries / continuation / planning-only: 解決済み旧VERIFYのlineageと新Usage、Unknown置換拒否、PLAN登録・VERIFY評価・Artifact専用Application |
| I15–I17 | authorization / atomic / boundaries: DRAININGは新規開始禁止、既存Usage保存、具体的Action Review、Result ACK喪失で追加実行なし、既存Resultの不変性 |
| R01–R04 | continuation / authorization: 指定TaskのVERIFYのみ、PREPAREDの正しいAction Reference付きResume、誤Reference・未知・Terminal拒否。既存Security/Evidenceのfirst-Resume回帰も維持 |
| H01–H07 | hold-lifecycle / migration: 原本・共通Control、解除は別承認かつ外部0、完了後もHELD、Generation再Hold、Heartbeat不変、旧Receipt検証と未消費旧Grant失効 |
| T01–T05 | boundaries / authorization、既存2A F-01: Model/Action/Readの同期90ms対25ms、遅延Evidence拒否、完全Usageだけ回収、回収窓外予約保持、旧Generation保存拒否、開始/受付期限 |
| C01–C05 | continuation-crash / atomic: 開始・各Intent・外部入口・Usage・Artifact・Result・終了・解除・再Holdの前後で実SIGKILL。独立ファイルの外部カウンタを再起動・再要求後にも比較 |
| M01–M02 | continuation-migration: 0〜8→9、データ入りv8のGrant/Receipt、停止中v8の安全投影、DDL障害、DDL/COMMIT前後SIGKILL、001〜008生成SQLのSHA-256不変 |
| M03–M05 | npm testと全既存subset、MACP、Reader/Timeline/DTO/ACL試験。旧通常・非Durable・4B-1・2A経路、所属/所有者・閲覧権を検査 |

新しいCrash Suiteは実子プロセスSIGKILLを30境界、Migrationをさらに4境界で試験する。Crash後の再要求を別プロセスから実行し、外部カウンタ増加なし、Ledger/Debit/開始Receiptの一致、Artifact→APPLIED、外部キー整合を検査する。開始ACK喪失ではInvocationと消費済みGrantがあっても外部呼出し0。Artifact ACK喪失では同じArtifactを照会する。

Migrationのハッシュは要求された基準mainの実生成SQLを採取して固定した。さらに基準commitの実際の旧Runtimeを別ディレクトリで実行し、Schema9 DBを `SCHEMA_UNSUPPORTED` で拒否し、Migration Ledgerが変わらないことを確認した。

## 初回失敗と修正履歴

全回帰の初回は1,299件中1,250 pass / 49 fail、skip/cancelled/todo 0。現行Schema期待値、故意の破損を投入するfixtureのSQL関数定義、Lease再取得時のHold原本Originを修正した。過去MigrationのSQLや歴史的なRollback期待値は変更していない。2回目は1,412件すべて成功。

追加試験の開発中には、Artifact複合FKのDDL列順、テスト側Reader API名、Action検証内の禁止されたネストread、VERIFY試験の列挙値、getter出力を正常扱いしていた試験期待値の失敗があった。DDLは正しい列順へ、Action検証は既存Transaction参加へ修正した。Getterは実行せず拒否する既存JSON契約を維持し、Thenableの処理も親Scope外へ分離した。各失敗を修正して関連Suiteを再実行した。

最終監査で、旧RecoveryReaderが解除済みHoldに属する過去4B-1履歴を検証できなくなる箇所を発見した。歴史的検証には原本、有効状態表示にはControlを使うよう修正し、解除後の旧Receiptと計画Review表示を回帰試験へ追加した。

解除後の既存2A Plan作成も、原本を保持して新Epochへ再Holdするようにし、同一COMMITの回帰を追加した。認証済み停止要求は操作者を持つSTOP ReceiptとしてAuditと同時保存する。

最終差分監査では、4B-1のDISCARDED_BY_RECOVERYを正しく検証済みでも、Application入口が歴史的PENDING_APPLICATIONを再び未解決として扱う箇所も発見した。旧Ledgerを変更せず、既存の解決Receipt検証を通した有効状態で判定するよう修正。追加した同じ回帰試験は修正前0 pass / 1 fail、修正後に旧Call→解決Receipt→新VERIFYとUsage/APPLIEDの成功を確認した。

| 開発中に失敗した試験バッチ | pass / fail | 主な修正 |
| --- | --- | --- |
| 基盤の既存Dispatch回帰 | 92 / 14 | Schema期待値 |
| 初期限定Runner | 0 / 2 | 正規Resume authorizationの検証 |
| 初回全回帰 | 1250 / 49 | Schema・破損fixture・Hold Origin |
| 既存回帰の修正途中 | 75 / 3 | SQL観測関数の引数数・Generation Trigger fixture |
| Deadline/lineage追加直後 | 0 / 10 | Artifact複合FKのDDL列順 |
| Migration/実プロセス競合 | 18 / 1 | 試験側のReaderメソッド名 |
| 計画採用経路 | 47 / 1 | ネストreadを既存Transaction参加へ変更 |
| Getter境界の初期期待値 | 33 / 1 | 非JSON出力は拒否しGetterを実行しない契約に修正 |
| 4B-1破棄後の新VERIFY再現 | 0 / 1 | 検証済み有効Model状態でApplicationを検査 |

これらは開発中の異なる差分に対する結果で、最終成功件数には合算しない。成功するまで単に再実行する対応はしていない。

## 未検証・接続未対応

- GPT/Gemini/Claudeの本番Adapter、実課金・Streaming、内部Retry/Tool制御の本番保証、Opaque provider continuation情報は未検証。合成Adapterの成功を本番接続成功とは扱わない。
- 本番Identity/ACLサービス、UI、ネットワークRead、Windowsネイティブ安全Readは未接続。必要なHost契約がなければ予約・実行前に拒否する。
- 未知Action/Usage、失われた本文、Crash後のIntentの外部照合は4C対象。既存事実を残し、新IDへの再送や推測ゼロ精算をしない。

公開差分はソース・合成試験・package scripts・設計/検証文書に限定する。実DB/WAL/SHM、キャッシュ、取得した外部repo、venv、生成dist、ローカル検証ログ、Credential/APIキーを含めない。mainへの直接Pushと自動マージは行わず、一つのDraft PRとして提出する。
