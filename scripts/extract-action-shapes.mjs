#!/usr/bin/env node
// 本番 snapshot から ActionType 別に最小サンプルを抽出。
// 新ツール実装時の payload 仕様根拠として使う。

import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const APPS = [
  "aa5925f1-be2d-4cac-97f8-1e5fe55f9526",  // 歯科
  "cb7c927c-be45-4fc6-8d6f-38689dfc9331",  // HopeCareDX
];

const TARGET_TYPES = [
  "NAVIGATE_APP",
  "EMAIL",
  "CALL",
  "SMS",
  "OPEN_FILE",
  "EXPORT_VIEW",
  "COPY_EDIT_ROW",
  "NAVIGATE_DIFFERENT_APP",
  "NAVIGATE_URL",  // 既存ツールの参照用
  "IMPORT_FILE",
];

const outDir = "samples/action-shapes";
await mkdir(outDir, { recursive: true });

const summary = {};
for (const appId of APPS) {
  const p = `snapshots/appdef-${appId}.json`;
  const app = JSON.parse(await readFile(p, "utf8"));
  const actions = app.AppData?.DataActions ?? [];
  for (const a of actions) {
    const t = a.ActionType;
    if (!TARGET_TYPES.includes(t)) continue;
    if (!summary[t]) summary[t] = [];
    if (summary[t].length >= 3) continue;
    // 不要キーを除いて最小化
    const clean = JSON.parse(JSON.stringify(a));
    ["ExprLookup", "ConditionEvaluatable", "ValueEvaluatable", "ComponentId", "_index", "_path", "_version", "_isNew"].forEach((k) => delete clean[k]);
    summary[t].push({ from: appId.slice(0, 8), action: clean });
  }
}

const summaryPath = path.join(outDir, "by-action-type.json");
await writeFile(summaryPath, JSON.stringify(summary, null, 2), "utf8");
console.log("Saved:", summaryPath);
for (const [t, samples] of Object.entries(summary)) {
  console.log(`  ${t}: ${samples.length} samples`);
}
