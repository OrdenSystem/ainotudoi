const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

const dir = 'C:/dev/ainotudoi/Excelマスタ';
const files = fs.readdirSync(dir).filter(f => f.endsWith('.xls'));
const out = {};

for (const f of files) {
  const wb = XLSX.readFile(path.join(dir, f));
  const sn = wb.SheetNames[0];
  const ws = wb.Sheets[sn];
  const json = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
  const stripRow = (row) => row ? row.map(v => v === null ? '' : String(v).slice(0, 60)) : [];

  let dailyHeaderRow = -1;
  for (let i = 30; i < Math.min(json.length, 200); i++) {
    const r = json[i] || [];
    const a = (r[0] || '').toString();
    const b = (r[1] || '').toString();
    if (a === '日' && b === '曜日') {
      dailyHeaderRow = i;
      break;
    }
  }

  out[f] = {
    sheet: sn,
    totalRows: json.length,
    dailyHeaderRow: dailyHeaderRow !== -1 ? dailyHeaderRow + 1 : null,
    dailyHeader: dailyHeaderRow !== -1 ? stripRow(json[dailyHeaderRow]) : null,
    sampleDailyRows: dailyHeaderRow !== -1 ? json.slice(dailyHeaderRow + 1, dailyHeaderRow + 5).map(stripRow) : null,
    rowsBeforeDailyHeader: dailyHeaderRow !== -1 ? json.slice(Math.max(0, dailyHeaderRow - 3), dailyHeaderRow).map((r, i) => ({ row: dailyHeaderRow - 3 + i + 1, cells: stripRow(r) })) : null,
  };
}

fs.writeFileSync('C:/tmp/litalico-daily.json', JSON.stringify(out, null, 2));
console.log('done');
for (const f of files) {
  const o = out[f];
  console.log(`\n=== ${f} ===`);
  console.log(`  daily header row: ${o.dailyHeaderRow} / total ${o.totalRows}`);
  if (o.dailyHeader) {
    console.log(`  header cells: ${o.dailyHeader.filter(x => x).join(' | ')}`);
  }
}
