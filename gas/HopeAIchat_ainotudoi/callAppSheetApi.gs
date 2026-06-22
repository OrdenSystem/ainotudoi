// 新規職員が追加された後のシステムの動き
// 追加直後 〜 最大1時間:
// システムはまだ「1時間の短期記憶（キャッシュ）」を使っているため、チャット画面を開いても新規職員はまだリストに表示されません。

// 1時間が経過した瞬間（短期記憶が消去）:
// 誰かがチャット画面を開くと、システムは「記憶が消えたから、AppSheetに最新のリストを取りに行こう！」と動きます。

// AppSheetから最新データを取得成功（通常時）:
// ここで新規職員を含んだ最新のリストを取得します。
// この瞬間、以下の2つが同時に行われます。

// --- 究極版：職員リスト取得（永久バックアップ・排他制御付き） ---
function getStaffList() {
  const cacheKey = "STAFF_LIST_CACHE";
  const backupKey = "STAFF_LIST_BACKUP"; // ★追加：永久保存用のキー
  const cache = CacheService.getScriptCache();
  const props = PropertiesService.getScriptProperties();

  let cached = cache.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(15000);

    cached = cache.get(cacheKey);
    if (cached) return JSON.parse(cached);

    console.log("[Lock] AppSheetへ職員リストを取得しに行きます");
    const APP_ID = props.getProperty("APPSHEET_APP_ID");
    const API_KEY = props.getProperty("APPSHEET_API_KEY");

    const rows = callAppSheetApi(APP_ID, API_KEY, "StaffStatus__c", "");

    // ★ API取得に失敗した場合（429エラーなど）のバックアップ発動
    if (!rows || rows.length === 0) {
      const backup = props.getProperty(backupKey);
      if (backup) {
        console.log(
          "AppSheet APIエラーのため、金庫(バックアップ)から職員リストを復元します",
        );
        // エラーの連鎖を防ぐため、バックアップデータを「10分間」キャッシュに置き、AppSheetへの突撃を止める
        cache.put(cacheKey, backup, 600);
        return JSON.parse(backup);
      }
      return []; // バックアップすら無い初回のみ空配列
    }

    // 正常に取得できた場合の処理
    const staffData = rows.map((r) => {
      const name =
        r["NameKana__c"] ||
        r["Name__c"] ||
        r["氏名"] ||
        r["Name"] ||
        "名称不明";
      const id = r["Row ID"] || r["ID"] || "";
      return { id: id, name: name };
    });

    if (staffData.length > 0) {
      const jsonStr = JSON.stringify(staffData);
      cache.put(cacheKey, jsonStr, 3600); // 1時間キャッシュ（通常の記憶）
      props.setProperty(backupKey, jsonStr); // ★ 次回エラー時のために金庫（プロパティ）へ永久保存
    }
    return staffData;
  } catch (e) {
    console.error("Lock/Fetch Error (Staff List): " + e.message);
    return [];
  } finally {
    lock.releaseLock();
  }
}

// --- AppSheet API 呼び出し（ジッター・長期リトライ対応版） ---
function callAppSheetApi(appId, apiKey, tableName, selector) {
  const url = `https://api.appsheet.com/api/v2/apps/${appId}/tables/${encodeURIComponent(tableName)}/Action`;
  const payload = {
    Action: "Find",
    Properties: { Locale: "ja-JP", Selector: selector },
    Rows: [],
  };
  const options = {
    method: "post",
    headers: {
      ApplicationAccessKey: apiKey,
      "Content-Type": "application/json",
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  };

  const MAX_RETRIES = 4; // リトライ上限を4回に引き上げ
  const failureLog = [];

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    let isRateLimit = false;

    try {
      const res = UrlFetchApp.fetch(url, options);
      const code = res.getResponseCode();
      const text = res.getContentText();

      if (code === 200) {
        try {
          return JSON.parse(text);
        } catch (parseErr) {
          failureLog.push(
            `試行${attempt}: JSONパース失敗 (${parseErr.message})`,
          );
        }
      } else if (code === 429) {
        isRateLimit = true;
        failureLog.push(`試行${attempt}: HTTP 429 (レートリミット)`);
      } else {
        failureLog.push(`試行${attempt}: HTTP ${code}`);
      }
    } catch (e) {
      failureLog.push(`試行${attempt}: 例外 ${e.message}`);
    }

    if (attempt < MAX_RETRIES) {
      // ランダムな揺らぎ（1〜3秒）を追加し、同時アクセスを分散
      const jitter = Math.floor(Math.random() * 2000) + 1000;
      // 429エラー時は大幅に待機（例: 1回目=約6秒, 2回目=約11秒, 3回目=約16秒）
      const waitTime = isRateLimit
        ? 5000 * attempt + jitter
        : 2000 * attempt + jitter;
      console.log(
        `[AppSheet API] ${tableName} 取得失敗。${waitTime / 1000}秒後に再試行します...`,
      );
      Utilities.sleep(waitTime);
    }
  }

  console.error(
    `AppSheet API 呼び出し失敗\nテーブル: ${tableName}\n${failureLog.join("\n")}`,
  );
  try {
    notifyError(
      "callAppSheetApi",
      `${tableName} 取得失敗 (4回試行)\n` + failureLog.join("\n"),
    );
  } catch (ne) {}

  return [];
}
