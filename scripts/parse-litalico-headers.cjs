const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

const dir = 'C:/dev/ainotudoi/Excelマスタ';
const outPath = 'C:/tmp/litalico-headers.json';

const files = fs.readdirSync(dir).filter(f => f.endsWith('.xls'));
const out = {};

for (const f of files) {
  const wb = XLSX.readFile(path.join(dir, f));
  out[f] = wb.SheetNames.map(sn => {
    const ws = wb.Sheets[sn];
    const json = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
    const stripRow = (row) => row.map(v => v === null ? '' : String(v).slice(0, 80));
    return {
      sheet: sn,
      rows: json.length,
      cols: json.length > 0 ? Math.max(...json.map(r => r.length)) : 0,
      facility_section_rows_28_60: json.slice(28, 60).map((r, i) => ({ row: 29 + i, cells: stripRow(r) })),
      potential_user_header_rows: json.slice(60, 110).map((r, i) => ({ row: 61 + i, cells: stripRow(r) })),
    };
  });
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log('done:', outPath);
