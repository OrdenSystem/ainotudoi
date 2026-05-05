#!/usr/bin/env node
// 初回 1 回だけ実行: headed Chromium で AppSheet にログインし、
// userDataDir (playwright-userdata/) に認証セッションを永続化する。
// 以降は appsheet_refresh_cookie ツールが headless で Cookie を更新できる。
//
// 使い方:
//   npm run cookie:init
//   npm run cookie:init -- --account=lab@appsheet.fun  # アカウント指定

import { refreshCookie } from "../dist/auth/playwright.js";

// CLI 引数から --account=xxx を抽出
const accountArg = process.argv.find((a) => a.startsWith("--account="));
const account = accountArg ? accountArg.split("=", 2)[1] : undefined;

const main = async () => {
  console.log("======================================");
  console.log(" AppSheet Cookie 初回セットアップ");
  console.log("======================================");
  console.log("");
  console.log("これから Chromium ブラウザが開きます。");
  if (account) {
    console.log(`Google アカウント '${account}' でログインしてください (authuser 指定済)。`);
  } else {
    console.log("Google アカウントで AppSheet にログインしてください。");
  }
  console.log("ログイン後 AppList ページが表示されると自動で完了します。");
  console.log("");

  try {
    const result = await refreshCookie({ headless: false, account });
    console.log("");
    console.log("✅ ログイン成功 + Cookie 取得完了");
    console.log(`   Cookie 長: ${result.cookieLength} chars`);
    console.log("   .env の APPSHEET_COOKIE が更新されました");
    console.log("   userDataDir (playwright-userdata/) に認証セッションを保存しました");
    console.log("");
    console.log("以降は MCP の appsheet_refresh_cookie ツールが headless で Cookie を更新できます。");
  } catch (err) {
    console.error("");
    console.error("❌ セットアップ失敗:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
};

main();
