# MAP-MEM-2　Room内検索と原文の確認

MEM-2は1回の検索を、ログインした人の1つのRoomに限定する。Room画面の **Search room** で、公開ノートを探す **Memory** と、発言した当時の原文を探す **Archive** を選ぶ。元資料の読取り、引用を開く操作、検索Profileごとの外部利用をサーバーで判定する。実測条件・試験結果・残る確認は[検証記録](map-mem-2-validation.md)にまとめる。

## Roomで検索する

| 選択 | 読める資料と日時 |
| --- | --- |
| Memory | 現行版が `PUBLISHED` である登録ノート。shared／privateの各Scopeについて現在の `READ_MEMORY` に従う。表示日時はノート版の記録日時。 |
| Archive、Current only | 現在のRevisionの、閲覧可能な会話Segment。検索日時は `occurredAt`。同じ発言のpublicとprivateは別の資料として扱う。 |
| Archive、Include historical revisions | 現在の権限で閲覧できる過去版と現行版。各結果にcurrent／historicalと版を表示し、原本から得られた初版・訂正・再生成などの区分を添える。削除済みRoom・Persona・Messageは対象外。 |

検索語の入力後 **Search** を押す。Personaを選ぶと対象が狭くなる。Archiveで日付を指定すると、IANAタイムゾーンの暦日で前後7日間を含めて内容を比較する。同日に候補がある場合も全期間の候補を比較する。**Exact date or period** では指定日から終了日（省略なら同日）までを検索する。指定日と実際の探索期間を結果の上に、該当発言の日時を各候補に表示する。日付なしはRoomの閲覧可能な全期間。Memoryに会話日によるフィルタは適用しない。

初回は索引の構築が必要になる。構築中や再同期要求が表示されたら、時間を置いて明示的に再検索する。**Open original** で引用原文を、**Open surrounding messages** で再認可された前後の現行Segment（各方向最大2件）を開ける。Memoryで共有された本文を読める場合にも、その元になったprivate会話の閲覧には独立した権限が必要になる。

検索は同一OriginのセッションとCSRFを使うPOSTで実行し、サーバー応答とブラウザからの要求にno-storeを適用する。検索語をURLに含めず、結果・原文・引用をReactの一時状態に置く。ログアウト、RoomやActorの変更、認証失効、再同期要求で古い表示を破棄する。同一Originで開いている別タブのログイン／ログアウトを受けた画面も、表示を破棄してセッションを読み直す。タブ間では変更通知だけを送る。原文は改行を保つプレーンテキストとして描画する。

## APIとMEM-3への引継ぎ

`POST /api/app/v1/rooms/:roomId/search` の入力例を示す。

```json
{
  "requestId": "f480f469-42fb-43a8-b7e2-5d4e569537eb",
  "target": "archive",
  "query": "設計 PR39",
  "revisionMode": "current",
  "retrievalMode": "auto",
  "date": {"mode": "approx", "anchorDate": "2026-11-11", "timeZone": "Asia/Tokyo"},
  "limit": 10
}
```

任意の `personaId`、strict期間の `date.endDate` に対応する。WorkspaceとActorはセッションから決まり、未対応フィールドやMemoryへの日付条件はエラーになる。Top-Kの既定は10、最大20。応答の読み方は次のとおり。

| フィールド | 利用側の判断 |
| --- | --- |
| `scope` | 対象Room・資料・版・Persona、指定日、タイムゾーン、実際の暦日範囲、UTCミリ秒の半開区間。 |
| `coverage`・`status`・`reasons` | 計画対象、索引状態、最終同期完了時刻、および更新中かどうかを確認する。現在のActorから読める未反映の変更を検知したときは部分結果として表示する。遅延の即時判定では変更台帳の先頭側と末尾側を各32件まで調べる。大量の変更があるときは最終同期完了時刻を反映時点の目安にする。未構築・構築中・再同期要求・停止・利用不能・部分結果・縮退を、完了した検索の無一致と区別する。 |
| `results` | 原文のSnippet、引用、版の現在性、表示できる話者・所有者等。Archiveのapproxでは該当日の層も含む。 |
| `methods`・`external`・`elapsedMs` | 実際に利用した方式と当該要求の外部利用、検索時間。ArchiveはLexical。Scoreを正答確率に変換しない。 |
| `verification` | この要求で再検証した候補数と除外数。グローバルな変更連番や他Actorの索引件数を表示しない。 |

`POST /api/app/v1/rooms/:roomId/search/citation` に `{citation, includeHistory, surrounding}` を送る。Archiveの版が変わったら、現行表示の引用取得は失敗する。過去版を開くには、明示した履歴モードと、その時点での閲覧権限が必要になる。

| 引用 | 正本への束縛 |
| --- | --- |
| Memory | Workspace・Room・Note ID・版・File Digest・Body Digest・本文範囲 |
| Archive | Workspace・Room・Message ID・Revision ID・版・Segment ID・Segment Digest・Segment内範囲 |

両方の範囲はJavaScript文字列のUTF-16 code unitによる `[start,end)`。対象はMemoryでは既存Parserが返すfrontmatter以降の本文、Archiveでは当該Segmentの原文。原文のCRLFや結合文字を保存し、サロゲートペアの途中を境界に選ばない。引用の照合にファイル名、URL、Vectorの行番号を使う必要はない。

MEM-3の接続先は `shared/search-contracts.ts` と `shared/search-sources.ts`。内部 `SearchAudience` は人の検索とAI Context取得を区別し、AI側にはconsumer Persona・資料種別・Room・外部送信先・用途を要求する。今回の検索サービスが受理するのは人の検索。別PersonaへのContext提供を実装する際は、渡す資料・送信先・用途ごとに再認可する。Query Routing、Context Pack、会話への注入・圧縮、回答生成はMEM-3で扱う。

## ADR　原本から検索結果を再現するための判断

| 手法 | 決定と理由 |
| --- | --- |
| Ports and Adapters | `MemorySourceReader`／`ArchiveSourceReader`が正本を読み、`CitationResolver`が版・Digest・範囲・認可を検証する。`SearchBackend`、`EmbeddingProvider`、`Reranker`は別の境界を持つ。共通Backend試験にSQLiteと参照実装を使う。 |
| CQRSの読取りモデル／Materialized View | App DB・Vaultは既存の責任を保ち、Chunk・FTS・短語・ID・Vector・Cursor・世代を専用SQLiteへ置く。索引全体を正本から再生成できる。 |
| Transactional Outboxと冪等Worker | COMMIT済みの `listNoteChanges` baseline／deltaと `app_changes` を回収する。索引ページとCursorを1つの派生DBトランザクションに保存する。Archiveの初回Watermarkと固定Cutoff、削除Tombstoneで、初回巡回中の変更を回収する。 |
| 転置索引・文字n-gram・BM25 | FTS5 trigramに1～2 Unicode文字の転置索引とID一致を追加し、日本語短語・識別子を扱う。日時、ID、検索Scopeの制限を上位候補の決定前に適用する。 |
| Hybrid Retrieval／Reciprocal Rank Fusion | 許可・設定・Coverageが揃ったDenseとLexicalの順位を各1位から数え、`sum(1 / (60 + rank))` で統合する。方式内の重複を除き、同点を安定IDで解決する。 |
| 版付き引用と原本再検証 | ノートの `readNote` はlive-file検証を含む。現行版を読めない場合は通常検索から外す。Archiveは現在のMessage・Revision・Segment・所有Personaと引用を照合する。 |
| 世代の構築・切替・Rollback | 同期と整合性検査を完了した世代をACTIVEにし、旧世代をRETIREDにする。途中で停止したBUILDING／VALIDATING／READY世代は検索対象外。検索要求は1つの世代を参照する。 |

MAP固有の判断には、Actorごとの読取り領域、人とconsumer Personaの区別、公開状態とprivate会話の独立した認可、MEM-1の失効契約がある。日付許容検索は、暦日の範囲フィルタ・内容比較・順位付けを組み合わせた運用ポリシー。特定日の事実の有無や利用者の記憶の正誤を判定する機能ではない。正本と索引は別のCOMMITを持つ。規模に合わせて単一Host上のSQLiteを採用した。

### Analyzerと上限

`nfkc-lower-whitespace-v1` は検索用コピーだけにNFKC・小文字化・空白列の圧縮を適用する。`trigram-shortpostings-id-v1` は正規化したQuery全体に加え、ラテン文字・数字・日本語等の文字種に沿って分けた語を使う。5文字以上の日本語語列は連続3文字の部分一致も探す。長い入力のプローブは全体に分散して採取し、全体と個々の語の一致を順位付けに使う。長語はFTSのリテラルに変換し、短語の経路はUnicodeコードポイント数で選ぶ。日本語形態素解析、同義語展開、年の補完は行わない。

`paragraph-utf16-v1` は最大768 UTF-16 code unit、Overlap 96を基準とする。Memoryでは長い範囲内の見出しや段落境界を優先する。別のノート・会話Segment・版を連結しない。原文のリンク・添付・画像を解決する処理は検索に含まれない。

| 処理 | 初期上限 |
| --- | --- |
| Query／候補 | APIのQueryは最大512 UTF-16 code unit。各方式100候補、原本検証200候補まで。 |
| 検索 | サービス同時処理4、検索期限10秒。Lexicalは別プロセスで実行し、取消・期限時は実計算を停止する。 |
| 索引 | Worker同時1、待ち行列4、1ジョブ30分。検索時の差分更新は直近同期から5秒を目安に要求する。未反映変更を検知した場合は前倒しする。 |
| Dense | パーティション・要求ごとに最大10,000 Chunk、Vector合計24 MiB、Worker同時2、待ち行列0。全対象のCoverage・バイト数・読取り権限を確認する。上限超過や未完成時は理由を返す。 |

上限は初期の制御値。例えば768次元のfloat32では24 MiBは8,192本に相当し、件数上限の前にバイト上限に達する。採用モデル、次元、対象拡大、Rerankerの価値は日本語の正解SourceRef付きデータ・遅延・更新コストで評価する。

## Hostの操作

App Schema 5は `search_profiles` と `search_operations` を正本DBに追加する。Schema 1～4から所定のMigrationを通す。検索契約は `MAP-MEM-2:SEARCH:1`。COORD Schema 11と既存MACP契約を維持する。派生領域は保護されたApp Rootの `search-index/` 配下に置き、Workspace・Actor・Roomを束縛する。ManifestにAnalyzer・Chunker・正本契約、設定Digest、ACL、復元世代、同期位置、検証結果とCoverageを記録する。

以下はBashの例。Host CLIは排他ロックを取得するため、稼働中のサーバーを停止してから実行する。各変数にはHostの保護Rootと既存Workspace、依頼元Actor、RoomのIDを指定する。

```bash
scope=(--root "$app_root" --workspace "$workspace" --actor "$actor" --room "$room")
npm run app:admin -- search-status "${scope[@]}"
npm run app:admin -- search-rebuild "${scope[@]}"
npm run app:admin -- search-sync "${scope[@]}"
```

`search-status` の世代一覧でACTIVEのManifestと最終同期時刻、ジョブ状態・失敗理由を確認する。再構築・差分同期は指定した実在Actorの現在の権限で動く。ACL変更後の再同期は、新しいbaselineから行う。MEM-1の候補・ノートの承認には既存の失効判定が適用される。

```bash
npm run app:admin -- search-stop "${scope[@]}"
npm run app:admin -- search-resume "${scope[@]}"
npm run app:admin -- search-rollback "${scope[@]}" --generation "$retired_generation_id"
```

Rollbackは互換なRETIRED世代に現在の差分を適用し、認可・復元世代・設定と原本を再確認して切り替える。全世代を片付ける場合は、次の2操作でこのパーティションを削除し、再構築する。通常の再構築では旧世代は残る。費用とProfile履歴はApp DBに残るため、Denseを再生成する前に予算を確認する。

```bash
npm run app:admin -- search-delete "${scope[@]}"
npm run app:admin -- search-rebuild "${scope[@]}"
```

### 外部Profile

初期状態ではProfileがなく、保存・検索に伴う外部呼出しは0件。外部利用の前に、対象PersonaとScopeの現在の読取り権限と、同じRoom・Persona・Scope・Providerへの `SEND_TO_PROVIDER` が必要になる。鍵はHostの `GEMINI_API_KEY` で与える。ProfileはCLIだけが設定でき、検索APIの `retrievalMode` には許可を広げる効力がない。

Host専用のJSONファイルに次の形で設定する。各数値は**形式を示す例**。実際に進める場合は金額単位と適用価格をHostで確認し、件数・Token・費用を業務上許容した上限に置き換える。費用はHost指定単価による推定で、実際の請求額の取得とは別になる。

```json
{
  "personaId": "<existing-persona-id>",
  "scopes": ["room_shared"],
  "purposes": ["DOCUMENT_EMBEDDING", "QUERY_EMBEDDING"],
  "maxCalls": 5,
  "maxTokens": 40960,
  "maxCostMicros": 50000,
  "priceMicrosPerThousandTokens": 1000
}
```

```bash
npm run app:admin -- search-profile-set "${scope[@]}" --config "$absolute_config_path"
npm run app:admin -- search-sync "${scope[@]}"
npm run app:admin -- search-profile-stop "${scope[@]}"
```

構成版を設定すると新しい予算が有効になる。上例は1つのPersonaが所有するroom_sharedの公開済みノートと、その検索語の外部送信を個別に許可している。privateを含める場合は `persona_private` をHostが明示する。文書だけをEmbedする場合は `QUERY_EMBEDDING` を外す。Profile設定後のCLI `search-sync`／`search-rebuild` は、許可・設定・予算が揃った文書について実際に外部送信し得る。Roomでの検索に付随する自動同期は文書を外部送信しない。

Google REST Adapterは `gemini-embedding-2:embedContent` に1要求1Chunkまたは1Queryを送る。入力量を制限し、Document／Queryのテンプレート、768次元、cosine、unit-f32と空間IDを固定する。透過的再試行と別Providerへの切替は行わない。Qdrantへの交換やCohereのEmbedding／実Reranker採用は将来の評価対象。

送信前の予約、送信Intent、ReceiptをApp DBに記録し、同じ操作IDでの再送を防ぐ。タイムアウトや送信後の応答欠落は結果不明として予約を使用中と数える。Usage確定前の予約は1操作8,192 TokenとHost指定単価から算出する。 `search_operations` の `usage_json` と `estimated_cost_micros` 、`reserved_tokens`・`reserved_cost_micros` で確定・部分・不明を区別する。返答後に設定・認可・原文が変わっていれば費用記録を残し、Vectorの採用を止める。

### BackupとRestore

既存Hostの `backup` と `restore` を使う。正本DB、Vault確定版、添付、承認・失効、検索Profileと費用台帳を保全し、派生索引をBackupの成立条件から外す。検索用の未解消 `DISPATCH_INTENT` がある場合はBackupを進められない。保守中は新しい外部操作を開始しない。

Restore先は再開前の保守状態で開始する。資格情報を再設定し、既存のRestore検証・`resume` を実施する。旧Cursorは復元世代の変更で無効になる。Profileは停止し、復元したIntentは自動再送しない。ローカル検索は正本から再構築する。外部Vectorが必要なら、Hostが復元後の送信範囲・新しい予算・鍵を明示してProfileを設定する。手順の共通部分は[DATA-1運用手順](map-data-1-runbook.md)と[MEM-1運用記録](map-mem-1.md)を参照。

## 本稼働前の確認項目

MEM-2のマージ判定には実装・受入試験と既知の制約を用いる。本稼働の可否は、MEM-3の検索→Context→会話の統合後、対象環境の実測で別途判定する。

- 実Providerの認証、入出力、切断時の台帳とUsage、実費とHost単価の突合せ。
- 日本語実データの正解SourceRef、Recall@K、モデル・次元・Rerankerの比較、応答と索引更新の費用。
- 実データ移行の件数・Digest・履歴・ACL照合、代表的な訂正・削除・撤回。
- 対象機器の10万MessageでLexical／日付検索p95 1秒、Hybrid p95 3秒という評価目標、通常保存・COORDとの共存時の遅延、待ち行列とRSS。Hybridには外部待ち時間も含める。
- Backup／Restore実機訓練、再構築所要時間と再Embeddingの予算、RPO／RTO、保護Root・静的配信との分離、TLS・パスワード・鍵の配置。
- 長時間稼働、容量不足と旧世代保持、Worker中断・再開、障害後の結果不明の調査手順。DATA-1／MEM-1から引き継いだ未完の本稼働Gate。

[試験の再現手順・測定結果](map-mem-2-validation.md)
