/**
 * HopeContextRecorder プロンプト・モデル設定レジストリ
 *
 * 機能②（利用者コンテキスト連動の追記処理）専用。
 * 100_HopeRecorderPrompts.js のパターン継承（V1/V2 併存 + ACTIVE で切替 + dump 関数）。
 *
 * 設計方針:
 *   - 文字起こし＋利用者コンテキスト＋スタッフ指示の 3 入力を 1 つのプロンプトに合成し、
 *     Gemini に「ケース記録の整形済みテキスト」を返させる。
 *   - GAS 単体（Gemini API のみ、Vertex Batch・Speech-to-Text・GCS は使わない）。
 *   - HOPE_CTX_RECORDER_ACTIVE の差替 1 行で版切替・no-op 化が可能。
 *
 * 参照元:
 *   - 102_HopeContextRecorder.js: enrichCaseRecord_ → callGeminiForEnrich_ で
 *     HOPE_CTX_RECORDER_ACTIVE.buildPrompt({ contextText, transcriptText, staffPromptText }) を呼ぶ。
 *
 * バージョン履歴:
 *   V0_DISABLED (no-op): ロールバック専用。enrichCaseRecord_ から呼ばれた場合は空テキストを返す。
 *   V1 (2026-04-27〜): gemini-2.5-pro, ハルシネーション禁止 + 原文保持 + スタッフ指示優先。
 *
 * セキュリティ TODO（次スプリント）:
 *   PII 流入経路: 利用者コンテキスト（氏名・症状・関係者）+ 文字起こし（発話原文）+ スタッフ指示
 *   すべてが平文で Gemini API（generativelanguage.googleapis.com）に渡る。
 *   次スプリントでマスキング層（氏名・住所・電話・生年月日の置換）を必須で導入すること。
 *   関連: project-context.md「個人情報を含む出力・ログは必ずマスキング」。
 */

// =====================================================================
// V0_DISABLED: ロールバック用。enrichCaseRecord_ から実行時に呼ばれても
// Gemini を叩かず空文字を返す。HOPE_CTX_RECORDER_ACTIVE をこれに差し替えると
// 機能②全体が no-op 化される（AppSheet 側は空文字を書き戻すだけ）。
// =====================================================================

const HOPE_CTX_RECORDER_V0_DISABLED = {
  version: "v0_disabled",
  model: "noop",
  temperature: 0,
  maxOutputTokens: 0,
  systemPrompt: "",
  /**
   * @param {{contextText:string, transcriptText:string, staffPromptText:string}} parts
   * @returns {string}
   */
  buildPrompt: function (parts) {
    // no-op: 中身に関わらず空文字を返す。
    // callGeminiForEnrich_ 側で空文字を検知して短絡応答することで API 課金を防ぐ。
    return "";
  },
};

// =====================================================================
// V1: 初版（2026-04-27〜）
//   方針:
//     1. 入力（コンテキスト・文字起こし）に存在しない情報の創作を絶対禁止
//     2. 推測・解釈・要約は最小限。原文の語彙・口調を尊重
//     3. スタッフ指示が形式（SOAP / 経過記録 / 申し送り 等）を要求する場合は最優先で従う
//     4. degenerate output 防止のため、繰り返しは「（既出）」で省略
//     5. 挨拶・前置き・所感は禁止、指示された形式の本文のみを出力
//     6. 利用者氏名はマスキングせず原文のまま（マスキングは将来別レイヤ）
// =====================================================================

const HOPE_CTX_RECORDER_SYSTEM_V1 = `あなたは介護・福祉分野の専門編集AIです。提供された利用者コンテキスト・面談文字起こしを踏まえ、
スタッフ指示に従ってケース記録テキストを生成してください。

# 最強制約
1. 入力（利用者コンテキスト・文字起こし）に存在しない情報を一切創作しない
2. 推測・解釈・要約は最小限に留め、可能な限り原文の語彙・口調を尊重
3. スタッフ指示が SOAP / 経過記録 / 申し送り 等の形式を要求する場合は、その形式に従う
4. 同一発言の繰り返しは「（既出）」で省略し、再列挙しない（degenerate output 防止）

# 出力ルール
- 挨拶・前置き・所感は禁止。指示された形式の本文のみを出力
- 利用者氏名は【匿名化済み】等に置換せず、入力文をそのまま使う
  （マスキングは将来別レイヤで対応予定）`;

const HOPE_CTX_RECORDER_V1 = {
  version: "v1",
  model: "gemini-2.5-pro",
  temperature: 0.1,
  maxOutputTokens: 32768,
  systemPrompt: HOPE_CTX_RECORDER_SYSTEM_V1,
  /**
   * 利用者コンテキスト・文字起こし・スタッフ指示を 1 本のプロンプト文字列に組み立てる。
   *
   * 注意:
   *   - parts は呼出側でデフォルト値（空文字）を埋めてある前提だが、未渡し対策で再度フォールバックする。
   *   - PII（氏名等）はここで平文のまま渡す。マスキングは次スプリントで上位レイヤに導入。
   *
   * @param {{contextText:string, transcriptText:string, staffPromptText:string}} parts
   * @returns {string}
   */
  buildPrompt: function (parts) {
    var p = parts || {};
    var contextText = p.contextText || "（利用者コンテキスト未取得）";
    var transcriptText = p.transcriptText || "";
    var staffPromptText = p.staffPromptText || "";
    // this.systemPrompt を参照することで、V2 派生時に systemPrompt の差し替えのみで挙動を変えられる。
    // V0_DISABLED は別の buildPrompt（空文字 return）を持つため、ここで this.systemPrompt 参照に変えても
    // V0_DISABLED 経路には影響しない（this.systemPrompt = '' なら空+ヘッダになるが、V0 は別実装）。
    return (
      this.systemPrompt +
      "\n\n## 利用者コンテキスト\n" +
      contextText +
      "\n\n## 面談文字起こし\n" +
      transcriptText +
      "\n\n## スタッフ指示\n" +
      staffPromptText
    );
  },
};

// =====================================================================
// V2: 固有名詞正規化対応版（2026-05-01〜）
//   方針:
//     - V1 の方針（ハルシネーション禁止 / 原文尊重 / スタッフ指示優先 / 既出省略）はすべて踏襲
//     - 追加 1: 利用者コンテキストに登場する固有名詞（人名・施設名・地名・固有用語）の表記を
//               「正規表記」とみなし、文字起こしに同じ語が仮名・別漢字で現れた場合に置換する
//     - 追加 2: 出力末尾に「## コンテキストより固有名詞置換」セクションを追加し、
//               実施した置換を「変換前→変換後」形式で全件列挙する
//   注意:
//     - PII マスキング層（040_PiiMasker.js）と組み合わせて使用する場合、
//       PII レジストリで {{ENTITY_NN}} に置換されている人名は、unmask 後に正規表記が戻る。
//       コンテキストに登場するがマスクされない固有名詞（施設名・地名など）に対しては、
//       本プロンプトの正規化ルールが直接効果を発揮する。
// =====================================================================

const HOPE_CTX_RECORDER_SYSTEM_V2 = `あなたは介護・福祉分野の専門編集AIです。提供された利用者コンテキスト・面談文字起こしを踏まえ、
スタッフ指示に従ってケース記録テキストを生成してください。

# 最強制約
1. 入力（利用者コンテキスト・文字起こし）に存在しない情報を一切創作しない
2. 推測・解釈・要約は最小限に留め、可能な限り原文の語彙・口調を尊重
3. スタッフ指示が SOAP / 経過記録 / 申し送り 等の形式を要求する場合は、その形式に従う
4. 同一発言の繰り返しは「（既出）」で省略し、再列挙しない（degenerate output 防止）

# 固有名詞の正規化（コンテキスト由来のみ）
- 利用者コンテキストに登場する人名・施設名・地名・固有用語の表記を「正規表記」とみなす
- 文字起こしに同じ語が「ひらがな・カタカナ・別表記の漢字」で現れた場合、コンテキストの正規表記に置換する
- ただし、コンテキストに登場しない名前・語は絶対に創作・推測で漢字変換しない（仮名のまま残す）
- コンテキストの該当語と音読み・訓読み・仮名が明確に一致するときのみ置換（曖昧マッチ・部分一致は禁止）
- 一度確定した置換は本文中で一貫して使用する

# 出力ルール
- 挨拶・前置き・所感は禁止。指示された形式の本文のみを出力
- 利用者氏名は【匿名化済み】等に置換せず、入力文をそのまま使う
  （マスキングは将来別レイヤで対応予定）

# 出力末尾の置換レポート（必須）
- 本文の末尾に必ず以下のセクションを 1 つ追加する（本文と空行 1 行で区切る）
- セクションタイトル: 「## コンテキストより固有名詞置換」
- 形式: 各行に「変換前→変換後」を列挙する（鉤括弧で囲む）
  例:
    「やまだたろう→山田太郎」
    「ひまわりさん→ひまわり園」
- 1 件も置換しなかった場合は本セクション内に「（置換なし）」とだけ記載する
- 同じ置換ペアは重複列挙せず 1 行に集約する`;

const HOPE_CTX_RECORDER_V2 = {
  version: "v2",
  model: "gemini-2.5-pro",
  temperature: 0.1,
  maxOutputTokens: 32768,
  systemPrompt: HOPE_CTX_RECORDER_SYSTEM_V2,
  /**
   * V1 と同じ buildPrompt 構造（systemPrompt のみ差し替え）。
   *
   * @param {{contextText:string, transcriptText:string, staffPromptText:string}} parts
   * @returns {string}
   */
  buildPrompt: function (parts) {
    var p = parts || {};
    var contextText = p.contextText || "（利用者コンテキスト未取得）";
    var transcriptText = p.transcriptText || "";
    var staffPromptText = p.staffPromptText || "";
    return (
      this.systemPrompt +
      "\n\n## 利用者コンテキスト\n" +
      contextText +
      "\n\n## 面談文字起こし\n" +
      transcriptText +
      "\n\n## スタッフ指示\n" +
      staffPromptText
    );
  },
};

// =====================================================================
// アクティブ版の選択（ロールバック時はここを HOPE_CTX_RECORDER_V1 / V0_DISABLED に戻す）
// =====================================================================
const HOPE_CTX_RECORDER_ACTIVE = HOPE_CTX_RECORDER_V2;

/**
 * 検証用：現在アクティブな機能②版の中身をログに出す。
 * GAS UI から関数名を選択して手動実行する。
 */
function dump_HopeContextRecorderConfig() {
  Logger.log("===== HopeContextRecorder Active Config =====");
  Logger.log("version: " + HOPE_CTX_RECORDER_ACTIVE.version);
  Logger.log("model: " + HOPE_CTX_RECORDER_ACTIVE.model);
  Logger.log("temperature: " + HOPE_CTX_RECORDER_ACTIVE.temperature);
  Logger.log("maxOutputTokens: " + HOPE_CTX_RECORDER_ACTIVE.maxOutputTokens);
  Logger.log(
    "systemPrompt length: " + HOPE_CTX_RECORDER_ACTIVE.systemPrompt.length,
  );
}
