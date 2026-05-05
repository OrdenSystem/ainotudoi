// Playwright を使った AppSheet Editor の Cookie 自動更新。
//
// 運用フロー:
//   1. 初回 1 回だけ `npm run cookie:init` を headed Chromium で実行し、
//      Google アカウントでログイン (MFA も手動)
//   2. 認証情報は userDataDir (`<repo>/playwright-userdata/`) に永続化される
//   3. 以降の `refreshCookie()` 呼び出しは headless で同 userDataDir を使い、
//      Cookie を取得して .env に書き戻す
//
// 注意:
//   - userDataDir は .gitignore に追加してコミットしない
//   - Cookie は通常 30 日程度で失効するので、定期的に refreshCookie() を呼ぶ
//   - Google OAuth セッションが切れた場合は再度 `npm run cookie:init` で
//     headed login を実行する必要あり

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// dist/auth/playwright.js または src/auth/playwright.ts から見て、リポジトリルートは 2 つ上
const repoRoot = path.resolve(__dirname, "..", "..");

export const USER_DATA_DIR = path.join(repoRoot, "playwright-userdata");
export const ENV_PATH = path.join(repoRoot, ".env");
export const APPSHEET_LOGIN_URL = "https://www.appsheet.com/Account";
export const APPSHEET_HOME_URL = "https://www.appsheet.com/Template/AppList";

// 動的 import で Playwright を読み込む (依存を必須化しない)
async function loadPlaywright() {
  try {
    const pw = await import("playwright");
    return pw;
  } catch (e) {
    throw new Error(
      `Playwright がインストールされていません。'npm install' を実行してください。\n${(e as Error).message}`,
    );
  }
}

/**
 * Playwright で AppSheet にアクセスして Cookie を取得。
 * @param opts.headless - true: 自動更新 / false: 初回 headed login
 * @param opts.account - Google アカウントを指定してアカウント選択画面をスキップ (例: 'lab@appsheet.fun')
 * @param opts.waitForLogin - headed モードでユーザーのログイン完了を待つ秒数 (default 300)
 * @returns Cookie 文字列 ("name1=value1; name2=value2; ..." 形式)
 */
export async function captureCookie(
  opts: { headless: boolean; account?: string; waitForLogin?: number },
): Promise<string> {
  const { chromium } = await loadPlaywright();
  const ctx = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: opts.headless,
    viewport: { width: 1280, height: 800 },
  });

  try {
    const page = await ctx.newPage();
    // authuser パラメータで Google アカウント直指定 (アカウント選択画面スキップ)
    const initialUrl = opts.account
      ? `${APPSHEET_HOME_URL}?authuser=${encodeURIComponent(opts.account)}`
      : APPSHEET_HOME_URL;
    await page.goto(initialUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

    if (!opts.headless) {
      console.log("[cookie:init] ブラウザが開きました。Google アカウントでログインしてください...");
      console.log("[cookie:init] ログイン完了後、AppList ページが表示されると自動で続行します。");
      // AppList ページが表示されるまで待つ
      await page.waitForURL(/\/[Tt]emplate\/AppList/, { timeout: (opts.waitForLogin ?? 300) * 1000 });
      console.log("[cookie:init] ログイン検知。Cookie 取得中...");
    } else {
      const url = page.url();
      if (!/\/[Tt]emplate\/AppList/i.test(url)) {
        throw new Error(
          `AppSheet にログインできていません (現在 URL: ${url})。'npm run cookie:init' を実行してログインしてください。`,
        );
      }
    }

    // ページが完全に読み込まれるまで待つ (Cookie 反映のラグ対策)
    await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(2000);

    // CDP (Chrome DevTools Protocol) で全 Cookie を取得
    // (Persistent context では context.cookies() が空を返すケースがあるため低レベル API を使う)
    const cdp = await ctx.newCDPSession(page);
    const cdpResult = await cdp.send("Network.getAllCookies");
    const allCookies = cdpResult.cookies as Array<{ name: string; value: string; domain: string }>;

    if (!opts.headless) {
      console.log(`[debug] CDP getAllCookies 全件数: ${allCookies.length}`);
      const domains = [...new Set(allCookies.map((c) => c.domain))];
      console.log(`[debug] ドメイン一覧: ${domains.join(", ") || "(空)"}`);
    }

    const cookies = allCookies.filter((c) => /(^|\.)appsheet\.com$/i.test(c.domain));
    if (cookies.length === 0) {
      const domains = [...new Set(allCookies.map((c) => c.domain))];
      throw new Error(
        `Cookie が取得できませんでした (全 ${allCookies.length} 件のうち appsheet.com ドメインなし)。` +
        `ドメイン一覧: ${domains.join(", ") || "(空)"}`,
      );
    }
    const cookieString = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    return cookieString;
  } finally {
    await ctx.close();
  }
}

/**
 * .env の APPSHEET_COOKIE 行を新しい値に書換える (他の行は維持)。
 */
export async function updateEnvCookie(newCookie: string): Promise<void> {
  let content = "";
  if (existsSync(ENV_PATH)) {
    content = await readFile(ENV_PATH, "utf8");
  }
  const cookieLine = `APPSHEET_COOKIE=${newCookie}`;
  const lines = content.split(/\r?\n/);
  const idx = lines.findIndex((l) => l.startsWith("APPSHEET_COOKIE="));
  if (idx >= 0) {
    lines[idx] = cookieLine;
  } else {
    // 末尾に追加 (空行があれば差し込む)
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    lines.push(cookieLine);
  }
  await writeFile(ENV_PATH, lines.join("\n") + "\n", "utf8");
}

/**
 * .env の Cookie を更新し、process.env にも反映する (再起動なしで使えるように)。
 * @param opts.headless - true: 自動更新 / false: 初回 headed login (default true)
 * @param opts.account - Google アカウント直指定 (例: 'lab@appsheet.fun')
 * @returns 取得した Cookie の長さ (桁数のみログ用)
 */
export async function refreshCookie(
  opts: { headless?: boolean; account?: string } = {},
): Promise<{ cookieLength: number }> {
  const cookie = await captureCookie({
    headless: opts.headless ?? true,
    account: opts.account,
  });
  await updateEnvCookie(cookie);
  process.env.APPSHEET_COOKIE = cookie;
  return { cookieLength: cookie.length };
}
