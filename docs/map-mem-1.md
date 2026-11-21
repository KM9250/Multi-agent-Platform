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

## Hostの準備

1. DATA-1のサーバーを停止し、更新前のバイナリで `backup` を実行する。可能なら同じバイナリで空の別Rootへ試験復元し、資格情報の再設定と復元結果を確認する。旧バイナリと更新前Backupを対応づけて保管する。
2. 新しいバイナリで保護されたApp Rootを開く。App Schema 1から2へのMigrationは `app_002_memory_vault`。MEM契約は `MAP-MEM-1:MEMORY_VAULT:1`。既存のDATA-1契約とCOORD Schema 11は維持する。
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
5. 既存ノートへの変更提案は、対象版と出所を確認して利用者がObsidianで反映する。掲載を取り消す場合は記憶を撤回する。会話原文と権限付き履歴は残る。

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

- 新規ノートの確定内容にはNote IDと公開Operation IDが入る。Linux AdapterはディレクトリFDに固定したパスで完全なファイルを準備し、排他的なリンク作成で公開する。既存の宛先が同じ確定内容ならReceiptを回復し、別内容なら競合を表示する。版保存領域と編集ファイルは独立している。
- 同じRequest IDで再照会して承認やProvider送信を増やさない。公開途中で停止した場合は、元のDBとVaultを保持して再起動する。失敗したJobは原因を取り除いてから、元のレビュー担当者が候補画面で同じ公開操作を再試行できる。競合では該当するNote IDと履歴を確認し、人間の編集を退避・照合する。別名での自動再公開は行わない。
- Hostは有界再走査でイベント欠落を補える。ファイルを信頼対象にしても、属性、フォルダ移動、リンク、モデル出力から権限を変更することはできない。未知のID・未登録の手書きファイルは自動公開されない。
- Backup／Restoreはサーバーを止めて実行する。確定版の対象になるよう、作業中の編集を保存して取り込み結果を確認する。未登録ファイルや未確定の編集中ファイルを保全する場合は、Hostが別途退避する。DB Snapshotと対応する確定版、添付、レビュー、保留Jobをmanifestと照合する。
- 復元は空の別Rootに対して行い、復元後に資格情報を再設定する。確定版から新Root内の `restored-vault/` に作成された本文を確認する。復元したAppを明示再開し、Vaultの状態・過去版・保留Jobを確認してから `vault-resume` でVault処理を再開する。更新前バイナリへ戻すときは、新バイナリを停止し、旧バイナリで更新前Backupを空の別Rootへ復元する。Schema 2のDBを旧版用に書き換えない。

```bash
npm run app:admin -- vault-pause --root "$app_root"
npm run app:admin -- vault-status --root "$app_root"
npm run app:admin -- vault-conflicts --root "$app_root" --workspace "$workspace" --actor "$actor" --room "$room"
npm run app:admin -- backup --root "$app_root" --destination "$backup_root"
npm run app:admin -- restore --source "$backup_root" --destination "$restore_root"
```

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

Room内の `/api/app/v1/rooms/{roomId}/memory/notes` でNote IDと状態を取得し、`notes/{noteId}` で本文、現在の版、digest、許可されたSourceRefを読む。本文取得時に現在のファイルを照合する。`notes/{noteId}/history` と `notes/{noteId}?version=N` は履歴表示用である。`memory/changes` の変更記録は公開、変更、失効、撤回を表し、前回のchange IDを `after` に渡して次を読む。失効により以前のカーソルが無効になった場合、現行の認可で一覧を再取得する。索引の構築と準備完了判定はMEM-2の責務である。
