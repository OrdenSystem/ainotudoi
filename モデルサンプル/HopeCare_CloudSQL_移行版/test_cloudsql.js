/**
 * [RETIRED] CloudSQL書き込みテスト用関数
 *
 * ============================================================
 *  退役日: 2026-04-23
 * ============================================================
 * CloudSQL 接続テスト・書き込みテスト（test_CloudSQL_Connection,
 * test_CloudSQL_Write 等）は開発時の動作確認用であり、運用移行後は
 * 不要のため、本スクリプトの中身は退避しました。
 *
 * 元のコードは GAS のバージョン履歴から復元可能です。
 *   Version 1: "Before stage1 cleanup - remove migration and test scripts"
 *
 * 一定期間運用に問題がなければ、将来的に本ファイル自体を完全削除予定。
 */

function _checkHyohyoTable(){
  var c=getCloudSqlConnection_();
  var s=c.prepareStatement(
    "SELECT column_name FROM information_schema.columns WHERE table_name='帳票マスタ複製登録' ORDER BY ordinal_position");
  var r=s.executeQuery();
  while(r.next()) Logger.log(r.getString(1));
  closeCloudSql_(c,s,r);
}

function _checkSpushiUrlRaw(){
  var c=getCloudSqlConnection_();
  var s=c.prepareStatement(
    'SELECT "帳票マスタ複製登録ID","スプシURL" FROM "帳票マスタ複製登録" ' +
    'WHERE "スプシURL" IS NOT NULL AND "スプシURL" <> \'\' LIMIT 3');
  var r=s.executeQuery();
  while(r.next()) Logger.log(r.getString("帳票マスタ複製登録ID")+" => "+r.getString("スプシURL"));
  closeCloudSql_(c,s,r);
}
