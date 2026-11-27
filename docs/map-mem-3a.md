# MEM-3A: 通常回答のMemory・Archive参照

基準は `b21e6760f04ce42b2135619e8524188f887b5fc6`（PR #40マージ後）。MEM-1の承認済み共有記憶とMEM-2の会話検索を、サーバー側の通常回答・明示再生成へ接続する。正本は会話DBと管理対象Markdown、検索IndexとVectorは再構築可能な派生物として維持する。

## 入力と既定値

通常送信には任意の `context` を指定できる。

```json
{
  "context": {
    "mode": "archive",
    "timeZone": "Asia/Tokyo",
    "date": {"mode": "approx", "anchorDate": "2026-11-11"}
  }
}
```

`mode` は `auto / none / memory / archive / both`。`none` は追加の長期参照を止め、現在入力、必須添付、承認済み設定、既存の通常履歴は保持する。各ターンの明示指定、Persona設定、Room設定、`auto` の順に優先する。設定の正本は既存のサーバー設定更新経路で管理する。

日付はArchiveの条件で、明示した `none`・`memory`との併用は入口で拒否する。日付付きでmodeを省略した場合はArchive条件を含むauto相当として、Persona／Roomの既定モードより優先する。日付検証と暦日範囲はMEM-2の処理を共用し、approxは指定日の前後7暦日を1回検索する。strictは指定日・期間を広げない。

timezone未指定時はUTC。相対日付は今日・昨日・一昨日（かな表記と `today / yesterday / day before yesterday` を含む）に限定し、受理時刻とIANA timezoneから解決する。解釈versionと絶対範囲を受付snapshotへ保存し、年なし日付を無条件に現在年へ補完しない。

受理済み入力にはcontextを含むdigestを結び、同一Request IDの再送では元のRunを返す。異なるモード・日付を同じIDで送ると競合になる。旧JSONと旧digestを再保存して互換性を合わせない。ブラウザのpending requestは受理まで同じbodyを保持する。

## RouterとContextの固定

Routerは決定的なローカル処理で、LLM呼出しを行わない。謝辞等は `none`、確定事項は `memory`、過去の発言は `archive`、過去発言と現在方針の比較は `both` を選ぶ。解決済み日付と過去発言の確認意図が重なる場合は、「方針」「決定」「合意」も含む要求をArchiveへ送り、現在方針との比較はbothへ送る。日付が含まれるだけではArchiveへ分岐しない。曖昧な通常会話では、利用できる少量のMemoryを選ぶ。`decision`、固定 `subagent`、既存仕様でコマンドと判定した `/memory` には追加検索しない。

検索Queryは受理済みの現在user入力だけから作る。最大512 UTF-16 code unitに決定的に制限し、surrogate pairの途中で切らない。private履歴、添付本文、private NoteをQueryへ暗黙に足さない。Query省略は回答への現在入力省略を意味しない。

実行は `preflight → route → prepare → freeze → compile → reserve → revalidate → dispatch → commit` に分ける。入力版・設定・認可、履歴窓と先頭固定の競合、添付容量、必須Context、Run予算・取消・期限を有料検索より前に確認する。PersonaごとにMemoryとArchiveをそれぞれ最大1回検索し、採用Sourceの版・digest・範囲を固定する。compileと再検証では検索やEmbeddingを繰り返さない。

固定後にSourceの版・本文・承認・必要な権限が変われば `CONTEXT_CHANGED` として当該処理を止める。別Sourceや最新版への自動置換は行わない。実行済み外部処理のUsageは出力を破棄する場合も保全する。Index世代の切替だけでは固定済み正本参照を差し替えない。

再生成は新Run・新prepare・新予算で、元ターンの設定を既定として継承する。Router本文とseqは `request_json.inputBinding` のuser発言から取得する。元user発言が訂正済みなら現在Revisionを利用する。Archiveは現在Revisionだけを検索し、seq上限は入力bindingのseq、再生成対象Messageは明示除外する。これを候補抽出・周辺取得・freshness・最終照合まで適用する。Memoryはprepare時点の現在版であり、過去時点のDB全体snapshotを再現する機能ではない。

## 認可と公開資料

Human検索は既存APIを維持する。AI検索は受理済みRun、選定済みConsumer Persona、Provider設定、入力bindingから作るサーバー内部bindingを使う。Actor、Source owner、Consumer Persona、audience、送信先、purposeを分離し、ブラウザがこれらの信頼済み値や任意SourceRefを指定する経路を作らない。

公開answerへ追加できるのは、現在有効で承認・由来・現物を検証できた `PUBLISHED / room_shared` Memoryと、現在Revisionの公開 `public_message / shared_summary` Archive。自身のprivate Memoryも公開answerの追加検索には含めない。認可条件はTopKより前に適用し、Lexical、Dense、Worker、coverage、freshness、周辺取得にも通す。

private原典から承認された共有Noteは、共有Note本文だけを公開資料として利用する。由来のproducer・reviewer・registrarの検証は元Actorのまま内部で行う。Consumerへprivate祖先の権限を要求・付与せず、祖先本文・ID・Vault実パスをProvider payloadや公開DTOへ出さない。

## Context Packと出典

資料は通常履歴やシステム方針と区別したenvelopeへ格納し、資料内の区切り文字・指示文をシステム構造へ昇格させない。初期上限はMemory 5件／推定2,048 tokens、Archive 5件／推定4,096 tokens、合計推定6,144 tokens。付随メタデータも見積もりに含め、Host・モデル上限の残容量へ収める。現在入力、必須添付、必須設定、先頭固定発言を追加資料のために押し出さない。

Router v2では原文忠実性を `requiresExactExcerpt`、明示的な全文要求を `requiresFullSource` として分離する。部分引用では検証済み原本から文・行境界と既存の検索語scoreで必要範囲を選ぶ。検索hit前後の各最大128 UTF-16 unitsは補助範囲とし、必要な文がhitやmarginをまたぐ場合はその文末まで含める。全検索のmetadata確定後、必要範囲を先に予約し、margin、hit、必要な文・行の順に容量を調整してから範囲を固定する。縮小によるstatus・reasonも最終envelopeの見積もりへ含める。「全文から一文だけ」などの部分指定は全文要求にしない。明示的な全文要求だけは各検索先の最初の採用Sourceを `0..length` へ拡張し、必須範囲がtoken枠またはcitation APIの4,096 UTF-16上限に収まらなければ `CONTEXT_LIMIT` を返す。補助候補は全文必須にしない。任意の追加資料を短縮した場合は `EXCERPT_TRUNCATED / partial` を記録する。抜粋は原文のUTF-16半開区間で、surrogate pairとCRLFの途中を境界にしない。

Manifestは `MAP-MEM-3:CONTEXT:1`。旧 `MAP-DATA-1:SERVER_CONVERSATION:1` と併存し、旧digestを維持する。実行主体・設定版・入力binding・Provider・Router version・日付解釈・検索状態・Index世代・採用SourceRef・UTF-16半開範囲・実使用権限・費用操作・payload digestを記録する。新規routeは `map-context-router-v2` とし、全文要求フラグを必須booleanで保存する。既存v1 routeは元の範囲・digestを読み継ぎ、再読時にRouterを実行しない。ACL snapshotは監査証跡であり、将来の許可ではない。未実装Summaryと未知Sourceを「依存なし」として受理しない。

サーバーがCall内aliasを割り当て、`[[MAP_SOURCE:S1]]` の予約された引用表記だけを固定Planへ照合する。供給したSourceと本文で引用したSourceを別集合として扱う。未知aliasやモデルが作ったURL・HTML・revisionを出典リンクとして信用しない。標準の非構造化回答、既存の構造化回答、引用なし回答を維持する。

出典表示は回答Message ID・Revision・生成receiptに対応し、原文表示は認可付きcitation APIで現在のActor権限、固定版、digest、正確な範囲を再確認する。検索・alias照合は回答内容の意味的正しさを保証しない。未検出、未構築、部分検索を区別し、「見つからなかった」を「存在しない」と表示しない。

## Note由来と失効

`共有Note → 通常回答 → 後日の /memory → 候補 → 新Note` を既存lineageへ接続する。ArchiveはMessage・Revision・Segment依存、NoteはID・版・file/body digest・owner・scope依存として記録する。生成Noteは既存candidate・publication・producer receipt、手書きNoteは登録者と登録grantへ接続する。

実使用 `READ_MEMORY` はRoom・Persona・scopeの完全一致で追跡する。未使用の権限撤回は無関係のNoteを失効させず、必要な権限のrevoke→regrantで古い承認を復活させない。Watcher未実行でも利用時に現物を照合する。Note内部の権限・依存処理も有界sliceに分け、永続frontierから再開する。長いだけの正常候補を恒久INVALIDにしない。準備時に検証が完了しないSourceはその回から除外できる。

回答の各実行境界では、Note祖先の現在ファイルをwriter transactionの外で32件ずつ読み直し、本文・file digestを検証する。ページ間ではイベントループへ制御を返す。最後にdev・inode・size・ctime・mtimeと候補identityを再照合し、同期callbackの間だけ有効な内部検証状態を付ける。writer内のDB・ACL・採用Note自身の現物照合は維持する。この状態はDBやDTOへ保存せず、次の境界へ持ち越さない。取消・期限は非同期ページ処理中も適用する。

## 外部検索と費用

AI検索の既定はLexical。Human向けProfileの `QUERY_EMBEDDING` だけではAI送信を許可しない。HostのProfileに `aiContext.queryEmbedding: true` と `consumerPersonaIds` を明示し、既存の用途・scope・送信許可・予算も満たした場合だけ、公開answer用Memory Queryを送信できる。AI経路でDocumentEmbeddingや新Rerankerを起動しない。旧Profileは元JSON・digestのままAI capabilityなしとして読む。

```json
"aiContext": {
  "queryEmbedding": true,
  "consumerPersonaIds": ["<existing-consumer-persona-id>"],
  "currency": "USD"
}
```

この項目は既存Host専用Profile JSONへ追加する。`currency` は料金設定と一致する3文字の通貨コードで、上例のUSDは形式例である。Generation側にもHost環境変数 `MAP_PRICING_CURRENCY=USD`（埋込み利用では `Pricing.currency`）を設定する。両方が明示され一致する場合だけAI QueryEmbeddingを送信でき、未設定・不一致は予約transactionをロールバックしてLexicalへ降格する。通貨の推測や自動換算は行わない。旧answer設定とHuman向けProfileの動作は維持する。

Profileの設定・停止・索引再構築は[MEM-2の運用手順](map-mem-2.md)を利用する。所有Persona、scope、空間、成功DocumentEmbedding receiptと現在の送信許可が一致すればQuery-only Vectorを再利用し、capability・予算だけの変更で文書を再送しない。

回答生成の実費台帳は `app_provider_calls`、検索の台帳は `search_operations` のまま維持する。`app_context_answer_holds` は回答枠の未消費予約、`search_operation_bindings` は検索操作と親Run・Planの関係を持つ補助表。holdは作成transaction内の有効なSearch Profile版へ束縛し、同じRunのhold間でProfile版と通貨を揃える。別版のProfileから検索予約を作って同じholdへ接続することはできない。検索予約と親bindingは同一transactionで作り、Profile予算とRun予算を原子的に確認する。回答枠を正式Callへ移すときは二重計上しない。

送信前に不足を確定できればQueryEmbeddingを送らずLexicalへ降格する。通信結果不明は `OUTCOME_UNKNOWN` とし、親Runを `NEEDS_REVIEW` に止める。正常応答でUsageだけ不完全なら必要予約を維持して残予算を判定する。未知Usageを0にしない。取消・期限・再起動から送信権限を再構成せず、遅延結果で回答生成を再開しない。価格は既存Host設定と単位を使う。

## SchemaとBackup／Restore

App Schema 7のmigrationは `app_007_answer_context`。リリース済み1〜6のSQLとCOORD Schema 11は変更しない。Context feature contract、回答予約、検索親binding、NOTE frontier、`notes_done`、旧paused restoreの前後digest receiptを追加する。既存Call counterの意味は維持する。

NOTE frontierはconsumer Call IDと、生成Noteでは権限の複合主キー、手書きNoteではgrant IDを継続位置として持つ。SQLiteの暗黙rowidを永続位置として使わず、Backupの `VACUUM INTO` や再起動後にも未検証権限を飛ばさず続行できる。`receipt_before` は監査上のヒントであり、検証時にはstable Call IDから現在DBのreceipt順を引き直す。

Backupは既存の `MAP-MEM-1:BACKUP:3` で `appSchema: 7` を受理する。新restore reportは `MAP-MEM-3:RESTORE:7` で、MEM-2検索台帳digestに加え、Context予約・binding・Run・Call・receipt・Turnのdigestを照合する。NOTE frontierと検証進捗はMemory台帳へ含まれる。旧Schema・旧Backup・旧paused restore reportは読み継ぎ、Schema7追加によるMemory台帳変化は移行transactionの前後digestで橋渡しする。

復元先は別の空Rootに限定する。セッション・資格情報を無効化し、Provider・検索の未確定送信を保留、未消費回答予約を解放、検索Profileを停止して保守状態で開始する。未完了NOTEの進捗を保全するが、再開前に検証や外部送信を起動しない。既存の資格情報再設定、`resume`、Vault再開手順を利用する。派生Indexは再構築する。復元や再付与で古い承認を復活させない。

## 後続工程と本稼働Gate

MEM-3BはRolling Summaryと `summary` 呼出し、MEM-3Cは正解SourceRefを持つ体系的な検索・回答品質評価と初期上限の調整を扱う。Memory自動承認・統合・階層化、Archive新Dense化、新Provider、COORD／MACP契約変更、ブラウザ生成復活、SSE追加は本変更の対象外。

本稼働Gateでは実ProviderのUsage・価格・取消／切断時挙動、実データ移行、対象機器でのBackup／Restore・Index再構築、TLS・鍵配置、長時間稼働・容量不足を確認する。合成試験の成功をこれらの確認済みとは扱わない。[設計判断](map-mem-3a-adr.md)と[検証記録](map-mem-3a-validation.md)を参照。

PR #41監査のF-01〜F-05修正と回帰対応は[監査修正記録](map-mem-3a-pr41-audit-fixes.md)を参照。

PR #41再監査v1.1のF-01・F-02残存条件への対応は[再監査修正記録](map-mem-3a-pr41-reaudit-v11.md)を参照。
