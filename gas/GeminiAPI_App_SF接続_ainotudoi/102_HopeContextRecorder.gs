/**
 * HopeContextRecorder（機能②：利用者コンテキスト連動の追記処理）
 *
 * 役割:
 *   - AppSheet Automation から doPost で渡された
 *       transcriptText / userFullName / userZaisekiId / staffPromptText / staffPromptKey / staffId
 *     を入力として、Drive 上の利用者コンテキスト（${userFullName}_AIコンテキスト_最新.txt）を取得し、
 *     Gemini に整形済みケース記録テキストを生成させて、HTTP レスポンス JSON で返す。
 *   - AppSheet 側 Automation が後続 Edit ステップで「AI処理フリーテキスト」列に書き戻す前提のため、
 *     当ファイルは AppSheet API も Salesforce API も叩かない。
 *
 * 設計方針:
 *   - 共有トークン認証は 000_POST.js 側で済ませる。当関数はトークン未検証想定で呼ばれない。
 *   - PII を含むパラメータ（氏名・在籍ID）はログ・Slack 通知に直接出さず、maskId_ / maskEmail_ で伏せる。
 *   - 利用者コンテキスト読込失敗時は fall through（空コンテキストで Gemini に渡し、エラー終了させない）。
 *   - Gemini 呼出失敗時のみ Slack 通知。それ以外（バリデーション失敗等）は console と JSON 戻りのみ。
 *
 * 参照する外部資源:
 *   - Script Properties: API_KEY（Gemini）、USER_ROOT_FOLDER_ID（AppConfig 経由）、SLACK_WEBHOOK_URL
 *   - Drive: USER_ROOT_FOLDER_ID 配下の事業所 → 利用者 → ChatPDF/${userFullName}_AIコンテキスト_最新.txt
 *
 * セキュリティ:
 *   - 既知エンティティ（利用者氏名・職員名・支援者・法定代理人名）は 040_PiiMasker.js により
 *     {{ENTITY_NN}} トークンに置換してから Gemini API に渡し、応答受領後に復号する。
 *   - 残存リスク（Vertex Batch / 会話中の自発的氏名）は docs/pii-masking-residual-risks.md を参照。
 *
 * 入力フォーマット（呼出元 doPost からそのまま渡される parameters）:
 *   {
 *     transcriptText:  string,  // 必須
 *     userFullName:    string,  // 必須
 *     userZaisekiId:   string,  // ログ用（任意）
 *     staffPromptText: string,  // 必須
 *     staffPromptKey:  string,  // ログ用（任意）
 *     staffId:         string   // ログ用 USEREMAIL()（任意）
 *   }
 *
 * 戻り値:
 *   成功: { success:true, text, charCount, promptKey, version, contextLength, transcriptLength }
 *   失敗: { success:false, error, code }
 */

/**
 * AppSheet doPost からのエントリポイント（000_POST.js から呼ばれる）。
 * 末尾アンダースコア付きで「内部用」を明示。
 *
 * @param {{transcriptText:string,userFullName:string,userZaisekiId:string,staffPromptText:string,staffPromptKey:string,staffId:string}} parameters
 * @returns {{success:boolean,text?:string,charCount?:number,promptKey?:string,version?:string,contextLength?:number,transcriptLength?:number,error?:string,code?:string}}
 */
function enrichCaseRecord_(parameters) {
  // 1. パラメータ取り出し（null/undefined セーフ）
  var p = parameters || {};
  var transcriptText = p.transcriptText || "";
  var userFullName = p.userFullName || "";
  var userZaisekiId = p.userZaisekiId || "";
  var staffPromptText = p.staffPromptText || "";
  var staffPromptKey = p.staffPromptKey || "";
  var staffId = p.staffId || "";
  var googleFolderUrl = p.googleFolderUrl || "";
  // 短予算モード（AppSheet "Call a script" の ~22 秒制限内に収める用途）。
  // 既定 false。true のとき callGeminiForEnrich_ に shortMode と timeBudgetMs を伝搬する。
  // 既存呼出の挙動は変更しない（未指定時は従来通り）。
  var shortMode = p.shortMode === true;
  var timeBudgetMs =
    typeof p.timeBudgetMs === "number" && p.timeBudgetMs > 0
      ? p.timeBudgetMs
      : null;

  // 2. バリデーション（必須 3 項目）
  if (!transcriptText) {
    return {
      success: false,
      error: "transcriptText is required",
      code: "E_NO_TRANSCRIPT",
    };
  }
  if (!userFullName) {
    return {
      success: false,
      error: "userFullName is required",
      code: "E_NO_USER",
    };
  }
  if (!staffPromptText) {
    return {
      success: false,
      error: "staffPromptText is required",
      code: "E_NO_PROMPT",
    };
  }

  // 3. ログ（PII 含めない）
  console.info(
    "[enrichCaseRecord] start zaisekiId=" +
      maskId_(userZaisekiId) +
      " promptKey=" +
      staffPromptKey +
      " staffId=" +
      maskEmail_(staffId) +
      " transcriptLen=" +
      transcriptText.length,
  );

  // 4. v0_disabled の早期短絡（コンテキスト取得・Gemini 呼出ともに完全スキップ）
  //    AppSheet Automation 側は success:false を見て後続 Edit ステップをスキップする設計に揃える。
  var cfg = HOPE_CTX_RECORDER_ACTIVE;
  if (cfg && cfg.version === "v0_disabled") {
    console.warn(
      "[enrichCaseRecord] HOPE_CTX_RECORDER_ACTIVE が v0_disabled のため処理しません",
    );
    return {
      success: false,
      error: "HopeContextRecorder is disabled (rollback mode)",
      code: "E_DISABLED",
      version: cfg.version,
      promptKey: staffPromptKey,
    };
  }

  // 5. 利用者コンテキスト取得（失敗しても fall through、Gemini は呼ぶ）
  //    AIチャット (HopeAIchat/HopeAIChat.js#getContextFileContent) と同一仕様で揃える:
  //    GoogleURL__c から folder ID 抽出 → ChatPDF サブフォルダ → 利用者名 + "AIコンテキスト" 部分一致
  //    の全ファイルをファイル名昇順で連結する。
  var contextText = "";
  try {
    contextText = getContextFileContent_(
      googleFolderUrl,
      userFullName,
      userZaisekiId,
    );
  } catch (e) {
    console.warn(
      "[enrichCaseRecord] コンテキスト読込失敗、空で続行: " + e.message,
    );
    contextText = "(利用者コンテキスト未取得)";
  }

  // 6. PII マスキング（040_PiiMasker.js）
  //    既知エンティティ（利用者氏名・職員名・支援者/法定代理人名）を {{ENTITY_NN}} に置換。
  //    LLM 応答後に unmaskText_ で復号。レジストリは関数ローカルで永続化しない。
  var staffList = getStaffListCached_();
  var registry = buildPiiRegistry_({
    userFullName: userFullName,
    contextText: contextText,
    staffList: staffList,
  });
  console.info("[enrichCaseRecord] piiMasking entityCount=" + registry.count);

  var maskedContext = maskText_(contextText, registry);
  var maskedTranscript = maskText_(transcriptText, registry);
  var maskedStaffPrompt = maskText_(staffPromptText, registry);

  // 7. プロンプト組立（マスク済みテキストを渡す）
  var fullPrompt = cfg.buildPrompt({
    contextText: maskedContext,
    transcriptText: maskedTranscript,
    staffPromptText: maskedStaffPrompt,
  });

  // buildPrompt が空文字を返した場合の安全弁（V0_DISABLED 以外で空応答を返す異常版への防衛）。
  if (!fullPrompt) {
    console.warn(
      "[enrichCaseRecord] buildPrompt が空文字を返したため no-op で返却",
    );
    return {
      success: false,
      error: "buildPrompt returned empty",
      code: "E_EMPTY_PROMPT",
      version: cfg.version || "unknown",
      promptKey: staffPromptKey,
    };
  }

  // 8. Gemini 呼出
  //    shortMode/timeBudgetMs を options で伝搬（短予算モードでは各キー 1 試行のみ）。
  var maskedResultText;
  try {
    maskedResultText = callGeminiForEnrich_(fullPrompt, cfg, {
      shortMode: shortMode,
      timeBudgetMs: timeBudgetMs,
    });
  } catch (e) {
    var errMsgRaw = e && e.message ? e.message : "unknown";
    console.error("[enrichCaseRecord] Gemini 呼出失敗: " + errMsgRaw);
    // Slack 通知には PII を含めないよう固定文言のみ。詳細は console.error / GCP Cloud Logging で確認
    sendSlackNotification(
      "🚨 enrichCaseRecord 失敗 zaisekiId=" +
        maskId_(userZaisekiId) +
        " — 詳細は GAS Cloud Logging を確認",
    );
    // タイムアウト系（time budget exceeded）は AppSheet 側で再実行を促す識別コードに分岐
    var isTimeout = /time budget exceeded/i.test(errMsgRaw);
    return {
      success: false,
      error: isTimeout ? "Gemini timeout" : "Gemini call failed",
      code: isTimeout ? "E_GEMINI_TIMEOUT" : "E_GEMINI",
    };
  }

  // 9. アンマスク + 監査ログ
  detectUnknownTokens_(maskedResultText, registry); // 未登録トークンがあれば warn ログのみ
  var resultText = unmaskText_(maskedResultText, registry);

  console.info(
    "[enrichCaseRecord] success zaisekiId=" +
      maskId_(userZaisekiId) +
      " outputLen=" +
      resultText.length,
  );

  return {
    success: true,
    text: resultText,
    charCount: resultText.length,
    promptKey: staffPromptKey,
    version: cfg.version,
    contextLength: contextText.length,
    transcriptLength: transcriptText.length,
  };
}

/**
 * StaffStatus__c の一覧を CacheService 経由で取得する（1 時間 TTL）。
 *
 * 目的:
 *   - PII マスキングのレジストリ構築用に職員氏名一覧が必要だが、
 *     enrichCaseRecord_ の呼出ごとに AppSheet API を叩くと 429 リスクが上がる。
 *   - 短期キャッシュで API 負荷を抑える。職員追加直後の最大 1 時間は反映遅延あり。
 *
 * 失敗時:
 *   - AppSheet API が落ちていてもマスキング処理を止めないため、空配列で fall through。
 *     利用者氏名と context 由来の名前だけはマスクされる。
 *
 * @returns {Array<Object>} StaffStatus__c の rows（要素は 'Name__c' / 'NameKana__c' を持つ）
 */
function getStaffListCached_() {
  var cache = CacheService.getScriptCache();
  // V2: 040_PiiMasker.js が必要とする名前フィールドのみに絞ったスリム版（cache 100KB 上限対策）
  // V1（PII_MASKER_STAFF_LIST）は full row を保存しており職員数増加で上限超過が頻発したため廃止。
  var CACHE_KEY = "PII_MASKER_STAFF_LIST_V2";
  try {
    var cached = cache.get(CACHE_KEY);
    if (cached) {
      var parsed = JSON.parse(cached);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch (e) {
    console.warn("[getStaffListCached_] cache 読込失敗: " + e.message);
  }

  var props = PropertiesService.getScriptProperties();
  var APP_ID = props.getProperty("APPSHEET_APP_ID");
  var API_KEY = props.getProperty("APPSHEET_API_KEY");
  if (!APP_ID || !API_KEY) {
    console.warn(
      "[getStaffListCached_] APPSHEET_APP_ID/APPSHEET_API_KEY 未設定、空リストで fall through",
    );
    return [];
  }

  try {
    var fullRows = callAppSheetApi(APP_ID, API_KEY, "StaffStatus__c", "");
    if (!Array.isArray(fullRows)) fullRows = [];

    // PII マスキングが利用するフィールドのみ抽出してキャッシュ容量を削減。
    // 040_PiiMasker.js#buildPiiRegistry_ は NameKana__c || Name__c のみ参照する。
    // 全カラム保持時の JSON サイズが 100KB を超え cache.put が "Argument too large: value"
    // で失敗していたため、スリム化で 1/10 〜 1/20 に圧縮する。
    var slimRows = fullRows
      .map(function (st) {
        return {
          NameKana__c: st["NameKana__c"] || "",
          Name__c: st["Name__c"] || "",
        };
      })
      .filter(function (st) {
        return st["NameKana__c"] || st["Name__c"];
      });

    // 1 時間キャッシュ（GAS CacheService の最大 21600 秒）
    try {
      cache.put(CACHE_KEY, JSON.stringify(slimRows), 3600);
    } catch (cacheErr) {
      // 想定外サイズ（slim 化後も上限超過するほど職員数が多い等）。マスキング自体は継続する。
      console.warn(
        "[getStaffListCached_] cache 保存失敗（slim化後も上限超過）: " +
          cacheErr.message,
      );
    }
    return slimRows;
  } catch (e) {
    console.warn(
      "[getStaffListCached_] StaffStatus__c 取得失敗、空リストで fall through: " +
        e.message,
    );
    return [];
  }
}

/**
 * フォールバック先モデル名（pro が 5xx で全滅したときに使う）。
 * v1beta API で動作する flash 系の安定版を指定する。
 *
 * maxOutputTokens 互換性メモ:
 *   gemini-2.5-flash の output token 上限は 65536（gemini-2.5-pro と同等）。
 *   HOPE_CTX_RECORDER_V1.maxOutputTokens=32768 はその範囲内で安全に使える。
 *   参照: Google AI Studio モデル仕様（2026-04 確認）
 */
var GEMINI_ENRICH_FALLBACK_MODEL_ = "gemini-2.5-flash";

/**
 * フォールバック発動時に応答テキストの先頭に付与する識別プレフィックス。
 * 後で本番テキストとして人が見て判別できるように、可視文字列として残す。
 */
var GEMINI_ENRICH_FALLBACK_PREFIX_ =
  "[フォールバック: gemini-2.5-flash 使用]\n\n";

/**
 * callGeminiForEnrich_ の time budget（ミリ秒）。
 *
 * Why:
 *   3 キー × 4 試行 × 待機 11s × pro+flash で最悪 66s 超 + UrlFetchApp 遅延が加算されるため、
 *   GAS 6 分制限・AppSheet "Call a script" タイムアウトに到達する可能性がある。
 *   実害発生時は途中で flash スキップして wrapper にコントロールを返し、
 *   `[AI処理エラー] E_GEMINI_TIMEOUT` 通知文字列で AppSheet に応答する設計とする。
 *
 * 値の根拠:
 *   GAS 全体 6 分 = 360s のうち、enrichCaseRecord_ 全体に 240s（4 分）の予算を割当。
 *   残り 120s は前後処理（コンテキスト読込・PII マスキング・unmask 等）と AppSheet 応答時間に充当。
 */
var GEMINI_ENRICH_TIME_BUDGET_MS_ = 240000;

/**
 * payload + parsed response から本文テキストを安全に抽出する内部ヘルパ。
 * candidates / parts のいずれかが欠けた場合は throw（呼出側でフォールバック判定）。
 *
 * @param {object} parsed callGeminiWithKeyRotation_ の戻り値
 * @returns {string}
 */
function extractGeminiText_(parsed) {
  var text =
    parsed &&
    parsed.candidates &&
    parsed.candidates[0] &&
    parsed.candidates[0].content &&
    parsed.candidates[0].content.parts &&
    parsed.candidates[0].content.parts[0] &&
    parsed.candidates[0].content.parts[0].text;
  if (!text) {
    var reason =
      (parsed &&
        parsed.candidates &&
        parsed.candidates[0] &&
        parsed.candidates[0].finishReason) ||
      "不明";
    throw new Error("Gemini 応答が空 (finishReason: " + reason + ")");
  }
  return text;
}

/**
 * Gemini API 呼出（generativelanguage.googleapis.com）+ flash フォールバック。
 * 設計参考: 101_HopeRecorder.js#callGeminiProToCleanText_。
 *
 * 共通点:
 *   - safetySettings 4 カテゴリ全て BLOCK_NONE（介護面談のため）
 *   - throw メッセージは HTTP コードのみ（API キー・PII 流出防止）、詳細は console.error
 *   - 空応答時は finishReason 込みで throw
 *
 * 機能②独自:
 *   - systemPrompt + コンテキスト + 文字起こし + スタッフ指示が合成済みの fullPrompt を受け取る。
 *   - generationConfig に maxOutputTokens を含める（cleaning 側は未指定）。
 *
 * フォールバック方針（HTTP 5xx 過負荷耐性）:
 *   1. cfg.model（通常 gemini-2.5-pro）で呼出（callGeminiWithKeyRotation_ 内で 1s/3s/7s リトライ + 全キー試行）
 *   2. pro が throw した場合のみ catch → gemini-2.5-flash で同一 payload を再試行
 *   3. flash も throw した場合のみ最終 throw（呼出側 enrichCaseRecord_ が success:false 化）
 *   4. フォールバック成功時は応答先頭に "[フォールバック: gemini-2.5-flash 使用]\n\n" を付与
 *      （本番テキストとして書き戻された後でも人が見て判別できるようにする）
 *   5. PII は payload にマスク済みで渡るためログ増加なし。本文はログに出さない（既存方針維持）。
 *
 * @param {string} fullPrompt buildPrompt の結果
 * @param {{model:string,temperature:number,maxOutputTokens:number}} cfg HOPE_CTX_RECORDER_ACTIVE
 * @param {object} [options] {
 *   shortMode: boolean    短予算モード（true なら pro/flash 双方の callGeminiWithKeyRotation_ に
 *                          maxAttempts: 1 を渡し、各キー 1 試行のみで次へ進める）
 *   timeBudgetMs: number  この呼出全体の time budget。null/未指定時は GEMINI_ENRICH_TIME_BUDGET_MS_
 * }
 * @returns {string} Gemini が返した整形済みテキスト（フォールバック時は識別プレフィックス付き）
 */
function callGeminiForEnrich_(fullPrompt, cfg, options) {
  options = options || {};
  var shortMode = options.shortMode === true;
  var timeBudgetMs =
    typeof options.timeBudgetMs === "number" && options.timeBudgetMs > 0
      ? options.timeBudgetMs
      : GEMINI_ENRICH_TIME_BUDGET_MS_;
  // 短予算モード時は callGeminiWithKeyRotation_ の maxAttempts を 1 に絞る。
  // それ以外（既定／バックグラウンドリトライ等の長予算モード）では従来動作。
  var rotationOpts = { apiVersion: "v1beta" };
  if (shortMode) rotationOpts.maxAttempts = 1;
  var startMs = Date.now();
  var payload = {
    contents: [{ role: "user", parts: [{ text: fullPrompt }] }],
    safetySettings: [
      { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
    ],
    generationConfig: {
      temperature: cfg.temperature,
      maxOutputTokens: cfg.maxOutputTokens,
    },
  };

  // 1) 第一選択: cfg.model（通常は gemini-2.5-pro）
  //    callGeminiWithKeyRotation_ 内で 5xx は同一キー指数バックオフ、
  //    quota は次キー、すべて尽きた場合に throw される。
  //    shortMode の場合は maxAttempts: 1（同一キー内リトライ無し）で短時間打ち切る。
  try {
    var parsedPro = callGeminiWithKeyRotation_(
      cfg.model,
      payload,
      rotationOpts,
    );
    return extractGeminiText_(parsedPro);
  } catch (proErr) {
    // pro 全試行失敗。flash にフォールバック。
    // PII を含まない（モデル名・エラーメッセージのみ）ことを確認した上で warn ログ。
    console.warn(
      "[callGeminiForEnrich_] " +
        cfg.model +
        " 全試行失敗、" +
        GEMINI_ENRICH_FALLBACK_MODEL_ +
        " にフォールバック: " +
        (proErr && proErr.message ? proErr.message : "unknown"),
    );
  }

  // 2) フォールバック: gemini-2.5-flash（同一 payload・同一 generationConfig）
  //    GAS 6 分制限保護のため time budget チェック。残時間が不足する場合は flash スキップして
  //    タイムアウト識別の throw を上げる（呼出側 enrichCaseRecord_ で success:false 化される）。
  //    timeBudgetMs は options で上書き可能（既定 GEMINI_ENRICH_TIME_BUDGET_MS_）。
  var elapsedMs = Date.now() - startMs;
  if (elapsedMs > timeBudgetMs) {
    var timeoutMsg =
      "time budget exceeded after " +
      cfg.model +
      " attempts (elapsed " +
      elapsedMs +
      "ms, budget " +
      timeBudgetMs +
      "ms), skipping " +
      GEMINI_ENRICH_FALLBACK_MODEL_;
    console.error("[callGeminiForEnrich_] " + timeoutMsg);
    throw new Error(timeoutMsg);
  }

  try {
    var parsedFlash = callGeminiWithKeyRotation_(
      GEMINI_ENRICH_FALLBACK_MODEL_,
      payload,
      rotationOpts,
    );
    var flashText = extractGeminiText_(parsedFlash);
    console.warn(
      "[callGeminiForEnrich_] " +
        GEMINI_ENRICH_FALLBACK_MODEL_ +
        " フォールバック成功 outputLen=" +
        flashText.length +
        " totalElapsedMs=" +
        (Date.now() - startMs),
    );
    return GEMINI_ENRICH_FALLBACK_PREFIX_ + flashText;
  } catch (flashErr) {
    // flash も失敗 → 最終 throw。呼出側 enrichCaseRecord_ で success:false 化される。
    console.error(
      "[callGeminiForEnrich_] " +
        GEMINI_ENRICH_FALLBACK_MODEL_ +
        " フォールバックも失敗: " +
        (flashErr && flashErr.message ? flashErr.message : "unknown"),
    );
    throw flashErr;
  }
}

/**
 * 利用者コンテキストファイルを読み込む（AIチャット仕様準拠）。
 *
 * 仕様:
 *   HopeAIchat/HopeAIChat.js#getContextFileContent と同一ロジック。AIチャット側が利用するのと
 *   同じテキストファイル群（複数）を読込み、ファイル名昇順で連結して 1 本のコンテキストとして返す。
 *
 *   1. googleFolderUrl から folder ID を抽出（id=... または /folders/... のいずれか）
 *   2. その folder 配下の "ChatPDF" サブフォルダを取得
 *   3. ChatPDF 配下の全ファイルから、ファイル名に「(空白除去後の利用者名)」と「AIコンテキスト」の
 *      両方を含むファイルを抽出
 *   4. ファイル名昇順でソート → "=== 参照: <ファイル名> ===" 区切りで連結
 *   5. 100KB 未満なら CacheService に 5 分キャッシュ（キー: CTX_<userZaisekiId>）
 *
 * 失敗パス（呼出側が catch して空コンテキストで Gemini に渡す fall through 想定）:
 *   - googleFolderUrl 空 / URL 形式不正
 *   - DriveApp.getFolderById 例外（権限なし・削除済み）
 *   - ChatPDF サブフォルダなし
 *   - 該当ファイル 0 件
 *
 * セキュリティ:
 *   - ログには PII（氏名・本文）を出さない。folder ID 末尾 4 桁とマッチ件数のみ。
 *   - cacheKey は userZaisekiId を含むが、マスク済みでログ出力（maskId_）。
 *
 * @param {string} googleFolderUrl AppSheet 側 [利用者在籍ID].[GoogleURL__c]
 * @param {string} userFullName 利用者フルネーム（例: "山田 太郎"）。空白除去後の部分一致に使う
 * @param {string} userZaisekiId キャッシュキー用。空でも動作する（その場合キャッシュ無効）
 * @returns {string} 連結されたコンテキスト本文（UTF-8）
 * @throws {Error} URL 不正 / フォルダ不在 / ChatPDF 不在 / 該当ファイル 0 件
 */
function getContextFileContent_(googleFolderUrl, userFullName, userZaisekiId) {
  if (!googleFolderUrl) {
    throw new Error("googleFolderUrl が空");
  }
  if (!userFullName) {
    throw new Error("userFullName が空");
  }

  // 1) キャッシュチェック（userZaisekiId が空のときはスキップ）
  var cacheKey = userZaisekiId ? "CTX_" + userZaisekiId : null;
  if (cacheKey) {
    try {
      var cached = CacheService.getScriptCache().get(cacheKey);
      if (cached) {
        console.info(
          "[getContextFileContent_] cache hit zaisekiId=" +
            maskId_(userZaisekiId) +
            " len=" +
            cached.length,
        );
        return cached;
      }
    } catch (cacheErr) {
      // キャッシュ読込失敗は致命でない。ログのみで素通し。
      console.warn(
        "[getContextFileContent_] cache read 例外: " + cacheErr.message,
      );
    }
  }

  // 2) URL から folder ID 抽出（HopeAIChat.js#getPDFFolderId_ と同じ正規表現）
  var match =
    String(googleFolderUrl).match(/id=([a-zA-Z0-9_-]+)/) ||
    String(googleFolderUrl).match(/\/folders\/([a-zA-Z0-9_-]+)/);
  if (!match) {
    throw new Error("GoogleURL__c から folder ID を抽出できず");
  }
  var folderId = match[1];

  // 3) 親フォルダ取得 → ChatPDF サブフォルダ
  var rootFolder;
  try {
    rootFolder = DriveApp.getFolderById(folderId);
  } catch (e) {
    // 権限なし・削除済みの可能性（folder ID 末尾 4 桁のみログ）
    throw new Error(
      "Drive folder 取得失敗 idTail=" + maskId_(folderId) + ": " + e.message,
    );
  }
  var chatPdfIter = rootFolder.getFoldersByName("ChatPDF");
  if (!chatPdfIter.hasNext()) {
    throw new Error("ChatPDF サブフォルダなし");
  }
  var chatPdfFolder = chatPdfIter.next();

  // 4) ファイル列挙: 名前に「(クリーンユーザー名)」と「AIコンテキスト」両方を含むものを集める
  var cleanUserName = String(userFullName).replace(/\s+/g, "");
  var fileList = [];
  var files = chatPdfFolder.getFiles();
  while (files.hasNext()) {
    var f = files.next();
    var fname = f.getName();
    var cleanFname = fname.replace(/\s+/g, "");
    if (
      cleanFname.indexOf(cleanUserName) >= 0 &&
      fname.indexOf("AIコンテキスト") >= 0
    ) {
      fileList.push({
        name: fname,
        content: f.getBlob().getDataAsString("UTF-8"),
      });
    }
  }

  if (fileList.length === 0) {
    throw new Error("AIコンテキストファイルが見つかりません (ChatPDF 配下)");
  }

  // 5) ファイル名昇順で連結（AIチャットと同じ順序）
  fileList.sort(function (a, b) {
    return a.name.localeCompare(b.name);
  });
  var combinedText = "";
  for (var i = 0; i < fileList.length; i++) {
    combinedText +=
      "\n\n=== 参照: " + fileList[i].name + " ===\n\n" + fileList[i].content;
  }

  console.info(
    "[getContextFileContent_] zaisekiId=" +
      maskId_(userZaisekiId) +
      " fileCount=" +
      fileList.length +
      " totalLen=" +
      combinedText.length,
  );

  // 6) キャッシュ保存（CacheService 100KB 上限を 90KB で安全側マージン）
  if (cacheKey && combinedText.length < 90000) {
    try {
      CacheService.getScriptCache().put(cacheKey, combinedText, 300);
    } catch (putErr) {
      // 100KB 超過等で put 失敗。ログのみで素通し（戻り値は維持）。
      console.warn(
        "[getContextFileContent_] cache put 例外: " + putErr.message,
      );
    }
  }

  return combinedText;
}

/**
 * 在籍ID等の文字列を末尾 4 文字以外マスクする。ログ用。
 * 4 文字以下の場合は全文を「****」に置換し、長さの手がかりも与えない。
 *
 * @param {string} s
 * @returns {string}
 */
function maskId_(s) {
  if (!s) return "(empty)";
  var str = String(s);
  if (str.length <= 4) return "****";
  return "****" + str.substring(str.length - 4);
}

/**
 * メールアドレスを「先頭2文字 + ***@***」形式にマスクする。ログ用。
 * ドメインも明かさない（組織名や個人事業所名が漏れることを防ぐ）。
 * 「@」を含まない場合は maskId_ にフォールバック。
 *
 * @param {string} email
 * @returns {string}
 */
function maskEmail_(email) {
  if (!email) return "(empty)";
  var str = String(email);
  var atIdx = str.indexOf("@");
  if (atIdx < 0) return maskId_(str);
  var local = str.substring(0, atIdx);
  var head = local.length >= 2 ? local.substring(0, 2) : "*";
  return head + "***@***";
}

// =====================================================================
// 単体テスト関数（GAS UI から手動実行用、末尾アンダースコアなし）
// =====================================================================

/**
 * enrichCaseRecord_ のドライラン。
 *
 * 動作確認のポイント:
 *   - userFullName を実在しない名前にしておくことで getContextFileContent_ の throw → fall through 経路を確認。
 *   - Gemini API は実際に叩かれる（API_KEY が必要、課金が発生）。
 *   - test_getContextFileContent_ で実利用者と GoogleURL を渡せばコンテキスト取得経路の動作確認が可能。
 */
function test_enrichCaseRecord_dryRun() {
  Logger.log(
    "[TEST] *** Gemini API を実際に呼び出します。" +
      "モデル: " +
      HOPE_CTX_RECORDER_ACTIVE.model +
      " / 課金が発生します。本番環境での実行を確認してください。 ***",
  );
  var dummyParams = {
    transcriptText:
      "speaker_1: 今日は調子どうですか？\n" +
      "speaker_2: まあぼちぼちです。\n" +
      "speaker_1: ご飯はちゃんと食べてますか？\n" +
      "speaker_2: うん、3食。",
    // 実フォルダで存在しない名前を使い「コンテキスト未取得」フォールバックを確認する
    userFullName: "TEST 利用者",
    userZaisekiId: "TEST_ZAISEKI_001",
    staffPromptText: "会話を SOAP 形式で要約してください。",
    staffPromptKey: "soap",
    staffId: "test@example.com",
  };
  var result = enrichCaseRecord_(dummyParams);
  Logger.log("===== test_enrichCaseRecord_dryRun =====");
  Logger.log("success: " + result.success);
  Logger.log("charCount: " + result.charCount);
  Logger.log("version: " + result.version);
  Logger.log("promptKey: " + result.promptKey);
  Logger.log("contextLength: " + result.contextLength);
  Logger.log("transcriptLength: " + result.transcriptLength);
  Logger.log("text (head 500 chars):");
  Logger.log((result.text || "").substring(0, 500));
  if (!result.success) {
    Logger.log("error: " + result.error + " (" + result.code + ")");
  }
}

/**
 * 5xx リトライ + flash フォールバックの動作観測用テスト（実 API を叩く）。
 *
 * 目的:
 *   - pro が成功する通常系の戻り値が長文 string であることを確認する。
 *   - pro が 503 を返した場合のリトライログ（[Gemini] ... attempt N HTTP 503 retrying in Ns）と
 *     フォールバックログ（[callGeminiForEnrich_] ... フォールバック成功）が GAS 実行ログに
 *     現れることを手動で確認する（503 を再現できるかは Gemini 側状況次第）。
 *
 * 注意:
 *   - 実際の Gemini API を叩くため API_KEY が必要かつ課金が発生する。
 *   - PII を含まない短文ダミープロンプトのみ使用する。
 *   - フォールバック発動時は戻り値の先頭に "[フォールバック: gemini-2.5-flash 使用]" が付与される。
 */
function test_callGeminiForEnrich_proAndFallback() {
  Logger.log(
    "[TEST] *** callGeminiForEnrich_ を直接呼出します。" +
      "モデル: " +
      HOPE_CTX_RECORDER_ACTIVE.model +
      " / フォールバック先: gemini-2.5-flash / 課金が発生します。 ***",
  );

  // PII を含まないダミープロンプト
  var dummyPrompt =
    HOPE_CTX_RECORDER_ACTIVE.systemPrompt +
    "\n\n## 利用者コンテキスト\n（テスト用ダミー）" +
    "\n\n## 面談文字起こし\nspeaker_1: 今日の天気はどうですか。\nspeaker_2: 晴れています。" +
    "\n\n## スタッフ指示\n会話を1行で要約してください。";

  var resultText;
  try {
    resultText = callGeminiForEnrich_(dummyPrompt, HOPE_CTX_RECORDER_ACTIVE);
  } catch (e) {
    Logger.log("[TEST] 全モデル失敗（pro + flash 両方失敗）: " + e.message);
    return;
  }

  Logger.log("===== test_callGeminiForEnrich_proAndFallback =====");
  Logger.log("typeof: " + typeof resultText);
  Logger.log("length: " + (resultText || "").length);
  var isFallback = (resultText || "").indexOf("[フォールバック:") === 0;
  Logger.log("fallbackTriggered: " + isFallback);
  Logger.log("head 300 chars:");
  Logger.log((resultText || "").substring(0, 300));
}

/**
 * getContextFileContent_ 単体動作確認用。
 * 引数を取るため GAS UI から直接実行できない。下の run_test_getUserContext を使う。
 *
 * @param {string} googleFolderUrl AppSheet の [利用者在籍ID].[GoogleURL__c] と同形式
 * @param {string} userFullName
 * @param {string} userZaisekiId キャッシュキー用（任意）
 */
function test_getContextFileContent_(
  googleFolderUrl,
  userFullName,
  userZaisekiId,
) {
  var ctx = getContextFileContent_(
    googleFolderUrl,
    userFullName,
    userZaisekiId || "",
  );
  Logger.log("contextLength: " + ctx.length);
  Logger.log("contextHead: " + ctx.substring(0, 300));
}

/**
 * GAS UI 直接実行用ラッパ。テスト前に対象利用者氏名と GoogleURL をハードコードして実行する。
 * 本番／hahaha どちらで叩くか、誰でテストするか明確にしてから差し替える。
 */
function run_test_getUserContext() {
  // ★テスト時に手動で書き換える
  var userFullName = "TEST 利用者";
  var googleFolderUrl = "https://drive.google.com/drive/folders/REPLACE_ME";
  var userZaisekiId = "";
  try {
    test_getContextFileContent_(googleFolderUrl, userFullName, userZaisekiId);
  } catch (e) {
    Logger.log("NG: " + e.message);
  }
}

/**
 * 機能② に必要な Script Properties が設定済みかを一括確認する診断関数。
 * 値そのものは出さず、「設定済 N 文字」または「未設定」のみログ出力する（秘密情報保護）。
 *
 * 確認対象:
 *   - WEBAPP_SHARED_TOKEN: doPost 共有トークン認証
 *   - API_KEY:             Gemini API（generativelanguage.googleapis.com）
 *   - SLACK_WEBHOOK_URL:   sendSlackNotification の送信先
 *   注: USER_ROOT_FOLDER_ID は AIチャット式（GoogleURL__c 直接参照）への切替により不要となった
 *
 * 使い方:
 *   GAS UI で関数 dump_RequiredPropsForFeature2 を選択して実行。
 *   本番／hahaha 双方で実行し、未設定項目があれば運用者が事前に Script Properties に追加する。
 */
function dump_RequiredPropsForFeature2() {
  var props = PropertiesService.getScriptProperties();
  var keys = ["WEBAPP_SHARED_TOKEN", "API_KEY", "SLACK_WEBHOOK_URL"];
  Logger.log("===== 機能② 必須 Script Properties チェック =====");
  var missing = 0;
  keys.forEach(function (k) {
    var v = props.getProperty(k);
    if (v) {
      Logger.log(k + " = (設定済 " + v.length + " 文字)");
    } else {
      Logger.log(k + " = (未設定 ★)");
      missing++;
    }
  });
  Logger.log(
    "===== " +
      (missing === 0 ? "すべて設定済み" : "未設定: " + missing + " 件") +
      " =====",
  );
}

/**
 * AppSheet Automation の "Call a script" ステップから呼ばれる public エントリポイント。
 *
 * Why:
 *   enrichCaseRecord_ は parameters オブジェクトを 1 引数で受ける doPost 用シグネチャだが、
 *   AppSheet "Call a script" は順序付きスカラー引数を 1 つずつ式で渡すため、
 *   そのままでは呼び出せない。本ラッパーが個別引数を集約し parameters 化する。
 *
 * 戻り値方針（AppSheet Automation を失敗扱いにしない）:
 *   - 必須引数が空 → 通知文字列を返却（throw しない）
 *   - 内部処理失敗（Gemini エラー等）→ 通知文字列を返却（throw しない）
 *   - 成功 → 整形済みケース記録テキスト（長文 string）
 *   いずれの場合も string を返すので、AppSheet 側の Return Value 型は LongText で OK。
 *   後続 Edit ステップで [AIリライト].[Output] を「AI適用」列にそのままセットする想定。
 *
 * セキュリティ:
 *   - PII マスキング・コンテキスト読込・Gemini 呼出はすべて enrichCaseRecord_ に委譲。
 *   - 本ラッパー自体は PII を含む引数を直接ログ出力しない（呼出先が maskId_/maskEmail_ 済み）。
 *
 * AppSheet 設定（参考）:
 *   Function Parameters の順序は本シグネチャに 1:1 対応:
 *     1. <<[文字起こしテキスト]>>
 *     2. <<[利用者在籍ID].[CustomerName__c]>>
 *     3. <<[利用者在籍ID]>>
 *     4. <<[AI整理_要約].[プロンプト]>>
 *     5. <<[AI整理_要約]>>
 *     6. <<[職員在籍ID]>>
 *     7. <<[利用者在籍ID].[GoogleURL__c]>>  ← AIチャットと同じテキストを読むためのフォルダURL
 *
 * @param {string} transcriptText
 * @param {string} userFullName
 * @param {string} userZaisekiId
 * @param {string} staffPromptText
 * @param {string} staffPromptKey
 * @param {string} staffId
 * @param {string} googleFolderUrl 利用者の GoogleURL__c。空でも処理は継続（コンテキスト無し扱い）
 * @returns {string} 成功時は整形済みテキスト、失敗時は通知文字列（先頭に [AI処理スキップ] / [AI処理エラー]）
 */
function enrichCaseRecordForAutomation(
  transcriptText,
  userFullName,
  userZaisekiId,
  staffPromptText,
  staffPromptKey,
  staffId,
  googleFolderUrl,
) {
  // 1. 必須引数の空チェック → throw せず通知文字列を返却
  //    googleFolderUrl は必須にしない（空ならコンテキスト無しで Gemini に渡る fall through）
  var missing = [];
  if (!transcriptText) missing.push("文字起こしテキスト");
  if (!userFullName) missing.push("利用者氏名");
  if (!staffPromptText) missing.push("AIプロンプト");
  if (missing.length > 0) {
    var skipMsg =
      "[AI処理スキップ] 以下のパラメータが空のため処理を行いませんでした: " +
      missing.join(", ");
    console.warn(
      "[enrichCaseRecordForAutomation] " +
        skipMsg +
        " zaisekiId=" +
        maskId_(userZaisekiId) +
        " staffId=" +
        maskEmail_(staffId),
    );
    return skipMsg;
  }

  // 2. 本処理を呼出（例外も握りつぶして通知文字列に変換）
  //    AppSheet "Call a script" の ~22 秒ハードタイムアウト対策のため shortMode:true,
  //    timeBudgetMs:18000 を渡す（同期呼出で時間内に決着しない場合は
  //    [AI処理タイムアウト] を返し、105_AiEnrichRetryWorker.js が後追いで再処理する設計）。
  var result;
  try {
    result = enrichCaseRecord_({
      transcriptText: transcriptText,
      userFullName: userFullName,
      userZaisekiId: userZaisekiId || "",
      staffPromptText: staffPromptText,
      staffPromptKey: staffPromptKey || "",
      staffId: staffId || "",
      googleFolderUrl: googleFolderUrl || "",
      shortMode: true,
      timeBudgetMs: 18000,
    });
  } catch (e) {
    var exMsg =
      "[AI処理エラー] 例外発生: " + (e && e.message ? e.message : "unknown");
    console.error("[enrichCaseRecordForAutomation] " + exMsg);
    return exMsg;
  }

  // 3. 内部失敗（Gemini エラー・v0_disabled 等）→ 通知文字列を返却
  if (!result || !result.success) {
    var code = (result && result.code) || "UNKNOWN";
    var errMsg;
    if (code === "E_GEMINI_TIMEOUT") {
      // タイムアウトは Google 側過負荷の長期化が主因。AppSheet 側で再実行することを促す。
      errMsg =
        "[AI処理タイムアウト] Gemini が過負荷で時間内に完了できませんでした。" +
        "しばらく経ってから再実行してください。(" +
        code +
        ")";
    } else {
      errMsg =
        "[AI処理エラー] " +
        code +
        ": " +
        ((result && result.error) || "enrichCaseRecord failed");
    }
    console.warn("[enrichCaseRecordForAutomation] " + errMsg);
    return errMsg;
  }

  // 4. 成功 → 整形済みテキストをそのまま返却
  return result.text;
}
