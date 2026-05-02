# AppSheet MCP クックブック

> **位置づけ**: 典型的な AppSheet 構築シナリオを **MCP ツール呼出の手順**として書き下したレシピ集。`appsheet-builder` エージェントが本書のレシピを参照して実装する。
>
> 各レシピは **目的 → 前提 → 手順 (ツール呼出) → 検証 → 落とし穴** の順で構成。

---

## 目次

1. SQL スキーマから AppSheet 立ち上げ
2. 既存テーブルへの REF 列後付け（親子化）
3. 仮想列で集計値を出す
4. Bot から GAS を叩いて重い処理
5. OpenUrl Action で外部 WebApp 起動
6. テーブルクローン展開（請求 → 見積 等）
7. Enum 列の選択肢を一括差替え
8. Action の式書換と verify
9. View / Action / Bot のクローン展開
10. Cookie 失効時のリカバリ

---

## レシピ 1: SQL スキーマから AppSheet 立ち上げ

### 目的

既存の SQL テーブルを AppSheet のテーブルとして取り込み、最低限の View / Action を生成する。

### 前提

- AppSheet の **データソース接続**は事前に Editor で完了（GUI 必須・MCP 化不可）
- ターゲットの SQL テーブル名・PK 列名が分かっている

### 手順

```
1. appsheet_refresh_app_def
   → 現在のアプリ定義スナップショットを最新化

2. appsheet_get_app_metadata
   → 現在のテーブル一覧を確認（重複しないテーブル名を選ぶ）

3. (現状: 新規テーブル一括追加ツールは未実装)
   暫定: AppSheet Editor で「Add Table」を 1 回手動実行 →
        appsheet_refresh_app_def → 以降の列調整は MCP で

4. appsheet_get_full_columns({ table: "<新テーブル>" })
   → SQL から自動生成された列の型を確認

5. appsheet_set_column_type で型を調整
   appsheet_set_column_flag で IsKey / IsLabel / IsHidden を設定
   appsheet_set_column_description で列の意味を記述

6. appsheet_set_column_formula で
   - キー列: Initial Value = UNIQUEID() （AppSheet が自動入力する場合）
   - 担当者列: Initial Value = USEREMAIL()
   - 作成日時列: Initial Value = NOW()
```

### 検証

- `appsheet_get_full_columns` で再取得し、設定が反映されているか
- AppSheet Editor で View を 1 つ開いて表示確認

### 落とし穴

- **データソース接続は Editor で先にやる**。MCP では接続情報を作れない。
- スプシ・SQL とも、列名に空白・記号があると AppSheet 内部名が変わる。`get_full_columns` の `Name` を正として使う。

---

## レシピ 2: 既存テーブルへの REF 列後付け

### 目的

既存の業務テーブルに親テーブルへの参照を追加し、dereference や REF_ROWS で集計可能にする。

### 前提

- 親テーブル（マスタ等）は既に存在
- 子テーブル側の現状の親キー列（テキスト型で書かれているケースが多い）

### 手順

```
1. appsheet_get_full_columns({ table: "子テーブル" })
   → 既存の親キー列を確認（例: "顧客 ID" が Text 型）

2. appsheet_set_column_type
   {
     table: "子テーブル",
     column: "顧客 ID",
     newType: "Ref",
     typeAuxData: { ReferencedTableName: "顧客マスタ", IsAPartOf: false },
     apply: false  // まず dry-run
   }

3. dry-run の差分を確認

4. 同じ呼出で apply: true で実行

5. appsheet_refresh_app_def → IsValid 確認

6. （オプション）親テーブル側に逆参照仮想列を追加:
   appsheet_add_virtual_column
   {
     table: "顧客マスタ",
     name: "案件件数",
     formula: "COUNT(REF_ROWS(\"案件\", \"顧客 ID\"))",
     type: "Number"
   }
```

### 検証

- 子テーブル → 親への dereference が動くか:
  - `appsheet_find_records` で 1 行取得 → 親 ID 列に有効な値があるか
- 親テーブル detail View で REF_ROWS の集計値が出るか

### 落とし穴

- **既存値が親テーブルに無い**と REF 化で「Invalid value」になる。事前にデータクレンジング。
- IsAPartOf: true は **親削除時に子も連鎖削除**される。慎重に。

---

## レシピ 3: 仮想列で集計値を出す

### 目的

親レコードに「子レコードの集計値」を表示する。

### 前提

- 子→親の REF が既に設定済み

### 手順

```
appsheet_add_virtual_column
{
  table: "案件",
  name: "請求合計",
  formula: "SUM(REF_ROWS(\"見積明細\", \"案件 ID\")[小計])",
  type: "Price",
  apply: true
}
```

### 検証

- detail View で表示されるか
- `appsheet_find_records` で取得して値が正しいか

### 落とし穴

- REF_ROWS は **子側に親 ID 列の REF が設定済み**でないと使えない（テキスト列ではダメ）
- 大量行で多用すると同期が遅くなる（best-practices.md §仮想列）

---

## レシピ 4: Bot から GAS を叩いて重い処理

### 目的

Edit トリガーで GAS 関数を呼び、結果を AppSheet に書き戻す。

### 前提

- GAS スクリプトは事前に AppSheet 連携済み（Editor で OAuth 完了）
- 業務テーブルに「処理フラグ」「処理結果」「更新日時」列を立てる

### 手順

**フェーズ A: テーブル準備**

```
appsheet_add_virtual_column ではなく、実列で 3 つ追加:
- 処理フラグ (Yes/No, Initial Value: FALSE)
- 処理結果 (LongText)
- 更新日時 (DateTime, Initial Value: NOW())

(現状: 実列追加ツールは未実装。Editor で追加 → refresh_app_def)
```

**フェーズ B: Bot 構築**

```
(現状: Bot 新規作成ツールは未実装。クローンか Editor で作成)

1. 既存テンプレ Bot をクローン:
   appsheet_clone_bot({
     fromName: "テンプレ Bot",
     toName: "案件処理 Bot",
     newTable: "案件"
   })

2. Event Condition を設定:
   appsheet_set_action_condition (Event 用ヘルパは現状未実装)
   → 暫定で saveapp 直叩き、または Editor で
   "AND([処理フラグ] = TRUE, ISNOTBLANK([更新日時]))"

3. Process の Task として AppsScript Task を組込み
   (Call a Script Task 専用ヘルパは現状未実装)

4. 末尾で「処理フラグ FALSE 化」Action を実行
```

**GAS 側**:

```javascript
function processCase(caseId) {
  try {
    // 重い処理
    const result = doHeavyWork(caseId);
    return "OK," + result;
  } catch (e) {
    return "ERROR," + e.message;
  }
}
```

**AppSheet 側で結果を受ける**:

Process 末尾の Action で:

```
処理結果 = [Outputs].[ScriptOutput]
処理フラグ = FALSE
更新日時 = NOW()
```

### 検証

- 行を編集 → フラグ TRUE → Bot 発火 → GAS 実行 → 結果列に文字列・フラグ FALSE
- Manage → Monitor で Bot 実行ログを確認

### 落とし穴

- Adds/Updates 二重発火。**Updates のみ**にする。
- フラグ FALSE 化を忘れると無限再実行。**必ず Process 末尾に組込む**。
- GAS のタイムアウト（5 分）を超える処理は分割。

---

## レシピ 5: OpenUrl Action で外部 WebApp 起動

### 目的

業務テーブルから外部の HTML ページに遷移し、ID と USEREMAIL を URL パラメータで渡す。

### 前提

- 外部 WebApp は HTTPS で公開済み
- WebApp 側で USEREMAIL の妥当性を再検証する仕組み

### 手順

```
appsheet_clone_action({
  fromName: "テンプレ OpenUrl Action",
  toName: "帳票プレビュー",
  newTable: "案件",
  apply: false
})

(現状: OpenUrl 専用ヘルパは未実装。クローン後に式を書換)

appsheet_set_action_value({
  actionName: "帳票プレビュー",
  newValue: "CONCATENATE(\"https://example.com/report?id=\", ENCODEURL([案件 ID]), \"&user=\", ENCODEURL(USEREMAIL()))",
  apply: true
})
```

### 検証

- AppSheet モバイル / Web で Action ボタン押下 → 外部 URL に遷移
- URL パラメータが正しく ENCODEURL されているか

### 落とし穴

- **HTTP は不可**。HTTPS 必須。
- USEREMAIL を URL に直書きすると改竄リスク。**WebApp 側で OAuth/JWT 等で再検証**。
- iframe 埋込みは別機能（IFrameSettings）で実現する。

---

## レシピ 6: テーブルクローン展開（請求 → 見積 等）

### 目的

既存テーブル（業務一式）を別テーブル名で複製。Schema・DataSet・Action・View まとめて。

### 前提

- 元テーブルは正常動作している
- 新テーブル名はアプリ内で未使用

### 手順

```
appsheet_clone_table({
  fromTable: "請求書",
  toTable: "見積書",
  apply: false  // まず dry-run
})

→ dry-run の差分を確認（Schema, DataSet, Actions, Views が新名で複製されるか）

→ apply: true で実行
```

### 検証

- `appsheet_get_app_metadata` で新テーブルが登録されているか
- 新テーブルの View が表示できるか
- Action が動作するか（必要なら式中の旧テーブル名参照を `set_action_*` で書換）

### 落とし穴

- **データソース側のテーブル/シートは別途用意**（AppSheet 側のテーブル名と一致させる）
- Bot は **clone_table の対象外**。必要なら別途 `clone_bot` する
- 式中に旧テーブル名がハードコードされていると新テーブルでも旧データを見てしまう。`set_action_value` 等で書換

---

## レシピ 7: Enum 列の選択肢を一括差替え

### 目的

ステータス列の選択肢を変更（例: `[未対応, 対応中, 完了]` → `[未着手, 着手, 確認待ち, 完了]`）。

### 手順

```
1. 現状確認:
   appsheet_get_full_columns({ table: "案件" })
   → ステータス列の TypeAuxData.EnumValues を確認

2. 一括置換:
   appsheet_set_enum_values({
     table: "案件",
     column: "ステータス",
     values: ["未着手", "着手", "確認待ち", "完了"],
     apply: true
   })

3. 既存データの移行（旧値 → 新値）:
   appsheet_find_records で旧値の行を取得
   appsheet_edit_records で更新
   または SQL 側で UPDATE
```

### 検証

- フォームで Enum ドロップダウンに新値が出るか
- 既存データに旧値が残っていないか（残っていると Valid_If エラー）

### 落とし穴

- **既存データが旧値のまま**だと、検索・フィルタで引っかからなくなる。データ移行を忘れない。
- ロケール違い（半角/全角・前後スペース）で一致しないことがある。

---

## レシピ 8: Action の式書換と verify

### 目的

既存 Action の Condition / Value を MCP から書き換える。

### 手順

```
1. 現状取得:
   appsheet_get_action_detail({ actionName: "公開済み化" })
   → Condition と Value を確認

2. dry-run:
   appsheet_set_action_condition({
     actionName: "公開済み化",
     newCondition: "AND([ステータス] = \"承認済み\", ISNOTBLANK([WP投稿URL]))",
     apply: false
   })

3. 差分を見て問題なければ apply: true

4. 検証:
   appsheet_get_action_detail で再取得
   IsValid: true を確認
   Editor の Action 編集画面で式が想定通りに表示されているか
```

### 落とし穴

- **複雑な式（ネストした SWITCH）は再パースされない**ことがある。`IsValid: false` か Editor で式が壊れて表示されたら、式を簡素化して再送。
- `Evaluatable` を空文字で送ると AppSheet 側の再パースを強制できる。`set_action_*` ツールはこれを内部でやっている。

---

## レシピ 9: View / Action / Bot のクローン展開

### 目的

1 個のテンプレを複数テーブル向けに展開（例: 同じ「公開済み化」Action を複数業務テーブルに横展開）。

### 手順

```
for table in ["案件", "請求", "見積"]:
  appsheet_clone_action({
    fromName: "公開済み化_テンプレ",
    toName: f"公開済み化_{table}",
    newTable: table,
    apply: true
  })

  appsheet_set_action_value({
    actionName: f"公開済み化_{table}",
    newValue: "...",
    apply: true
  })
```

Bot 横展開も同様：

```
appsheet_clone_bot({
  fromName: "通知 Bot テンプレ",
  toName: "案件通知 Bot",
  newTable: "案件"
})
```

### 検証

- 各 Action が正しいテーブルを向いているか（`get_action_detail.Table`）
- Bot は 4 配列リンク整合性が保たれているか

### 落とし穴

- **clone_action は ColumnToEdit を新テーブルにマッピングしない**。クローン後に `set_action_value` で対象列名を補正。
- Bot クローンは Event/Process/Tasks も全部新名で複製されるが、Tasks 内の式中の旧テーブル名は手動置換が必要。

---

## レシピ 10: Cookie 失効時のリカバリ

### 症状

- `/api/saveapp` を叩くと 401 が返る
- もしくは HTML（ログイン画面）が返る
- MCP ツールが「Cookie expired」エラーで停止

### 手順

```
1. AppSheet Editor を Google ログイン状態で開く

2. 対象アプリで任意の編集を 1 回 → Save

3. F12 → Network タブ → "saveapp" リクエスト
   右クリック → Copy → Copy as cURL (bash)

4. 結果を appsheet-mcp/samples/saveapp.curl.txt に貼付

5. cURL の "-b '...'" の中身を抽出

6. .env の APPSHEET_COOKIE=... を更新

7. MCP サーバー再起動（Claude Code を再起動）

8. 動作確認:
   appsheet_refresh_app_def を実行 → 200 で完了するか
```

### 落とし穴

- **Cookie は約 30 日有効**。失効サイクルをカレンダーに登録しておく
- Cookie に **改行文字が混入**するとパースに失敗。`.env` で 1 行に収める
- 複数 Google アカウントを使い分けている場合、**Editor を開いたアカウントと saveapp を叩く App Owner が一致**しているか確認

---

## レシピ 11: 「個人設定」テーブルでマルチロール権限管理

### 目的

実プロジェクトで鉄板の **マルチロール権限管理パターン**を MCP ツールでセットアップ。`USEREMAIL()` の直接比較ではなく、個人設定テーブル経由で「担当者ロール / 管理者ロール」を切替可能にする。

### 前提

- 業務テーブル（例: `ケース記録`）が既に存在
- 担当者情報を保持する列（例: `[記録者]`）がある

### 手順

**フェーズ A: 個人設定テーブルを作成（手動 or create_table）**

```
appsheet_create_table({
  newTableName: "個人設定",
  sourceQualifier: "個人設定",   // データソース上の実体名
  templateTableName: "<既存の AppSheet DB テーブル名>",
  apply: false
})
```

その後、Editor で以下の列を整える（実列追加は GUI または HAR ベースで実装される将来ヘルパで）:

```
個人設定:
  - UserMail (Email, IsKey: true)
  - 職員在籍ID (Ref → StaffStatus__c など)
  - 職員在籍YN_ケース (Yes/No)
  - 職員在籍YN_帳票 (Yes/No)
  - 利用者ID (LongText)
  - 使用事業所 (LongText)
```

**フェーズ B: 個人設定の Security Filter（自分の行のみ）**

```
appsheet_set_security_filter({
  tableName: "個人設定",
  filter: 'USEREMAIL() = [UserMail]',
  apply: true
})
```

**フェーズ C: 業務テーブルの Security Filter（個人設定経由）**

```
appsheet_set_security_filter({
  tableName: "ケース記録",
  filter: 'IF(ANY(個人設定[職員在籍YN_ケース]), [記録者] = ANY(個人設定[職員在籍ID]), TRUE)',
  apply: true
})
```

**フェーズ D: ユーザーカスタマイズ Slice**

```
appsheet_add_slice({
  sliceName: "ユーザーカスタマイズ",
  sourceTable: "個人設定",
  filterCondition: 'USEREMAIL() = [UserMail]',
  apply: true
})
```

これで設定編集 View で「自分の設定だけ」が見える。

### 検証

- 担当ロール（職員在籍YN_ケース = TRUE）でログイン → 自分の記録者の行のみ表示
- 管理者ロール（職員在籍YN_ケース = FALSE）でログイン → 全行表示
- 個人設定テーブルで他人の行は見えない

### 落とし穴

- 個人設定の **行が複数あると `ANY()` で 1 行決まらない** → 必ず Security Filter で 1 行に絞る
- 個人設定が `USEREMAIL()` の値を持っていないユーザーは **データが見えない** → デフォルト行を AppSheet API v2 で自動追加する Bot を別途作る
- `ANY()` の引数列が **null だと比較が成立しない**（`null = 値` は FALSE）。null チェックを `IFS()` か `OR(ISBLANK(...), ...)` で先に入れる

---

## レシピ 12: マルチテナント識別子で 1 マスタ N アプリ運用

### 目的

複数テナント（事業所）が **共通のマスタテーブル**を参照しつつ、それぞれ自テナントのデータだけ見える構成を作る。

### 前提

- マスタテーブル（例: `001_事業所加算マスタ`）に `[使用事業所]` 列（LongText）がある
- 各行の `[使用事業所]` には `"HAHAHA, FUFUFU, FOO_BAR"` のようにテナント識別子をカンマ区切りで保持

### 手順

```
1. アプリ識別子を決める（例: "HAHAHA"）

2. マスタの Security Filter を設定:
   appsheet_set_security_filter({
     tableName: "001_事業所加算マスタ",
     filter: 'IN("HAHAHA", [使用事業所])',
     apply: true
   })

3. 「フラグ ON のものだけ」を見せる Slice:
   appsheet_add_slice({
     sliceName: "有効_事業所加算",
     sourceTable: "001_事業所加算マスタ",
     filterCondition: '[フラグ]',
     apply: true
   })
```

### 検証

- アプリ A から `001_事業所加算マスタ` の `[使用事業所]` に `"HAHAHA"` が含まれる行のみ取得
- アプリ B（識別子 "FUFUFU"）からは別の行集合
- マスタを更新 → 識別子追記すれば該当アプリで即時表示

### 落とし穴

- アプリ識別子を `[使用事業所]` から漏らすと、そのアプリでは行が見えなくなる（**追加だけで OK**、削除は影響大）
- 識別子のスペル違い（HAHAHA vs HaHaHa）で IN マッチしない → **大文字統一など命名規約を docs に明記**
- 大量行マスタで全件 IN 評価は重い → **Slice 経由でさらに絞り込み**

---

## レシピ 13: 帳票生成の 3 段階 Bot 自動化チェーン

### 目的

帳票（PDF）生成のような複数段の処理を Bot チェーンで実装する。ADDS → UPDATES → UPDATES の 3 段で **段階的に処理**する。

### 前提

- 業務テーブル（例: `帳票マスタ複製登録`）に以下の列がある:
  - `[帳票完了フラグ]` (Yes/No)
  - `[展開UserMail]` (Email, 処理済みマーカー)
  - 子テーブル（例: `帳票子レコード複製登録`）への REF が定義済み

### 手順

**Bot 1: ADDS_ONLY で子展開**

```
appsheet_create_bot({
  botName: "帳票_子展開_自動化",
  tableName: "帳票マスタ複製登録",
  actionName: "<子展開 Action>",
  eventType: "ADDS_ONLY",
  filterCondition: 'TRUE',
  apply: true
})
```

**Bot 2: UPDATES_ONLY で子項目反映**

```
appsheet_create_bot({
  botName: "子項目_スプシ反映",
  tableName: "帳票マスタ複製登録",
  actionName: "<子項目反映 Action>",
  eventType: "UPDATES_ONLY",
  filterCondition: '[展開フラグ] = TRUE',
  apply: true
})
```

**Bot 3: UPDATES_ONLY で完了登録**

```
appsheet_create_bot({
  botName: "帳票完了登録_基本報酬",
  tableName: "帳票マスタ複製登録",
  actionName: "<完了登録 Action>",
  eventType: "UPDATES_ONLY",
  filterCondition: 'AND([帳票完了フラグ], ISBLANK([展開UserMail]))',
  apply: true
})
```

**Bot 4: Schedule Bot で PDF 生成**

```
PDF 生成は別途 Schedule Bot で対象 Slice (PDF生成待機リスト) を処理。
（create_bot は Schedule トリガをまだサポートしていないので、HAR 取得後に対応）
```

### 検証

- 親行を追加 → Bot 1 で子展開
- 親行を更新（展開フラグ ON） → Bot 2 で子項目反映
- 親行を更新（帳票完了フラグ ON） → Bot 3 で完了登録 → 展開UserMail が埋まる
- Schedule Bot で PDF 生成

### 落とし穴

- ADDS_ONLY と UPDATES_ONLY を**明確に分離**しないと Bot 2 が Bot 1 直後にも誤発火する
- 完了系 Bot の Condition で **`ISBLANK([展開UserMail])`** を入れないと 2 重実行する
- Bot 3' (帳票完了登録_算定以外) のように、同じ EventType でも **Condition で分岐**して並行 Bot にできる

---

## 付録 A: ツール呼出の dry-run / apply 規約

書込み系ツールはすべて **デフォルト dry-run**。`apply: true` を明示しない限り実環境に反映されない。

**推奨フロー**:

1. dry-run（`apply` 省略 or `false`）
2. 差分を Claude Code に表示・確認
3. 問題なければ `apply: true` で同じ呼出を再実行
4. saveapp レスポンスでの verify を確認
5. 必要なら `appsheet_refresh_app_def` で再取得

## 付録 B: 想定外時の安全停止

書込みが失敗した場合、`appsheet_refresh_app_def` で現状を取得し、**意図しない差分が無いか確認**する。saveapp は丸ごと置換型なので、失敗しても直前の状態が保たれているはず（ただし Cookie 認証の途中エラー等では中途半端な状態になり得る）。

**復旧の基本**:

1. `appsheet_load_app_def` で現状の appdef を確認
2. 想定と異なる箇所を `appsheet_refresh_app_def` 後に再操作
3. それでも復旧しない場合は AppSheet Editor の「Versions」機能で前バージョンに戻す（Editor 必須・MCP 化不可）
