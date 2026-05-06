#!/usr/bin/env node
// addCallProcessStep / addReturnStep / addWaitStep を dry-run + apply で検証。
// 検証用アプリ: 介護カルテシステム-995205666

import { config as loadEnv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
loadEnv({ path: path.join(repoRoot, ".env") });

const { addCallProcessStep, addReturnStep, addWaitStep } = await import("../dist/tools/edit.js");

const APPLY = process.argv.includes("--apply");

const COMMON = {
  appId: "95eed509-b59f-4697-b1f1-fc545328fac6",
  appName: "介護カルテシステム-995205666",
  apply: APPLY,
};

const PROCESS = "Process for テスト_異常検知Bot";

// 検証アプリ整理後 Process が 1 個しかないため、CallProcess は self-call で
// payload 受理性のみ確認 (実運用では別 Process を target にする)
const tests = [
  {
    label: "callProcess",
    fn: addCallProcessStep,
    args: {
      ...COMMON,
      processName: PROCESS,
      stepName: APPLY ? "mcp_call_apply" : "mcp_call_dry",
      targetProcessName: PROCESS,
    },
  },
  {
    label: "return",
    fn: addReturnStep,
    args: {
      ...COMMON,
      processName: PROCESS,
      stepName: APPLY ? "mcp_return_apply" : "mcp_return_dry",
      returnValues: [{ name: "result", value: '"ok"' }],
    },
  },
  {
    label: "waitForPeriod",
    fn: addWaitStep,
    args: {
      ...COMMON,
      processName: PROCESS,
      stepName: APPLY ? "mcp_wait_apply" : "mcp_wait_dry",
      waitNodeType: "WaitForPeriod",
      period: "0:01:00",
    },
  },
];

console.log(`Mode: ${APPLY ? "APPLY (real saveapp)" : "DRY-RUN"}`);
let pass = 0, fail = 0;
for (const t of tests) {
  try {
    const r = await t.fn(t.args);
    const mark = APPLY ? (r.applied ? "✅" : "⚠️") : "✅";
    console.log(`${mark} ${t.label}: dryRun=${r.dryRun} applied=${r.applied ?? false} step='${r.stepName}' componentId=${r.componentId ?? "-"}`);
    (APPLY ? r.applied : r.dryRun) ? pass++ : fail++;
  } catch (e) {
    console.log(`❌ ${t.label}:`, e instanceof Error ? e.message : String(e));
    fail++;
  }
}
console.log(`\n=== ${pass}/${tests.length} pass, ${fail} fail ===`);
process.exit(fail === 0 ? 0 : 1);
