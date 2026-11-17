# MAP-DATA-1 検証報告

この文書は初回提出HEAD `76be76a` の検証記録である。PR #38 F-01〜F-04の追加修正、
監査修正は[監査修正報告](map-data-1-pr38-audit.md)、最新コードSHA・回帰結果・公開HEADは
[履歴窓1件の再監査追補](map-data-1-pr38-pin-followup.md)を参照。

検証日: 2026-11-17 UTC。対象は DATA-1 のコード・合成環境での機能検証である。
**実Provider試験と対象配備環境の復元試験は未実施のため、本稼働Gateは未通過。**
全体DATA/MEM設計は将来の原本参照・Scope・更新情報の確認に使用したが、MEM-1以降を実装済みとは扱わない。

## 対象と再現条件

| 項目                  | 値                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------- |
| Repository            | `KM9250/Multi-agent-Platform`                                                         |
| 基準main              | `c945bd1228af2c346791012ef3a6935bd5a82d17`                                            |
| 最終コード・テストSHA | `596b4b256c422a5974caef278b28992bab02e7ed`                                            |
| 提出Branch            | `codex/map-data-1-server-conversation`                                                |
| 公開HEAD              | Draft PR本文の `公開HEAD` を参照。上記コードSHAに検証報告・運用文書だけを加えたcommit |
| 基準mainからの変更    | 64 files。既存COORDコード、既存テスト、既存loaderの変更なし                           |
| 契約                  | `MAP-DATA-1:SERVER_CONVERSATION:1`                                                    |
| App DB                | 独立した `app-data.sqlite`、Schema 1、`app_001_conversation_persistence`              |
| COORD DB              | Schema 11、既存Migration 001–011を維持                                                |
| Node / npm / SQLite   | 24.22.1 / 11.9.0 / 3.53.4                                                             |
| OS                    | Linux x86_64、kernel 6.18.57                                                          |
| Browser               | インストール済みChromiumをPlaywright 1.65.1から実行                                   |
| データ                | 合成会話、一時DB、一時添付、一時アカウントのみ                                        |

コード修正後は以下の最終検証を順番に実行し、別Agentの重い試験を並行実行しなかった。
最終コードSHA以降の変更はREADME、移行・運用文書、本報告のみである。
最初の実装commitは `544f836`。追加レビューでnative Usageの省略値保存と添付読込み前の有界化を修正した。

## 最終検証コマンド

| コマンド                                   | 結果                      | 時間（秒） |
| ------------------------------------------ | ------------------------- | ---------: |
| `npm ci --cache /workspace/work/npm-cache` | exit 0                    |      6.775 |
| `npm run typecheck`                        | exit 0                    |      9.648 |
| `npm run build`                            | exit 0                    |      4.215 |
| `npm test`                                 | 2097成功 / 0失敗 / 0 Skip |    520.426 |
| `npm run test:app-data`                    | 118成功 / 0失敗 / 0 Skip  |     20.308 |
| `npm run test:app-data-redteam`            | 101成功 / 0失敗 / 0 Skip  |     14.006 |
| `npm run test:app-data-crash`              | 15成功 / 0失敗 / 0 Skip   |      8.073 |
| `npm run test:app-data-import`             | 12成功 / 0失敗 / 0 Skip   |      2.218 |
| `npm run test:app-data-backup`             | 6成功 / 0失敗 / 0 Skip    |      2.277 |
| `npm run test:app-data-browser`            | exit 0（件数は別記）      |     17.303 |
| `npm run bench:app-data`                   | exit 0（件数は別記）      |     14.478 |
| `git diff --check`                         | exit 0                    |      0.013 |

成功件数は各コマンドの結果であり、重複Suiteを合算しない。
ブラウザー・Benchmarkは通常のNode test件数とは別に報告する。
実Provider専用コマンドは実行しておらず、成功件数やSkip 0の根拠に含めない。

## 既存契約の回帰

以下の指定17系統を実行した。DATA-1追加コードと独立した既存COORD実装・テストは基準mainから不変である。
最終コードSHAではさらに `npm test` を実行している。固定MACP統合は専用コマンドで別実行した。

| コマンド                              | 最終成功 / 失敗 / Skip |
| ------------------------------------- | ---------------------: |
| `npm run test:durable`                |            163 / 0 / 0 |
| `npm run test:durable-execution`      |            111 / 0 / 0 |
| `npm run test:recovery-reader`        |            495 / 0 / 0 |
| `npm run test:runtime-lease`          |             46 / 0 / 0 |
| `npm run test:model-call-ledger`      |            103 / 0 / 0 |
| `npm run test:recovery-authorization` |             90 / 0 / 0 |
| `npm run test:recovery-execution`     |            119 / 0 / 0 |
| `npm run test:recovery-dispatch`      |            129 / 0 / 0 |
| `npm run test:recovery-continuation`  |             92 / 0 / 0 |
| `npm run test:planning-only`          |             52 / 0 / 0 |
| `npm run test:hold-lifecycle`         |              5 / 0 / 0 |
| `npm run test:reconciliation`         |            251 / 0 / 0 |
| `npm run test:reconciliation-redteam` |            135 / 0 / 0 |
| `npm run test:notification-outbox`    |            136 / 0 / 0 |
| `npm run test:notification-redteam`   |             82 / 0 / 0 |
| `npm run test:macp`                   |              9 / 0 / 0 |
| `npm run test:notification-macp`      |              8 / 0 / 0 |

初回の並行開発中には既存child processの準備・watchdog制限に伴う失敗があった。
`recovery-reader` は490成功・5失敗、`recovery-authorization` は89成功・1失敗、
`recovery-execution` は118成功・1失敗。失敗を削除していない。
同じコマンドを静かな実行時間帯に順次再実行した結果が上表である
（各135.294秒、13.911秒、27.550秒）。既存のAssertion、timeout、Skip、コードは変更していない。
この経過は資源競合によるchild準備遅延と整合するが、全環境で発生しない保証ではない。

修正前SHA `544f836` で開始した最終検証の試行は、native Usageの不具合を発見したため
`npm test` の途中で停止した。中断試行を成功として計上せず、「最終検証コマンド」節の検証を修正後SHAで開始し直した。

MACP参照は `KM9250/Multi-Agent-Command-Protocol` の
`e88937d0c8132ae7d18098a24d01ee28bffda655` に固定し、参照先の追跡ファイルは変更していない。
Python 3.12.14、専用venv、認証付き一時Loopback HTTP、実SSE、一時SQLiteで実行した。
稼働中Receiverや実通知先には送っていない。

## HTTP・ブラウザー・Providerの区別

実Chromiumで18操作群が成功した。合成Provider呼出しは3回、外部通信0回。
最終実行で観測したアプリHTTP応答数は以下のとおり。ポーリング回数は実行時間に依存する。

| Method / Status | 回数 |
| --------------- | ---: |
| GET 200         |   73 |
| GET 401         |    6 |
| GET 404         |    1 |
| PATCH 200       |    3 |
| PATCH 409       |    1 |
| POST 200        |    5 |
| POST 201        |    5 |
| POST 202        |    4 |
| POST 409        |    1 |

実ブラウザーの操作対象は実Cookieログイン、Room/Persona作成、本文・添付保存、Avatarと追加Context、
受理ACK喪失後の同一要求再照会、訂正・旧Revision・明示的再生成、旧localStorage移行、
Storage消去後の別Browser Contextでの復元、古い画面からの409、管理失効後の表示消去、
明示Private Grantによる `/memory` 閲覧である。画面経由でサーバー保存先へ接続している。
通常画面のポーリングは既存Run照会のみで、再接続から新しい生成を開始しない。

| 経路              | 検証内容とHTTP回数                                                                                               |
| ----------------- | ---------------------------------------------------------------------------------------------------------------- |
| 合成Browser       | 上記固定シナリオ。Providerは `FakeProvider` で外部Provider HTTPは0                                               |
| Native Gemini形式 | 成功、省略Usage、Usageなし、総数不整合、明示thoughtsの5応答をfetch差替えで検査。保存・再読取り・予約保持まで検査 |
| Native送信障害    | 実Loopback HTTPで「本文受信後socket切断」と「503」を各1 POST。自動再送0、Unknown予約保持、公開結果0              |
| 実Google Gemini   | **未実施、HTTP 0回**。Model未選択、実Usage・実費用の観測なし                                                     |

キーを持たないnative応答試験は実Provider疎通を証明しない。
実接続の手順と明示的有効化・Model・1呼出し上限・価格設定は[運用手順](map-data-1-runbook.md)に記載した。
専用コマンドは実Cookie/APIから実Provider・Usage保存・ブラウザー再読込みまで確認する実装を用意したが、
今回実行したと表現しない。

## 保存・認可・再送防止の試験範囲

| 受入項目              | 検査した境界                                                                                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1-01–07、14–15       | 再起動/別ブラウザー復元、失効、冪等受理、Payload束縛、期待Revision、旧版取得、失敗した再生成の旧成功版保持、保存失敗の拒否                                               |
| D1-08–11              | Recipient/Group/他Personaの参加判断、STAMP、Decision、固定直列Workerの全Call追跡、private `/memory`、分離OFFでも保存分類不変                                             |
| D1-12–13              | ビルド実体のキー検査、認可付き添付/Avatar/追加Context、過去版添付、メタデータにもREAD_ATTACHMENT適用                                                                     |
| G1-01–04、11          | Intent COMMIT/ACK境界、実プロセス再起動、二独立processの同一Call競合、同一Receiptへの収束                                                                                |
| G1-05–10、12          | 全Callの予算、Unknown予約保持、実使用超過、同期ブロック後deadline、取消/ACL撤回、構造不正/部分応答の非公開                                                               |
| RT-DATA-01–07、10、15 | 他ScopeのID、偽Role/Owner、immutable分類、初回/再要求/Reader/ACK復旧の現在認可、悪意Callback、不正URL/tool/モデル、Cursor用途/Actor/ACL束縛、管理権とPrivate読取りの分離 |
| RT-DATA-08–09         | POSIX Root/Symlink/Hardlink/Digest、SVG/HTML拒否、文字列のescaped表示、外部画像・URL fetchなし。Windows Junctionは未検証                                                 |
| RT-DATA-11–14、16     | 偽旧権限/未完了Run、巨大/深いJSON、CSRF/Host/session、削除の旧版/Export適用、固定エラー/秘密を含めないログ                                                               |

巨大Contextは添付本文の読込み前に合計サイズを検査し、8MiB単体と複数添付の両方で
body read 0・Provider送信0を確認した。文字列サイズからの概算は保守的な上限であり、
Provider固有の正確なtokenizerを実装したとは扱わない。

### 実Crashと保存障害

Linux child processを境界通知後に実 `SIGKILL` し、別接続で再開した。
例外だけを投げた試験を実Crashと呼んでいない。

| 境界                                    | 確認内容                                                                        |
| --------------------------------------- | ------------------------------------------------------------------------------- |
| App Migration COMMIT前/後               | Schemaは一度だけ成立、FK整合。自分で作成したDBのbootstrap証跡がある場合だけ再開 |
| Message/Turn受理COMMIT前/後             | 同じRequestへ収束、Message/Turn重複なし、Provider0                              |
| Intent COMMIT前/後                      | 強制終了後のProvider0、保存Intent読取りで送信権を再生成しない                   |
| Provider送信後・応答後・Result COMMIT前 | 送信記録1、再起動後追加送信0、不確定状態として保持                              |
| Result COMMIT後                         | 元Receipt/結果へ到達、追加送信0                                                 |
| 添付staging・file確定後DB前             | 未確定ファイルを取得できず、明示的回収対象として残る                            |
| 通常Transaction COMMIT前/後             | 本文・Revision・Sequence・Auditが全部または無し                                 |
| Importの項目/照合/公開境界              | 不完全Roomは非公開、同じ対応表で再開、二重添付/Messageなし                      |

二独立Node processで同一Callを競合させ、合計送信1を確認した。
SQLiteの実書込みロックによるBUSYと `max_page_count` による実SQLite FULLを発生させ、
Audit失敗・捕捉された内側Transaction失敗も含めて部分COMMITを拒否した。
SQLite FULL試験はホスト全ディスクを実際に埋めた試験ではない。
`Atomics.wait` による120ms同期停止と80ms期限により、timer通知遅延後も結果を成功扱いしないことを確認した。

### 移行、Export、BackupとRestore

旧本文、元時刻、分類、Persona設定、Decision、Reaction、添付bytes/Digestを照合した。
同名Personaを無断統合せず、同旧IDの異内容は競合、同内容の複数Exportは既存IDへ収束する。
Owner/Role/承認/isStreamingは権限・実行Receiptにならず、移行からProviderを起動しない。
ファイル選択はブラウザー8 MiB、サーバー移行Envelope16 MiBが上限であり、大きい旧データには明示的分割が必要である。
分類が確定できない旧情報は隔離原本として保全され、公開本文へ昇格しない。

Backupの生成と、空の別RootへのRestoreをそれぞれ実行した。
DB/添付Digest、意味上の原本Digest、Revision、削除状態、参照整合性を検証した。
添付改変・Symlink・上書き先・改変Restore Reportは拒否した。
CLIの実process列でも account-create → backup → restore → 早すぎるresume拒否 →
password-reset → resume → login/read を確認した。旧Session/旧Passwordは無効、
復元されたJob/Intentは診断状態、Provider送信0である。

これらはLinux一時領域・合成データの復元成功である。
利用者の実データ、対象機器、実媒体、TLS/Reverse Proxy配備を使った復元成功ではない。
Backupは停止中のAppを対象とし、COORDを勝手に停止しない。複数DBの原子的Snapshotは保証しない。

## 性能とCOORD共存

Corpusは100,000 Message、本文各60 bytes、公開Segment1個。50回の逐次取得と
4並列・計100回の取得、50回の保存を測定した。
機器は INTEL(R) XEON(R) PLATINUM 8573C、論理CPU 5、報告メモリ18,882,662,400 bytes。

| 測定                                         |                 結果 |
| -------------------------------------------- | -------------------: |
| 10万件準備                                   |          3362.240 ms |
| 新DB接続での最新50件HTTP・単発               |            21.141 ms |
| Warm HTTP p50 / p95                          |   12.897 / 27.441 ms |
| 4並列 HTTP p50 / p95                         |   51.977 / 89.553 ms |
| 保存 p50 / p95                               |     1.558 / 2.516 ms |
| RSS                                          |    199,438,336 bytes |
| DB本体                                       |    159,920,128 bytes |
| 2,000 Message Import                         |          5813.251 ms |
| 100ms周期のLease更新 / 失敗                  |               55 / 0 |
| Heartbeat最大間隔                            |           152.907 ms |
| Event-loop delay p95 / 最大                  |   25.199 / 59.343 ms |
| 通知予定 / Attempt / Transport送信 / Receipt |    20 / 20 / 20 / 20 |
| Import中の通知完了                           |                   20 |
| 通知失敗 / Pending / HTTP                    |            0 / 0 / 0 |
| 通知enqueue→ACK p95 / 最大                   | 124.001 / 130.103 ms |

この条件で最新50件のp95が1秒未満という暫定目標を満たした。

最新50件の取得は実認証付きLoopback HTTP（JSON parse完了まで）で測定した。
保存はRepository transactionの時間であり、HTTP送信時間を含む値ではない。
新接続測定でOS page cacheは消去していない。平均的な小本文の一条件であり、
大きな添付・長いRevision列・実TLS・ネットワーク・運用機器の性能保証へ一般化しない。

Import共存試験は既存COORD leaseを同じイベントループで更新し、100件Importごとに
WorkflowCancelledを発生させ、既存 `DurableNotificationWorker` のclaim/intent/receiptまで動かした。
通知のTransportはprocess内の合成ACKでHTTP 0。固定MACPの実Loopback試験とは別の証拠である。
Lease失効や通知欠落がこの測定でなかったことは、長期負荷・実受信先のSLA保証ではない。

## 公開前検査と互換性

ブランチの実装2コミットについて、各commitの変更ファイルを検査した（同一ファイルの別版を含む延べ68ファイル版）。実DB/WAL/SHM、Export、添付、ログ等のartifact混入と
一般的なGoogle/GitHub/OpenAI秘密形式・秘密鍵を検査し、該当なし。
追加文書も最終差分で再確認した。テストに含む固定Password/キーは合成fixtureである。
検査用の偽 `GEMINI_API_KEY` を与えて実ビルドし、distの3ファイルにその文字列、
`GEMINI_API_KEY`、`@google/genai`、Provider endpointが含まれず、source map出力も無いことを確認した。
既存クライアントProvider helperは孤立した回帰契約用に残り、production Appからはimportしない。
文字列検査を万能な秘密検出と説明せず、実キーや実データを投入しない方針と合わせて確認した。

変更理由は[ADR](map-data-1-adr.md)、詳細は[Architecture](map-data-1-architecture.md)を参照。
単回送信は外部サービスのexactly-once実行を保証せず、Provider費用はHost価格設定からの推定である。

- Public回答はPrivate履歴やPrivate Worker Reportを消費しない。旧ClientのPrompt注入方式との意図的な差異であり、承認済み公開Projection機能は追加していない。
- UI本文はescaped plain text。任意HTML/外部画像を描画しない。Graphは現在Roomの取得済みページの概観である。別機能だった旧3D SceneViewは接続していない。
- Pollingを採用し、SSE endpointは提供しない。Session/ACLは各pollで再検査する。
- Exportは最大200 MessageのChunkを個別に取得する。全Chunkを一つのSnapshotとする保証はなく、保全には停止中Backupを使う。
- 旧情報の未判別分類を公開へ推測変換しない。Import上限超過は拒否し、切り詰めない。
- 記憶公開、Vault監視、承認、検索、Embedding、Reranker、自動要約、動的Worker選択は未実装。将来接続用のStable ID/Revision/Digest/Scope/変更参照のみを持つ。

## 未実施Gateと利用手順

| 未実施項目      | 状態                                                                         |
| --------------- | ---------------------------------------------------------------------------- |
| 実Provider      | 実キー・承認されたModel/利用上限の提供なし。0呼出し、実Usage/費用/疎通未確認 |
| 対象環境Restore | 実データ・実媒体・実機の権限/FS/停止/切戻し未確認                            |
| Windows         | Junction/Reparse Point、パス大小文字等のOS固有動作未確認                     |
| 本番配備        | 実TLS/Proxy、実鍵rotation、RPO/RTO、保持世代、運用負荷未確認                 |

キーなしで利用する場合は、[運用手順](map-data-1-runbook.md)に従って保護RootとCLIローカルアカウントを作り、
build後に明示的なLoopback開発モード・合成Providerで起動してログインする。
旧ブラウザーのExport → Dry Run → Import照合 → 別ブラウザー確認 → 明示的な旧データ削除の順は
[移行・保全手順](map-data-1-migration.md)に記載した。
Backup → 別Root Restore → 資格情報再設定 → 明示resume → 内容確認 → 切替えも同文書を参照する。
このPRはDraftとして提出し、自動マージを設定しない。
