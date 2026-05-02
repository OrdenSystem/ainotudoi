// Phase 5 で追加した 8 ツールの dry-run 検証スクリプト
// 使い方: node -r dotenv/config scripts/test-phase5.mjs
// 全て apply: false（dry-run）なので AppSheet 側に書込みは発生しない。
// loadApp は呼ばれるので Cookie 認証が通るかどうかは検証される。

import {
  setSecurityFilter,
  promoteToRef,
  addOpenUrlAction,
  createBot,
  addSlice,
  removeSlice,
  addCallScriptTask,
  createTable,
} from "../dist/tools/edit.js";

const ok = (s) => `\x1b[32m${s}\x1b[0m`;
const ng = (s) => `\x1b[31m${s}\x1b[0m`;
const dim = (s) => `\x1b[90m${s}\x1b[0m`;

async function run(name, fn) {
  console.log(`\n=== ${name} ===`);
  try {
    const result = await fn();
    console.log(ok("✅ OK"));
    console.log(dim(JSON.stringify(result, null, 2).slice(0, 600)));
    return { name, ok: true };
  } catch (e) {
    console.log(ng("❌ ERROR: " + (e.message || e)));
    return { name, ok: false, error: e.message };
  }
}

const summary = [];

summary.push(
  await run("1. setSecurityFilter (記事管理)", () =>
    setSecurityFilter({
      tableName: "記事管理",
      filter: '[担当者メール] = USEREMAIL()',
      apply: false,
    }),
  ),
);

summary.push(
  await run("2. promoteToRef (記事管理.カテゴリ → 設定)", () =>
    promoteToRef({
      tableName: "記事管理",
      columnName: "カテゴリ",
      parentTableName: "設定",
      isAPartOf: false,
      apply: false,
    }),
  ),
);

summary.push(
  await run("3. addOpenUrlAction (記事管理)", () =>
    addOpenUrlAction({
      tableName: "記事管理",
      actionName: "テストOpenUrl_DryRun",
      urlExpression: 'CONCATENATE("https://example.com/?id=", ENCODEURL([ID]))',
      condition: 'NOT(ISBLANK([ID]))',
      apply: false,
    }),
  ),
);

summary.push(
  await run("4. createBot (記事管理 + Edit)", () =>
    createBot({
      botName: "dry_run_test_bot",
      tableName: "記事管理",
      actionName: "Edit",
      eventType: "ADDS_AND_UPDATES",
      apply: false,
    }),
  ),
);

summary.push(
  await run("5. addSlice (記事管理 → 公開済み_DryRun_Slice)", () =>
    addSlice({
      sliceName: "公開済み_DryRun_Slice",
      sourceTable: "記事管理",
      filterCondition: '[ステータス] = "公開済み"',
      apply: false,
    }),
  ),
);

summary.push(
  await run("6. removeSlice (存在しないSlice → エラー期待)", async () => {
    try {
      const r = await removeSlice({ sliceName: "存在しないSlice_xyz", apply: false });
      throw new Error("期待: エラー、実際: 成功 = " + JSON.stringify(r));
    } catch (e) {
      if (e.message?.includes("見つかりません")) {
        return { expected_error: e.message };
      }
      throw e;
    }
  }),
);

summary.push(
  await run("7. addCallScriptTask (Process for __test_bot)", () =>
    addCallScriptTask({
      processName: "Process for __test_bot",
      taskName: "DryRun_AppsScript_Task",
      scriptId: "DocId=DUMMY_SCRIPT_ID_FOR_DRYRUN",
      functionName: "doSomething",
      functionArguments: [
        { name: "rows", expression: "記事管理[ID]" },
        { name: "user", expression: "USEREMAIL()" },
      ],
      tableName: "記事管理",
      stepName: "DryRunStep",
      asyncExec: false,
      forEntireTable: true,
      apply: false,
    }),
  ),
);

summary.push(
  await run("8. createTable (設定 をテンプレに テストテーブル_DryRun)", () =>
    createTable({
      newTableName: "テストテーブル_DryRun",
      sourceQualifier: "テスト用シート",
      templateTableName: "設定",
      apply: false,
    }),
  ),
);

console.log("\n=== サマリ ===");
const okCount = summary.filter((s) => s.ok).length;
const ngCount = summary.length - okCount;
console.log(`OK: ${okCount} / ${summary.length}, NG: ${ngCount}`);
for (const s of summary) {
  console.log(`${s.ok ? "✅" : "❌"} ${s.name}${s.error ? "  --  " + s.error : ""}`);
}
process.exit(ngCount > 0 ? 1 : 0);
