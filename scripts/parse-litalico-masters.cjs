const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

const dir = 'C:/dev/ainotudoi/Excelマスタ';
const outPath = 'C:/tmp/litalico-masters.json';

const files = fs.readdirSync(dir).filter(f => f.endsWith('.xls'));
const out = {};

for (const f of files) {
  const wb = XLSX.readFile(path.join(dir, f));
  out[f] = wb.SheetNames.map(sn => {
    const ws = wb.Sheets[sn];
    const json = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
    const ref = ws['!ref'] || null;
    return {
      sheet: sn,
      ref,
      rows: json.length,
      cols: json.length > 0 ? Math.max(...json.map(r => r.length)) : 0,
      sample: json.slice(0, 25),
    };
  });
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log('done:', outPath);
console.log('files:', files.length);
for (const f of files) {
  console.log(`  ${f}: ${out[f].length} sheets, ${out[f].map(s => s.sheet + '(' + s.rows + 'r/' + s.cols + 'c)').join(', ')}`);
}
