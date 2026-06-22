const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

const dir = 'C:/dev/ainotudoi/Excelマスタ';
const outPath = 'C:/tmp/litalico-blocks.json';

const files = fs.readdirSync(dir).filter(f => f.endsWith('.xls'));
const out = {};

for (const f of files) {
  const wb = XLSX.readFile(path.join(dir, f));
  const sn = wb.SheetNames[0];
  const ws = wb.Sheets[sn];
  const json = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });

  const labels = json.map(r => (r[0] === null ? '' : String(r[0])));
  const labelOccurrences = {};
  labels.forEach((l, i) => {
    if (!l) return;
    if (!labelOccurrences[l]) labelOccurrences[l] = [];
    labelOccurrences[l].push(i + 1);
  });

  const keyLabel = '氏名';
  const keyRows = labelOccurrences[keyLabel] || [];
  const blockGaps = [];
  for (let i = 1; i < keyRows.length; i++) blockGaps.push(keyRows[i] - keyRows[i - 1]);

  const firstBlockStart = keyRows[0] || -1;
  const firstBlockEnd = keyRows[1] ? keyRows[1] - 1 : Math.min(firstBlockStart + 80, json.length);

  const firstBlock = [];
  for (let r = firstBlockStart - 1; r < firstBlockEnd && r < json.length; r++) {
    const row = json[r] || [];
    const cells = row.map(v => (v === null ? '' : String(v).slice(0, 60)));
    firstBlock.push({ row: r + 1, cells });
  }

  out[f] = {
    sheet: sn,
    rows: json.length,
    cols: json.length > 0 ? Math.max(...json.map(r => r.length)) : 0,
    氏名_行番号一覧: keyRows.slice(0, 6),
    ブロック間隔: blockGaps.slice(0, 5),
    最初の利用者ブロック: firstBlock,
    特徴的なラベル件数: {
      氏名: (labelOccurrences['氏名'] || []).length,
      受給者証番号: (labelOccurrences['受給者証番号'] || []).length,
      上限額管理事業所番号: (labelOccurrences['上限額管理事業所番号'] || []).length,
      日数: (labelOccurrences['日数'] || []).length,
    },
  };
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));

console.log('done:', outPath);
for (const f of files) {
  const o = out[f];
  console.log(`\n${f}:`);
  console.log(`  シート: ${o.sheet}, ${o.rows} 行 × ${o.cols} 列`);
  console.log(`  「氏名」出現行: ${o.氏名_行番号一覧.join(', ')}`);
  console.log(`  ブロック間隔: ${o.ブロック間隔.join(', ')}`);
  console.log(`  利用者数（推定）: ${o.特徴的なラベル件数.氏名}`);
  console.log(`  受給者証番号 件数: ${o.特徴的なラベル件数.受給者証番号}`);
}
