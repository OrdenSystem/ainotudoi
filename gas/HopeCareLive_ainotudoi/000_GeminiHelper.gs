/**
 * Gemini API 共通ヘルパー（APIキーローテーション + シークレットマスキング）
 *
 * 必要なスクリプトプロパティ:
 *   GEMINI_API_KEY      : 主キー（必須）
 *   GEMINI_API_KEY-002  : 第2キー（任意、quota切替用）
 *   GEMINI_API_KEY-003  : 第3キー（任意、quota切替用）
 *   ... GEMINI_API_KEY-005 まで対応
 */

/**
 * 利用可能な Gemini API キー一覧を返す（重複除外）
 */
function getGeminiApiKeys_() {
  var props = PropertiesService.getScriptProperties();
  var keys = [];
  var primary = props.getProperty("GEMINI_API_KEY");
  if (primary) keys.push(primary);
  for (var i = 2; i <= 5; i++) {
    var k = props.getProperty("GEMINI_API_KEY-" + String(i).padStart(3, "0"));
    if (!k) k = props.getProperty("GEMINI_API_KEY_" + i);
    if (k && keys.indexOf(k) === -1) keys.push(k);
  }
  return keys;
}

/**
 * URLやエラーメッセージから API キーをマスクする（ログ用）
 * 例: "...?key=AIzaSy..." → "...?key=***"
 */
function maskSecrets_(text) {
  if (!text) return text;
  return String(text)
    .replace(/key=[A-Za-z0-9_\-]+/g, "key=***")
    .replace(/AIza[A-Za-z0-9_\-]{20,}/g, "AIza***");
}

/**
 * Gemini API 呼び出し（APIキーローテーション対応）
 *
 * @param {string} modelName - 例: "gemini-2.5-flash", "gemini-2.5-pro"
 * @param {object} payload - リクエストペイロード（contents, generationConfig 等）
 * @param {object} [opts] - { apiVersion: "v1"|"v1beta"（既定 v1beta） }
 * @returns {object} 成功時は Gemini レスポンス JSON、失敗時は { error: "...", details: [...] }
 */
function callGeminiWithKeyRotation_(modelName, payload, opts) {
  opts = opts || {};
  var apiVersion = opts.apiVersion || "v1beta";
  var keys = getGeminiApiKeys_();
  if (keys.length === 0) {
    return { error: "GEMINI_API_KEY が未設定です" };
  }

  var errors = [];
  for (var i = 0; i < keys.length; i++) {
    var apiKey = keys[i];
    var keyLabel =
      i === 0
        ? "GEMINI_API_KEY"
        : "GEMINI_API_KEY-" + String(i + 1).padStart(3, "0");
    var url =
      "https://generativelanguage.googleapis.com/" +
      apiVersion +
      "/models/" +
      modelName +
      ":generateContent?key=" +
      apiKey;

    try {
      var res = UrlFetchApp.fetch(url, {
        method: "post",
        contentType: "application/json",
        payload: JSON.stringify(payload),
        muteHttpExceptions: true,
      });
      var code = res.getResponseCode();
      var text = res.getContentText();

      if (code === 200) {
        try {
          return JSON.parse(text);
        } catch (parseErr) {
          errors.push(keyLabel + "/" + modelName + " parse error");
          continue;
        }
      }

      var json = {};
      try {
        json = JSON.parse(text);
      } catch (_) {}
      var errMsg = maskSecrets_(
        (json.error && json.error.message) || text.substring(0, 200),
      );
      errors.push(keyLabel + "/" + modelName + " HTTP " + code + ": " + errMsg);

      // quota/429/帯域幅 検知 → 次のキーへ
      var isQuota =
        code === 429 ||
        /quota|rate.?limit|帯域幅|bandwidth|exceed/i.test(errMsg);
      if (isQuota && i < keys.length - 1) {
        console.log("[Gemini] " + keyLabel + " quota切れ、次のキーへ");
        continue;
      }
      // それ以外でも次のキーで試す（最終キーまで）
    } catch (e) {
      errors.push(keyLabel + "/" + modelName + " 例外: " + e.message);
    }
  }

  // 全失敗
  console.error(
    "[Gemini] 全キー試行失敗 (" + keys.length + "本): " + errors.join(" | "),
  );
  return { error: "Gemini API 全キー試行失敗", details: errors };
}
