# MAP-MEM-1 運用・設計記録

## 初期本稼働までの工程

| 工程 | 成果物と判定 |
| --- | --- |
| DATA-1 | PR #38 で会話DB、認証、生成、添付、移行、Backup／Restoreをマージ済み |
| MEM-1 | このDraft PRで記憶候補、レビュー、Markdown公開、外部編集取込を監査 |
| MEM-2 | 長期記憶検索と会話原文検索、日付許容検索、交換・再構築可能な索引 |
| MEM-3 | 検索経路の選択、回答Contextへの組込み、基本圧縮、品質・費用評価、統合試験 |
| 本稼働前確認 | 各工程の申し送りから採用構成に必要な項目を選び、順序・手順・成功条件・切戻しを一本化して実施し、本稼働を判定 |
| MEM-4 | 高度な整理、階層要約、重複統合。初期本稼働前に採用した変更は同じ最終確認で検証 |

初期本稼働に必要な実装はDATA-1からMEM-3。各工程の合成データ試験は各PRで完結させる。実機、実データ、実Providerが必要な条件は[検証報告の末尾](map-mem-1-validation.md#最終確認へ引き継ぐ項目)に残す。

## 正本と公開の境界

会話・生成Receipt・候補・編集履歴・承認・所有Persona・ScopeはApp DBが管理する。人が現在編集する本文は専用VaultのMarkdownに置く。DBの版と照合可能な確定時のバイト列を、利用者が編集するファイルとは独立した保護領域に保存する。「公開」はMAP内部で承認済み記憶として、許可された読者が参照できる状態を指す。

| 手法 | この実装で担う役割 |
| --- | --- |
| Ports and Adapters | DATA-1のProvider境界を再利用し、Vaultのファイル操作を専用Adapterに集約する |
| 明示的な版管理と楽観的競合検出 | 編集に期待revisionを要求し、承認した本文・出所・Scope・宛先版を固定する |
| Transactional Outboxと冪等Worker | 承認と公開依頼をSQLiteで同時確定し、ノートごとのファイル反映とReceiptを回復可能にする |

MAP固有の判断は、所有Personaごとのprivate候補、利用者が選ぶ公開範囲、SourceRefと確定版の束縛、明示登録したノートの本文編集取込である。Context manifestは生成に使用した資料を示す。主張を裏付ける独立した証拠として扱うには、人が出所と本文を確認する必要がある。

Roomの内部状態分離が有効なとき、利用者が入力した完全な `/memory` コマンドから生成を開始する。前後の空白は許容される。候補作成には対象Personaへの `PROPOSE_MEMORY` が必要になる。未付与の利用者は従来どおりDATA-1のprivate exportだけを生成できる。Usageが不完全な場合や実使用量が上限を超えた場合は既存の生成記録に結果を残し、候補登録を止める。生成した候補は未承認であり、承認後の公開もノート単位で進む。公開版を通常回答へ組み込む処理はMEM-3で接続する。

### 訂正と既存の候補

候補のSourceRefは、候補を生んだ確定済み `memory_export` のMessage・revision・segment・digestを指す。元発言を後から訂正したときの判定には、これとは別に生成依存を保存する。履歴窓に過去の生成結果が入った場合、生成ReceiptとContext manifestをたどり、その結果が読んだ会話版・添付・必要な認可を候補に引き継ぐ。通常回答を経由する場合や、過去の出力に候補が作られていない場合も対象になる。元資料の訂正・削除後は関係する候補と公開ノートを `NEEDS_REVIEW` に移す。訂正済みの出力から新しく作った候補も同じ扱いになる。

生成依存の検証には、SQLiteに進捗を保存する**作業キュー**を使う。候補IDとCall IDの組を一意にし、確定したReceipt・入力manifestを1トランザクションにつき最大4 Call検証する。複数の回答が同じ先行Callを参照しても、そのCallの処理は候補ごとに1回で済む。各manifestを読む際のサイズ・項目数の制限は維持する。長いRoomでは複数回に分け、処理済みのCallと次の検証対象を同じコミットで保存する。検証途中の新規候補は `LINEAGE_PENDING`（Verifying sources）で待機し、本文の利用・編集・承認は検証完了後に可能になる。短い依存関係は生成確定の処理内で検証を終えられる。

サーバー起動時のWorkerは候補間を順番に処理し、各回の間にイベントループへ制御を返す。確認済みの元資料が訂正・削除された場合や、必要な権限が撤回された場合は同じトランザクションで検証を失効させる。これから確認する資料は、各Callを検証する時点で現在版・認可と照合する。再起動後は同じ候補IDの保存済み進捗から再開する。Provider呼出し、承認、Markdown公開にはそれぞれ既存の独立したReceiptを使う。

### 撤回された権限の照合

Schema 4では権限変更と同じトランザクションに、Workspace・Actor・ACL revision・要求された操作・失効した各grantのID、操作、Room、Persona、Provider、可視範囲を記録する。一括撤回では該当した全grantを記録する。各Callについて、manifest作成以降に実際の入力を読むための権限が撤回されたかを照合する。たとえばVault管理権限だけの撤回後も、会話を読む権限が継続していれば、過去の生成出力を参照する候補を承認できる。private原文を読むために使った権限を一度撤回すると、再付与してもその原文に依存した旧承認は失効したままになる。差分APIのカーソルは従来どおりWorkspaceのACL revisionに束縛される。

### 旧DBの保留と回復

| 更新元 | 検証と復帰先 |
| --- | --- |
| Schema 2（`b982414`） | 元の候補・公開状態を記録し、Migration 003と004を同じSQLiteトランザクションで適用する。対象ノートは検証中の通常参照を止め、元の出所・承認・公開・現行版が一致すれば同じNote ID・版・digestで参照を再開する。未承認候補はレビュー待ちに戻す。 |
| Schema 3（`3370f59`） | 旧実装では256 Callまたは延べ16,384参照への到達と実際の失効が、同じ `NEEDS_REVIEW` になった。該当し得る生成候補を再検証し、旧上限を超えた証拠、現在の原文と権限、承認した候補版・出所・Scope、Job・成功Receipt、公開時と現行の保護版、Vault上の現在ファイルを照合する。すべて成立した公開ノートは既存の版のまま復帰する。未承認候補は承認が必要なままになる。 |
| 根拠が不足する場合 | 訂正・削除・撤回、権限の中断、ファイルの不在や未取込編集、資料・承認との不一致は保留する。旧ACL履歴から撤回Scopeや継続性を特定できない場合も対象となる。APIと画面では現在版の通常取得を止め、認可された版履歴を残す。 |

MAPでは、過去の承認が今も同じ資料と本文に適用できるかを回復の基準にする。Hostはサーバーを再開し、候補画面で出所の検証が終わるのを待つ。保留が続く場合は、権限のある利用者が元の会話版・ノート履歴・Vaultに残った編集を照合する。必要な訂正と現在の閲覧権限を確認し、その資料から新たに `/memory` を実行して候補をレビューする。旧世代には承認時の正確なACL revisionがないため、レビュー担当者の権限は元の生成時点から保守的に照合する。生成後・承認前の撤回しかなかった場合も、継続を立証できなければこの手順で扱う。

## Hostの準備

1. 利用中のDATA-1またはMEM-1サーバーを停止し、更新前のバイナリで `backup` を実行する。可能なら同じバイナリで空の別Rootへ試験復元し、資格情報の再設定と復元結果を確認する。旧バイナリと更新前Backupを対応づけて保管する。
2. 新しいバイナリで保護されたApp Rootを開く。Schema 1には `app_002_memory_vault` を適用する。Schema 2からは `app_003_memory_integrity` と `app_004_resumable_memory_lineage`、Schema 3からは004を適用し、Schema 4へ進む。移行完了時から通常のWorkerが依存検証を引き継ぐ。MEM契約は `MAP-MEM-1:MEMORY_VAULT:1`。既存のDATA-1契約とCOORD Schema 11は維持する。
3. Hostユーザーだけが管理する場所に、空の専用Vaultを一つ指定する。App Root、ソースツリー、Webの静的配信領域とは分離する。Obsidianとそのプラグイン、同じOSアカウントでファイルを編集できる利用者は、本文編集の信頼境界に入る。
4. 新規公開ノートの本文編集を自動取込する構成なら、登録時に `--trust-new true` を指定する。個別に信頼登録する場合は省略する。登録後にVaultの状態を確認して、処理を明示再開する。

以下では `app_root`、`vault_path` をHostが選んだ絶対パス、`workspace`、`actor`、`room`、`persona` を登録済みIDとする。

```bash
npm run app:admin -- vault-register --root "$app_root" --path "$vault_path" --trust-new true
npm run app:admin -- vault-status --root "$app_root"
npm run app:admin -- vault-resume --root "$app_root"
```

### 権限付与

通常アカウントへの初期付与はDATA-1の既定操作に限定する。次は、自分で生成・編集・レビュー・private公開する一人の利用者の例である。同じ権限を一括して全Personaへ付与する必要はない。

```bash
for operation in PROPOSE_MEMORY READ_MEMORY EDIT_MEMORY REVIEW_MEMORY PUBLISH_MEMORY; do
  npm run app:admin -- grant --root "$app_root" --actor "$actor" --workspace "$workspace" \
    --operation "$operation" --room "$room" --persona "$persona" --visibility persona_private
done
npm run app:admin -- grant --root "$app_root" --actor "$actor" --workspace "$workspace" \
  --operation READ_PRIVATE_SEGMENT --room "$room" --persona "$persona" --visibility self_only
```

候補の閲覧・編集・承認は共有提案でも `persona_private` に対して確認する。Room内への公開には、対象のRoom／Personaに `CHANGE_MEMORY_SCOPE` と `PUBLISH_MEMORY` を `room_shared` に対して付与する。共有版の読者には `READ_MEMORY` を `room_shared` に対して付与する。権限を撤回して再付与した場合は、以前の承認での公開を再開できない。撤回には `RETRACT_MEMORY`、Vaultのオンライン管理にはHostが付与する `MANAGE_VAULT` を使う。運用上の管理権限とprivate資料の閲覧は別々に付与する。

### 利用者の操作

1. ログインし、対象Roomの内部状態分離を有効にする。受信者と処理の上限を確認して `/memory` を送る。
2. Roomの記憶画面で、所有Persona、本文、出所、記憶の種類、主張の種類を確認する。生成直後は未分類である。原文の閲覧権限を持つ利用者が元資料を確認し、必要な候補だけを編集する。
3. 公開先を確認し、承認する候補を選択する。古いrevisionへの承認は競合になるので、最新の本文と出所を開き直す。まとめ承認後は各候補の状態を確認する。
4. 公開済み記憶の本文をObsidianで保存する。改名してもPropertiesの `map_id` を維持する。信頼登録済みノートの通常本文編集は、新しい版として同じScopeへ取り込まれる。変更履歴では公開時と編集後の版を個別に読める。
5. 既存ノートへの変更提案は、対象版と出所を確認して利用者がObsidianで反映する。撤回時は画面で確認した状態・版番号・digestを送る。公開中のノートではVault上のIDとファイル全体のdigestも照合する。外部保存が先なら `409 REVISION_CONFLICT` になるので、取込後に新しい版を開いて確認する。削除・競合が既に表示されている場合は、その状態を確認して撤回できる。成功したRequest IDの再送は現在の認可を確認して元の結果を返す。会話原文と権限付き履歴は残る。

### 手書きノートの明示登録

Hostは既存ファイルの相対パス、Note ID、ファイル全体のSHA-256、登録者、所有Persona、Scopeを指定する。本文と出所を確認し、登録時に指示した版のみを採用する。次のようなUTF-8 Markdownを専用Vaultに保存し、そのファイル全体のdigestを確認する。

```markdown
---
map_id: mem_handwritten_01
---
次回の打合せでは試作結果を確認する。
```

サーバーを停止し、Vaultが再開可能な状態で次を実行する。`--trusted true` は登録後の通常本文編集を同じScopeへ取り込む指定である。

```bash
npm run app:admin -- vault-register-note --root "$app_root" --workspace "$workspace" \
  --actor "$actor" --room "$room" --persona "$persona" --visibility persona_private \
  --note mem_handwritten_01 --path meeting.md --digest "$sha256" --request "$request_id" --trusted true
```

登録者は対象Scopeの閲覧・レビュー・公開に加えてVault管理権限を持つ必要がある。共有Scopeの登録には範囲変更権限も必要になる。手書きノートの出所は登録者・元ファイル版・登録日時で追跡する。

## 検出・回復・切戻し

- 新規公開では、Operation ID・Note ID・宛先・digestに加え、準備ファイルのデバイス番号・inode番号・生成時刻をApp Rootの `memory-publication-state/` に記録する。Linux Adapterは準備済み記録を同じディレクトリ内で試行済みに改名し、ディレクトリをfsyncしてから、排他的なリンク作成でVaultに公開する。元のApp RootとVaultを一緒に保持する。対象媒体にはLinux procfs、ハードリンク、ディレクトリfsync、安定したデバイス・inode・正のファイル生成時刻が必要になる。
- 同じRootで再起動した場合、未試行と確認できれば公開へ進む。試行済みなら元の宛先のファイル識別情報・ID・内容が一致したときにReceiptを回復する。試行開始を記録してリンクを作る前に停止した場合も、宛先が不在なら `CONFLICT` で止まる。削除・改名・差し替え後の元パスには書き込まない。Schema 2で既に処理途中だったJobは、準備ファイルと宛先が同一inodeで確定内容とも一致する場合に回復する。旧形式の準備ファイルだけ、または宛先だけが残った場合は競合として保留する。
- 同じRequest IDで再照会して承認やProvider送信を増やさない。公開途中で停止した場合は、元のDBとVaultを保持して再起動する。失敗したJobは原因を取り除いてから、元のレビュー担当者が候補画面で同じ公開操作を再試行できる。競合では該当するNote IDと履歴を確認し、人間の編集を退避・照合する。別名での自動再公開は行わない。
- Hostは有界再走査でイベント欠落を補える。ファイルを信頼対象にしても、属性、フォルダ移動、リンク、モデル出力から権限を変更することはできない。未知のID・未登録の手書きファイルは自動公開されない。
- Backup／Restoreはサーバーを止めて実行する。確定版の対象になるよう、作業中の編集を保存して取り込み結果を確認する。未登録ファイルや未確定の編集中ファイルを保全する場合は、Hostが別途退避する。DB Snapshotと対応する確定版、添付、レビュー、保留Jobをmanifestと照合する。
- 復元は空の別Rootに対して行い、復元後に資格情報を再設定する。確定版から新Root内の `restored-vault/` に作成された本文を確認する。復元したAppを明示再開し、Vaultの状態・過去版・保留Jobを確認してから `vault-resume` でVault処理を再開する。更新前バイナリへ戻すときは、新バイナリを停止し、旧バイナリで更新前Backupを空の別Rootへ復元する。旧バイナリには対応するSchemaの更新前Backupを使用する。

```bash
npm run app:admin -- vault-pause --root "$app_root"
npm run app:admin -- vault-status --root "$app_root"
npm run app:admin -- vault-conflicts --root "$app_root" --workspace "$workspace" --actor "$actor" --room "$room"
npm run app:admin -- backup --root "$app_root" --destination "$backup_root"
npm run app:admin -- restore --source "$backup_root" --destination "$restore_root"
```

### Backup形式と中断済みJob

| `manifest.json` の `schema` | 版の対応と復元 |
| --- | --- |
| `MAP-DATA-1:BACKUP:1` | 当時の形式で照合してから、別Rootで会話・添付を引き継いで順次移行する |
| `MAP-MEM-1:BACKUP:2` | manifest内の従来の全件一覧を、元のSchema 2スナップショットで照合してから移行する |
| `MAP-MEM-1:BACKUP:3` | DBスナップショットを全版の対応表に使う。manifestにはそのDBのサイズ・digestと、順序を固定した版・現在版・添付の件数とdigestなどを記録する |

全形式で同じ `restore --source … --destination …` を使う。形式3では検証済みDBから順に対応を読み、各確定版ファイルのdigest、MarkdownのNote ID、本文digestを照合する。同じ確定バイト列を多数の履歴が参照しても、物理ファイルはdigestごとに検証・コピーする。ヘッダーには16 MiBの読込上限があり、版ファイルにも個別のサイズ上限を適用する。

公開先のファイル識別情報は元の媒体に属する。別Rootへの復元で公開の有無を確定できないJobは `CONFLICT`（`RESTORE_PUBLICATION_UNCERTAIN`）として残し、元のOperation・承認内容と照合できるようにする。未準備と確認できるJobは、AppとVaultを明示再開してから処理する。旧形式で既に復元したRootでは旧実装が準備状態を初期化していたため、残存する未完了・再試行待ちJobを保守的に保留する。旧復元Rootから再取得したSchema 2 Backupでも、登録先の `restored-vault` をこの判定に含める。旧復元レポートを使った再開では移行直前・直後の台帳digestを照合する。

Schema 4のBackupには検証キュー、チェック済みCall、権限撤回の台帳も含まれる。以前公開していたノートの再検証中にBackupを採るときは、有界走査でNote IDが登録パスの1件に絞れ、そこで再読取したdigestが保護版に一致するものだけを、復元対象としてスナップショットに記録する。保留中に走査またはBackupが検出した重複IDは自動復帰を止める。別パスに新しく置かれた複製は次の走査で検出する。別Rootでの復元はこの記録と確定版を使う。未取込編集・不在のファイルには回復の根拠を付けない。Appの再開前には検証を進めず、再開後も未承認候補には通常のレビューが必要になる。

資格情報の再設定、保守ロック、DATA-1世代の復元手順は[移行・復元の運用手順](map-data-1-migration.md)を参照。

### Hostによる状態確認と再走査

```bash
npm run app:admin -- vault-trust --root "$app_root" --workspace "$workspace" --actor "$actor" --note "$note_id" --trusted true
npm run app:admin -- vault-rescan --root "$app_root"
npm run app:admin -- vault-status --root "$app_root"
```

稼働中のHost管理APIは `GET /api/app/v1/memory/vault` と `POST /api/app/v1/memory/vault/rescan`。書込みには同一Origin、現在のセッションとCSRF検証が必要になる。停止中のCLIとサーバーはHostロックで排他する。ファイル監視を補う定期走査は10秒ごとに起動し、変更した本文の確定には500ms以上離れた一致する観測を2回要する。有界走査が上限に達した場合は、新しい完全な走査が成功するまで現在版の読取りを停止し、履歴は認可付きで参照できる。

公開枠はVault全体で1,024件。現在管理するノートと公開準備済みJobが枠を利用する。削除を検知したノートは、復帰に備えて枠を保持する。撤回済み・再確認待ちの履歴は枠を使わない。満杯のときはファイル作成前にJobが `FAILED` になる。権限を持つ利用者が不要な記憶を撤回した後、元の承認者が同じ公開操作を再試行できる。フォルダや未登録ファイルも走査の4,096エントリ上限に含まれる。既存の本文をVault外で保管する場合はHostが退避先と内容を確認する。

### MEM-2への読取契約

以下のパスは `/api/app/v1/rooms/{roomId}/memory` からの相対パス。すべての読取りに現在のセッションを使い、Workspace・Actor・Roomごとに同期状態を管理する。

**現在版と履歴**　`GET notes` は閲覧できるノートのID、状態、登録版、digestを返す。本文を使う直前に `GET notes/{noteId}` で再取得し、利用するNote ID・版・digestとの一致を確認する。この読取りで、現在の認可、公開状態、出所の有効性、Vaultの現パスにあるNote IDとファイルdigestを照合する。取得できた本文と閲覧を許可されたSourceRefを利用する。原本の再確認が必要なときは当該ノートを現在の参照から外す。`GET notes/{noteId}/history` と `GET notes/{noteId}?version=N` は現在の認可で保護された版履歴を参照する。履歴の用途は過去版の監査・比較である。

**登録状態の同期**　`GET changes` は `mode`、`items`、`hasMore`、`cursor` を返す。最大200件の各項目に `changeId`、`noteId`、`version`、`digest`、`state`、`action` がある。本文の利用可否は上記の現在版読取りで判定する。

1. 初回は空の作業用集合を用意し、引数なしで `GET changes` を呼ぶ。`mode=baseline` の各項目は、読取開始時点を固定して集めた、認可範囲内の各ノートの最終登録状態である。Note ID順に `action=BASELINE` で届く。`PUBLISHED` のID・版・digestを集合に保持し、他の状態のノートは現在の参照から外す。
2. `hasMore=true` の間は毎回、直前の応答の不透明な `cursor` をそのまま `GET changes?after={cursor}` に渡す。最後のbaselineページのカーソルから `mode=delta` に移り、初期読込中に生じた変更も取得できる。deltaも開始時点を固定した範囲を記録順に返す。公開、変更、失効、撤回を適用し、`hasMore=false` までの範囲を読み切る。
3. 再構築した集合全体と、その範囲を読み終えたカーソルを一緒に確定し、参照先を一度に切り替える。その後も適用済みの変更と次回のカーソルを一緒に保存する。空の応答にもカーソルがある。`changeId` は個々の記録を識別する。

**権限の変更と再同期**　カーソルはWorkspace・Actor・Room、WorkspaceのACL版と現在の閲覧範囲に束縛される。権限の追加・撤回等で境界が変わった場合や、旧形式の `changeId` を `after` に渡した場合、APIは `409 MEMORY_RESYNC_REQUIRED` を返す。直ちに当該範囲の旧キャッシュの利用を止め、作業途中のページとカーソルを破棄し、空の集合から手順1へ戻る。これにより、新たに読める既存のprivateノートも取り込まれ、権限を失ったノートは再構築後の集合から除かれる。同期APIの401・403でも旧キャッシュの利用を停止し、再認証・権限回復後に初回同期から始める。Restore後も初回同期から再開する。検索索引の構築・評価はMEM-2で行う。
