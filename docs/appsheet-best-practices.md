# AppSheet 設計ベストプラクティス

> **位置づけ**: AppSheet アプリの設計・運用で迷ったときの**判断基準集**。`appsheet-spec.md` が「何ができるか」の仕様書だとすれば、本書は「**どう選ぶか**」の意思決定ガイド。
>
> ユーザーの実プロジェクト経験から抽出した**ハマり所カタログ**を含む。新規アプリ設計時には `appsheet-architect` エージェントが本書を参照し、レビュー時には `appsheet-reviewer` が本書のチェック項目で監査する。

---

## 目次

1. データモデル設計（REF・親子・正規化）
2. 仮想列の使いどころ
3. Slice vs Security Filter
4. データソース選択（SQL / スプシ / AppSheet DB）
5. Automation 判断基準（Bot vs GAS vs SQL 直接）
6. Schedule Bot vs Data Change Bot
7. Call a Script の戻り値設計
8. 外部 WebApp 連携（OpenUrl）
9. ハマり所カタログ
10. レビューチェックリスト

---

## 1. データモデル設計

### 1.1 REF を中心に組む

AppSheet の式言語は **dereference (`[親列].[孫列]`)** と **REF_ROWS** が圧倒的に高速。これらを使えるよう、テーブル間の関係は **明示的な REF 列**で繋ぐのが基本方針。

**設計手順**:

1. エンティティ（業務概念）を洗い出してテーブル化
2. 「A は B の一部か？」を判定 → Yes なら `Ref` 型 + `IsPartOf: true` で親子化
3. 「A は B を 1 つ持つか？」 → Yes なら `Ref` 型のみ（is-a-part-of なし）
4. 多対多は中間テーブルを切る（直接 `EnumList<Ref>` も可だが集計が苦しい）

**REF 列の利点**:

- フォームで親選択 → ドロップダウン自動生成（Label 列が表示される）
- `[親].[孫列]` で親値を遅延参照（仮想列不要）
- `REF_ROWS(子テーブル, 親 ID 列)` で子レコードのリスト取得
- is-a-part-of 親子は親削除で子も連鎖削除

### 1.2 循環 REF の回避

A → B → A のような循環参照は AppSheet で原則禁止。

**症状**: アプリ起動時に「Circular reference」エラー、または保存できなくなる。

**よくあるパターンと回避策**:

| パターン | 回避 |
|---------|------|
| 親テーブルに「最新の子 ID」列を持たせる | 仮想列で `MAXROW` か、Bot で更新する実列にする（仮想列なら循環判定を回避できる場合あり） |
| 顧客テーブルに「最終取引案件」、案件に「顧客」 | 顧客側を仮想列にする |
| マスタ A ↔ マスタ B 相互参照 | 中間テーブルで多対多に分解 |

経験則: **片方向は実列 REF、逆方向は仮想列 (REF_ROWS / MAXROW) で取得**。これで循環判定を回避できる。

### 1.3 キー列の設計

- **AppSheet DB / スプシ**: `_RowNumber` をキーに使わず、必ず明示キー列を立てる（`UNIQUEID()` を Initial Value）
- **SQL**: 物理 PK をキー列に指定
- **キーが変わると参照が崩れる**ので、ユーザーに編集させる列をキーにしない（Email・氏名等は不適）

### 1.4 Label 列の重要性

各テーブルに `IsLabel: true` の列を 1 つ立てる。これは：

- REF ドロップダウンの表示文字列
- detail View のヘッダ表示
- 通知・メールでの参照表記

Label が未設定だとキー（UUID 等）がそのまま表示されて読めなくなる。

---

## 2. 仮想列の使いどころ

### 2.1 原則: 実列に寄せる

仮想列は**起動時・同期時に全行で再計算**される。行数が増えると体感速度が劣化する第一要因。

**判断基準**:

| ケース | 推奨 |
|--------|------|
| 入力時に確定する値（顧客氏名・コードのラベル） | **実列 + Initial Value** か **REF + dereference** |
| 集計（SUM・COUNT・REF_ROWS） | **仮想列で OK**（他に手段なし） |
| 親値の単純参照 | **dereference (`[親].[列]`)** で直接書く（仮想列不要） |
| 表示専用の整形（書式変換） | **仮想列で OK** |
| 条件式の中間結果 | **仮想列で OK**（複雑式の分割） |

### 2.2 入力時 Initial Value で実列に書くパターン

ユーザー氏名のような「入力時に分かっている値」は仮想列で都度参照するより、入力時に実列に書込んでしまう方が高速。

**例**: 案件テーブルに `担当者氏名` 列を実列で持つ。

```
DefaultExpression = LOOKUP(USEREMAIL(), "ユーザーマスタ", "メール", "氏名")
```

これで以降は dereference も不要、検索もインデックスで効く。

### 2.3 SELECT を直接使うときの注意

`SELECT(テーブル[列], 条件)` は内部的に**全件走査**。

**速い順** (子側のインデックスがあるとき):

1. `[親列].[列]` (dereference) — 一段
2. `REF_ROWS(子, 親 ID 列)[列]` — 親→子インデックス
3. `FILTER(テーブル, 条件)` — `SELECT(...)` より速い場合あり
4. `SELECT(テーブル[列], 条件)` — 全件走査

REF が引ける関係なら必ず REF を使う。SELECT は最後の手段。

### 2.4 親リレーションからの List 取得

子テーブルで親の値リストを使いたい時：

```
✅ 良い: REF_ROWS("子", "親 ID")[列名]
❌ 遅い: SELECT(子[列名], [親 ID] = [_THISROW].[親 ID])
```

両者は同じ結果だが、REF_ROWS はインデックスを使う。

---

## 3. Slice vs Security Filter

### 3.1 役割の違い

| | Security Filter | Slice |
|--|----------------|-------|
| 評価場所 | サーバ | クライアント |
| データ秘匿 | ✅ 可能 | ❌ 全件ダウンロード後に絞るだけ |
| 仮想列 / dereference | ❌ 不可 | ✅ 可能 |
| 列の絞り込み | ❌ 不可 | ✅ 可能 |
| Bot 対象指定 | × | ✅ 対象 Slice 指定 |
| パフォーマンス | ✅ 行数削減 | △ ダウンロード量は同じ |

**端的に**: **権限・データ量はサーバで切る (Security Filter)**、**画面・ビューはクライアントで切る (Slice)**。

### 3.2 Security Filter の使い方

実カラム制約があるので、**シンプルな等値比較**を基本にする：

```
[担当者メール] = USEREMAIL()
```

複雑な権限ロジックは User Settings 経由テーブル化する（→ §3.3）。

**チェック項目**:

- [ ] 仮想列を参照していないか
- [ ] dereference (`[Ref列].[孫列]`) を使っていないか
- [ ] Slice を使う条件と混同していないか
- [ ] オフライン時の挙動を想定しているか（最終同期時点の絞り込みデータを使う）

### 3.3 鉄板パターン: User Settings テーブルで権限集中管理

**1 ユーザー処理高速化のため、別テーブルにアカウント表示設定を置いて USEREMAIL() で切替**するパターンが実プロジェクトで最も安定。

**構成**:

```
ユーザー設定テーブル
├── メール (キー)
├── 表示モード (Enum: 一覧/詳細)
├── 部署
├── 権限レベル
└── 担当顧客 (EnumList<Ref> など)

業務テーブル.Security Filter:
[担当者] = USEREMAIL() OR
LOOKUP(USEREMAIL(), "ユーザー設定", "メール", "権限レベル") = "管理者"
```

**利点**:

- 権限変更がユーザー設定 1 行の編集で済む（Editor 不要）
- Automation の RowID 受け渡しでも権限が伝搬する
- 標準 CSV ダウンロードも絞り込み済みになる
- 1 ユーザーあたりのデータ量が減るので同期高速

**注意**: LOOKUP は実カラムを参照すること（仮想列を経由すると Security Filter で使えない）。

### 3.4 Slice を使うべきケース

- **ステータス別 View**（進行中・完了・保留）の作り分け
- **ユーザー別ダッシュボード**（自分の担当のみ表示する一覧）
- **Bot トリガー対象の事前絞り込み**（特定条件の行だけ Schedule Bot で処理したい）
- **列順カスタマイズ**（編集 View では全列、一覧 View では主要 5 列のみ）

Slice は表示制御専用。**データ秘匿には絶対に使わない**（クライアントには元データが届いている）。

---

## 4. データソース選択

### 4.1 4 種類の使い分け

| 用途 | 第一選択 | 補足 |
|------|---------|------|
| **業務トランザクション**（受注・案件・請求） | **SQL** | 蓄積系。行数が増え続けても安定 |
| **マスタ・複数アプリ共通参照** | **AppSheet DB** | 1 マスタ → 複数アプリで共有 |
| **ユーザー設定・少量・人間が直接編集したい** | **スプシ** | フォーム外で直接編集できる利点 |
| **Excel 2 次活用用書き出し** | **スプシ** | エクスポートが容易 |
| **オフライン・モバイル中心** | **AppSheet DB** | 同期が安定 |
| **既存 Excel 資産の取り込み** | **Excel** | xlsx を OneDrive/Dropbox に置く |

### 4.2 スプシの限界

実プロジェクト経験：**Enterprise でもスプシは数万行で詰まる**。

- API レート制限（書込み頻度に上限）
- 行数 5,000〜10,000 で同期が分単位に
- 列が 50 を超えると Editor の応答が悪化
- 同時編集が AppSheet と人間で競合する

**目安**: スプシは **2,000 行・30 列以下** に抑える。それ以上は SQL か AppSheet DB へ移行。

### 4.3 SQL を選ぶ判断

- 行が増え続ける（追記型）
- 行単位のロック・トランザクションが要る
- 集計クエリを SQL 側で前処理したい（View / Stored Procedure）
- 他システムとデータ共有
- 100 ユーザー以上での運用

### 4.4 AppSheet DB を選ぶ判断

- 複数 AppSheet アプリでマスタ共有（医療介護福祉の基本報酬・加算マスタ等）
- 行数は中程度（1 万〜数万）
- AppSheet 単独で完結する案件
- リアルタイム同期が重要

---

## 5. Automation 判断基準

### 5.1 3 系統の選択肢

| 手段 | 適性 |
|------|------|
| **Bot (AppSheet 内)** | データ変更トリガー・スケジュール送信・通知・簡単な分岐 |
| **Bot + Call a Script (GAS)** | 複雑なロジック・外部 API 呼出・スプシ操作・PDF 生成 |
| **AppSheet API v2 直接呼び（外部から）** | バッチ取込・他システム連携・大量データ更新 |
| **SQL 直接操作** | 大量更新・集計・スキーマ変更を伴う処理 |

### 5.2 判断フロー

```
[データ変更が起点か？]
   YES → Data Change Bot
   NO  → Schedule Bot か外部から API 呼出

[ロジックは AppSheet 式で書ける範囲か？]
   YES → Bot のみで完結
   NO  → Bot から Call a Script で GAS 関数呼出

[データ量は大きいか（数千行以上の更新）？]
   YES → SQL 直接操作 or バックエンド側 API 呼出
   NO  → Bot で OK

[他システム連携か？]
   YES → AppSheet API v2 を外部システム側から叩く
   NO  → AppSheet 内で完結
```

### 5.3 Bot と GAS 定期トリガーの選択

**Schedule Bot を選ぶ**:

- AppSheet 内データだけで完結
- 通知・レポート送信
- アプリ内で再利用したい

**GAS 定期トリガーを選ぶ**:

- スプシ・Drive・Gmail 操作
- 複雑な条件分岐
- 外部 API 呼出
- 結果のロギングが必要
- AppSheet 課金プランで Bot 実行枠を節約したい

**併用パターン**: Bot のトリガーで Call a Script → GAS で重い処理 → 戻り値で AppSheet を更新。

---

## 6. Schedule Bot vs Data Change Bot

### 6.1 Data Change Bot は Edit 中心

**Data Change Bot は Edit (Updates) を主トリガーにするのが鉄板**。Adds/Deletes は副次的に使う。

理由: AppSheet の同期サイクルで「変更があった行」をピンポイントに処理しやすい。

### 6.2 フラグパターン（実プロジェクトで多用）

1 発火に「**更新日時 NOW() + 処理フラグ TRUE**」を 1 セット用意し、**Bot 処理末尾でフラグを FALSE に戻す**パターン。

**テーブル設計**:

```
業務テーブル
├── 更新日時 (DateTime)
├── 処理フラグ (Yes/No)
└── ... 業務列
```

**Bot Event 条件**:

```
AND([処理フラグ] = TRUE, ISNOTBLANK([更新日時]))
```

**Process 末尾**: 処理フラグを FALSE に戻す Action を実行。

**利点**:

- 同じ行を意図せず複数回処理しない
- フラグを TRUE にする側（フォーム / Action）でトリガー条件を集中制御
- デバッグ時にフラグだけ見れば処理待ちが分かる

### 6.3 Schedule Bot の使いどころ

- 毎日 0 時の集計
- 週次レポートメール
- 月次の自動アーカイブ
- 滞留データのアラート（最終更新が N 日前以上の行を抽出）

注意: Schedule Bot は **AppSheet 課金プランで実行枠（回数）に上限**がある。頻繁に走らせる処理は GAS 定期トリガーへ寄せる。

---

## 7. Call a Script の戻り値設計

### 7.1 制約: 戻り値は LongText 1 個のみ

GAS 関数の戻り値は AppSheet 側では **LongText 1 個** として受け取る。オブジェクトや配列はそのままでは返せない。

### 7.2 鉄板イディオム: カンマ区切り配列

複数値を返したい場合、GAS 側で文字列連結し、AppSheet 側で SPLIT する：

**GAS 側**:

```javascript
function processRow(rowId) {
  // 何か処理
  const status = "OK";
  const message = "処理完了";
  const url = "https://...";
  return [status, message, url].join(","); // カンマ区切り
}
```

**AppSheet 側** (受け側 Bot Process 内の参照):

```
[Outputs].[ScriptOutput]                            // 全体（生）
INDEX(SPLIT([Outputs].[ScriptOutput], ","), 1)      // status
INDEX(SPLIT([Outputs].[ScriptOutput], ","), 2)      // message
INDEX(SPLIT([Outputs].[ScriptOutput], ","), 3)      // url
```

**注意**: 値そのものにカンマが含まれる場合は別の区切り文字（`|` など）を使う。SPLIT は単純区切りのみで、エスケープには対応していない。

### 7.3 GAS 側のエラー対応

- AppSheet からの呼出は OAuth 経由。**スクリプトオーナーの権限で実行**される。
- GAS で例外を投げても AppSheet 側のログに詳細が出ない。**try/catch でログを文字列化して戻り値に含める**のが安全：

```javascript
function processRow(rowId) {
  try {
    // 本処理
    return "OK," + result;
  } catch (e) {
    return "ERROR," + e.message + "," + e.stack;
  }
}
```

AppSheet 側で 1 番目を見て分岐：

```
IF(INDEX(SPLIT([Outputs].[ScriptOutput], ","), 1) = "OK", ..., エラー処理)
```

---

## 8. 外部 WebApp 連携 (OpenUrl)

### 8.1 用途

- AppSheet 内で実装が困難な UI（複雑なグラフ・特殊な入力フォーム）
- 既存 Web システムへの遷移
- 帳票プレビュー（HTML/PDF）

### 8.2 OpenUrl Action の設計

`App: open a URL` Action を作成。Value に URL 式を書く：

```
CONCATENATE(
  "https://example.com/report?",
  "id=", ENCODEURL([案件 ID]),
  "&user=", ENCODEURL(USEREMAIL())
)
```

### 8.3 セキュリティ要件

**HTTPS 必須**。HTTP は AppSheet 側で警告される（モバイルでは開けないことも）。

**権限受け渡しの考え方**:

- URL に **トークンを埋める**（GAS 側で発行・検証）
- 単純な ID 渡しは **盗聴・改竄リスク**があるので、サーバ側で USEREMAIL() の妥当性を再検証する
- セッションは AppSheet では管理できない → **WebApp 側で独自セッション管理**

### 8.4 配置

- HTML はサーバー（自社 Web サーバ・Heteml・Cloud Run 等）に置く
- ドメインは AppSheet と別で OK（OpenUrl は外部 URL 前提）
- **iframe 埋込みは IFrameSettings で別管理**（OpenUrl とは別の機能）

---

## 9. ハマり所カタログ

実プロジェクトで遭遇した・遭遇する可能性が高い問題のリスト。

### 9.1 仮想列の連鎖で起動が遅い

**症状**: 行数 5,000 のテーブルに仮想列 10 個 → 起動 30 秒。

**対処**:

1. 仮想列を減らす（実列に寄せる、Initial Value で書込む）
2. dereference 1 段で済むなら直接書く
3. 集計仮想列は Slice の RowFilter で対象行を絞る
4. それでも残るなら SQL ビューで前処理

### 9.2 循環 REF（最近は稀だが注意喚起）

最近の AppSheet は警告が出やすくなったので頻発はしないが、**親→子→親の三角参照**は油断するとハマる。

### 9.3 Security Filter で仮想列・dereference を使ってしまう

Editor では入力できてしまうが、**サーバ側で評価できずデータが返らない**。

### 9.4 スプシ 1 万行超えで同期不可

スプシソースで業務テーブルを設計してしまい、行が増えてから SQL 移行する羽目になるケース。**初期からデータ量を見積もる**。

### 9.5 Bot の Edit/Adds 二重発火

Adds + Updates 両方を有効にした Bot で、フォーム保存時に 2 回発火する。**通常は Updates だけにする**か、フラグパターンで重複処理を避ける。

### 9.6 Call a Script の戻り値型の取り違え

戻り値を LongText でなく Number として扱おうとしてエラー。**常に LongText で受けて INDEX/SPLIT する**ことを徹底。

### 9.7 USEREMAIL() のドメイン違いで同期失敗

組織アカウントと個人アカウントが混在すると認証で予期しない挙動。**AuthDomain で制限**するか、ユーザー設定テーブルで明示ホワイトリスト。

### 9.8 Action の式が再パースされず無視される

複雑な IFS / SWITCH を `appsheet_set_action_condition` で書込んでも、AppSheet 側で再パースされないケース。**saveapp 後に IsValid を verify**。

### 9.9 Bot 名前リンク切れ

Bot をクローンした後、Event/Process/Tasks のどれかが旧名のまま残っていて動かない。**4 配列を ComponentId と名前文字列の両方で整合性チェック**。

### 9.10 Cookie 失効で MCP が動かない

`/api/saveapp` 401 を見落とすと、書込みが全て無視されているのに気づかない。**MCP ツールが 401/HTML を検出して即時エラー化**するロジックは必須。

### 9.11 OpenAPI スキーマ ID 衝突

`ログ` と `設定` のように同文字数のテーブル名で OpenAPI が片方欠ける。**Phase 3 HAR 経由を優先**。

### 9.12 Slice で「データを隠したつもり」

Slice はクライアント評価。**全データはダウンロードされる**。秘匿は Security Filter のみ。

---

## 10. レビューチェックリスト

新規アプリ・既存アプリのレビュー時に `appsheet-reviewer` エージェントが本書のこの節を順に確認する。

### データモデル

- [ ] 各テーブルにキー列が立っているか（`_RowNumber` を使っていないか）
- [ ] 各テーブルに Label 列があるか
- [ ] テーブル間の REF が明示されているか
- [ ] 親子関係には is-a-part-of が設定されているか
- [ ] 循環 REF が無いか

### 列・式

- [ ] 仮想列の数が必要最小限か
- [ ] dereference で済む箇所に SELECT を使っていないか
- [ ] Initial Value で済む値を仮想列で計算していないか
- [ ] Enum 値は TypeAuxData.EnumValues に入っているか

### Security

- [ ] 業務テーブルに Security Filter が設定されているか
- [ ] Security Filter に仮想列・dereference を使っていないか
- [ ] Slice をデータ秘匿目的で使っていないか
- [ ] User Settings テーブルで権限を集中管理しているか

### Bot / Automation

- [ ] Bot は Edit 中心か（Adds/Deletes 多用していないか）
- [ ] フラグパターンで重複発火を防いでいるか
- [ ] Call a Script の戻り値はカンマ区切り規約か
- [ ] エラー時の文字列化・ログ化ができているか
- [ ] Bot 4 配列の名前リンクが整合しているか

### データソース

- [ ] スプシで 2,000 行・30 列を超えていないか
- [ ] 蓄積系テーブルが SQL か AppSheet DB か
- [ ] マスタは AppSheet DB で複数アプリ共有可能か

### 外部連携

- [ ] OpenUrl の URL は HTTPS か
- [ ] WebApp 側で USEREMAIL() の妥当性を再検証しているか
- [ ] トークン渡しの場合、有効期限・署名があるか
