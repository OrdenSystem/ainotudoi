// 新規クローン直後 / 新しい AppSheet アプリを扱う前に、Claude Code が
// 「会話の最初に必ず呼ぶ」事前チェックツール。副作用なしで以下を確認する:
//
//   1. AppID / Access Key (.env)
//   2. 内部 App Name（Editor ディープリンク・HAR キャプチャに必要）
//   3. APPSHEET_COOKIE（書込系ツールに必要）と Cookie 推定鮮度
//   4. snapshots/openapi-<appId>.json（テーブル/列名の曖昧解消に必要）
//   5. snapshots/appdef-<appId>.json（Phase 3/4 の式・Action・View・Bot 取得に必要）
//   6. Application API v2 への到達確認（軽量 GET）
//
// 結果は「checks 配列 + nextSteps + conversationGuide」を返す。
// Claude は nextSteps を 1 つずつクローズドクエッションでユーザーに確認する。

import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "../util/log.js";
import { refreshCookie, resolveLoginAccount } from "../auth/playwright.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..", "..");

type CheckStatus = "ok" | "missing" | "warning" | "unknown";

interface Check {
  /** 識別子（CLI から再実行する時の参照用） */
  id: string;
  /** ユーザー向け短文 */
  label: string;
  status: CheckStatus;
  /** ok 以外の時に表示するメッセージ・原因・対処 */
  message?: string;
  /** Claude が次に提案すべきアクション（クローズド Y/N で確認させる） */
  nextAction?: string;
}

interface PreflightResult {
  ok: boolean;
  appId: string | null;
  appName: string | null;
  region: string;
  /** 書込系（Phase 4）まで使えるか */
  writeReady: boolean;
  /** メタデータ系（Phase 2/3）まで使えるか */
  metaReady: boolean;
  /** データ CRUD（Phase 1）まで使えるか */
  dataReady: boolean;
  checks: Check[];
  /** Claude が会話で順に確認すべき次手順（クローズド Y/N で。先頭から消化する） */
  nextSteps: string[];
  /** 会話パラダイムの再掲（Claude が忘れないように毎回返す） */
  conversationGuide: string;
}

const KEY_PREFIX = "APPSHEET_ACCESS_KEY__";

function lookupAccessKey(appId: string): string | undefined {
  const env = process.env;
  const direct = env[`${KEY_PREFIX}${appId}`];
  if (direct) return direct;
  const underscored = appId.replace(/-/g, "_");
  return env[`${KEY_PREFIX}${underscored}`];
}

function fileMtimeIso(path: string): string | null {
  try {
    return statSync(path).mtime.toISOString();
  } catch {
    return null;
  }
}

function daysSince(iso: string): number {
  const d = new Date(iso).getTime();
  return Math.floor((Date.now() - d) / (1000 * 60 * 60 * 24));
}

async function tryReachApi(appId: string, accessKey: string, region: string): Promise<{ ok: boolean; status?: number; message?: string }> {
  // Application API v2 の `/Action` は POST しか受け付けないが、
  // 認証エラー / 404 / 405 で「到達はしている」ことは判別できる。
  // ここでは「存在しないテーブル名で Find を投げて 4xx が返ってくれば到達 OK」とする。
  const host = `https://${region}.appsheet.com`;
  const probeTable = "__preflight_probe__";
  const url = `${host}/api/v2/apps/${appId}/tables/${encodeURIComponent(probeTable)}/Action`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ApplicationAccessKey: accessKey,
      },
      body: JSON.stringify({ Action: "Find", Properties: {}, Rows: [] }),
      signal: AbortSignal.timeout(8000),
    });
    // 404 (table not found) でも到達 OK。401/403 は鍵不正
    if (res.status === 401 || res.status === 403) {
      return { ok: false, status: res.status, message: "Access Key 認証失敗。.env の APPSHEET_ACCESS_KEY__<AppId> を確認してください" };
    }
    return { ok: true, status: res.status };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

interface AppDefSnapshot {
  appId?: string;
  appName?: string;
  metadata?: { appName?: string; internalAppName?: string };
}

async function readAppNameFromSnapshot(appId: string): Promise<string | null> {
  const path = resolve(repoRoot, "snapshots", `appdef-${appId}.json`);
  if (!existsSync(path)) return null;
  try {
    const text = await readFile(path, "utf8");
    const parsed = JSON.parse(text) as AppDefSnapshot;
    return parsed.appName ?? parsed.metadata?.internalAppName ?? parsed.metadata?.appName ?? null;
  } catch {
    return null;
  }
}

const CONVERSATION_GUIDE = [
  "## 会話パラダイム（必読）",
  "",
  "**新規開発・新規作成**（テーブル新設 / View 新設 / Bot 新設 / 設計フェーズ）:",
  "- オープンクエッション中心。要件・前提・データソース選択・REF 関係を**ヒアリングで広げる**",
  "- 安易に書込みツールを呼ばない。設計が固まってからユーザーの GO サイン待ち",
  "",
  "**編集・是正・データ操作**（既存テーブル/列の変更 / レコード追加・更新・削除 / Action 実行）:",
  "- クローズドクエッション中心（Y/N で答えられる形）",
  "- 対象を 1 つに絞り込んでから動く。テーブル名・列名・Action 名が曖昧なら必ず**候補を列挙**してユーザーに番号で選ばせる",
  "  - テーブル候補: `appsheet_get_tables` の結果から提示",
  "  - 列候補: `appsheet_get_columns` または `appsheet_get_full_columns` から提示",
  "  - Action 候補: `appsheet_get_actions` から提示",
  "- 書込系は必ず **dry-run で diff を提示 → ユーザー Y → apply: true で再実行** の 2 段階",
  "- 削除・置換・テーブル丸ごと操作は **影響範囲を口頭で要約してから** 確認を取る",
  "",
  "**事故防止チェック**:",
  "- `apply: true` を付ける前に必ず dry-run の差分をユーザーに見せる",
  "- 同名テーブル・同名列が複数ある場合はユーザーに選ばせる（推測しない）",
  "- データ削除・テーブル削除は影響受ける行数・関連 View / Action / Bot も合わせて提示",
].join("\n");

export async function preflight(args: {
  appId?: string;
  appName?: string;
  /** true で API 到達確認をスキップ（オフライン時） */
  skipApiProbe?: boolean;
}): Promise<PreflightResult> {
  const checks: Check[] = [];
  const nextSteps: string[] = [];

  // ---- 1. AppID ----
  const appId = (args.appId ?? process.env.APPSHEET_DEFAULT_APP_ID ?? "").trim();
  if (!appId) {
    checks.push({
      id: "app_id",
      label: "AppSheet App ID",
      status: "missing",
      message: ".env の APPSHEET_DEFAULT_APP_ID が未設定。AppSheet Editor → Manage → Integrations → IN セクションに表示される UUID。",
      nextAction: "対象 AppSheet アプリの App ID を教えてください（UUID 形式）。",
    });
    nextSteps.push("App ID をユーザーに尋ねる（クローズドではなくオープンで OK：UUID をそのまま入力させる）");
  } else {
    checks.push({ id: "app_id", label: "AppSheet App ID", status: "ok", message: `appId=${appId}` });
  }

  // ---- 2. Access Key ----
  const accessKey = appId ? lookupAccessKey(appId) : undefined;
  if (appId && !accessKey) {
    checks.push({
      id: "access_key",
      label: "Application Access Key",
      status: "missing",
      message: `.env に APPSHEET_ACCESS_KEY__${appId}=V2-... の追記が必要。AppSheet Editor → Manage → Integrations → IN → Enable から発行。`,
      nextAction: "Access Key を発行済みか？ 発行済みなら値を教えてください（V2- で始まる文字列）。",
    });
    nextSteps.push(
      "Access Key の発行有無を Y/N で確認 → 未発行なら Editor → Manage → Integrations → IN → Enable へ誘導 → 値を受領したら .env を更新",
    );
  } else if (appId) {
    checks.push({ id: "access_key", label: "Application Access Key", status: "ok" });
  }

  // ---- 3. Region ----
  const region = process.env.APPSHEET_REGION?.trim() || "www";
  checks.push({ id: "region", label: "Region", status: "ok", message: region });

  // ---- 4. AppSheet 開発者権限（招待済みか）の確認 ----
  // 技術的に検出できないので、ユーザーへの問い掛けを必須化
  checks.push({
    id: "developer_invite",
    label: "AppSheet 開発者（co-author）招待",
    status: "unknown",
    message: "Application API は閲覧者でも叩けるが、Phase 3/4（loadApp / saveapp）は開発者権限が必須。",
    nextAction: "対象アプリの AppSheet Editor を開いて編集できる状態ですか？（Y/N）。N の場合はオーナーに co-author 招待を依頼してください。",
  });
  nextSteps.push("Editor を開いて編集できるか Y/N で確認（招待済みかの代替確認）");

  // ---- 5. 内部 App Name ----
  let appName: string | null = args.appName ?? null;
  if (!appName && appId) {
    appName = await readAppNameFromSnapshot(appId);
  }
  if (appName) {
    checks.push({ id: "app_name", label: "内部 App Name", status: "ok", message: appName });
  } else {
    checks.push({
      id: "app_name",
      label: "内部 App Name",
      status: "warning",
      message: "Editor ディープリンク・HAR キャプチャに必要。snapshot 取得後は自動検出可能。",
      nextAction: "AppSheet Editor の URL に出てくる '<アプリ名>-<数字>' 形式の内部 App Name は分かりますか？（例: `WP投稿app-12345678`）",
    });
    nextSteps.push("内部 App Name をユーザーに尋ねる（Editor URL の末尾セグメント）");
  }

  // ---- 6. Cookie ----
  const cookie = process.env.APPSHEET_COOKIE?.trim();
  const userDataDir = resolve(repoRoot, "playwright-userdata");
  const userDataMtime = fileMtimeIso(userDataDir);
  const userDataExists = existsSync(userDataDir);
  if (!cookie) {
    if (!userDataExists) {
      checks.push({
        id: "cookie",
        label: "Editor Cookie（書込系の前提）",
        status: "missing",
        message: "Cookie 未設定 + Playwright プロファイル無し。書込系（Phase 4）は使えない。",
        nextAction: "書込系を使う予定はありますか？（Y/N） Y なら自動取得（headed Chromium で 1 回ログイン）の許可をください。",
      });
      nextSteps.push(
        "書込系を使う予定があるか Y/N → 必要なら appsheet_run_cookie_init を呼ぶ許可を Y/N で取る → 許可後にツール実行（headed Chromium が開く）",
      );
    } else {
      checks.push({
        id: "cookie",
        label: "Editor Cookie",
        status: "warning",
        message: `Cookie は .env に無いが Playwright プロファイル有り（最終更新 ${userDataMtime}）。appsheet_refresh_cookie で取得可能。`,
        nextAction: "今すぐ Cookie を更新しますか？（Y/N） headless で完結します。",
      });
      nextSteps.push("appsheet_refresh_cookie の実行許可を Y/N で取る");
    }
  } else {
    // .env の Cookie 行のタイムスタンプは取れないので、playwright-userdata の更新時刻を擬似的に使う
    const ageInfo = userDataMtime ? `Playwright プロファイル更新: ${userDataMtime}（${daysSince(userDataMtime)} 日前）` : "Cookie 取得時刻は不明";
    const days = userDataMtime ? daysSince(userDataMtime) : null;
    if (days !== null && days > 25) {
      checks.push({
        id: "cookie",
        label: "Editor Cookie",
        status: "warning",
        message: `${ageInfo}。30 日で失効するので念のため更新を推奨。`,
        nextAction: "appsheet_refresh_cookie で Cookie を更新しますか？（Y/N）",
      });
      nextSteps.push("Cookie 鮮度が 25 日超 → 更新可否を Y/N で確認");
    } else {
      checks.push({ id: "cookie", label: "Editor Cookie", status: "ok", message: `長さ ${cookie.length} chars / ${ageInfo}` });
    }
  }

  // ---- 7. snapshot ファイル ----
  if (appId) {
    const openapiPath = resolve(repoRoot, "snapshots", `openapi-${appId}.json`);
    const appdefPath = resolve(repoRoot, "snapshots", `appdef-${appId}.json`);
    const openapiExists = existsSync(openapiPath);
    const appdefExists = existsSync(appdefPath);
    checks.push({
      id: "snapshot_openapi",
      label: "OpenAPI snapshot（テーブル/列名の曖昧解消用）",
      status: openapiExists ? "ok" : "missing",
      message: openapiExists ? `${openapiPath}（${fileMtimeIso(openapiPath)}）` : `未取得。ブラウザで https://www.appsheet.com/api/v2/apps/${appId}/openapi.json を開き ${openapiPath} に保存。`,
      nextAction: openapiExists ? undefined : "OpenAPI snapshot を今取得しますか？（Y/N） 取得後はテーブル/列名の候補列挙が可能になります。",
    });
    if (!openapiExists) nextSteps.push("OpenAPI snapshot 取得の許可を Y/N で取る → ブラウザで上記 URL を開く手順を案内");

    checks.push({
      id: "snapshot_appdef",
      label: "App Definition snapshot（Phase 3/4 必須）",
      status: appdefExists ? "ok" : "missing",
      message: appdefExists
        ? `${appdefPath}（${fileMtimeIso(appdefPath)}）`
        : "未取得。Cookie が用意できていれば appsheet_refresh_app_def で 1 発取得可能。Cookie 無しなら HAR インポート経由。",
      nextAction: appdefExists ? undefined : "Cookie が用意できたら appsheet_refresh_app_def を実行しますか？（Y/N）",
    });
    if (!appdefExists) nextSteps.push("appdef snapshot 取得の可否を Y/N（Cookie 取得後に推奨）");
  }

  // ---- 8. API 到達確認 ----
  let dataReady = false;
  if (appId && accessKey && !args.skipApiProbe) {
    const probe = await tryReachApi(appId, accessKey, region);
    if (probe.ok) {
      dataReady = true;
      checks.push({ id: "api_reachable", label: "Application API v2 到達", status: "ok", message: `HTTP ${probe.status}` });
    } else {
      checks.push({
        id: "api_reachable",
        label: "Application API v2 到達",
        status: "warning",
        message: probe.message ?? `HTTP ${probe.status}`,
        nextAction: probe.status === 401 || probe.status === 403 ? "Access Key を再確認してください" : "ネットワーク・リージョン設定を確認してください",
      });
    }
  } else if (appId && accessKey) {
    checks.push({ id: "api_reachable", label: "Application API v2 到達", status: "unknown", message: "skipApiProbe=true でスキップ" });
    dataReady = true;
  }

  const metaReady =
    !!appId &&
    !!accessKey &&
    (existsSync(resolve(repoRoot, "snapshots", `openapi-${appId}.json`)) ||
      existsSync(resolve(repoRoot, "snapshots", `appdef-${appId}.json`)));
  const writeReady = !!cookie && metaReady;

  const ok = checks.every((c) => c.status === "ok" || c.status === "unknown" || c.id === "developer_invite");

  log.info("preflight", { appId, ok, dataReady, metaReady, writeReady, missing: checks.filter((c) => c.status === "missing").map((c) => c.id) });

  return {
    ok,
    appId: appId || null,
    appName: appName ?? null,
    region,
    writeReady,
    metaReady,
    dataReady,
    checks,
    nextSteps,
    conversationGuide: CONVERSATION_GUIDE,
  };
}

// ============================================================
// appsheet_run_cookie_init — 初回 Cookie 取得を MCP 経由で起動
// ============================================================
//
// `npm run cookie:init` を CLI から打たずに、Claude との会話の中で
// 「許可を取った上で headed Chromium を起動 → Cookie を .env に書込」する。
//
// 重要:
//   - userConsent: true が無いと実行しない（誤起動防止）
//   - headed Chromium がデスクトップに開く副作用があるため、必ず事前に
//     ユーザーに「これからブラウザが開きます。Google アカウントでログイン
//     してください」と伝えてから呼ぶこと
//   - 既に playwright-userdata/ にセッションがある環境では、ヘッドレス
//     更新で十分なケースが多い → 無駄に headed を開かないよう、preflight
//     の判定に従って分岐するのが望ましい

export interface RunCookieInitArgs {
  /** 必須: ユーザーの明示同意。false / 未指定なら実行せず、確認文を返す */
  userConsent?: boolean;
  /** Google アカウント直指定（authuser）。省略時は .env の APPSHEET_LOGIN_ACCOUNT */
  account?: string;
  /** ヘッドレスにフォールバックしたいとき true（既に userDataDir に有効セッションがある場合のみ成功） */
  preferHeadless?: boolean;
  /** ログイン待ち最大秒数。default 300 */
  waitForLoginSeconds?: number;
}

export interface RunCookieInitResult {
  executed: boolean;
  cookieLength?: number;
  message: string;
  /** 実行前確認メッセージ（userConsent 未指定時） */
  consentPrompt?: string;
}

export async function runCookieInit(args: RunCookieInitArgs): Promise<RunCookieInitResult> {
  const account = resolveLoginAccount(args.account);

  if (!args.userConsent) {
    const accountInfo = account ? `Google アカウント: ${account}` : "Google アカウント: .env 未設定（手動選択）";
    return {
      executed: false,
      message: "userConsent: true が必要です（誤起動防止）。",
      consentPrompt: [
        "## 確認: AppSheet Cookie 自動取得",
        "",
        "これから以下を実行します:",
        "",
        "1. デスクトップに **headed Chromium** が 1 つ立ち上がります",
        "2. AppSheet ログインページへ自動遷移します",
        `3. ${accountInfo} でログインしてください（MFA も含む）`,
        "4. AppList ページが表示されたら自動で Cookie を取得",
        "5. 取得した Cookie は `.env` の `APPSHEET_COOKIE=` に書込まれます",
        "6. セッション情報は `playwright-userdata/` に永続化（以降は headless 更新可能）",
        "",
        "**実行してよろしいですか？（Y/N）**",
        "",
        "Y なら同じツールを `userConsent: true` で再実行してください。",
      ].join("\n"),
    };
  }

  log.info("run_cookie_init: starting headed Chromium", { account });
  const result = await refreshCookie({
    headless: args.preferHeadless ?? false,
    account,
  });

  return {
    executed: true,
    cookieLength: result.cookieLength,
    message: `✅ Cookie 取得完了（${result.cookieLength} chars）。.env を更新しました。`,
  };
}
