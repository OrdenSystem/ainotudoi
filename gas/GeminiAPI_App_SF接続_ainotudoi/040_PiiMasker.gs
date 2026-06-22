/**
 * PII マスキング層（可逆トークン置換）
 *
 * 役割:
 *   Gemini API / Vertex AI の generateContent / batchPredictionJobs に渡る前に
 *   利用者氏名・職員名・支援者名・法定代理人名を opaque トークン {{ENTITY_NN}} に置換し、
 *   応答受領後に元の名前へ復号する 2 段階マスキングを提供する。
 *
 * 設計方針:
 *   - 完全可逆性（mask → unmask が原文と一致）
 *   - レジストリは関数呼出ローカル、永続化しない（再識別リスク低減）
 *   - 長さ降順置換（「山田太郎」を「山田」より先に処理し部分一致衝突を回避）
 *   - 既知エンティティのみマスク。会話中の自発的氏名は対象外（残存リスク文書参照）
 *
 * 適用サイト:
 *   - 101_HopeRecorder.js#callGeminiProToCleanText_
 *   - 102_HopeContextRecorder.js#enrichCaseRecord_
 *
 * 既存ログ用マスク（maskId_ / maskEmail_ in 102_HopeContextRecorder.js）とは
 * 用途が異なる（あちらは Slack / console.log 用、こちらは LLM payload 用）。
 *
 * 全関数末尾アンダースコアで private 化（`_`）。
 */

// =====================================================================
// ロールバックスイッチ
// =====================================================================

/**
 * マスキング全体を無効化するキルスイッチ。
 * true: マスキング有効 / false: 既存挙動（PII 平文で LLM へ）
 *
 * 切替手順:
 *   1) このファイルの定数を false に書換 → デプロイ
 *   2) もしくはスクリプトプロパティ USE_PII_MASKING=false で動的切替（読込側で and 評価）
 *
 * **重要:** ロールバックに伴う後方互換性のため呼出側は disable 時にも
 * mask/unmask を no-op で通過する設計とする（壊れた registry を返さない）。
 */
const PII_MASKING_ENABLED = true;

// =====================================================================
// レジストリ構築
// =====================================================================

/**
 * PII エンティティを収集してレジストリを構築する。
 *
 * @param {Object} options
 * @param {string} [options.userFullName]    利用者フルネーム
 * @param {string} [options.contextText]     利用者コンテキストTXT（201_AI情報テキストFILE.js が生成）
 * @param {Array}  [options.staffList]       StaffStatus__c rows（AppSheet API キャッシュ）
 * @returns {{forward: Object, reverse: Object, count: number}}
 *   forward: { 実名: トークン } — マスク用
 *   reverse: { トークン: 実名 } — アンマスク用
 *   count:   登録エンティティ数
 */
function buildPiiRegistry_(options) {
  var opts = options || {};
  var names = [];

  if (opts.userFullName) {
    names.push(opts.userFullName);
  }

  if (opts.contextText) {
    var contextNames = extractNamesFromContext_(opts.contextText);
    contextNames.forEach(function (n) {
      names.push(n);
    });
  }

  if (opts.staffList && opts.staffList.length) {
    opts.staffList.forEach(function (st) {
      // 201_AI情報テキストFILE.js#L137 と同じフォールバック順
      var sName = st["NameKana__c"] || st["Name__c"];
      if (sName) names.push(String(sName));
    });
  }

  // 重複除去 + 短い空文字除外 + 長さ降順
  var deduped = {};
  names.forEach(function (n) {
    if (!n) return;
    var trimmed = String(n).trim();
    if (trimmed.length < 2) return; // 1 文字は誤検出リスクが高い
    deduped[trimmed] = true;
  });
  var sorted = Object.keys(deduped).sort(function (a, b) {
    return b.length - a.length;
  });

  var forward = {};
  var reverse = {};
  sorted.forEach(function (name, idx) {
    var token = nextToken_(idx);
    forward[name] = token;
    reverse[token] = name;
  });

  return { forward: forward, reverse: reverse, count: sorted.length };
}

/**
 * 利用者コンテキストTXT から既知エンティティの氏名を抽出する。
 *
 * 抽出対象（201_AI情報テキストFILE.js が生成する形式に依存）:
 *   1. `## 【基本属性】` 配下の `- 利用者名: 山田 太郎 (ヤマダ タロウ)`
 *      → 漢字氏名と読み仮名の両方を登録
 *   2. `## 【関係者情報】` 配下の SupportPersonnel__c / LegalRepresentative__c の
 *      JSON ダンプから Name__c / NameKana__c / NameFurigana__c / 氏名 等のフィールド値
 *   3. `## 【職員マスタ】` 配下の `- ID: xxx, 氏名: NAME` 行
 *
 * 抽出しない:
 *   - History block 内の氏名（記録者名等は redundant、抽出ロジック複雑化を避ける）
 *
 * @param {string} contextText
 * @returns {string[]}
 */
function extractNamesFromContext_(contextText) {
  if (!contextText) return [];
  var found = [];

  // 1) 利用者名: フル氏名 (フリガナ)
  //    例: "- 利用者名: 山田 太郎 (ヤマダ タロウ)"
  //    フリガナ部分も同時に登録（LLM入力に出現する可能性のため）
  var userNameMatch = contextText.match(
    /^\s*-\s*利用者名:\s*([^\(\n]+?)\s*\(([^\)\n]+)\)/m,
  );
  if (userNameMatch) {
    found.push(userNameMatch[1].trim());
    found.push(userNameMatch[2].trim());
  }

  // 2) 関係者 JSON ダンプから氏名系フィールドを抽出
  //    SupportPersonnel__c / LegalRepresentative__c は JSON.stringify(row) 形式で書かれている
  //    （201_AI情報テキストFILE.js#L119, L123）
  //    JSON 内の "Name__c":"...", "NameKana__c":"...", "NameFurigana__c":"...", "氏名":"..." を拾う
  var jsonNameKeys = [
    "Name__c",
    "NameKana__c",
    "NameFurigana__c",
    "Name",
    "NameKana",
    "NameFurigana",
    "氏名",
  ];
  jsonNameKeys.forEach(function (key) {
    // ダブルクォートで囲まれた key:value をマッチ。値中のエスケープには非対応（必要なら強化）。
    var re = new RegExp('"' + key + '"\\s*:\\s*"([^"\\\\]+)"', "g");
    var m;
    while ((m = re.exec(contextText)) !== null) {
      found.push(m[1].trim());
    }
  });

  // 3) 職員マスタ: "- ID: xxx, 氏名: NAME"
  //    NameKana__c が無い場合は Name__c になる（201_AI情報テキストFILE.js#L137）
  var staffRe = /^\s*-\s*ID:\s*[^,]+,\s*氏名:\s*([^\n]+)$/gm;
  var sm;
  while ((sm = staffRe.exec(contextText)) !== null) {
    var staffName = sm[1].trim();
    if (staffName && staffName !== "名称不明") {
      found.push(staffName);
    }
  }

  return found;
}

// =====================================================================
// マスク / アンマスク本体
// =====================================================================

/**
 * テキスト中の登録エンティティをトークンに置換する。
 *
 * @param {string} text
 * @param {Object} registry  buildPiiRegistry_ の戻り値
 * @returns {string} マスク済テキスト
 */
function maskText_(text, registry) {
  if (!PII_MASKING_ENABLED) return text;
  if (!text || !registry || !registry.forward) return text;
  var keys = Object.keys(registry.forward);
  if (keys.length === 0) return text;

  // 長さ降順で置換（buildPiiRegistry_ で既にソート済だが念のため）
  keys.sort(function (a, b) {
    return b.length - a.length;
  });

  var out = text;
  keys.forEach(function (name) {
    var token = registry.forward[name];
    var re = new RegExp(escapeRegex_(name), "g");
    out = out.replace(re, token);
  });
  return out;
}

/**
 * テキスト中のトークンを元の名前へ復号する。
 *
 * **PII_MASKING_ENABLED チェックは敢えて含めない**:
 *   ロールバック後（PII_MASKING_ENABLED=false）でも、過去に PII_MASKING_ENABLED=true で
 *   生成されたマスク済みデータ（{{ENTITY_NN}} トークン残存）が存在する可能性があるため、
 *   アンマスクは常に「呼ばれたら復号する」セマンティクスとする（安全側の操作）。
 *
 * @param {string} text
 * @param {Object} registry  buildPiiRegistry_ の戻り値
 * @returns {string} 復号済テキスト
 */
function unmaskText_(text, registry) {
  if (!text || !registry || !registry.reverse) return text;
  var tokens = Object.keys(registry.reverse);
  if (tokens.length === 0) return text;

  var out = text;
  tokens.forEach(function (token) {
    var name = registry.reverse[token];
    var re = new RegExp(escapeRegex_(token), "g");
    out = out.replace(re, name);
  });
  return out;
}

/**
 * LLM 応答に登録外のトークンが含まれていないか検出して warn する。
 * LLM が学習データから拾ってきた `{{ENTITY_999}}` 等を返す可能性への防衛。
 *
 * @param {string} text
 * @param {Object} registry
 * @returns {string[]} 未登録トークンの配列（空配列なら問題なし）
 */
function detectUnknownTokens_(text, registry) {
  if (!text) return [];
  var tokenRe = /\{\{ENTITY_\d+\}\}/g;
  var seen = {};
  var unknown = [];
  var m;
  while ((m = tokenRe.exec(text)) !== null) {
    var t = m[0];
    if (seen[t]) continue;
    seen[t] = true;
    if (!registry || !registry.reverse || !registry.reverse[t]) {
      unknown.push(t);
    }
  }
  if (unknown.length > 0) {
    console.warn("[PiiMasker] 未登録トークン検出: " + unknown.join(", "));
  }
  return unknown;
}

// =====================================================================
// 内部ヘルパー
// =====================================================================

/**
 * 正規表現特殊文字を literal にエスケープ。
 * 名前にカッコ等が含まれた場合の安全策。
 * @param {string} s
 * @returns {string}
 */
function escapeRegex_(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * トークン採番。3 桁ゼロ埋め（ENTITY_001 ～ ENTITY_999）。
 * 999 件超は明示的に throw し、無音バグでマスク漏れを発生させない。
 *
 * @param {number} idx 0-based
 * @returns {string}
 * @throws {Error} idx + 1 > 999
 */
function nextToken_(idx) {
  var n = idx + 1;
  if (n > 999) {
    // detectUnknownTokens_ の正規表現は 4 桁以上もマッチしうるが、reverse map の
    // キーが 3 桁前提でビルドされているため逆引きに失敗し、無音でマスク漏れが発生する。
    // 想定外の大規模コンテキストは設計範囲外として早期 throw する。
    throw new Error(
      "[PiiMasker] エンティティ数が上限 999 を超えました。コンテキスト分割または上限引き上げを検討してください。",
    );
  }
  var padded = n < 10 ? "00" + n : n < 100 ? "0" + n : String(n);
  return "{{ENTITY_" + padded + "}}";
}

// =====================================================================
// 単体テスト（GAS UI から手動実行）
//
// **重要**: テストデータには **実在する利用者・職員の氏名を絶対に使用しないこと**。
// GAS の Logger.log は GCP Cloud Logging に永続化される。テスト関数で
// 実名をハードコードすると Logging に PII が残る。
// 必ず架空名（山田 太郎・田中 花子 等）を使うこと。
// =====================================================================

/**
 * mask → unmask が原文と完全一致することを確認する。
 *
 * ログ出力ポリシー:
 *   - 原文（PII 含む可能性）は出力しない
 *   - マスク後（PII 除去済み）と一致判定結果のみを出力
 */
function test_PiiMasker_roundtrip() {
  var registry = buildPiiRegistry_({
    userFullName: "山田 太郎",
    staffList: [
      { NameKana__c: "タナカ ハナコ", Name__c: "田中 花子" },
      { Name__c: "佐藤 一郎" },
    ],
  });
  Logger.log("[roundtrip] entity count = " + registry.count);

  var input =
    "本日 山田 太郎 様の面談を タナカ ハナコ が担当。立ち会い: 佐藤 一郎。";
  var masked = maskText_(input, registry);
  var restored = unmaskText_(masked, registry);

  Logger.log("masked   : " + masked); // マスク後は安全
  if (restored === input) {
    Logger.log("✅ roundtrip OK (length=" + input.length + ")");
  } else {
    // 比較失敗時は input/restored を直接出さず、長さと一致位置のみ出力
    Logger.log(
      "❌ roundtrip FAILED (input.length=" +
        input.length +
        ", restored.length=" +
        restored.length +
        ")",
    );
  }
}

/**
 * 部分一致衝突回避: 「山田太郎」と「山田」が両方登録された場合に
 * 「山田太郎」が先にマスクされて壊れないことを確認。
 */
function test_PiiMasker_orderingLongestFirst() {
  var registry = buildPiiRegistry_({
    userFullName: "山田太郎",
    staffList: [{ Name__c: "山田" }],
  });
  var input = "山田太郎さんと山田さんは別人です。";
  var masked = maskText_(input, registry);
  var restored = unmaskText_(masked, registry);

  Logger.log("masked   : " + masked); // マスク後は安全
  // forward は長さ降順なので「山田太郎」が先にマッチし、「山田」は残存「山田太郎」「山田」で別トークンに割当られる
  if (restored === input) {
    Logger.log("✅ ordering OK (length=" + input.length + ")");
  } else {
    Logger.log(
      "❌ ordering FAILED (input.length=" +
        input.length +
        ", restored.length=" +
        restored.length +
        ")",
    );
  }
}

/**
 * コンテキスト文字列からエンティティ抽出ができることを確認。
 */
function test_PiiMasker_extractFromContext() {
  var sample = [
    "# 利用者包括データ: 山田 太郎",
    "生成日時: 2026/04/29 09:00",
    "",
    "## 【基本属性】(CustomerStatus__c)",
    "- 利用者名: 山田 太郎 (ヤマダ タロウ)",
    "- ステータス: 利用中",
    "",
    "## 【関係者情報】",
    "### 支援関係者",
    '- {"Row ID":"x1","Name__c":"鈴木 花子","NameKana__c":"スズキ ハナコ","Relation__c":"姉"}',
    "### 法定代理人・親族",
    '- {"Row ID":"x2","Name__c":"山田 父","NameFurigana__c":"ヤマダ チチ"}',
    "",
    "## 【職員マスタ】(StaffStatus__c)",
    "- ID: s001, 氏名: タナカ ハナコ",
    "- ID: s002, 氏名: 名称不明",
  ].join("\n");

  var names = extractNamesFromContext_(sample);
  Logger.log("extracted: " + JSON.stringify(names));
  // 期待: 山田 太郎, ヤマダ タロウ, 鈴木 花子, スズキ ハナコ, 山田 父, ヤマダ チチ, タナカ ハナコ
  // 「名称不明」は除外
  var expected = [
    "山田 太郎",
    "ヤマダ タロウ",
    "鈴木 花子",
    "スズキ ハナコ",
    "山田 父",
    "ヤマダ チチ",
    "タナカ ハナコ",
  ];
  var ok =
    expected.every(function (e) {
      return names.indexOf(e) >= 0;
    }) && names.indexOf("名称不明") < 0;
  Logger.log(ok ? "✅ extract OK" : "❌ extract FAILED");
}

/**
 * 未登録トークンの検知。
 */
function test_PiiMasker_detectUnknownTokens() {
  var registry = buildPiiRegistry_({ userFullName: "山田 太郎" });
  var responseFromLlm =
    "結論: {{ENTITY_001}} 様、補足: {{ENTITY_999}} という未登録トークン。";
  var unknown = detectUnknownTokens_(responseFromLlm, registry);
  Logger.log("unknown: " + JSON.stringify(unknown));
  if (unknown.length === 1 && unknown[0] === "{{ENTITY_999}}") {
    Logger.log("✅ detect OK");
  } else {
    Logger.log("❌ detect FAILED");
  }
}

/**
 * テスト一括実行。GAS UI で「test_PiiMasker_all」を選択 → 実行。
 */
function test_PiiMasker_all() {
  Logger.log("===== PiiMasker tests =====");
  test_PiiMasker_roundtrip();
  Logger.log("---");
  test_PiiMasker_orderingLongestFirst();
  Logger.log("---");
  test_PiiMasker_extractFromContext();
  Logger.log("---");
  test_PiiMasker_detectUnknownTokens();
  Logger.log("===== done =====");
}
