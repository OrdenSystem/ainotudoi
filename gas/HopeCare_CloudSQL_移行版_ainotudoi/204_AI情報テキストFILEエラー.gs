function checkErrorsAndNotifySlack() {
  try {
    console.log("処理を開始します...");

    const ss = SpreadsheetApp.openById(QUEUE_SPREADSHEET_ID);
    const sheet = ss.getSheetByName(QUEUE_SHEET_NAME);

    if (!sheet) {
      throw new Error(
        `シート「${QUEUE_SHEET_NAME}」が見つかりません。名前が正しいか確認してください。`,
      );
    }

    const data = sheet.getDataRange().getValues();
    console.log(`取得データ数: ${data.length}行`);

    if (data.length <= 1) {
      console.log("チェック対象のデータがありません。");
      return;
    }

    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      const targetId = row[0]; // A列
      const status = row[1]; // B列
      const createdAt = row[2]; // C列
      const updatedAt = row[3]; // D列
      const memo = row[4]; // E列
      const queueId = row[5]; // F列

      if (!targetId) continue;

      // 条件判定: ERROR/FAILEDのみ通知（PENDING/PROCESSING/RETRY等は対象外）
      if (status === "ERROR" || status === "FAILED") {
        const rowNumber = i + 1;
        console.log(`【エラー検知】行番号: ${rowNumber}`);

        const messageText =
          `⚠️ *204_AI情報テキストFILEエラー検知*\n` +
          `*${rowNumber}行目* で異常を検知しました。\n` +
          `• *queueId:* ${queueId}\n` +
          `• *targetId:* ${targetId}\n` +
          `• *status:* ${status}\n` +
          `• *memo:* ${memo}`;

        sendSlackNotification(messageText);
      }
    }

    console.log("すべてのチェックが正常に完了しました。");
  } catch (e) {
    // スクリプト自体がエラーで落ちた場合にここを通ります
    const systemErrorMessage =
      `🚨 *GAS実行システムエラー（204_AI情報テキストFILEトリガー失敗）*\n` +
      `スクリプトの実行中に致命的なエラーが発生しました。\n` +
      `• *エラー内容:* ${e.message}\n` +
      `• *発生箇所:* ${e.stack.split("\n")[0]}`;

    console.error("システムエラーを検知しました: " + e.message);
    sendSlackNotification(systemErrorMessage);
  }
}

function diagnoseAccessError() {
  // 検証したいスプレッドシートのID（Script Property "QUEUE_SS_ID" から取得）
  const TEST_SPREADSHEET_ID = getConfigId_("QUEUE_SS_ID");
  console.log("🔍 【アクセス権限・ID検証】を開始します...");

  // 1. IDの形式チェック（よくあるミスを事前検知）
  if (!TEST_SPREADSHEET_ID || TEST_SPREADSHEET_ID.trim() === "") {
    console.error("❌ 【診断】IDが空になっています。");
    return;
  }
  if (
    TEST_SPREADSHEET_ID.includes("/") ||
    TEST_SPREADSHEET_ID.includes("https")
  ) {
    console.error(
      "❌ 【診断】IDにURLが含まれています。URL全体ではなく、ID部分のみを抽出してください。",
    );
    return;
  }
  if (TEST_SPREADSHEET_ID.includes(" ")) {
    console.error(
      "❌ 【診断】IDに不要な空白が含まれています。前後のスペースを削除してください。",
    );
    return;
  }

  // 2. 実際にアクセスを試みる
  try {
    console.log(
      `📄 ID: ${TEST_SPREADSHEET_ID} のファイルへアクセスを試みます...`,
    );

    // ここでアクセスできるかテストします
    const ss = SpreadsheetApp.openById(TEST_SPREADSHEET_ID);

    // アクセス成功時
    console.log(`✅ 【診断結果: 成功】アクセスできました！`);
    console.log(`シート名: 「${ss.getName()}」`);
    console.log(
      "💡 現在のエラーは解消されています。もし本番コードでエラーが出る場合は、本番コード側のIDのコピペミスなどを確認してください。",
    );
  } catch (e) {
    // アクセス失敗時
    console.error(`❌ 【診断結果: 失敗】エラーが発生しました: ${e.message}`);

    if (e.message.includes("No item with the given ID could be found")) {
      console.log("--------------------------------------------------");
      console.log("💡 【結論】以下のいずれかが原因です。");
      console.log(
        `原因A: ID「${TEST_SPREADSHEET_ID}」が間違っている（削除された、または1文字欠けている等）。`,
      );
      console.log(
        `原因B: 今GASを開いているGoogleアカウントに、このシートを開く権限がない。`,
      );
      console.log("--------------------------------------------------");
      console.log("🛠️ 【解決策】");
      console.log(
        "1. GASエディタの右上にあるプロフィールアイコンを見て、どのアカウントで作業しているか確認する。",
      );
      console.log(
        "2. 対象のスプレッドシートの「共有」設定から、そのアカウントに閲覧・編集権限を付与する。",
      );
    } else {
      console.log(
        "💡 予期せぬ別のエラーです。Googleのサーバー障害などの可能性があります。",
      );
    }
  }
}
