/**
 * ==========================================================
 * CloudSQL_Monitor.js: CloudSQL ヘルスチェック & スロークエリ監視
 *
 * GASの時限トリガーで定期実行し、異常時にSlackへ通知する。
 * 全通知は既存の sendSlackNotification() を経由して Slack に統一。
 *
 * 必要なスクリプトプロパティ:
 *   CLOUDSQL_URL, CLOUDSQL_USER, CLOUDSQL_PASS  — JDBC接続情報
 *   SLACK_WEBHOOK_URL                            — Slack Webhook
 *
 * 推奨トリガー設定:
 *   monitorCloudSQL     → 5分おき（時間主導型）
 *   monitorSlowQueries  → 10分おき（時間主導型）
 * ==========================================================
 */

// --- 閾値設定 ---
var MONITOR_CONFIG = {
  MAX_CONNECTIONS_WARN: 150, // 接続数の警告閾値（max_connections=200）
  MAX_CONNECTIONS_CRITICAL: 180, // 接続数の危険閾値
  SLOW_QUERY_SECONDS: 10, // スロークエリとみなす秒数
  LONG_RUNNING_SECONDS: 60, // 長時間クエリの警告閾値（秒）
  IDLE_IN_TRANSACTION_SECONDS: 30, // idle in transaction の警告閾値（秒）
};

/**
 * メイン監視関数（5分おきトリガー推奨）
 * - 接続可否チェック
 * - アクティブ接続数チェック
 * - idle in transaction チェック
 * - 長時間実行クエリチェック
 */
function monitorCloudSQL() {
  var conn = null;
  var stmt = null;
  var rs = null;
  var alerts = [];

  try {
    // --- 1. 接続チェック ---
    var startTime = new Date().getTime();
    conn = getCloudSqlConnection_();
    var connectTime = new Date().getTime() - startTime;

    if (connectTime > 5000) {
      alerts.push("⚠️ 接続遅延: " + connectTime + "ms（5秒超）");
    }

    // --- 2. 接続数チェック ---
    stmt = conn.prepareStatement(
      "SELECT count(*) AS total, " +
        "  count(*) FILTER (WHERE state = 'active') AS active, " +
        "  count(*) FILTER (WHERE state = 'idle') AS idle, " +
        "  count(*) FILTER (WHERE state = 'idle in transaction') AS idle_in_tx " +
        "FROM pg_stat_activity WHERE backend_type = 'client backend'",
    );
    rs = stmt.executeQuery();

    if (rs.next()) {
      var total = rs.getInt("total");
      var active = rs.getInt("active");
      var idle = rs.getInt("idle");
      var idleInTx = rs.getInt("idle_in_tx");

      if (total >= MONITOR_CONFIG.MAX_CONNECTIONS_CRITICAL) {
        alerts.push(
          "🔴 *接続数 CRITICAL*: " +
            total +
            "/200（active:" +
            active +
            ", idle:" +
            idle +
            ", idle_in_tx:" +
            idleInTx +
            "）",
        );
      } else if (total >= MONITOR_CONFIG.MAX_CONNECTIONS_WARN) {
        alerts.push(
          "🟡 *接続数 WARNING*: " +
            total +
            "/200（active:" +
            active +
            ", idle:" +
            idle +
            ", idle_in_tx:" +
            idleInTx +
            "）",
        );
      }
    }
    rs.close();
    rs = null;
    stmt.close();
    stmt = null;

    // --- 3. idle in transaction の長時間放置チェック ---
    stmt = conn.prepareStatement(
      "SELECT pid, usename, state, " +
        "  EXTRACT(EPOCH FROM (now() - state_change))::int AS duration_sec, " +
        "  LEFT(query, 80) AS query_preview " +
        "FROM pg_stat_activity " +
        "WHERE state = 'idle in transaction' " +
        "  AND EXTRACT(EPOCH FROM (now() - state_change)) > ? " +
        "  AND backend_type = 'client backend' " +
        "ORDER BY duration_sec DESC LIMIT 5",
    );
    stmt.setInt(1, MONITOR_CONFIG.IDLE_IN_TRANSACTION_SECONDS);
    rs = stmt.executeQuery();

    var idleTxList = [];
    while (rs.next()) {
      idleTxList.push(
        "  PID " +
          rs.getInt("pid") +
          " (" +
          rs.getString("usename") +
          ") " +
          rs.getInt("duration_sec") +
          "秒 — " +
          (rs.getString("query_preview") || "").substring(0, 50),
      );
    }
    if (idleTxList.length > 0) {
      alerts.push("🟠 *idle in transaction 放置*:\n" + idleTxList.join("\n"));
    }
    rs.close();
    rs = null;
    stmt.close();
    stmt = null;

    // --- 4. 長時間実行中クエリ ---
    stmt = conn.prepareStatement(
      "SELECT pid, usename, " +
        "  EXTRACT(EPOCH FROM (now() - query_start))::int AS duration_sec, " +
        "  LEFT(query, 100) AS query_preview " +
        "FROM pg_stat_activity " +
        "WHERE state = 'active' " +
        "  AND query NOT LIKE '%pg_stat_activity%' " +
        "  AND EXTRACT(EPOCH FROM (now() - query_start)) > ? " +
        "  AND backend_type = 'client backend' " +
        "ORDER BY duration_sec DESC LIMIT 5",
    );
    stmt.setInt(1, MONITOR_CONFIG.LONG_RUNNING_SECONDS);
    rs = stmt.executeQuery();

    var longQueries = [];
    while (rs.next()) {
      longQueries.push(
        "  PID " +
          rs.getInt("pid") +
          " (" +
          rs.getString("usename") +
          ") " +
          rs.getInt("duration_sec") +
          "秒\n  → " +
          (rs.getString("query_preview") || "").substring(0, 80),
      );
    }
    if (longQueries.length > 0) {
      alerts.push("🔴 *長時間クエリ実行中*:\n" + longQueries.join("\n"));
    }
  } catch (e) {
    // 接続失敗時は 000_CloudSQL接続.js 側で Slack 通知済み（重複防止のためここでは alerts に追加しない）
    Logger.log("monitorCloudSQL: 接続失敗のため監視スキップ: " + e.message);
  } finally {
    closeCloudSql_(conn, stmt, rs);
  }

  // --- アラート送信 ---
  if (alerts.length > 0) {
    var timestamp = Utilities.formatDate(
      new Date(),
      "Asia/Tokyo",
      "yyyy/MM/dd HH:mm:ss",
    );
    var message =
      "📊 *CloudSQL 監視アラート*\n時刻: " +
      timestamp +
      "\n\n" +
      alerts.join("\n\n");
    sendSlackNotification(message);
    Logger.log("監視アラート送信: " + alerts.length + "件");
  } else {
    Logger.log(
      "CloudSQL監視: 正常（" +
        Utilities.formatDate(new Date(), "Asia/Tokyo", "HH:mm:ss") +
        "）",
    );
  }
}

/**
 * スロークエリ監視（10分おきトリガー推奨）
 * pg_stat_statements からスロークエリ統計を取得
 * ※ pg_stat_statements拡張が有効な場合のみ動作
 */
function monitorSlowQueries() {
  var conn = null;
  var stmt = null;
  var rs = null;

  try {
    conn = getCloudSqlConnection_();

    // pg_stat_statements が有効かチェック
    stmt = conn.prepareStatement(
      "SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements') AS enabled",
    );
    rs = stmt.executeQuery();
    rs.next();
    var extensionEnabled = rs.getBoolean("enabled");
    rs.close();
    rs = null;
    stmt.close();
    stmt = null;

    if (!extensionEnabled) {
      Logger.log(
        "pg_stat_statements 拡張が無効のため、pg_stat_activity から代替監視",
      );
      monitorSlowQueriesFallback_(conn);
      return;
    }

    // スロークエリ統計（過去の累計から平均実行時間が長いものを抽出）
    stmt = conn.prepareStatement(
      "SELECT LEFT(query, 120) AS query_preview, " +
        "  calls, " +
        "  ROUND(mean_exec_time::numeric, 2) AS avg_ms, " +
        "  ROUND(max_exec_time::numeric, 2) AS max_ms, " +
        "  ROUND(total_exec_time::numeric, 2) AS total_ms " +
        "FROM pg_stat_statements " +
        "WHERE mean_exec_time > ? * 1000 " +
        "  AND query NOT LIKE '%pg_stat%' " +
        "  AND calls > 0 " +
        "ORDER BY mean_exec_time DESC LIMIT 5",
    );
    stmt.setInt(1, MONITOR_CONFIG.SLOW_QUERY_SECONDS);
    rs = stmt.executeQuery();

    var slowQueries = [];
    while (rs.next()) {
      slowQueries.push(
        "  avg: " +
          rs.getString("avg_ms") +
          "ms" +
          " / max: " +
          rs.getString("max_ms") +
          "ms" +
          " / calls: " +
          rs.getInt("calls") +
          "\n  → " +
          (rs.getString("query_preview") || "").substring(0, 100),
      );
    }

    if (slowQueries.length > 0) {
      var timestamp = Utilities.formatDate(
        new Date(),
        "Asia/Tokyo",
        "yyyy/MM/dd HH:mm:ss",
      );
      var message =
        "🐢 *スロークエリ検出*\n時刻: " +
        timestamp +
        "\n閾値: 平均" +
        MONITOR_CONFIG.SLOW_QUERY_SECONDS +
        "秒超\n\n" +
        slowQueries.join("\n\n");
      sendSlackNotification(message);
    } else {
      Logger.log("スロークエリ監視: 異常なし");
    }
  } catch (e) {
    Logger.log("スロークエリ監視エラー: " + e.message);
  } finally {
    closeCloudSql_(conn, stmt, rs);
  }
}

/**
 * pg_stat_statements が無効な場合のフォールバック監視
 * pg_stat_activity から現在実行中のスロークエリを検出
 */
function monitorSlowQueriesFallback_(conn) {
  var stmt = null;
  var rs = null;

  try {
    stmt = conn.prepareStatement(
      "SELECT pid, usename, " +
        "  EXTRACT(EPOCH FROM (now() - query_start))::int AS duration_sec, " +
        "  state, " +
        "  LEFT(query, 120) AS query_preview " +
        "FROM pg_stat_activity " +
        "WHERE state = 'active' " +
        "  AND query NOT LIKE '%pg_stat_activity%' " +
        "  AND EXTRACT(EPOCH FROM (now() - query_start)) > ? " +
        "  AND backend_type = 'client backend' " +
        "ORDER BY duration_sec DESC LIMIT 5",
    );
    stmt.setInt(1, MONITOR_CONFIG.SLOW_QUERY_SECONDS);
    rs = stmt.executeQuery();

    var slowQueries = [];
    while (rs.next()) {
      slowQueries.push(
        "  PID " +
          rs.getInt("pid") +
          " (" +
          rs.getString("usename") +
          ") " +
          rs.getInt("duration_sec") +
          "秒実行中\n  → " +
          (rs.getString("query_preview") || "").substring(0, 100),
      );
    }

    if (slowQueries.length > 0) {
      var timestamp = Utilities.formatDate(
        new Date(),
        "Asia/Tokyo",
        "yyyy/MM/dd HH:mm:ss",
      );
      var message =
        "🐢 *スロークエリ検出（実行中）*\n時刻: " +
        timestamp +
        "\n閾値: " +
        MONITOR_CONFIG.SLOW_QUERY_SECONDS +
        "秒超\n\n" +
        slowQueries.join("\n\n");
      sendSlackNotification(message);
    }
  } finally {
    try {
      if (rs) rs.close();
    } catch (e) {}
    try {
      if (stmt) stmt.close();
    } catch (e) {}
  }
}

/**
 * DB統計サマリーをSlackに送信（手動実行 or 1日1回トリガー推奨）
 */
function sendDailyDBReport() {
  var conn = null;
  var stmt = null;
  var rs = null;

  try {
    conn = getCloudSqlConnection_();
    var report = [];

    // テーブル行数
    stmt = conn.prepareStatement(
      "SELECT relname AS table_name, n_live_tup AS row_count " +
        "FROM pg_stat_user_tables ORDER BY n_live_tup DESC LIMIT 10",
    );
    rs = stmt.executeQuery();
    var tableCounts = [];
    while (rs.next()) {
      tableCounts.push(
        "  " +
          rs.getString("table_name") +
          ": " +
          rs.getLong("row_count") +
          "行",
      );
    }
    report.push("*テーブル行数 (TOP10):*\n" + tableCounts.join("\n"));
    rs.close();
    rs = null;
    stmt.close();
    stmt = null;

    // DB容量
    stmt = conn.prepareStatement(
      "SELECT pg_size_pretty(pg_database_size(current_database())) AS db_size",
    );
    rs = stmt.executeQuery();
    if (rs.next()) {
      report.push("*DB容量:* " + rs.getString("db_size"));
    }
    rs.close();
    rs = null;
    stmt.close();
    stmt = null;

    // 接続数
    stmt = conn.prepareStatement(
      "SELECT count(*) AS total, " +
        "  (SELECT setting::int FROM pg_settings WHERE name = 'max_connections') AS max_conn " +
        "FROM pg_stat_activity WHERE backend_type = 'client backend'",
    );
    rs = stmt.executeQuery();
    if (rs.next()) {
      report.push(
        "*接続数:* " + rs.getInt("total") + " / " + rs.getInt("max_conn"),
      );
    }

    var timestamp = Utilities.formatDate(
      new Date(),
      "Asia/Tokyo",
      "yyyy/MM/dd HH:mm:ss",
    );
    var message =
      "📋 *CloudSQL 日次レポート*\n時刻: " +
      timestamp +
      "\nDB: hopecare\n\n" +
      report.join("\n\n");
    sendSlackNotification(message);
    Logger.log("日次レポート送信完了");
  } catch (e) {
    Logger.log("日次レポートエラー: " + e.message);
    var timestamp = Utilities.formatDate(
      new Date(),
      "Asia/Tokyo",
      "yyyy/MM/dd HH:mm:ss",
    );
    sendSlackNotification(
      "🔴 *日次レポート失敗*\nエラー: " + e.message + "\n時刻: " + timestamp,
    );
  } finally {
    closeCloudSql_(conn, stmt, rs);
  }
}

// ========== トリガー管理ユーティリティ ==========

/**
 * 監視トリガーを一括セットアップ
 * ※ GASエディタから1回だけ手動実行する
 */
function setupMonitorTriggers() {
  // 既存の監視トリガーを削除
  removeMonitorTriggers();

  // 10分おきヘルスチェック
  ScriptApp.newTrigger("monitorCloudSQL").timeBased().everyMinutes(10).create();

  // 15分おきスロークエリ監視
  ScriptApp.newTrigger("monitorSlowQueries")
    .timeBased()
    .everyMinutes(15)
    .create();

  // 毎朝6時に日次レポート（業務開始前、接続競合を避ける）
  ScriptApp.newTrigger("sendDailyDBReport")
    .timeBased()
    .atHour(6)
    .everyDays(1)
    .create();

  Logger.log("監視トリガーをセットアップしました");
  sendSlackNotification(
    "✅ *CloudSQL監視を開始しました*\n• ヘルスチェック: 10分おき\n• スロークエリ監視: 15分おき\n• 日次レポート: 毎朝6時",
  );
}

/**
 * 監視トリガーを一括削除
 */
function removeMonitorTriggers() {
  var triggers = ScriptApp.getProjectTriggers();
  var monitorFunctions = [
    "monitorCloudSQL",
    "monitorSlowQueries",
    "sendDailyDBReport",
  ];
  triggers.forEach(function (trigger) {
    if (monitorFunctions.indexOf(trigger.getHandlerFunction()) >= 0) {
      ScriptApp.deleteTrigger(trigger);
    }
  });
  Logger.log("既存の監視トリガーを削除しました");
}

/**
 * テスト: 各監視を手動実行
 */
function testMonitor() {
  Logger.log("=== ヘルスチェック ===");
  monitorCloudSQL();
  Logger.log("=== スロークエリ監視 ===");
  monitorSlowQueries();
  Logger.log("=== テスト完了 ===");
}
