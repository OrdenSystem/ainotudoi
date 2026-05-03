import { resolveCredential, buildEndpoint, AppCredential } from "../auth/appsheet.js";
import { log } from "../util/log.js";

type Action = "Find" | "Add" | "Edit" | "Delete";

interface ApiPayload {
  Action: Action | string;
  Properties?: {
    Locale?: string;
    Timezone?: string;
    UserSettings?: Record<string, string>;
    Selector?: string;
  };
  Rows: Array<Record<string, unknown>>;
}

interface InvokeOptions {
  appId?: string;
  tableName: string;
  action: Action | string;
  rows?: Array<Record<string, unknown>>;
  selector?: string;
  locale?: string;
  timezone?: string;
  userSettings?: Record<string, string>;
}

async function callAppSheet(
  credential: AppCredential,
  tableName: string,
  payload: ApiPayload,
): Promise<unknown> {
  const url = buildEndpoint(credential, tableName);
  const body = JSON.stringify(payload);
  log.debug("appsheet request", { url, action: payload.Action, rows: payload.Rows.length });

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "ApplicationAccessKey": credential.accessKey,
    },
    body,
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`AppSheet API ${res.status}: ${text || res.statusText}`);
  }
  if (!text) return [];
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function invoke(opts: InvokeOptions): Promise<unknown> {
  const credential = resolveCredential(opts.appId);
  const payload: ApiPayload = {
    Action: opts.action,
    Properties: {},
    Rows: opts.rows ?? [],
  };
  if (opts.selector) payload.Properties!.Selector = opts.selector;
  if (opts.locale) payload.Properties!.Locale = opts.locale;
  if (opts.timezone) payload.Properties!.Timezone = opts.timezone;
  if (opts.userSettings) payload.Properties!.UserSettings = opts.userSettings;
  return callAppSheet(credential, opts.tableName, payload);
}

/**
 * AppSheet API v2 の Selector は `Filter("table", boolean式)` または `Select(table[col], cond)` の
 * 形式が必須。boolean 式単体（例: `[列] = "値"`）を渡すと API は 0 件返却して何も教えてくれず
 * デバッグが辛いので、ここで自動ラップする。
 *
 * 既に Filter / Select / TopN / OrderBy などのリスト関数で始まる場合は素通し。
 * 空文字列も素通し（全件取得）。
 *
 * Issue #7 対応。
 */
function wrapSelector(rawSelector: string | undefined, tableName: string): string | undefined {
  if (rawSelector === undefined) return undefined;
  const trimmed = rawSelector.trim();
  if (trimmed === "") return rawSelector; // 空は全件
  // 既にリスト関数で始まっている場合は素通し
  const listFns = ["Filter(", "FILTER(", "Select(", "SELECT(", "TopN(", "TOPN(", "OrderBy(", "ORDERBY(", "Sort(", "SORT(", "REF_ROWS(", "Ref_Rows(", "RefRows(", "List(", "LIST("];
  for (const fn of listFns) {
    if (trimmed.startsWith(fn)) return rawSelector;
  }
  // それ以外（boolean 式や定数）を Filter("table", ...) でラップ
  log.info("wrapping selector with Filter()", { tableName, original: rawSelector.slice(0, 60) });
  return `Filter("${tableName}", ${trimmed})`;
}

export const findRecords = (args: {
  tableName: string;
  selector?: string;
  appId?: string;
  locale?: string;
  timezone?: string;
}) => invoke({ ...args, action: "Find", selector: wrapSelector(args.selector, args.tableName) });

export const addRecords = (args: {
  tableName: string;
  rows: Array<Record<string, unknown>>;
  appId?: string;
}) => invoke({ ...args, action: "Add" });

export const editRecords = (args: {
  tableName: string;
  rows: Array<Record<string, unknown>>;
  appId?: string;
}) => invoke({ ...args, action: "Edit" });

export const deleteRecords = (args: {
  tableName: string;
  rows: Array<Record<string, unknown>>;
  appId?: string;
}) => invoke({ ...args, action: "Delete" });

export const invokeAction = (args: {
  tableName: string;
  actionName: string;
  rows?: Array<Record<string, unknown>>;
  appId?: string;
}) => invoke({
  appId: args.appId,
  tableName: args.tableName,
  action: args.actionName,
  rows: args.rows ?? [],
});
