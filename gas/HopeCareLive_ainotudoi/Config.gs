// ==========================================
// Config.gs: 共通設定・環境変数
// ==========================================

const props = PropertiesService.getScriptProperties();

// 画像で設定されているプロパティをグローバル定数化
const APPSHEET_APP_ID = props.getProperty("APPSHEET_APP_ID");
const APPSHEET_API_KEY = props.getProperty("APPSHEET_API_KEY");
const APPSHEET_TABLE_NAME = props.getProperty("APPSHEET_TABLE_NAME"); // "ケース記録"
const DEEPGRAM_API_KEY = props.getProperty("DEEPGRAM_API_KEY");
const GEMINI_API_KEY = props.getProperty("GEMINI_API_KEY");

// キャッシュ設定（チャットアプリ用）
const CONTEXT_CACHE_TTL_SEC = 6 * 60 * 60; // 6時間
