#!/usr/bin/env node
// 8 つの UI Action ツールを検証アプリ (介護カルテシステム) で smoke test。
// view が無いので linkToView は navigateTarget で直接式指定。

import { config as loadEnv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
loadEnv({ path: path.join(repoRoot, ".env") });

const m = await import("../dist/tools/edit.js");
const APPLY = process.argv.includes("--apply");

const COMMON = {
  appId: "95eed509-b59f-4697-b1f1-fc545328fac6",
  appName: "介護カルテシステム-995205666",
  tableName: "バイタル記録",
  apply: APPLY,
};

const suffix = APPLY ? "_apply" : "_dry";

const tests = [
  {
    label: "linkToView",
    fn: m.addLinkToViewAction,
    args: { ...COMMON, actionName: `mcp_link${suffix}`, navigateTarget: '=LINKTOVIEW("dummy_view")' },
  },
  {
    label: "email",
    fn: m.addEmailAction,
    args: { ...COMMON, actionName: `mcp_email${suffix}`, emailTo: "[記録者メール]", subject: "異常検知通知" },
  },
  {
    label: "call",
    fn: m.addCallAction,
    args: { ...COMMON, actionName: `mcp_call${suffix}`, number: "[備考]" },
  },
  {
    label: "sms",
    fn: m.addSmsAction,
    args: { ...COMMON, actionName: `mcp_sms${suffix}`, number: "[備考]", message: "確認お願いします" },
  },
  {
    label: "openFile",
    fn: m.addOpenFileAction,
    args: { ...COMMON, actionName: `mcp_openfile${suffix}`, fileTarget: "[備考]" },
  },
  {
    label: "exportView",
    fn: m.addExportViewAction,
    args: { ...COMMON, actionName: `mcp_export${suffix}` },
  },
  {
    label: "copyEdit",
    fn: m.addCopyEditAction,
    args: { ...COMMON, actionName: `mcp_copyedit${suffix}` },
  },
  {
    label: "navigateDifferentApp",
    fn: m.addNavigateDifferentAppAction,
    args: { ...COMMON, actionName: `mcp_navdiff${suffix}`, targetAppName: "介護カルテシステム-995205666" },
  },
];

console.log(`Mode: ${APPLY ? "APPLY (real saveapp)" : "DRY-RUN"}`);
let pass = 0, fail = 0;
for (const t of tests) {
  try {
    const r = await t.fn(t.args);
    const mark = APPLY ? (r.applied ? "OK" : "WARN") : "OK";
    console.log(`[${mark}] ${t.label}: dryRun=${r.dryRun} applied=${r.applied ?? false} actionName='${r.actionName}' componentId=${r.componentId ?? "-"}`);
    (APPLY ? r.applied : r.dryRun) ? pass++ : fail++;
  } catch (e) {
    console.log(`[FAIL] ${t.label}:`, e instanceof Error ? e.message : String(e));
    fail++;
  }
}
console.log(`\n=== ${pass}/${tests.length} pass, ${fail} fail ===`);
process.exit(fail === 0 ? 0 : 1);
