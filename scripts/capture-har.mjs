#!/usr/bin/env node
// AppSheet Editor を headed Chromium で開き、saveapp 通信を傍受して
// 1 リクエストごとに JSON ファイルに保存する dogfood ツール。
//
// 使い方:
//   npm run capture-har -- --label=add_data_action_step --app=<APP_ID> --app-name=<INTERNAL_NAME>
//
// 主なオプション:
//   --label=<string>      保存ファイル名のラベル (必須)
//   --app=<APP_ID>        対象 App の UUID (省略時は AppList で手動選択)
//   --app-name=<string>   Editor ディープリンク用の internal app name (例: '介護カルテシステム-995205666')
//   --account=<email>     Google アカウント直指定。省略時 .env の APPSHEET_LOGIN_ACCOUNT
//   --out=<dir>           保存先ディレクトリ (default: <repo>/samples/captured)
//   --max=<n>             最大キャプチャ件数 (default: 50)
//   --timeout=<minutes>   セッション全体のタイムアウト分 (default: 30)

import { config as loadEnv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { captureSaveapp } from "../dist/auth/playwright.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
loadEnv({ path: path.join(repoRoot, ".env") });

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq < 0) {
      out[a.slice(2)] = true;
    } else {
      out[a.slice(2, eq)] = a.slice(eq + 1);
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

if (!args.label) {
  console.error("❌ --label=<string> は必須です (保存ファイル名のラベル)");
  console.error("");
  console.error("例: npm run capture-har -- --label=add_data_action_step --app=<APP_ID> --app-name=<INTERNAL_NAME>");
  process.exit(2);
}

const appId = args.app;
const appName = args["app-name"];
if (!appId) {
  console.error("❌ --app=<APP_ID> は必須です");
  process.exit(2);
}

const opts = {
  appId,
  appName,
  label: args.label,
  account: args.account,
  outDir: args.out ? path.resolve(process.cwd(), args.out) : undefined,
  maxCaptures: args.max ? Number(args.max) : undefined,
  timeoutMs: args.timeout ? Number(args.timeout) * 60 * 1000 : undefined,
};

(async () => {
  try {
    const result = await captureSaveapp(opts);
    console.log("");
    console.log("======================================");
    console.log(" HAR キャプチャ終了");
    console.log("======================================");
    console.log(` 保存件数: ${result.saved.length} / 検知 ${result.total} 件`);
    if (result.saved.length > 0) {
      console.log(" 保存先:");
      for (const p of result.saved) console.log(`   - ${path.relative(repoRoot, p)}`);
    }
  } catch (err) {
    console.error("");
    console.error("❌ キャプチャ失敗:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
})();
