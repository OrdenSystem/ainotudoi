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

export const findRecords = (args: {
  tableName: string;
  selector?: string;
  appId?: string;
  locale?: string;
  timezone?: string;
}) => invoke({ ...args, action: "Find" });

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
