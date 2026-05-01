import { log } from "../util/log.js";

export interface AppCredential {
  appId: string;
  accessKey: string;
  region: string;
}

const KEY_PREFIX = "APPSHEET_ACCESS_KEY__";

function normalize(appId: string): string {
  return appId.trim();
}

function lookupAccessKey(appId: string): string | undefined {
  const env = process.env;
  const direct = env[`${KEY_PREFIX}${appId}`];
  if (direct) return direct;
  const underscored = appId.replace(/-/g, "_");
  return env[`${KEY_PREFIX}${underscored}`];
}

export function resolveCredential(appIdInput?: string): AppCredential {
  const defaultId = process.env.APPSHEET_DEFAULT_APP_ID?.trim();
  const appId = normalize(appIdInput ?? defaultId ?? "");
  if (!appId) {
    throw new Error(
      "AppSheet App ID が指定されていません。ツール引数 appId または .env の APPSHEET_DEFAULT_APP_ID を設定してください。",
    );
  }
  const accessKey = lookupAccessKey(appId);
  if (!accessKey) {
    throw new Error(
      `AppSheet Access Key が .env に見つかりません。'${KEY_PREFIX}${appId}' をセットしてください。`,
    );
  }
  const region = process.env.APPSHEET_REGION?.trim() || "www";
  log.debug("resolved appsheet credential", { appId, region });
  return { appId, accessKey, region };
}

export function buildEndpoint(c: AppCredential, tableName: string): string {
  const host = `https://${c.region}.appsheet.com`;
  const encoded = encodeURIComponent(tableName);
  return `${host}/api/v2/apps/${c.appId}/tables/${encoded}/Action`;
}
