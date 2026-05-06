#!/usr/bin/env node
// addDataActionStep を 5 サブタイプ × dry-run で直接呼んでロジック検証。
// 検証用アプリ: 介護カルテシステム-995205666 (App ID 95eed509-b59f-4697-b1f1-fc545328fac6)

import { config as loadEnv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
loadEnv({ path: path.join(repoRoot, ".env") });

const { addDataActionStep } = await import("../dist/tools/edit.js");

const COMMON = {
  appId: "95eed509-b59f-4697-b1f1-fc545328fac6",
  appName: "介護カルテシステム-995205666",
  processName: "Process for テスト_異常検知Bot",
  tableName: "バイタル記録",
};

const cases = [
  {
    label: "addRow",
    args: {
      ...COMMON,
      stepName: "smoke_addRow",
      subtype: "addRow",
      referencedTable: "バイタル記録",
      assignments: [{ column: "バイタルID", value: "1" }],
    },
  },
  {
    label: "deleteRow",
    args: {
      ...COMMON,
      stepName: "smoke_deleteRow",
      subtype: "deleteRow",
    },
  },
  {
    label: "setColumn",
    args: {
      ...COMMON,
      stepName: "smoke_setColumn",
      subtype: "setColumn",
      columnToEdit: "異常フラグ",
      newColumnValue: "TRUE",
    },
  },
  {
    label: "refAction",
    args: {
      ...COMMON,
      stepName: "smoke_refAction",
      subtype: "refAction",
      referencedTable: "バイタル記録",
      referencedRows: "バイタル記録[利用者ID]",
      referencedAction: "Delete",
    },
  },
  {
    label: "composite",
    args: {
      ...COMMON,
      stepName: "smoke_composite",
      subtype: "composite",
      actions: ["Delete"],
    },
  },
];

let pass = 0, fail = 0;
for (const c of cases) {
  try {
    const r = await addDataActionStep({ ...c.args, apply: false });
    console.log(`✅ ${c.label}: dryRun=${r.dryRun} actionName='${r.actionName}'`);
    pass++;
  } catch (e) {
    console.log(`❌ ${c.label}:`, e instanceof Error ? e.message : String(e));
    fail++;
  }
}

console.log(`\n=== ${pass}/${cases.length} pass, ${fail} fail ===`);
process.exit(fail === 0 ? 0 : 1);
