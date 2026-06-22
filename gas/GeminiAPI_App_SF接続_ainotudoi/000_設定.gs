//和暦取得スプシから取得しておく（Script Property "WAREKI_SS_ID" から取得、000_AppConfig.js 参照）
const SPREADSHEET_ID_WAREKI = getConfigId_("WAREKI_SS_ID");
const ss_wareki = SpreadsheetApp.openById(SPREADSHEET_ID_WAREKI);
const sheet_wareki = ss_wareki.getSheetByName("和暦API取得");
const yearValues = sheet_wareki.getRange("H3:I9").getValues();
