/**
 * リタリコ Excel 5 枚の利用者ブロック完全抽出
 * - 利用者属性セクション（A列ラベルが続く範囲）の全行
 * - 日次データヘッダ行の完全列リスト
 */
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

const dir = 'C:/dev/ainotudoi/Excelマスタ';
const out = {};
const files = fs.readdirSync(dir).filter(f => f.endsWith('.xls'));

for (const f of files) {
  const wb = XLSX.readFile(path.join(dir, f));
  const sn = wb.SheetNames[0];
  const ws = wb.Sheets[sn];
  const json = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });

  // Find daily header row (日, 曜日)
  let dailyHeaderRow = -1;
  for (let i = 30; i < Math.min(json.length, 200); i++) {
    const r = json[i] || [];
    if ((r[0] || '') === '日' && (r[1] || '') === '曜日') {
      dailyHeaderRow = i;
      break;
    }
  }

  // Find "利用者情報" anchor row (E column = "利用者情報")
  let userInfoAnchor = -1;
  for (let i = 25; i < Math.min(json.length, 100); i++) {
    const r = json[i] || [];
    for (let c = 0; c < r.length; c++) {
      if ((r[c] || '').toString().includes('利用者情報')) {
        userInfoAnchor = i;
        break;
      }
    }
    if (userInfoAnchor !== -1) break;
  }

  // Extract all rows between userInfoAnchor and dailyHeaderRow as user attributes
  const userAttrs = [];
  if (userInfoAnchor !== -1 && dailyHeaderRow !== -1) {
    for (let i = userInfoAnchor; i < dailyHeaderRow; i++) {
      const r = json[i] || [];
      const label = (r[0] || '').toString();
      const value = (r[1] || '').toString().slice(0, 80);
      if (label) {
        userAttrs.push({ row: i + 1, label, sample: value });
      }
    }
  }

  // Daily header row full columns
  const dailyHeader = dailyHeaderRow !== -1
    ? (json[dailyHeaderRow] || []).map(v => v === null ? '' : String(v).slice(0, 40))
    : null;

  out[f] = {
    sheet: sn,
    totalRows: json.length,
    userInfoAnchorRow: userInfoAnchor !== -1 ? userInfoAnchor + 1 : null,
    dailyHeaderRow: dailyHeaderRow !== -1 ? dailyHeaderRow + 1 : null,
    dailyHeaderColumns: dailyHeader,
    dailyHeaderColCount: dailyHeader ? dailyHeader.filter(x => x).length : 0,
    userAttributeRows: userAttrs,
  };
}

fs.writeFileSync('C:/tmp/litalico-userblock.json', JSON.stringify(out, null, 2));
console.log('Saved: C:/tmp/litalico-userblock.json');

for (const f of files) {
  const o = out[f];
  console.log(`\n=== ${f} ===`);
  console.log(`  daily header row: ${o.dailyHeaderRow} (cols: ${o.dailyHeaderColCount})`);
  console.log(`  daily header: ${(o.dailyHeaderColumns || []).filter(x => x).join(' | ')}`);
  console.log(`  user attrs (${o.userAttributeRows.length}):`);
  o.userAttributeRows.forEach(a => {
    console.log(`    [${a.row}] ${a.label} = ${a.sample || '(empty)'}`);
  });
}
