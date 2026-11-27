# ADR: MEM-3Aの回答Contextと由来

基準: `b21e6760f04ce42b2135619e8524188f887b5fc6`。対象は承認済みMemory・公開Archiveと通常回答の接続である。

## 採用する手法と適用範囲

| 手法 | 適用箇所 | MAP固有の判断 |
| --- | --- | --- |
| [Ports and Adapters／Hexagonal Architecture](https://alistair.cockburn.us/hexagonal-architecture) | 検索、Provider、正本Source readerを交換可能な境界にする。 | 正本・承認履歴をIndexやEmbedding空間から分離し、HumanとAIの入口は別認可を持つ。 |
| [Retrieval-Augmented Generation](https://arxiv.org/abs/2005.11401) | 回答前に外部資料を取得し、入力へ供給する。 | 原論文の学習方式は実装しない。公開answerには有効な共有Noteと現在Revisionの公開Archiveだけを追加する。 |
| [Context Engineering](https://www.anthropic.com/research/effective-context-engineering-for-ai-agents) | 限られた入力枠へ役割を区別して資料を配置する。 | 現在入力・必須添付・設定・先頭固定を守り、残容量でMemoryとArchiveを採用する。 |
| [各アクセス時の認可・最小権限](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html) | 候補抽出、原本取得、送信、保存、出典閲覧で現在の権限を確認する。 | ActorとSource ownerとConsumerを分離し、private祖先の内部由来検証をConsumerへの開示と区別する。 |
| [Data Provenance](https://www.w3.org/TR/prov-dm/) | 元資料、Call、Actor、承認、派生Noteを追跡する。 | 新旧Manifestを共存させ、NOTE/CALLの永続frontierと実使用grantで推移的失効を実装する。W3C形式への完全準拠を主張しない。 |
| [Idempotency](https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/) | 同じ要求の再送で副作用を増やさず、異なる入力を同一IDで実行しない。 | contextと日付解釈を受付へ固定し、明示再生成は新Run・新prepare・新予算にする。 |

## 具体的な判断

RouterはLLMを使わず `none / memory / archive / both` を決定する。追加有料処理を暗黙に増やさず、同じversion・入力から再現できることを優先した。日付は過去発言の意図と組み合わせ、単なる日付質問をArchive検索にしない。

`prepare → freeze → compile → revalidate` を分ける。既存Coordinatorの複数compileをそのまま検索実行箇所にすると再課金とSource変動が起きるため、検索はprepareだけで行う。固定後のSource不整合は停止し、自動再検索しない。Index世代は検索証跡として記録し、正本参照の有効性とは分離する。

初期上限はMemory 5件／2,048 tokens、Archive 5件／4,096 tokens、合計6,144 tokensとする。これはMAPの初期運用値であり、論文が最適性を証明した数値ではない。MEM-3Cの日本語実データ評価で調整する。検索資料を増やすために現在入力を切り捨てない。

新Manifest `MAP-MEM-3:CONTEXT:1` をProvider Callへ保存し、資料本文は正本への版付き参照と範囲で表す。供給資料と公開回答の引用alias集合を区別する。意味的な裏付けまで自動検証したと表示せず、原文は現在の権限で再取得する。通常回答を一律JSONへ変更しない。

共有Noteのprivate祖先は、元producer・reviewer・registrarとして内部検証する。Consumerに祖先の読取権限を要求すると、共有承認の意味を失わせる。逆に祖先本文をContextへ複製すると公開範囲を拡大するため、共有Noteを公開projectionの境界とする。Noteを利用した回答から作る候補にはNOTE依存を残し、同じ情報の循環を独立証拠の増加として扱わない。

長いlineageは永続frontierを有界sliceで進める。現在のprepareに間に合わないSourceは一時除外できるが、長さだけで恒久失効させない。未完了と循環・矛盾・証拠欠落を区別し、再起動後も進捗と候補間の公平性を維持する。

利用時の祖先ファイル検証もwriterを長く占有しないよう、32件単位の非同期ページへ分ける。各境界で実ファイルを再読取し、最後にファイルidentityと変更時刻を照合してから、同期callback限定の検証状態を渡す。DB・ACL・採用Note自身の現物確認は従来の同期境界で行う。長寿命の検証cacheは作らず、再起動・別Call・次の送信境界へ証跡だけを流用しない。

費用の正本台帳は既存のGenerationとSearchの2つを維持する。回答の未消費予約と検索の親bindingだけを補助表へ保存し、同一App DB transactionで両予算を確認する。QueryEmbeddingが回答枠を使い切らないよう先に確保する。既存料金値に新しい固定単価を足さず、GenerationとAI Profileの明示通貨が一致した場合だけAI検索費用をRunへ合算する。未指定・不一致はLexicalへ降格する。通信結果不明とUsageだけの不明を分け、前者は親Runを保留、後者は保守的予約を維持する。外部Providerを含む処理全体に厳密なexactly-onceを保証しない。

Schema7は追加migrationだけで実装する。旧catalogueを再構成する既存SQLやProfile JSON・digestは書き換えない。新frontierがMemory台帳digestへ加わるため、旧paused restoreの移行前後をreceiptで結び、旧報告書の検証を保つ。新restoreはContext台帳digestも照合し、古いIntentから外部送信を再開しない。

永続frontierはstable consumer Call IDと権限の主キーによるkeysetで再開位置を表す。暗黙rowidは `VACUUM INTO` 等で再採番され得るため、永続cursorや承認の根拠にしない。Callの因果順はstable IDからそのDBでのreceiptを引き直して検査し、Backup／Restoreでもconsumerのscope・Manifest参照とkeyset形式を照合する。

MEM-3Aで検索・Context・由来・費用・互換性を接続し、MEM-3BへSummary、MEM-3Cへ体系的品質評価を分ける。これらの統合後に本稼働Gateとして実Provider、実データ移行、実機復元、TLSを確認する。
