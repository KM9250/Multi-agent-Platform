# PR #41 再修正記録 v1.2

対象はF-01のLEGACY公開復元、F-02-Aの行指定、F-02-Bの短縮metadataを含む容量判定。作業開始時のPR最新HEADとローカルHEADはともに `1869fb7d0feb82662a7704e0d97e98002cc74022`、後続変更・未コミット変更はなかった。

正しい添付 `PR41_v11_reaudit_evidence.zip` のREADME・verificationを読み、同梱SHA-256を照合した。指定3ファイルを名前・assertとも維持して配置し、修正前は **0成功／3失敗／0skip、終了コード1、6.727秒**。これは今回のローカル再現結果であり、添付記録の既存全体2,427成功や過去の検証時間とは別の実行である。

最終HEADとそのHEAD上の全コマンド・件数・時間は、実装・テスト・この文書をコミット後に検証して[PR #41のv1.2提出欄](https://github.com/KM9250/Multi-agent-Platform/pull/41)へ記録する。マージは再監査後に判断する。

## F-01：LEGACY公開復元のPending伝播

`server/memory/lineage-recovery.ts` の `recoverHeldCandidate()` で、catch内の既存savepoint rollback／releaseの直後に `NoteVerificationPending` を再throwする。汎用のcode付きエラーをfalseへ変換する処理より前で判定するため、派生する `VaultRootUnavailable` も既存workerの保留経路へ届く。

復元途中の一時的なAPPROVED等の状態はsavepointで戻す。savepointより前に正常終了したCALL／REFの検証進捗は保持し、既存の分割処理とlast_stepによる順番の受渡しを使う。Unproven、SyntaxError、通常の原本・権限不一致による失敗、SQLite／プログラムエラーの分類は変えない。エラー文字列だけの一律再試行、migration追加、登録inode更新、INVALID／NEEDS_REVIEWの一括解除はない。

`test/pr41-v11-vault-legacy-pending.test.ts` は旧実リリース `b98241429466f1ad6406288c1f0ad724bafe6115` をgit archiveで展開し、その版の正規生成・承認・公開でschema2 DBを作る。現行 `new AppDatabase()` による通常移行を利用し、業務状態・manifest・依存関係・queueを注入しない。元assertに、候補／Note状態、checked frontier、障害中の再試行、進捗・digest保持を追加した。

| 経路 | 検証中／障害中 | 復帰後 |
|---|---|---|
| 障害なし | 通常のLEGACY検証 | work DONE、候補／NoteともPUBLISHED |
| scan先行 | PENDING、候補／NoteともLINEAGE_PENDING | 正常scan後DONE、候補／NoteともPUBLISHED |
| worker先行・incomplete=0 | PENDING、候補／NoteともLINEAGE_PENDING | 正常scan後DONE、候補／NoteともPUBLISHED |

worker先行では `calls_done=1`、`refs_done=4`、`notes_done=0`、`invalidated=0`。障害中の再試行でもこの進捗とchecked frontierを保持し、復帰後も同じ検証数で完了する。原本digestは障害前後・公開記録と一致。これは旧公開済みNoteのPUBLISHEDへの復帰であり、新規候補のPENDING_REVIEWとは区別する。旧版の合成Providerは1回、実Providerは0回。

真正な失効、root identity・symlink、duplicate、権限失効、再起動と公平性、Backup／Restoreは既存の `memory-vault-access-boundary`、`pr41-audit-lineage-scan-recovery`、`pr41-reaudit-f01-read-before-scan`、各lineage migration／backup／revocation試験を利用した。

## F-02-A：明示的な行と文の区別

`server/generation/context-excerpt.ts` の内部opening引数をsentence／line／未指定に分け、`context-plan.ts` で既存の `最初の行 / first line` をlineとして渡す。行指定では句点ではなく改行を境界にする。LF、CRLF、従来の単独CRを扱い、CRLF全体を含める場合は分断しない。供給本文は正規化・再構成せず、検証済みの同一原本に対するsliceとoffsetで固定する。文指定と明示的全文の既存保護は維持する。

添付 `test/pr41-v11-excerpt-first-line.test.ts` の上限1,000の実Coordinatorで、次の結果を確認した。

```text
cedarの保存先はSQLiteです。バックアップは毎日保存します。\r\n
```

上記の末尾表記は実際にはCRLFで、供給範囲は **[0,36)**。両文を完全に含み、Citationと原本sliceが一致する。COMPLETED、通常履歴窓外、requiresFullSource=false、合成Answer 1回、実リクエストからの推定値とmanifestはともに **740／1,000 tokens**。固定範囲や740への一致を合格条件にはせず、必要な行の保持と実入力が上限内であることをassertする。

既存の一文・全文・UTF-16／CRLF・容量不足試験を再利用し、小さな追加対照として英語first lineとLFを同じ実生成経路で確認した。新しいHTTP入力項目・manifestフィールド・汎用自然言語解析器はない。

## F-02-B：実metadata込みで必要範囲を確保

全候補が収まらない場合、各primaryの周辺付きverified、hit、requiredから、必要範囲を包含し、検証済み原本内にあり、安全な境界と4,096 UTF-16上限を満たす候補だけを選ぶ。同一offsetを除去し、Memory・Archiveの最大2 primary、各最大3候補、**最大9通り**を評価する。

各 `fits()` は元の検索状態からstatus・reason、採用Source、供給本文を作り直し、実際のsystem instruction・通常履歴・現在入力・検索metadataを含むenvelopeを計算する。収まる組み合わせのうち実入力token数が最小のものを確保し、その選択を復元してから既存の優先順で周辺・補助資料を追加する。追加失敗時は確保済みの範囲へ戻す。短縮理由を消したり、候補ごとに検索・Embedding・Providerを呼んだりしない。

この再現ではpackingより前の `server/generation/context.ts` にも先行拒否があった。固定予約2,048＋設定JSON 67＋現在入力267＝**2,382 bytes**が、789 tokensの2,367 bytesを超え、実際には788 tokensの入力を作れるのにContextPlan作成へ到達しなかった。

そのため、添付のないanswerは既存の実シリアライズ後のHost入力検査を使う。この検査はcompileのreturn前にあり、有料検索・Provider送信より前に実行される。metadataの収集と安全な整数・サイズの検証は維持し、添付があるanswerは全metadata収集後・本文読取前に従来の保守的な容量検査を行う。answer以外の保守的判定も維持する。2,048を都合のよい別定数へ変更せず、Host上限や保護された入力・履歴・pin・添付の選択も変更しない。

`test/app-data-generation-native.test.ts` に実際に枠外となる添付なし入力の対照を追加し、CONTEXT_LIMIT、Provider 0、Answer台帳0、検索操作台帳0を確認する。既存の単一巨大添付・8件合計添付も、本文read 0、Provider 0、台帳0のまま拒否する。

添付 `test/pr41-v11-compat-metadata-budget.test.ts` の下側上限と、Source長を入れ替えた対照の実測は次のとおり。

| ケース | Memory採用範囲・検索状態 | Archive採用範囲・検索状態 | 実入力／上限 |
|---|---|---|---:|
| 短いMemory＋長いArchive | [0,20)、ready、理由なし | [0,19)、partial、EXCERPT_TRUNCATED | **788／789 tokens** |
| 長いMemory＋短いArchive | [0,19)、partial、EXCERPT_TRUNCATED | [0,20)、ready、理由なし | **788／789 tokens** |

いずれもCOMPLETED、通常の合成Answer 1回。両targetの必要文を保持し、Citation・digest・供給本文・原本slice、manifestと実入力の見積り、採用範囲とstatus・reasonの一致をassertする。仮想payloadは元の監査証拠として残すが、合格は実Coordinatorの最終payloadで判断する。

## 保存契約と最終検証

DB schema・migration・HTTP入力・Router v1／v2・manifest保存形式は変更しない。最終のSource／alias、Citation、permissions、estimatedTokens、payloadDigestは採用後の同じ選択から作る。固定後のcompile／revalidateはその範囲を検証し、再検索や範囲の選び直しをしない。保存済みmanifestの再packing、DB初期化、Vault再作成、全件再Importは不要。

Memory 2,048、Archive 4,096、合計6,144 estimated tokens、Citation 4,096 UTF-16 units、設定されたHost入力枠は維持する。F-03の日付、F-04の期限・Usage・UNKNOWN、F-05の認可・freshness条件は変更していない。既存Citation、NOTE lineage、Backup／Restoreの契約も維持する。

添付の3ファイル名と元assertを保持し、関連する英語／LF、両target入替の2ケースを追加したため、次の追加probeコマンドは5件を実行する。新しい添付なし容量超過の対照1件は既存native試験へ追加した。最終全体テストにはいずれも含まれる。

```bash
mkdir -p work/pr41-reaudit-v12
export PR41_V11_EVIDENCE_DIR="$PWD/work/pr41-reaudit-v12"
export PR41_V11_AUDIT_EVIDENCE_DIR="$PWD/work/pr41-reaudit-v12"
export PR41_AUDIT_EVIDENCE_DIR="$PWD/work/pr41-reaudit-v12"
export PR41_REAUDIT_EVIDENCE_DIR="$PWD/work/pr41-reaudit-v12"
node --experimental-transform-types --loader ./test/ts-loader.mjs \
  --test --test-concurrency=1 test/pr41-v11-*.test.ts
node --experimental-transform-types --loader ./test/ts-loader.mjs \
  --test --test-concurrency=1 --test-name-pattern='PR41 audit:' test/pr41-audit-*.test.ts
node --experimental-transform-types --loader ./test/ts-loader.mjs \
  --test --test-concurrency=1 --test-name-pattern='PR41 re-audit' test/pr41-reaudit-*.test.ts
npm run typecheck
npm run build
npm test
git diff --check
npm run test:context-browser
npm run test:app-data-browser
npm run test:memory-browser
npm run test:search-browser
MACP_REPO_PATH="$PWD/work/macp" MACP_PYTHON="$PWD/work/macp-venv/bin/python" npm run test:macp
MACP_REPO_PATH="$PWD/work/macp" MACP_PYTHON="$PWD/work/macp-venv/bin/python" npm run test:notification-macp
```

実行記録では **再現基準HEAD** と **修正後のexecutionHead** を区別し、コマンド、終了コード、成功・失敗・skip、コマンド全体の時間を残す。probe JSON内の固定 `auditedHead` は過去の再現基準であり、最終検証HEADと読み替えない。

Chromium実体とMACP checkout `e88937d0c8132ae7d18098a24d01ee28bffda655` を利用する。実Provider呼出し0件。一時DB／Vault、合成Provider、既存fixture、loopback統合だけを使う。実Provider疎通・実Usage／請求、実データ移行、運用機器のBackup／Restore、実TLSは既存の本稼働前Gateへ残し、新しいGateは追加しない。
