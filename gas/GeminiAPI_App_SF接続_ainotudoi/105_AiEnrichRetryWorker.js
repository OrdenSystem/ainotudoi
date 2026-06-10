/**
 * AI整理リトライワーカー（バックグラウンド自動再処理）
 *
 * 役割:
 *   AppSheet "Call a script" の短予算（18s）で失敗した（[AI整理_要約] のリトライ後も
 *   ケース記録.AI適用 が "[AI処理エラー]" / "[AI処理タイムアウト]" のままになっている）
 *   行を 10 分おきに自動検出し、長予算（240s）で再生成して上書きする。
 *
 *   ユーザーから見ると、初回失敗から数分以内に自動的に正常テキストへ更新され、
 *   AppSheet 側で明示的にリトライ操作する必要がなくなる。
 *
 * スキーマ調査結果:
 *   - ケース記録 (76列): AI適用 列あり、ただし 音声記録対応 への明示的な参照列なし、
 *     リトライ回数列なし。
 *   - 音声記録対応 (18列): 文字起こしテキスト / 利用者在籍ID / AI整理_要約 (=AIプロンプト Ref) /
 *     職員在籍ID を保持。元データの再構築に必要な情報は全て音声記録対応にある。
 *   - リンク方式: 利用者在籍ID + 登録日時近接（10 分以内）でヒューリスティック JOIN。
 *     AppSheet Automation はトリガ後ほぼ即座に ケース記録 を作成するため、
 *     同利用者・同分内に複数の音声記録対応 行が存在しない限り 1:1 マッチが成立する。
 *   - リトライ回数: Script Properties に RETRY_<ケース記録RowID> をキーとして整数で保持。
 *     上限 3 回。永続化のためテーブル列追加は行わない（DDL 変更ゼロ）。
 *
 * 設計上の保護:
 *   - 1 実行あたり最大 3 件まで処理（GAS 6 分制限保護、240s × 3 = 12 分なので実は若干危険）
 *   - 既に正常テキスト（[AI処理 で始まらない）になっている行は絶対に上書きしない（同時編集レース）
 *   - AppSheet API ルックアップ失敗時はその行をスキップして次へ
 *   - JDBC コネクションは finally で必ずクローズ
 *
 * AppSheet Automation 注意（必読）:
 *   現状の Automation トリガが「音声記録対応 行追加」のみであれば、ケース記録 の AI適用 列を
 *   GAS が更新しても再発火しないため安全。万一トリガ条件が「ケース記録 AI適用 列変更」を
 *   含む場合は、本ワーカーが書き込んだ瞬間に再発火 → 短予算 Call a script でまた失敗、という
 *   無限ループのリスクあり。AppSheet Automation の Event 設定を事前確認すること。
 *
 * セキュリティ:
 *   - JDBC でデータ取得時、文字起こしテキスト本文・氏名・GoogleURL をログに出さない
 *   - エラーログには ケース記録RowID（マスク不要、利用者個人を一意に特定する PII ではない）と
 *     利用者在籍ID（maskId_）のみ記録
 *
 * セットアップ手順（時間主導型トリガー追加）:
 *   1. GAS Editor を開く
 *   2. 左サイドバー「トリガー」アイコン → 「トリガーを追加」
 *   3. 関数: retryFailedAiEnrichments
 *   4. デプロイ時: Head
 *   5. イベントのソース: 時間主導型
 *   6. 時間ベースのトリガーのタイプ: 分ベースのタイマー
 *   7. 時間の間隔: 10 分おき
 *   8. 保存（OAuth 認可ダイアログが出れば承認）
 *
 * 関連ファイル:
 *   - 102_HopeContextRecorder.js: enrichCaseRecord_ 本体（再利用）
 *   - 000_GeminiHelper.js: callGeminiWithKeyRotation_（5xx リトライ + maxAttempts オプション）
 *   - 000_CloudSQL接続.js: JDBC コネクション取得
 */

// =====================================================================
// 設定（マジックナンバー集約）
// =====================================================================

/**
 * 1 実行あたり処理する最大行数。
 * 各行で最大 240s の Gemini 呼出が走るため、6 分（360s）の GAS 制限内に収めるには 1 が安全だが、
 * 多くの場合 pro 1 試行で成功するため平均は数秒。バランスとして 3 を採用。
 */
var RETRY_BATCH_SIZE = 3;

/**
 * リトライ上限（Script Properties で行ごとに追跡）。
 * 上限到達後は再試行しない（永続失敗扱い、ケース記録 AI適用 はエラーテキストのまま残る）。
 */
var RETRY_MAX_ATTEMPTS = 3;

/**
 * 利用者在籍ID + 登録日時近接 JOIN の許容秒数。
 * 180s = 3 分。AppSheet Automation はトリガ後 1 分以内に動くのが通常で、
 * 同利用者で短時間に複数音声を処理する誤マッチを避けるため幅を絞る。
 * （誤マッチが起きると別の音声の文字起こしを上書きするデータ汚染リスクあり）
 */
var RETRY_JOIN_WINDOW_SEC = 180;

/**
 * 残時間チェック用。1 実行あたりの hard budget（ミリ秒）。
 * GAS の 6 分（360s）制限の 75%（270s）で打ち切ることで、未処理行が次回 trigger で
 * 拾われる猶予を残し、強制中断リスクを避ける。
 */
var RETRY_RUN_BUDGET_MS = 270000;

// =====================================================================
// メイン関数（time-driven trigger から呼ばれる）
// =====================================================================

/**
 * ケース記録 AI適用 が [AI処理 で始まる行を最大 RETRY_BATCH_SIZE 件取得し、
 * 各々を長予算で再処理して上書きする。
 *
 * GAS UI から手動実行も可能（時間主導型トリガー設定前のテスト用）。
 *
 * @returns {{success:number, fail:number, skipped:number, total:number}}
 */
function retryFailedAiEnrichments() {
  // LockService で同時実行排他（trigger と手動実行の重複・前回実行が長引いた場合の重複を防止）
  // 排他取得失敗時は今回の起動を諦める（次回 trigger で再試行）。
  // Gemini 課金倍増とデータ競合を避けるための重要保護。
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(2000)) {
    console.info('[retryWorker] skip: another instance is running');
    return { success: 0, fail: 0, skipped: 0, total: 0, lockBusy: true };
  }

  var startMs = Date.now();
  console.info('[retryWorker] start batchSize=' + RETRY_BATCH_SIZE
    + ' runBudgetMs=' + RETRY_RUN_BUDGET_MS);

  var conn = null;
  var summary = { success: 0, fail: 0, skipped: 0, total: 0 };

  try {
    conn = getCloudSqlConnection_();

    // 1) 失敗行を抽出（ケース記録 ↔ 音声記録対応 を JOIN）
    var rows = fetchFailedRowsWithSource_(conn);
    summary.total = rows.length;

    if (rows.length === 0) {
      // 候補ゼロは通常運用での日常。Cloud Logging スパム抑制のため info ではなく log で控えめに。
      console.log('[retryWorker] no candidates');
      return summary;
    }
    console.info('[retryWorker] candidates=' + rows.length);

    // 2) 各行を順次リトライ。残時間チェックで GAS 6 分制限に到達する前に打ち切る。
    for (var i = 0; i < rows.length; i++) {
      var elapsed = Date.now() - startMs;
      if (elapsed > RETRY_RUN_BUDGET_MS) {
        console.warn('[retryWorker] run budget exceeded after ' + i + ' rows '
          + '(elapsed ' + elapsed + 'ms), remaining will retry next trigger');
        break;
      }
      var row = rows[i];
      var result = retryOneRow_(conn, row);
      if (result === 'success') summary.success++;
      else if (result === 'fail') summary.fail++;
      else summary.skipped++;
    }

    console.info('[retryWorker] done success=' + summary.success
      + ' fail=' + summary.fail
      + ' skipped=' + summary.skipped
      + ' total=' + summary.total
      + ' elapsedMs=' + (Date.now() - startMs));
    return summary;
  } catch (e) {
    console.error('[retryWorker] fatal: ' + e.message);
    throw e;
  } finally {
    closeCloudSql_(conn);
    try { lock.releaseLock(); } catch (_) {}
  }
}

// =====================================================================
// 内部関数
// =====================================================================

/**
 * 失敗ケース記録 行を取得。利用者在籍ID + 登録日時近接で 音声記録対応 と JOIN する。
 * 同一ケース記録 に複数の 音声記録対応 候補がマッチした場合は最も登録日時が近いものを採用。
 *
 * 取得列: ケース記録RowID / 利用者在籍ID / 音声記録対応RowID /
 *         文字起こしテキスト / プロンプトキー / 職員在籍ID
 *
 * リトライ上限超過の行はクライアント側でフィルタ（DB に状態を持たせない方針）。
 *
 * @param {JdbcConnection} conn
 * @returns {Array<{kRowId:string, zaisekiId:string, oRowId:string, transcriptText:string, promptKey:string, staffId:string}>}
 */
function fetchFailedRowsWithSource_(conn) {
  // 失敗候補は最近のものから処理（古い失敗は手動対応に回す方針）
  // LIMIT は RETRY_BATCH_SIZE × 3 倍取得してリトライ上限済みをスキップしても batchSize に届くようにする
  var sql =
    'SELECT k."Row ID" AS k_row_id, ' +
    '       k."利用者在籍ID" AS zaiseki_id, ' +
    '       o."Row ID" AS o_row_id, ' +
    '       o."文字起こしテキスト" AS transcript_text, ' +
    '       o."AI整理_要約" AS prompt_key, ' +
    '       o."職員在籍ID" AS staff_id, ' +
    '       k."登録日時" AS k_ts, ' +
    '       o."登録日時" AS o_ts ' +
    'FROM "ケース記録" k ' +
    'JOIN "音声記録対応" o ' +
    '  ON o."利用者在籍ID" = k."利用者在籍ID" ' +
    ' AND ABS(EXTRACT(EPOCH FROM (k."登録日時" - o."登録日時"))) < ? ' +
    'WHERE k."AI適用" LIKE \'[AI処理%\' ' +
    'ORDER BY k."登録日時" DESC, ' +
    '         ABS(EXTRACT(EPOCH FROM (k."登録日時" - o."登録日時"))) ASC ' +
    'LIMIT ?';

  var stmt = null;
  var rs = null;
  var rows = [];
  var seen = {}; // ケース記録RowID 重複排除（最も近い音声記録対応 だけ採用）
  try {
    stmt = conn.prepareStatement(sql);
    stmt.setInt(1, RETRY_JOIN_WINDOW_SEC);
    stmt.setInt(2, RETRY_BATCH_SIZE * 5); // バッファ込み
    rs = stmt.executeQuery();

    var props = PropertiesService.getScriptProperties();
    while (rs.next() && rows.length < RETRY_BATCH_SIZE) {
      var kRowId = rs.getString('k_row_id');
      if (seen[kRowId]) continue;
      seen[kRowId] = true;

      // リトライ上限済みはスキップ
      var retryCountStr = props.getProperty('RETRY_' + kRowId);
      var retryCount = retryCountStr ? parseInt(retryCountStr, 10) : 0;
      if (retryCount >= RETRY_MAX_ATTEMPTS) {
        console.info('[retryWorker] skip kRowId=' + kRowId
          + ' (retryCount=' + retryCount + ' >= ' + RETRY_MAX_ATTEMPTS + ')');
        continue;
      }

      rows.push({
        kRowId:         kRowId,
        zaisekiId:      rs.getString('zaiseki_id') || '',
        oRowId:         rs.getString('o_row_id') || '',
        transcriptText: rs.getString('transcript_text') || '',
        promptKey:      rs.getString('prompt_key') || '',
        staffId:        rs.getString('staff_id') || '',
        retryCount:     retryCount
      });
    }
  } finally {
    if (rs) try { rs.close(); } catch (_) {}
    if (stmt) try { stmt.close(); } catch (_) {}
  }
  return rows;
}

/**
 * 1 行をリトライ処理する。例外は内部で握りつぶし、'success' / 'fail' / 'skipped' を返す。
 *
 * @param {JdbcConnection} conn
 * @param {object} row
 * @returns {'success'|'fail'|'skipped'}
 */
function retryOneRow_(conn, row) {
  var props = PropertiesService.getScriptProperties();
  var retryKey = 'RETRY_' + row.kRowId;

  console.info('[retryWorker] retry kRowId=' + row.kRowId
    + ' zaisekiId=' + maskId_(row.zaisekiId)
    + ' attempt=' + (row.retryCount + 1));

  // 1) AppSheet API でプロンプト本文と利用者情報を取得
  var promptText = '';
  var userInfo = { fullName: '', googleFolderUrl: '' };
  try {
    promptText = lookupPromptText_(row.promptKey);
    userInfo = lookupUserInfo_(row.zaisekiId);
  } catch (e) {
    console.warn('[retryWorker] AppSheet lookup failed kRowId=' + row.kRowId
      + ': ' + e.message);
    incrementRetryCount_(retryKey, row.retryCount);
    return 'fail';
  }

  if (!promptText || !userInfo.fullName) {
    console.warn('[retryWorker] missing prompt/userInfo kRowId=' + row.kRowId
      + ' promptLen=' + promptText.length
      + ' nameSet=' + (!!userInfo.fullName));
    incrementRetryCount_(retryKey, row.retryCount);
    return 'fail';
  }

  // 2) enrichCaseRecord_ を長予算で呼出
  var result;
  try {
    result = enrichCaseRecord_({
      transcriptText:  row.transcriptText,
      userFullName:    userInfo.fullName,
      userZaisekiId:   row.zaisekiId,
      staffPromptText: promptText,
      staffPromptKey:  row.promptKey,
      staffId:         row.staffId,
      googleFolderUrl: userInfo.googleFolderUrl,
      shortMode:       false,
      timeBudgetMs:    240000
    });
  } catch (e) {
    console.error('[retryWorker] enrichCaseRecord_ exception kRowId=' + row.kRowId
      + ': ' + e.message);
    incrementRetryCount_(retryKey, row.retryCount);
    return 'fail';
  }

  if (!result || !result.success) {
    console.warn('[retryWorker] enrich failed kRowId=' + row.kRowId
      + ' code=' + ((result && result.code) || 'unknown'));
    incrementRetryCount_(retryKey, row.retryCount);
    return 'fail';
  }

  // 3) ケース記録.AI適用 を JDBC で直接更新（[AI処理 で始まる行のみ更新する WHERE 句で同時編集レース対策）
  var updated = false;
  try {
    updated = updateCaseRecordAiKekka_(conn, row.kRowId, result.text);
  } catch (e) {
    console.error('[retryWorker] update failed kRowId=' + row.kRowId
      + ': ' + e.message);
    incrementRetryCount_(retryKey, row.retryCount);
    return 'fail';
  }

  if (updated) {
    console.info('[retryWorker] success kRowId=' + row.kRowId
      + ' charCount=' + result.charCount);
    // リトライカウンタクリア（成功した行は今後再処理対象外）
    try { props.deleteProperty(retryKey); } catch (_) {}
    return 'success';
  } else {
    // 既に他の処理（手動編集・別 trigger 等）が AI適用 を上書き済み
    console.info('[retryWorker] race kRowId=' + row.kRowId + ' (already updated)');
    try { props.deleteProperty(retryKey); } catch (_) {}
    return 'skipped';
  }
}

/**
 * Script Properties のリトライカウンタをインクリメントする。
 * RETRY_MAX_ATTEMPTS に到達した瞬間に Slack 通知を 1 回だけ送る（永続失敗の人手対応依頼）。
 *
 * @param {string} key
 * @param {number} currentCount リトライ前の現在値
 */
function incrementRetryCount_(key, currentCount) {
  var newCount = currentCount + 1;
  try {
    PropertiesService.getScriptProperties()
      .setProperty(key, String(newCount));
  } catch (e) {
    console.warn('[retryWorker] retryCount increment failed: ' + e.message);
    return;
  }
  if (newCount === RETRY_MAX_ATTEMPTS) {
    // key は "RETRY_<kRowId>" 形式。kRowId 部分のみ抜き出して通知。PII ではない。
    var kRowId = key.indexOf('RETRY_') === 0 ? key.substring(6) : key;
    try {
      sendSlackNotification('AI整理リトライ上限到達 kRowId=' + kRowId
        + '（' + RETRY_MAX_ATTEMPTS + ' 回失敗で諦めました。'
        + '手動で diagnose_clearAllRetryCounters を実行すると再開可能）');
    } catch (slackErr) {
      console.warn('[retryWorker] Slack 通知失敗: ' + slackErr.message);
    }
  }
}

/**
 * AppSheet API で AIプロンプト テーブルから プロンプト 本文を取得する。
 *
 * @param {string} promptRowId AIプロンプト テーブルの Row ID（AI整理_要約 列の値）
 * @returns {string} プロンプト本文（取得失敗・該当なしは空文字）
 */
function lookupPromptText_(promptRowId) {
  if (!promptRowId) return '';
  var props = PropertiesService.getScriptProperties();
  var appId = props.getProperty('APPSHEET_APP_ID');
  var apiKey = props.getProperty('APPSHEET_API_KEY');
  if (!appId || !apiKey) {
    throw new Error('APPSHEET_APP_ID/APPSHEET_API_KEY 未設定');
  }
  // AppSheet Selector: Filter("AIプロンプト", [Row ID] = "xxx")
  var selector = 'Filter(AIプロンプト, [Row ID] = "' + promptRowId.replace(/"/g, '') + '")';
  var rows = callAppSheetApi(appId, apiKey, 'AIプロンプト', selector) || [];
  if (rows.length === 0) return '';
  // プロンプト 列の値を返す（列名は事前設定済の前提）
  return String(rows[0]['プロンプト'] || '');
}

/**
 * AppSheet API で CustomerStatus__c から利用者氏名と GoogleURL__c を取得する。
 *
 * @param {string} zaisekiId 利用者在籍ID
 * @returns {{fullName:string, googleFolderUrl:string}}
 */
function lookupUserInfo_(zaisekiId) {
  var info = { fullName: '', googleFolderUrl: '' };
  if (!zaisekiId) return info;
  var props = PropertiesService.getScriptProperties();
  var appId = props.getProperty('APPSHEET_APP_ID');
  var apiKey = props.getProperty('APPSHEET_API_KEY');
  if (!appId || !apiKey) {
    throw new Error('APPSHEET_APP_ID/APPSHEET_API_KEY 未設定');
  }
  var selector = 'Filter(CustomerStatus__c, [Id] = "' + zaisekiId.replace(/"/g, '') + '")';
  var rows = callAppSheetApi(appId, apiKey, 'CustomerStatus__c', selector) || [];
  if (rows.length === 0) return info;
  var row = rows[0];
  info.fullName = String(row['CustomerName__c'] || '');
  info.googleFolderUrl = String(row['GoogleURL__c'] || '');
  return info;
}

/**
 * ケース記録.AI適用 列を JDBC で直接更新する。
 * WHERE 句で AI適用 LIKE '[AI処理%' を強制し、既に正常テキストになっている行は絶対に上書きしない。
 *
 * @param {JdbcConnection} conn
 * @param {string} kRowId ケース記録 Row ID
 * @param {string} newText 新しい AI適用 値
 * @returns {boolean} true = 更新成功（1 行更新）, false = 更新行なし（既に他処理で上書き済み）
 */
function updateCaseRecordAiKekka_(conn, kRowId, newText) {
  // 注意: 更新日時 列は触らない。AppSheet Automation のトリガに「ケース記録 列変更」が
  //       含まれていた場合、更新日時 を変えると再発火 → 短予算 Call a script が再失敗 →
  //       本ワーカーが拾う、という無限ループになりうる。AI適用 列のみ更新する。
  var stmt = null;
  try {
    stmt = conn.prepareStatement(
      'UPDATE "ケース記録" SET "AI適用" = ? ' +
      'WHERE "Row ID" = ? AND "AI適用" LIKE \'[AI処理%\''
    );
    stmt.setString(1, newText);
    stmt.setString(2, kRowId);
    var n = stmt.executeUpdate();
    return n > 0;
  } finally {
    if (stmt) try { stmt.close(); } catch (_) {}
  }
}

// =====================================================================
// 診断・テスト関数（GAS UI から手動実行用）
// =====================================================================

/**
 * 失敗ケース記録 の候補数だけ表示（実際のリトライは行わない）。
 * トリガー設定前の動作確認用。
 */
function diagnose_listFailedAiEnrichments() {
  var conn = getCloudSqlConnection_();
  try {
    var rows = fetchFailedRowsWithSource_(conn);
    Logger.log('===== diagnose_listFailedAiEnrichments =====');
    Logger.log('候補件数: ' + rows.length);
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      Logger.log('  ' + (i + 1) + '. kRowId=' + r.kRowId
        + ' zaisekiId=' + maskId_(r.zaisekiId)
        + ' oRowId=' + r.oRowId
        + ' promptKey=' + r.promptKey
        + ' transcriptLen=' + r.transcriptText.length
        + ' retryCount=' + r.retryCount);
    }
  } finally {
    closeCloudSql_(conn);
  }
}

/**
 * Script Properties に積もったリトライカウンタを表示する。
 * デバッグ・運用監視用。
 */
function diagnose_listRetryCounters() {
  var props = PropertiesService.getScriptProperties().getProperties();
  Logger.log('===== diagnose_listRetryCounters =====');
  var found = 0;
  Object.keys(props).forEach(function(k) {
    if (k.indexOf('RETRY_') === 0) {
      Logger.log('  ' + k + ' = ' + props[k]);
      found++;
    }
  });
  Logger.log('total: ' + found);
}

/**
 * 全リトライカウンタを削除する。リトライ上限を超えた行を再開させたい場合の手動実行用。
 * 慎重に使うこと。
 */
function diagnose_clearAllRetryCounters() {
  var props = PropertiesService.getScriptProperties();
  var allProps = props.getProperties();
  var deleted = 0;
  Object.keys(allProps).forEach(function(k) {
    if (k.indexOf('RETRY_') === 0) {
      props.deleteProperty(k);
      deleted++;
    }
  });
  Logger.log('cleared ' + deleted + ' retry counters');
}
