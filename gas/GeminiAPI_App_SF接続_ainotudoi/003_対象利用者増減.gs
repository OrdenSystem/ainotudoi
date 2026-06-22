// ==========================================
// 加算処理（元のまま）
// ==========================================
function AddKasanCoding(imputURL, targetPair) {
  if (!imputURL) {
    const errMsg =
      "【エラー】imputURLが空白または未定義です。スプレッドシートを開けないため処理を終了します。";
    console.error(errMsg);
    return;
  }

  let targetArray = [];
  if (!targetPair) {
    console.warn(
      "【警告】targetPairが空白または未定義です。対象の受給者証番号なし（全て一致しない）として処理を続行します。",
    );
  } else {
    try {
      targetArray = String(targetPair)
        .split(",")
        .map((item) => item.trim());
    } catch (e) {
      const errMsg =
        "【エラー】targetPairの変換に失敗しました。処理を終了します。詳細: " +
        e.message;
      console.error(errMsg);
      return;
    }
  }

  let ss;
  try {
    ss = SpreadsheetApp.openByUrl(imputURL);
  } catch (e) {
    const errMsg =
      "【エラー】スプレッドシートを開けませんでした。URL: " +
      imputURL +
      " / 詳細: " +
      e.message;
    console.error(errMsg);
    return;
  }

  const sheet = ss.getSheets()[0];
  const lastRow = sheet.getLastRow();

  if (lastRow < 1) {
    console.warn(
      "【警告】対象のシートにデータが存在しません。処理を終了します。",
    );
    return;
  }

  try {
    const data = sheet.getRange(1, 1, lastRow, 2).getValues();

    let currentIdNumber = "";
    let cellsToClear = [];

    for (let i = 0; i < data.length; i++) {
      const cellA = data[i][0] ? String(data[i][0]) : "";

      if (cellA.includes("受給者証番号")) {
        currentIdNumber = data[i][1] ? String(data[i][1]).trim() : "";
      }

      if (cellA.includes("特別地域加算")) {
        if (currentIdNumber !== "") {
          const isMatched = targetArray.includes(currentIdNumber);

          if (!isMatched) {
            const rowNumber = i + 1;
            cellsToClear.push("B" + rowNumber);
          }
        } else {
          console.warn(
            `【警告】${i + 1}行目の特別地域加算に対して、受給者証番号が見つかりませんでした。`,
          );
        }

        currentIdNumber = "";
      }
    }

    if (cellsToClear.length > 0) {
      sheet.getRangeList(cellsToClear).clearContent();
    }

    console.log(
      "【成功】処理が正常に完了しました。消去対象: " +
        cellsToClear.length +
        "件",
    );

    return "Success";
  } catch (e) {
    const errMsg =
      "【エラー】データの処理中、またはシートへの書き込み中にエラーが発生しました。詳細: " +
      e.message;
    console.error(errMsg);
  }
}
