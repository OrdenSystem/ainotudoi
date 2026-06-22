/**
 * Spreadsheet/Folder ID を Script Properties から取得するヘルパー
 *
 * 設計方針:
 *   - 各 .js ファイルにハードコードしていた SS_ID/FOLDER_ID を
 *     Script Properties に外出しし、本番（とよさと）と hahaha で値だけ差し替える運用にする。
 *   - getConfigId_(KEY) は値を返す。未設定なら明確なエラーで停止し、原因を特定しやすくする。
 *
 * 必須プロパティキー（このプロジェクトで実行時に必要）:
 *   WAREKI_SS_ID            : 和暦変換マスタ（000_設定.js で起動時にロード）
 *   SEIKYU_TASK_SS_ID       : 請求App（HopeCare_CloudSQL_移行版 と共通の値）
 *   RECORDER_SHEET_ID       : HopeRecorder のPOST履歴シート
 *   QUEUE_SS_ID             : AI テキスト生成キュー（HopeCare_CloudSQL_移行版 と共通の値）
 *   USER_ROOT_FOLDER_ID     : 利用者フォルダのルート
 *   STAFF_ROOT_FOLDER_ID    : 職員フォルダのルート
 *
 * migrate_*.js のハードコード ID は移行用一過性のため対象外。
 */

var _APP_CONFIG_CACHE_ = {};

function getConfigId_(key) {
  if (_APP_CONFIG_CACHE_[key]) return _APP_CONFIG_CACHE_[key];
  var v = PropertiesService.getScriptProperties().getProperty(key);
  if (!v) {
    throw new Error(
      '[AppConfig] Script Property "' +
        key +
        '" が未設定です。GAS UI > プロジェクトの設定 > スクリプト プロパティ で設定してください。',
    );
  }
  _APP_CONFIG_CACHE_[key] = v;
  return v;
}

/**
 * 設置済みプロパティを一括チェックする手動実行用テスト関数。
 * - 各キーがプロパティに存在するか
 * - 値が示すスプシ／フォルダに実際にアクセスできるか（権限確認も兼ねる）
 *
 * 実行方法: GAS エディタで関数名 test_AppConfig_All を選択して実行 → ログを確認。
 */
function test_AppConfig_All() {
  var checks = [
    {
      key: "WAREKI_SS_ID",
      type: "spreadsheet",
      required: true,
      desc: "和暦変換マスタ",
    },
    {
      key: "SEIKYU_TASK_SS_ID",
      type: "spreadsheet",
      required: true,
      desc: "請求App",
    },
    {
      key: "RECORDER_SHEET_ID",
      type: "spreadsheet",
      required: true,
      desc: "HopeRecorder POST履歴",
    },
    {
      key: "QUEUE_SS_ID",
      type: "spreadsheet",
      required: true,
      desc: "AIテキスト生成キュー",
    },
    {
      key: "USER_ROOT_FOLDER_ID",
      type: "folder",
      required: true,
      desc: "利用者フォルダルート",
    },
    {
      key: "STAFF_ROOT_FOLDER_ID",
      type: "folder",
      required: true,
      desc: "職員フォルダルート",
    },
  ];

  Logger.log("===== AppConfig プロパティチェック開始 =====");
  var props = PropertiesService.getScriptProperties();
  var passed = 0,
    failed = 0,
    skipped = 0;

  checks.forEach(function (c) {
    var v = props.getProperty(c.key);
    if (!v) {
      if (c.required) {
        Logger.log("❌ [" + c.key + "] " + c.desc + " — 未設定（必須）");
        failed++;
      } else {
        Logger.log(
          "⚠️ [" + c.key + "] " + c.desc + " — 未設定（任意のためスキップ）",
        );
        skipped++;
      }
      return;
    }
    try {
      if (c.type === "spreadsheet") {
        var ss = SpreadsheetApp.openById(v);
        Logger.log(
          "✅ [" +
            c.key +
            "] " +
            c.desc +
            " → スプシ「" +
            ss.getName() +
            "」アクセスOK",
        );
      } else if (c.type === "folder") {
        var f = DriveApp.getFolderById(v);
        Logger.log(
          "✅ [" +
            c.key +
            "] " +
            c.desc +
            " → フォルダ「" +
            f.getName() +
            "」アクセスOK",
        );
      }
      passed++;
    } catch (e) {
      Logger.log(
        "❌ [" + c.key + "] " + c.desc + " — アクセス失敗: " + e.message,
      );
      failed++;
    }
  });

  Logger.log(
    "===== 結果: ✅ " +
      passed +
      " / ❌ " +
      failed +
      " / ⚠️ " +
      skipped +
      " =====",
  );
  if (failed > 0) {
    throw new Error(
      "AppConfig チェック失敗: " +
        failed +
        " 件のエラーがあります（上のログ参照）",
    );
  }
  Logger.log(
    "✨ すべての必須プロパティが正しく設定されており、アクセス可能です",
  );
}

/**
 * 設置済みプロパティの実 ID をダンプする。
 * 本番／hahaha で同一 ID を指していないかの照合用。
 */
function dump_AppConfig_Ids() {
  var keys = [
    "WAREKI_SS_ID",
    "SEIKYU_TASK_SS_ID",
    "RECORDER_SHEET_ID",
    "QUEUE_SS_ID",
    "USER_ROOT_FOLDER_ID",
    "STAFF_ROOT_FOLDER_ID",
  ];
  var props = PropertiesService.getScriptProperties();
  Logger.log("===== AppConfig ID ダンプ =====");
  keys.forEach(function (k) {
    var v = props.getProperty(k) || "(未設定)";
    Logger.log(k + " = " + v);
  });
}
