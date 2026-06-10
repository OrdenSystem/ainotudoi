/**
 * 前月の加算項目レコードを今月分として複製する
 * @param {string} seikyuID - 新しく作成された請求情報ID
 * @param {string} yyyymmCategory - 今回の「提供年月_種別」（例: 202512_計画相談支援）
 * @param {string} appSSdbURL - データベースのスプレッドシートURL
 */
function AddRecordCopyYYYYMM(seikyuID, yyyymmCategory, appSSdbURL) {
  try {
    const ss = SpreadsheetApp.openByUrl(appSSdbURL);
    const sheet = ss.getSheetByName("事業所加算項目DB");
    if (!sheet) throw new Error("シート「事業所加算項目DB」が見つかりません。");

    const data = sheet.getDataRange().getValues();
    const header = data[0];
    
    // 列インデックスの取得
    const colIdx_ID = header.indexOf("事業所加算項目ID"); // A列
    const colIdx_seikyuID = header.indexOf("請求情報ID");   // B列
    const colIdx_yyyymmCat = header.indexOf("提供年月_種別"); // D列
    
    if (colIdx_seikyuID === -1 || colIdx_yyyymmCat === -1) {
      throw new Error("必要なヘッダー項目が見つかりません。");
    }

    // 1. 前月分の yyyymmCategory 文字列を生成
    const prevYyyymmCategory = getPreviousMonthCategory(yyyymmCategory);
    console.log("検索キーワード（前月）: " + prevYyyymmCategory);

    // 2. 前月分に一致するレコードを抽出
    const recordsToCopy = data.filter(row => String(row[colIdx_yyyymmCat]) === prevYyyymmCategory);

    if (recordsToCopy.length === 0) {
      return "前月分のデータが見つかりませんでした (" + prevYyyymmCategory + ")";
    }

    // 3. 複製用データの作成
    const now = new Date();
    const newRows = recordsToCopy.map(row => {
      const newRow = [...row]; // 元の行データをコピー
      
      // A列: ユニークな16桁のランダム英数字を生成
      newRow[colIdx_ID] = generateRandomId(16);
      
      // B列: 新しい請求情報IDをセット
      newRow[colIdx_seikyuID] = seikyuID;
      
      // D列: 今回の提供年月_種別をセット
      newRow[colIdx_yyyymmCat] = yyyymmCategory;
      
      // G列(登録日時)・H列(更新日時)がある場合、現在時刻にリセット
      if (header.indexOf("登録日時") !== -1) newRow[header.indexOf("登録日時")] = now;
      if (header.indexOf("更新日時") !== -1) newRow[header.indexOf("更新日時")] = now;

      return newRow;
    });

    // 4. シートの末尾に追加
    sheet.getRange(sheet.getLastRow() + 1, 1, newRows.length, newRows[0].length).setValues(newRows);

    return "Success: " + newRows.length + " items copied.";

  } catch (e) {
    console.error("エラー: " + e.message);
    return "Error: " + e.message;
  }
}


/**
 * 前月の文字列を生成（例：202512_計画相談支援 -> 202511_計画相談支援）
 */
function getPreviousMonthCategory(currentStr) {
  const parts = currentStr.split("_");
  const yyyymm = parts[0]; 
  const category = parts[1] || ""; 

  const year = parseInt(yyyymm.substring(0, 4), 10);
  const month = parseInt(yyyymm.substring(4, 6), 10);

  const date = new Date(year, month - 2, 1); 
  const prevYear = date.getFullYear();
  const prevMonth = ("0" + (date.getMonth() + 1)).slice(-2);

  return prevYear + prevMonth + (category ? "_" + category : "");
}