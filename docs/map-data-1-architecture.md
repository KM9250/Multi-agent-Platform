# MAP-DATA-1 アーキテクチャ

この変更の契約は `MAP-DATA-1:SERVER_CONVERSATION:1`。対象は会話のサーバー永続化と、その利用に必要な認証、生成、添付、移行、保全である。全体設計の MEM-1 以降（Vault 公開、承認、全文・ベクトル検索、Embedding、自動要約）は実装対象に含めない。既存 `/memory` は分類された内部メモの生成であり、Vault 公開ではない。

## 境界と正本

```text
React App / services/appClient.ts
    └─ 同一Origin /api/app/v1、Cookie + CSRF
        server/http
          ├─ auth: SessionService / AuthorizationPolicy
          ├─ app-data: AppDatabase / ConversationRepository
          ├─ generation: GenerationCoordinator / ContextCompiler / ProviderAdapter
          ├─ attachments: AttachmentStore
          └─ operations: ImportService / ExportService / BackupService
                ├─ app-data.sqlite
                └─ attachments / staging
```

ブラウザの通常起動は localStorage の Room 全集を復元・保存しない。メモリ上の表示ページ、下書き、未Uploadファイル、短期UI状態だけを持つ。旧 `rooms` キーの読取りは利用者が開始する移行操作に限定する。サーバー受理後のリロードやポーリングは既存Runを読み、新しいProvider要求を作らない。

`shared/app-contracts` はDTOと有限上限だけを公開し、Node SQLite、ファイル操作、秘密情報、Provider実装をimportしない。Providerクライアントは `server/generation` に閉じ、ViteにProviderキーを展開しない。既存のCOORDモデル呼出し・Schedulerは変更せず、会話用Provider呼出しは独立した単回送信経路を使う。

## DB識別とTransaction

会話DBは **App Schema 1**、初期Migration名は **`app_001_conversation_persistence`**。`app_metadata` に契約とSchema、`app_migrations` に独立した適用履歴を保存する。COORD Schema 11とMigration 001〜011に追加・改変しない。

`AppDatabase` は既存DBをread-onlyで識別してから、WAL等の設定やMigrationを行う。識別できない既存DB、COORDを含むパス、非対応Schemaは拒否し、削除・初期化へフォールバックしない。新規作成時の `.app-bootstrap` は作成したファイルのパス、device、inode、契約を記録する。Migration途中の停止で空のSQLiteヘッダーが残っても、この作成証跡と空Schemaが一致する場合だけ初期Migrationを再開する。別の既存空ファイルを無条件に初期化しない。

各接続で `foreign_keys=ON`、`journal_mode=WAL`、`synchronous=FULL` と有限の `busy_timeout`（既定2秒、最大60秒）を設定する。主要テーブルはSTRICT。Workspace・Room・Persona・Message・Revisionの組合せを複合外部キーで結び、別RoomのIDを流用しない。Message/Personaの現在版も、同一原本のRevisionを指す遅延外部キーで検査する。

書込みは同期 `BEGIN IMMEDIATE` Transaction。ネストした操作は同一Transactionに参加し、内側で失敗した場合は外側がその例外を捕捉してもTransaction全体を中止する。Promiseを返すTransaction callbackを拒否し、ネットワーク待機中に書込みロックを保持しない。Auditの失敗は本文保存等と一緒にロールバックする。COMMIT後の応答喪失は、保存の未実施と同一視しない。

Host試験用のbefore/after COMMIT hookはHTTPから設定できない。実プロセス終了試験に使用する。通常運用の保存失敗は成功Receiptへ変換しない。

## データと原本参照

| 保存群 | 責務 |
| --- | --- |
| `workspaces`, `principals`, `access_grants` | 所属、現在のACL版、操作別・対象別許可、失効 |
| `auth_accounts`, `auth_sessions` | scrypt検証情報、不透明Sessionのハッシュ、期限、失効 |
| `rooms`, `room_memberships` | Room設定・期待版・所属・Import公開障壁 |
| `personas`, `persona_revisions`, `room_personas` | 安定Persona ID、設定原本、Room内有効版 |
| `messages`, `message_revisions`, `message_segments` | 安定Message ID、順序、訂正/再生成履歴、分類付き原文 |
| `attachments`, `attachment_links`, `persona_attachment_links` | 原本Digest、所有者、Message版/Avatar/追加Context参照 |
| `app_turns`, `app_generation_runs`, `app_provider_calls`, `app_generation_receipts` | 冪等受理、実行状態、送信Intent、Usage、結果参照 |
| `app_decisions`, `app_reactions` | 参加判断とSTAMPの意味 |
| `import_batches`, `import_item_map`, `import_source_registry`, `import_source_records` | 移行出所、旧/新ID、内容照合、隔離原本 |
| `import_decisions`, `import_reactions` | 旧診断・Reactionの履歴。実行Receiptにはしない |
| `app_audit_events`, `app_generation_audit`, `app_changes` | 本文を複製しない監査、将来MEM向け変更参照 |

Messageの訂正は新Revisionを追加する。再生成も成功時だけ新Revisionを追加し、失敗/取消で前回成功版を消さない。過去版は現在の認可と削除状態で取得する。Segmentは `channel` と `visibility` を別々に保存し、公開ChannelをPrivate扱いしたりPrivate Channelをpublicにしたりする不整合を制約で拒否する。

MEM側へ引き継ぐ原本参照はWorkspace、Room、Message、Revision、SegmentのIDとContent Digestである。Provider応答IDやファイルパスを業務IDにしない。`app_changes` は訂正、削除、設定変更を記録するための通常の変更記録であり、会話DB全体をEvent Sourcingへ変換したものではない。

`occurred_at` は旧発言時刻を保持し、`ingested_at` と `modified_at` を区別する。Importでは日時の信頼状態も原本記録へ残す。日時索引は用意するが、MEM-2の日付許容検索は提供しない。

## 認可と出力

Actorは認証済みSessionから取得する。Client入力のRole/Owner/isAdminは権限にならない。管理操作、生成、Provider送信、Room閲覧、Private本文、添付閲覧は別操作である。初期ユーザーの通常操作Grantに全Private読取りは含めない。

Private GrantはRoom、Owner Persona、Visibilityの組合せを必要とする。Personaの編集権や管理権だけでPrivate本文を読むことはできない。セッションやACLの現在状態を各操作で確認する。ブラウザの表示チェックボックスや内部状態分離OFFは、保存した分類を変更しない。

通常Message DTOは `public_message` / `shared_summary` の公開Segmentだけを含む。Private本文、内部Prompt、Provider生応答、サーバーパス、Session秘密を含めない。Private-only Messageは通常一覧・単体公開Reader・公開履歴へ露出しない。内部の書込み結果は、生成ReceiptやImport対応表に必要なID/版を返せるが、これをそのまま汎用公開Readerとして使わない。Private本文は明示的ReaderでSegmentごとの現在Grantを検査する。

外部認可callbackには、Actor・Scope・Segmentの切り離した凍結済みコピーを渡す。callbackがこれらを変更して後続SQLの対象を差し替えることはできない。返却DTOは保存値から構成した新規オブジェクトであり、Clientの変更をDBへ反映しない。

## ページングと削除

最新ページは `messages(workspace_id, room_id, seq DESC)` 等の索引を使うKeyset取得。既定50件、最大200件。公開可能な現行版だけを検索し、内部Sequenceや全Message件数をDTOへ出さない。

CursorはAES-256-GCMで暗号化し、Actor、Workspace、Room、ACL版、30分の有効期限へ束縛する。別ActorやACL変更後のCursorを拒否する。復元時はCursor鍵も更新する。ExportのCursorには別用途を束縛する。

削除はまず削除マーカーで、一覧・履歴・Context・Exportから即時に除外する。Persona削除後は、そのPersonaの履歴本文と添付リンクも通常Readerから除外する。物理消去やバックアップの保持を同じ操作と見なさず、保持年数を自動決定しない。過去バックアップに残る情報は、保護された保管領域と運用上の削除方針で管理する。

## 添付の確定と読取り

RootはHostが絶対パスで指定し、リポジトリや公開静的ディレクトリから分離する。LinuxではRoot/Storeを0700、原本を0600で作成する。ファイル名は表示名だけに使用し、ClientにBlobキーやサーバーパスを指定させない。原本のファイル名はサーバー生成ID。

UploadはStagingへ排他的に作成し、サイズ・UTF-8または画像Signature・許可MIMEを検査、fdをsyncする。その後、既存ファイルを上書きしない原子的リンクでStoreへ確定し、Stagingを外してディレクトリをsyncし、最後にDBの `AVAILABLE` 行とAuditをCOMMITする。ファイルとDBを一つの原子的Transactionとは説明しない。

DB記録前に停止したファイルは孤立原本として保全する。Hostの後処理はDB参照を照合して孤立ファイル/Stagingを報告し、明示指定された場合だけ除去する。Importの再実行ではサーバー内部で決定した安定添付IDを使い、同一Digest・所有者・MIME・表示名の再要求を同じ原本へ収束させる。

未参照UploadはUpload Actorだけが取得できる。削除されていないMessageの公開Revisionへリンクすると、そのRoomで添付閲覧を許可されたActorが取得できる。過去Revisionの添付も現在の本文閲覧方針で取得し、Private-only版はそのOwner/Visibilityの明示Grantを追加で必要とする。Avatarは現在のPersona設定からの公開参照。追加Contextは設定用参照として保護され、通常の添付閲覧だけでは取得できない。Persona編集権、または生成専用 `readForContext` とそのPersonaに対する生成権を必要とする。追加Contextは編集者が公開応答への利用を承認する設定であり、Private Segmentの自動昇格経路ではない。

読取りでは都度、現在認可、Room、リンク、削除状態を確認し、`O_NOFOLLOW`、通常ファイル・単一Hardlink・サイズ・Digestを再確認する。読み終わった時点にも認可を検査する。欠落/不一致を空の成功ファイルにしない。HTML/SVG/実行可能MIMEはUploadで拒否し、外部URLを取得しない。画像はPNG/JPEG/GIF/WebPに限定する。

Linux上でSymlink、Hardlink、Root外参照、内容改ざんを試験した。Windows Junction/Reparse Point、大小文字別名、対象OS固有のファイル保護はこの環境では未検証であり、Windows運用Gateを通過したとは扱わない。SQLite WALはローカルディスクの単一Host用で、ネットワークファイルシステムやクラウド同期フォルダは運用対象外。

## GenerationとPrivate Context

通常入力はInput Message、Turn、Generation Run、要求Digest、Auditを同一Transactionで受理する。同一Actor/Workspace/操作のRequest IDと異なるPayloadは競合となる。ACK喪失後の同一要求は既存Receiptへ収束する。

Provider Callは `RESERVED → DISPATCH_INTENT → COMPLETED/REJECTED/INVALID/DISCARDED/OUTCOME_UNKNOWN` を追跡する。送信IntentのCOMMIT成功を直接確認した現在の実行だけが送信できる。保存したIntentを読むことや再起動によって送信権限を復元しない。送信成否が不明なら再送せず保全する。新しい明示再生成は新Run、新予算として元Runに結ぶ。

参加判断、固定直列SubAgent、回答、`/memory` をすべてCall台帳と予算へ含める。Usageの完全性と本文の公開可否は別。非公開/不正/取消応答でも既に発生したUsageを保持し、不明Usageをゼロへ置き換えない。入力/出力Token・Call数・費用・同時数・受付/送信/実行/収集時間に有限上限を適用する。

公開回答のContextは公開原本と承認済み設定から構成する。Private SegmentやPrivate SubAgent報告を公開回答Promptへ入れない。SubAgentの内部報告は独立した非公開Segmentとして保存する。この境界により、従来の「Private内容を同じモデルへ渡して漏らさないよう指示する」挙動とは互換性差分がある。共有Projectionの承認機能はこの工程で追加しない。

構造化出力はサーバーで完全検証してからSegmentへ分解し、Message版、Usage、Receipt、Auditを対応するTransactionで確定する。Raw JSONや部分応答を先に公開表示しない。再照会も現在認可で出力を再構成する。

## 有限上限

主要な保存/API上限は `APP_LIMITS` に固定する。

| 項目 | 上限 |
| --- | --- |
| Message合計本文 | 32,768文字 |
| Persona設定 | 65,536文字 |
| Message版のSegment | 16 |
| RoomのPersona | 16 |
| Message添付 | 8 |
| 添付原本 | 8 MiB/件 |
| ページ | 既定50、最大200 |
| JSON深さ | 16 |
| 固定SubAgent設定 | 4/Persona |
| 追加Context/Group配列 | 16 |

上限超過は固定エラーで拒否する。旧 `historyWindow=0` は無制限な全履歴送信へ戻さない。Generationの実効上限はHost設定と `server/generation/types.ts` の上限を参照し、Clientは拡張できない。Import/Exportは別の有限件数・サイズ上限と公開障壁を持つ。

## 試験の位置付け

`test/app-data-storage.test.ts` は再起動、OCC、原文Revision、現在分類、公開Reader、Cursor、削除、異種DB拒否、ネスト失敗/Audit失敗、閉じた入力、callback改変を検査する。`test/app-data-attachments.test.ts` はUpload所有、公開リンク、追加Context保護、Symlink/Hardlink/Digest、MIME、孤立ファイル、冪等Uploadを検査する。

HTTP、Generation、実プロセスCrash、Import/Backup、実ブラウザ、性能は専用試験と検証報告を参照する。合成Providerの成功と実Provider接続の成功、バックアップ作成と復元試験、Linux合成環境と対象運用環境は区別する。既存COORDの耐障害保証を、通常会話の全経路へそのまま拡張したとは主張しない。
