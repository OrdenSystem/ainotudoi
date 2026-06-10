/**
 * Gemini API 共通ヘルパー（APIキーローテーション + シークレットマスキング）
 *
 * 必要なスクリプトプロパティ:
 *   API_KEY        : 主キー（必須）
 *   API_KEY-002    : 第2キー（任意、quota切替用）
 *   API_KEY-003    : 第3キー（任意、quota切替用）
 *   ... API_KEY-005 まで対応
 */

/**
 * 利用可能な Gemini API キー一覧を返す（重複除外）
 */
function getGeminiApiKeys_() {
  var props = PropertiesService.getScriptProperties();
  var keys = [];
  var primary = props.getProperty('API_KEY');
  if (primary) keys.push(primary);
  for (var i = 2; i <= 5; i++) {
    var k = props.getProperty('API_KEY-' + String(i).padStart(3, '0'));
    if (!k) k = props.getProperty('API_KEY_' + i);
    if (k && keys.indexOf(k) === -1) keys.push(k);
  }
  return keys;
}

/**
 * URL や エラー本文から API キーをマスクする（ログ用）
 */
function maskSecrets_(text) {
  if (!text) return text;
  return String(text)
    .replace(/key=[A-Za-z0-9_\-]+/g, 'key=***')
    .replace(/AIza[A-Za-z0-9_\-]{20,}/g, 'AIza***');
}

/**
 * 5xx 過負荷リトライ用のバックオフ間隔（ミリ秒）。
 *
 * 配列長 = リトライ回数。試行回数は (配列長 + 1)（初回 + リトライ）= 最大 4 回。
 * 1s → 3s → 7s（合計待機 11 秒）。Gemini 過負荷時の一時復旧を狙う。
 *
 * 対象 HTTP ステータス: 500 / 502 / 503 / 504
 * 4xx 系（400/401/403/404 等）は構造的エラーのため即次キーへ進む（リトライ無意味）。
 */
var GEMINI_5XX_BACKOFF_MS_ = [1000, 3000, 7000];

/**
 * 同一 API キーで 5xx エラーが返ったときに再試行すべきか判定する。
 *
 * @param {number} code HTTP ステータスコード
 * @returns {boolean}
 */
function isRetriable5xx_(code) {
  return code === 500 || code === 502 || code === 503 || code === 504;
}

/**
 * Gemini API 呼び出し（APIキーローテーション + 5xx 過負荷リトライ対応）
 *
 * 設計方針:
 *   - HTTP 5xx (500/502/503/504) → 同一キーで指数バックオフリトライ（1s/3s/7s, 最大 4 試行）
 *   - quota / 429 / 帯域幅エラー検知 → 次の API キーへ切替（リトライしない）
 *   - その他 4xx（400/401/403/404 等） → 次の API キーへ切替（リトライしない）
 *   - HTTP 200 で JSON パース成功 → 即返却
 *   - 全キー全リトライ失敗 → throw（Slack通知 + console.error）
 *   - PII保護のためエラー詳細はSlackに乗せない（GAS実行ログ参照を促す）
 *
 * 後方互換性:
 *   - シグネチャ・戻り値仕様は変更なし（呼出側コード修正不要）
 *
 * @param {string} modelName 例: "gemini-2.5-flash", "gemini-2.5-pro"
 * @param {object} payload リクエストペイロード（contents, safetySettings, generationConfig 等）
 * @param {object} [opts] {
 *   apiVersion: "v1"|"v1beta"（既定 v1beta）,
 *   maxAttempts: number（同一キー内の最大試行回数。既定 GEMINI_5XX_BACKOFF_MS_.length + 1。
 *                       1 を指定するとリトライ無し＝各キー 1 試行のみで次キーへ）
 * }
 * @returns {object} 成功時 Gemini レスポンス JSON、全失敗時は throw
 *
 * 後方互換性メモ:
 *   opts.maxAttempts は省略可。省略時は従来動作（4 試行）と完全に同一になる。
 *   AppSheet "Call a script" の ~22 秒タイムアウトに合わせ、短予算モードでは
 *   呼出側が opts.maxAttempts: 1 を渡して各キー 1 試行のみで次へ進める設計。
 */
function callGeminiWithKeyRotation_(modelName, payload, opts) {
  opts = opts || {};
  var apiVersion = opts.apiVersion || 'v1beta';
  var keys = getGeminiApiKeys_();
  if (keys.length === 0) {
    throw new Error('API_KEY 未設定（Script Property）');
  }

  var errors = [];
  // 既定値: 初回 + リトライ回数 = GEMINI_5XX_BACKOFF_MS_.length + 1（従来動作）
  // opts.maxAttempts が正の整数なら上書き（1 ならリトライ無し）。
  var defaultMaxAttempts = GEMINI_5XX_BACKOFF_MS_.length + 1;
  var maxAttempts = (typeof opts.maxAttempts === 'number'
    && opts.maxAttempts > 0
    && Math.floor(opts.maxAttempts) === opts.maxAttempts)
    ? opts.maxAttempts
    : defaultMaxAttempts;

  for (var i = 0; i < keys.length; i++) {
    var apiKey = keys[i];
    var keyLabel = i === 0 ? 'API_KEY' : 'API_KEY-' + String(i + 1).padStart(3, '0');
    var url = 'https://generativelanguage.googleapis.com/' + apiVersion + '/models/' +
              modelName + ':generateContent?key=' + apiKey;

    // 同一キーでの試行ループ（5xx の場合のみ再試行）
    var attempt;
    for (attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        var res = UrlFetchApp.fetch(url, {
          method: 'post',
          contentType: 'application/json',
          payload: JSON.stringify(payload),
          muteHttpExceptions: true
        });
        var code = res.getResponseCode();
        var text = res.getContentText();

        if (code === 200) {
          try {
            return JSON.parse(text);
          } catch (parseErr) {
            errors.push(keyLabel + '/' + modelName + ' attempt ' + attempt
              + ' parse error: ' + parseErr.message);
            // パースエラーは再試行しても無意味 → 次キーへ
            break;
          }
        }

        // エラー本文先頭200文字に truncate（ログ膨張防止 + PII量削減）
        var bodySnippet = text.substring(0, 200).replace(/[\r\n]/g, ' ');
        var json = {};
        try { json = JSON.parse(text); } catch (_) {}
        var errMsg = maskSecrets_((json.error && json.error.message) || bodySnippet);
        errors.push(keyLabel + '/' + modelName + ' attempt ' + attempt
          + ' HTTP ' + code + ': ' + errMsg);

        // 5xx 過負荷 → 同一キーで指数バックオフリトライ
        if (isRetriable5xx_(code) && attempt < maxAttempts) {
          var waitMs = GEMINI_5XX_BACKOFF_MS_[attempt - 1];
          console.info('[Gemini] ' + keyLabel + ' attempt ' + attempt
            + ' HTTP ' + code + ' retrying in ' + (waitMs / 1000) + 's');
          Utilities.sleep(waitMs);
          continue;
        }

        // 5xx で全リトライ消費 → 次キーへフォールバック
        if (isRetriable5xx_(code)) {
          console.info('[Gemini] ' + keyLabel + ' 5xx 全リトライ失敗、次のキーへ');
          break;
        }

        // quota / 429 / 帯域幅 → 次のキーへ（リトライしない）
        var isQuota = (code === 429) || /quota|rate.?limit|帯域幅|bandwidth|exceed/i.test(errMsg);
        if (isQuota) {
          console.info('[Gemini] ' + keyLabel + ' quota切れ、次のキーへ');
          break;
        }

        // その他 4xx（400/401/403/404 等）→ 次キーへ（リトライ無意味）
        break;
      } catch (e) {
        // ネットワーク例外等は 5xx と同等のリトライポリシー
        errors.push(keyLabel + '/' + modelName + ' attempt ' + attempt + ' 例外: ' + e.message);
        if (attempt < maxAttempts) {
          var waitMsEx = GEMINI_5XX_BACKOFF_MS_[attempt - 1];
          console.info('[Gemini] ' + keyLabel + ' attempt ' + attempt
            + ' 例外 retrying in ' + (waitMsEx / 1000) + 's');
          Utilities.sleep(waitMsEx);
          continue;
        }
        break;
      }
    }
    // 同一キー試行ループ終了。break で抜けた後はそのまま次キーへ進む。
  }

  // 全失敗
  console.error('[Gemini] 全キー試行失敗 (' + keys.length + '本): ' + errors.join(' | '));
  try {
    if (typeof sendSlackNotification === 'function') {
      sendSlackNotification('Gemini API 全キー試行失敗\nモデル: ' + modelName +
        '\nキー数: ' + keys.length +
        '\n（PII保護のため詳細は GAS 実行ログを確認してください）');
    }
  } catch (_) {}

  throw new Error('Gemini API 全キー試行失敗 (' + keys.length + '本)');
}
