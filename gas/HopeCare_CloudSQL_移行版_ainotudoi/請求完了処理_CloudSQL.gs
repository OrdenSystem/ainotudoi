/**
 * 表示中の相談記録IDリストに基づき、CSVバックアップ作成とフラグの一括更新を行う
 */
function completeBillingWithIDs_CloudSQL(targetIDs, backupFolderUrl) {
  let executionLogs = [];
  const log = (msg) => {
    const timestamp = Utilities.formatDate(new Date(), "JST", "HH:mm:ss");
    executionLogs.push(`[${timestamp}] ${msg}`);
    console.log(`[${timestamp}] ${msg}`);
  };

  log("--- 処理開始（請求完了・フラグ更新） ---");

  try {
    // ★ CloudSQL移行版: スプレッドシート → JDBC

    // フォルダ準備
    const folderId = backupFolderUrl.match(/[-\w]{25,}/);
    if (!folderId) throw new Error("フォルダURLが不正です。");
    const folder = DriveApp.getFolderById(folderId[0]);

    // --- IDリストの正規化（List形式でもString形式でも対応可能にする） ---
    let idList = [];
    if (Array.isArray(targetIDs)) {
      idList = targetIDs.map((id) => String(id).trim());
    } else if (typeof targetIDs === "string") {
      idList = targetIDs.split(",").map((id) => id.trim());
    } else if (targetIDs) {
      idList = [String(targetIDs).trim()];
    }

    if (idList.length === 0) throw new Error("対象となるIDリストが空です。");

    // ★ CloudSQLから対象レコードを取得
    var conn, stmt, rs;
    try {
      conn = getCloudSqlConnection_();

      // 全カラム名を取得（CSV用ヘッダー）
      stmt = conn.prepareStatement('SELECT * FROM "01相談記録" LIMIT 0');
      rs = stmt.executeQuery();
      var meta = rs.getMetaData();
      var colCount = meta.getColumnCount();
      var header01 = [];
      for (var ci = 1; ci <= colCount; ci++)
        header01.push(meta.getColumnName(ci));
      rs.close();
      stmt.close();

      // 対象IDのレコードを取得（更新前バックアップ用）
      var placeholders = idList
        .map(function () {
          return "?";
        })
        .join(", ");
      stmt = conn.prepareStatement(
        'SELECT * FROM "01相談記録" WHERE "相談記録ID" IN (' +
          placeholders +
          ")",
      );
      for (var si = 0; si < idList.length; si++) {
        stmt.setString(si + 1, idList[si]);
      }
      rs = stmt.executeQuery();

      var targetRowsBefore = [];
      while (rs.next()) {
        var row = [];
        for (var rj = 1; rj <= colCount; rj++) row.push(rs.getString(rj) || "");
        targetRowsBefore.push(row);
      }
      rs.close();
      stmt.close();

      if (targetRowsBefore.length === 0) {
        log("対象IDに一致するレコードが見つかりませんでした。");
      } else {
        const ts = Utilities.formatDate(new Date(), "JST", "yyyyMMdd_HHmmss");

        // 2. 【更新前】CSV保存
        saveRowsToCsv_CloudSQL(
          targetRowsBefore,
          header01,
          `BEFORE_COMPLETE_${ts}.csv`,
          folder,
        );
        log(`更新前CSV保存完了 (${targetRowsBefore.length}件)`);

        // 3. ★ フラグの更新処理（JDBC UPDATE）
        conn.setAutoCommit(false);
        stmt = conn.prepareStatement(
          'UPDATE "01相談記録" SET "フラグ" = TRUE WHERE "相談記録ID" = ?',
        );
        for (var ui = 0; ui < idList.length; ui++) {
          stmt.setString(1, idList[ui]);
          stmt.addBatch();
        }
        stmt.executeBatch();
        conn.commit();
        stmt.close();
        log(`01相談記録のフラグを更新完了 (${idList.length}件)`);

        // 4. 【更新後】CSV保存（更新後データを再取得）
        stmt = conn.prepareStatement(
          'SELECT * FROM "01相談記録" WHERE "相談記録ID" IN (' +
            placeholders +
            ")",
        );
        for (var ai = 0; ai < idList.length; ai++) {
          stmt.setString(ai + 1, idList[ai]);
        }
        rs = stmt.executeQuery();
        var targetRowsAfter = [];
        while (rs.next()) {
          var aRow = [];
          for (var aj = 1; aj <= colCount; aj++)
            aRow.push(rs.getString(aj) || "");
          targetRowsAfter.push(aRow);
        }
        rs.close();
        stmt.close();

        saveRowsToCsv_CloudSQL(
          targetRowsAfter,
          header01,
          `AFTER_COMPLETE_${ts}.csv`,
          folder,
        );
        log(`更新後CSV保存完了`);
      }
    } finally {
      closeCloudSql_(conn, stmt, rs);
    }

    log("処理完了");
  } catch (e) {
    log(`エラー発生: ${e.message}`);
  }

  return {
    Output: executionLogs.join("\n"),
  };
}

/**
 * 対象行をCSV形式で保存する補助関数
 */
function saveRowsToCsv_CloudSQL(rows, header, fileName, folder) {
  const csvString = [header, ...rows]
    .map((row) => {
      return row
        .map((cell) => {
          let val = String(cell).replace(/"/g, '""');
          return `"${val}"`;
        })
        .join(",");
    })
    .join("\r\n");

  const blob = Utilities.newBlob(csvString, "text/csv", fileName);
  folder.createFile(blob);
}
