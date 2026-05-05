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
 * .env の APPSHEET_LOGIN_ACCOUNT を読んでデフォルトアカウントとして返す。
 * 引数が明示指定されていればそれを優先。
 */
export function resolveLoginAccount(explicit?: string): string | undefined {
  if (explicit) return explicit;
  const fromEnv = process.env.APPSHEET_LOGIN_ACCOUNT?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : undefined;
}

/**
 * Playwright で AppSheet にアクセスして Cookie を取得。
 * @param opts.headless - true: 自動更新 / false: 初回 headed login
 * @param opts.account - Google アカウントを指定してアカウント選択画面をスキップ。省略時 .env の APPSHEET_LOGIN_ACCOUNT を使用
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
    const account = resolveLoginAccount(opts.account);
    const initialUrl = account
      ? `${APPSHEET_HOME_URL}?authuser=${encodeURIComponent(account)}`
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
 * @param opts.account - Google アカウント直指定。省略時 .env の APPSHEET_LOGIN_ACCOUNT を使用
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

// ============================================================
// HAR キャプチャ — saveapp 通信を傍受して JSON 保存
// ============================================================

export const APPSHEET_EDITOR_URL = "https://www.appsheet.com/Template/AppDef";

export interface CapturedSaveapp {
  /** 何回目のキャプチャか (セッション内連番) */
  sequence: number;
  /** ISO timestamp */
  capturedAt: string;
  /** リクエスト URL (?appName=... 等のクエリ含む) */
  url: string;
  /** リクエスト method (常に POST) */
  method: string;
  /** リクエストヘッダ抜粋 (機密情報除く) */
  requestHeaders: Record<string, string>;
  /** リクエストボディ (saveapp は multipart 風 form-encoded; 解析できればパース後の object も付ける) */
  requestBody: string;
  /** appJson 部分を JSON パースしたもの (差分の本体)。失敗時 null */
  parsedAppJson: unknown;
  /** その他フォームフィールド (appJson 以外) */
  otherFields: Record<string, string>;
  /** レスポンスステータス */
  responseStatus: number;
  /** レスポンスボディ (JSON パース可能ならパース、不可なら文字列) */
  responseBody: unknown;
}

/**
 * saveapp の form-encoded body から appJson と他のフィールドを抽出する。
 * AppSheet Editor は通常 application/x-www-form-urlencoded で送信。
 */
function parseSaveappBody(body: string): {
  parsedAppJson: unknown;
  otherFields: Record<string, string>;
} {
  const otherFields: Record<string, string> = {};
  let parsedAppJson: unknown = null;
  try {
    const params = new URLSearchParams(body);
    for (const [k, v] of params.entries()) {
      if (k === "appJson") {
        try {
          parsedAppJson = JSON.parse(v);
        } catch {
          parsedAppJson = null;
        }
      } else {
        otherFields[k] = v;
      }
    }
  } catch {
    /* fall through with defaults */
  }
  return { parsedAppJson, otherFields };
}

/**
 * AppSheet Editor を headed モードで開き、saveapp 通信を傍受して
 * 1 件ごとに JSON ファイルに保存する。
 *
 * ユーザーは Editor の UI から普通に Bot/Step/Task を追加・保存するだけ。
 * Playwright が `POST /api/saveapp` を全て自動キャプチャ。
 *
 * @param opts.appId       — 開く App ID（必須）
 * @param opts.appName     — 内部アプリ名 (例: '介護カルテシステム-995205666')
 *                           指定時は Editor のディープリンクに使う。未指定時は AppList から手動選択
 * @param opts.label       — 保存ファイル名のラベル (例: 'add_data_action_step')
 * @param opts.outDir      — 保存先ディレクトリ (default: <repoRoot>/samples/captured)
 * @param opts.account     — Google アカウント直指定。省略時 .env の APPSHEET_LOGIN_ACCOUNT
 * @param opts.maxCaptures — 最大キャプチャ件数 (default: 50)
 * @param opts.timeoutMs   — セッション全体のタイムアウト (default: 30 分)
 * @param opts.onCapture   — キャプチャごとに呼ばれるコールバック
 */
export async function captureSaveapp(
  opts: {
    appId: string;
    appName?: string;
    label: string;
    outDir?: string;
    account?: string;
    maxCaptures?: number;
    timeoutMs?: number;
    onCapture?: (cap: CapturedSaveapp, savedPath: string) => void | Promise<void>;
  },
): Promise<{ saved: string[]; total: number }> {
  const { chromium } = await loadPlaywright();
  const outDir = opts.outDir ?? path.join(repoRoot, "samples", "captured");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(outDir, { recursive: true });

  const ctx = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    viewport: { width: 1400, height: 900 },
  });

  const saved: string[] = [];
  let sequence = 0;
  const maxCaptures = opts.maxCaptures ?? 50;
  const timeoutMs = opts.timeoutMs ?? 30 * 60 * 1000;

  try {
    const page = await ctx.newPage();

    // saveapp request/response を傍受
    page.on("response", async (response) => {
      const url = response.url();
      if (!/\/api\/saveapp(?:[?#].*)?$/i.test(url)) return;
      const request = response.request();
      if (request.method() !== "POST") return;

      sequence += 1;
      if (sequence > maxCaptures) {
        console.log(`[capture] 最大件数 ${maxCaptures} 件に到達。これ以上は無視します`);
        return;
      }

      const requestBody = request.postData() ?? "";
      const { parsedAppJson, otherFields } = parseSaveappBody(requestBody);

      let responseBody: unknown;
      const responseText = await response.text().catch(() => "");
      try {
        responseBody = JSON.parse(responseText);
      } catch {
        responseBody = responseText;
      }

      const capturedAt = new Date().toISOString();
      const stamp = capturedAt.replace(/[:.]/g, "-");
      const filename = `${opts.label}-${String(sequence).padStart(2, "0")}-${stamp}.json`;
      const savedPath = path.join(outDir, filename);

      const cap: CapturedSaveapp = {
        sequence,
        capturedAt,
        url,
        method: request.method(),
        requestHeaders: filterHeaders(request.headers()),
        requestBody,
        parsedAppJson,
        otherFields,
        responseStatus: response.status(),
        responseBody,
      };

      await writeFile(savedPath, JSON.stringify(cap, null, 2), "utf8");
      saved.push(savedPath);
      console.log(
        `[capture #${sequence}] ${response.status()} -> ${path.relative(repoRoot, savedPath)}`,
      );
      if (opts.onCapture) await opts.onCapture(cap, savedPath);
    });

    // Editor のディープリンクへ直接遷移
    const account = resolveLoginAccount(opts.account);
    const editorUrl = buildEditorUrl({ appId: opts.appId, appName: opts.appName, account });
    console.log(`[capture] Editor を開きます: ${editorUrl}`);
    await page.goto(editorUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

    console.log("");
    console.log("======================================");
    console.log(" HAR キャプチャ準備完了");
    console.log("======================================");
    console.log(` ラベル: ${opts.label}`);
    console.log(` 保存先: ${path.relative(repoRoot, outDir)}/`);
    console.log("");
    console.log(" Editor で Bot / Step / Task を追加して Save してください。");
    console.log(" saveapp が飛ぶたびに自動で JSON が保存されます。");
    console.log(" 終了するときは Chromium を閉じるか Ctrl+C を押してください。");
    console.log("");

    // ブラウザを閉じる or タイムアウトまで待機
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        console.log("[capture] タイムアウト。セッション終了します");
        resolve();
      }, timeoutMs);
      ctx.on("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });

    return { saved, total: sequence };
  } finally {
    if (ctx.pages().length > 0) await ctx.close().catch(() => {});
  }
}

function buildEditorUrl(opts: { appId: string; appName?: string; account?: string }): string {
  // AppSheet Editor のディープリンク。internal name 必須。appId は URL からは見えないが、
  // Editor は内部 name で開く。appName 未指定時は AppList へ
  const params = new URLSearchParams();
  if (opts.account) params.set("authuser", opts.account);
  const query = params.toString();
  if (opts.appName) {
    return `${APPSHEET_EDITOR_URL}/${encodeURIComponent(opts.appName)}${query ? `?${query}` : ""}`;
  }
  return `${APPSHEET_HOME_URL}${query ? `?${query}` : ""}`;
}

function filterHeaders(h: Record<string, string>): Record<string, string> {
  const blocklist = new Set(["cookie", "authorization", "set-cookie"]);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    if (blocklist.has(k.toLowerCase())) continue;
    out[k] = v;
  }
  return out;
}
