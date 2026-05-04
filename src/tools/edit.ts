import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { log } from "../util/log.js";
import { resolveCredential } from "../auth/appsheet.js";
import { getEditorHeaders } from "../auth/cookies.js";

interface AppDef {
  Id: string;
  Name?: string;
  ShortName?: string;
  AppData: {
    DataSchemas?: Array<{
      Name: string;
      AutoSchemaFrom?: string;
      Attributes?: Array<Record<string, unknown>>;
    }>;
  };
  [key: string]: unknown;
}

const SAFE_FLAGS = [
  "IsHidden",
  "Searchable",
  "IsLabel",
  "IsScannable",
  "IsNfcScannable",
  "IsSensitive",
  "ResetOnEdit",
  "IsRequired",
  "DefEdit",
] as const;
type SafeFlag = (typeof SAFE_FLAGS)[number];

function snapshotPath(appId: string): string {
  return resolve(process.cwd(), "snapshots", `appdef-${appId}.json`);
}

async function readSnapshot(appId: string): Promise<AppDef | null> {
  const path = snapshotPath(appId);
  if (!existsSync(path)) return null;
  const text = await readFile(path, "utf8");
  return JSON.parse(text) as AppDef;
}

async function lookupAppName(appId: string, fallback?: string): Promise<string> {
  if (fallback) return fallback;
  const snap = await readSnapshot(appId);
  if (snap?.Name) return snap.Name;
  throw new Error(
    "App Name が分かりません。先に appsheet_import_har か appsheet_refresh_app_def でスナップショット作成、または appName を引数指定してください。",
  );
}

async function fetchLoadApp(appName: string): Promise<{ raw: string; app: AppDef }> {
  const url = `https://www.appsheet.com/api/loadApp/${encodeURIComponent(appName)}?version=&checkConsistency=false&useUpdatedWarningText=false`;
  const r = await fetch(url, { headers: getEditorHeaders(appName) });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`loadApp 失敗: ${r.status} ${text.slice(0, 200)}`);
  }
  const wrapper = (await r.json()) as { app?: string };
  if (typeof wrapper.app !== "string") throw new Error("loadApp レスポンスの app フィールドが文字列ではありません");
  return { raw: wrapper.app, app: JSON.parse(wrapper.app) as AppDef };
}

interface SaveAppResponse {
  status: number;
  success: boolean;
  errorDescription?: string;
  retryable?: boolean;
  app?: AppDef;
}

async function postSaveApp(appId: string, appName: string, app: AppDef): Promise<SaveAppResponse> {
  const body = {
    location: "0, 0",
    locale: "ja",
    tzOffset: -540,
    userSettings: { _RowNumber: "0", _THISUSER: "onlyvalue" },
    appId,
    appJson: JSON.stringify(app),
  };
  const r = await fetch("https://www.appsheet.com/api/saveapp", {
    method: "POST",
    headers: { ...getEditorHeaders(appName), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`saveapp 失敗: ${r.status} ${text.slice(0, 300)}`);
  let parsed: { Success?: boolean; ErrorDescription?: string; Retryable?: boolean; App?: string } = {};
  try {
    parsed = JSON.parse(text);
  } catch {
    return { status: r.status, success: false, errorDescription: "saveapp レスポンスが JSON でない" };
  }
  if (!parsed.Success) {
    throw new Error(`saveapp 内部エラー: ${parsed.ErrorDescription ?? "(no description)"}${parsed.Retryable ? " [retryable]" : ""}`);
  }
  let savedApp: AppDef | undefined;
  if (typeof parsed.App === "string") {
    try {
      savedApp = JSON.parse(parsed.App) as AppDef;
    } catch {
      // ignore
    }
  }
  return { status: r.status, success: true, errorDescription: parsed.ErrorDescription, retryable: parsed.Retryable, app: savedApp };
}

/**
 * 409 Version Conflict 対応の saveapp ラッパ。
 * applyFn を「app に対する変更ロジック」として受け取り、初回送信失敗時は
 * fetchLoadApp で最新版を再取得 → applyFn を再適用 → 再送信を最大 maxRetries 回繰り返す。
 *
 * 呼出側パターン:
 *   const componentId = generateComponentId();   // 新規エンティティの場合は 1 回だけ生成
 *   const applyFn = (a: AppDef) => { ... ComponentId: componentId など固定値で組立 ... };
 *   applyFn(app);  // dry-run 表示用に初回適用
 *   if (!args.apply) return { dryRun: true, ... };
 *   const { result, refreshed } = await applyChangesAndSave(credential, appName, applyFn, app);
 */
async function applyChangesAndSave(
  credential: { appId: string },
  appName: string,
  applyFn: (app: AppDef) => void,
  initialApp: AppDef,
  maxRetries = 4,
): Promise<{ result: SaveAppResponse; refreshed: AppDef }> {
  let app = initialApp;
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await postSaveApp(credential.appId, appName, app);
      const refreshed = result.app ?? (await fetchLoadApp(appName)).app;
      return { result, refreshed };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const is409 = msg.includes("saveapp 失敗: 409");
      if (is409 && attempt < maxRetries) {
        const waitMs = 1500 * (attempt + 1);
        log.info("saveapp 409 conflict, retrying", { attempt: attempt + 1, waitMs });
        await new Promise((r) => setTimeout(r, waitMs));
        const fresh = (await fetchLoadApp(appName)).app;
        applyFn(fresh);
        app = fresh;
        lastError = e;
        continue;
      }
      throw e;
    }
  }
  throw lastError instanceof Error
    ? new Error(`saveapp が ${maxRetries} 回リトライしても 409 で失敗。最後のエラー: ${lastError.message}`)
    : new Error(`saveapp が ${maxRetries} 回リトライしても 409 で失敗`);
}

function findAttribute(app: AppDef, tableName: string, columnName: string): Record<string, unknown> {
  const schemas = app.AppData?.DataSchemas ?? [];
  const sch = schemas.find((s) => s.AutoSchemaFrom === tableName) ?? schemas.find((s) => s.Name === `${tableName}_Schema`);
  if (!sch) {
    const known = schemas.map((s) => s.AutoSchemaFrom || s.Name).join(", ");
    throw new Error(`スキーマ '${tableName}' が見つかりません。既知: ${known}`);
  }
  const attr = (sch.Attributes ?? []).find((a) => a.Name === columnName);
  if (!attr) {
    const known = (sch.Attributes ?? []).map((a) => a.Name).join(", ");
    throw new Error(`列 '${columnName}' が見つかりません。テーブル '${tableName}' の列: ${known}`);
  }
  return attr;
}

export async function refreshAppDef(args: { appId?: string; appName?: string }): Promise<{
  savedTo: string;
  appId: string;
  name: string;
  version?: string;
  bytes: number;
}> {
  const credential = resolveCredential(args.appId);
  const appName = await lookupAppName(credential.appId, args.appName);
  const { raw, app } = await fetchLoadApp(appName);
  const out = snapshotPath(credential.appId);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(app, null, 2), "utf8");
  log.info("appdef refreshed", { appId: credential.appId, bytes: raw.length });
  return {
    savedTo: out,
    appId: credential.appId,
    name: app.Name ?? appName,
    version: app.Version as string | undefined,
    bytes: raw.length,
  };
}

interface FlagWriteResult {
  dryRun: boolean;
  applied: boolean;
  table: string;
  column: string;
  flag: SafeFlag;
  before: boolean;
  requested: boolean;
  after?: boolean;
  verified?: boolean;
  message: string;
}

export async function setColumnFlag(args: {
  appId?: string;
  appName?: string;
  tableName: string;
  columnName: string;
  flag: SafeFlag;
  value: boolean;
  apply?: boolean;
}): Promise<FlagWriteResult> {
  if (!SAFE_FLAGS.includes(args.flag)) {
    throw new Error(`安全に書き換え可能なフラグは ${SAFE_FLAGS.join(", ")} のみ`);
  }
  const credential = resolveCredential(args.appId);
  const appName = await lookupAppName(credential.appId, args.appName);
  const { app } = await fetchLoadApp(appName);
  const attr = findAttribute(app, args.tableName, args.columnName);
  const before = !!attr[args.flag];

  if (before === args.value) {
    return {
      dryRun: !args.apply,
      applied: false,
      table: args.tableName,
      column: args.columnName,
      flag: args.flag,
      before,
      requested: args.value,
      message: "変更不要（既に同じ値）",
    };
  }

  const applyFn = (a: AppDef) => {
    const target = findAttribute(a, args.tableName, args.columnName);
    target[args.flag] = args.value;
  };
  applyFn(app);

  if (!args.apply) {
    return {
      dryRun: true,
      applied: false,
      table: args.tableName,
      column: args.columnName,
      flag: args.flag,
      before,
      requested: args.value,
      message: `dry-run のため未送信。実際に適用するには apply: true を指定してください。`,
    };
  }

  const { refreshed } = await applyChangesAndSave(credential, appName, applyFn, app);
  const refreshedAttr = findAttribute(refreshed, args.tableName, args.columnName);
  const after = !!refreshedAttr[args.flag];
  await writeFile(snapshotPath(credential.appId), JSON.stringify(refreshed, null, 2), "utf8");

  return {
    dryRun: false,
    applied: true,
    table: args.tableName,
    column: args.columnName,
    flag: args.flag,
    before,
    requested: args.value,
    after,
    verified: after === args.value,
    message: after === args.value ? "✅ 適用完了・検証 OK" : "⚠️ 送信は成功したが事後検証で値が異なる（要確認）",
  };
}

const SAFE_TYPE_CHANGES: Record<string, string[]> = {
  Text: ["LongText", "Name", "Url", "Email", "Phone"],
  LongText: ["Text"],
  Name: ["Text", "LongText"],
  Url: ["Text", "LongText"],
  Email: ["Text", "LongText"],
  Phone: ["Text", "LongText"],
  Number: ["Decimal", "Percent"],
  Decimal: ["Number", "Percent"],
  Percent: ["Number", "Decimal"],
};

export async function setColumnType(args: {
  appId?: string;
  appName?: string;
  tableName: string;
  columnName: string;
  newType: string;
  apply?: boolean;
}): Promise<{
  dryRun: boolean;
  applied: boolean;
  table: string;
  column: string;
  before: string;
  requested: string;
  after?: string;
  verified?: boolean;
  message: string;
  warning?: string;
}> {
  const credential = resolveCredential(args.appId);
  const appName = await lookupAppName(credential.appId, args.appName);
  const { app } = await fetchLoadApp(appName);
  const attr = findAttribute(app, args.tableName, args.columnName);
  const before = (attr.Type ?? "Unknown") as string;

  if (before === args.newType) {
    return {
      dryRun: !args.apply,
      applied: false,
      table: args.tableName,
      column: args.columnName,
      before,
      requested: args.newType,
      message: "変更不要（既に同じ Type）",
    };
  }

  const safe = SAFE_TYPE_CHANGES[before]?.includes(args.newType);
  const warning = safe
    ? undefined
    : `'${before}' → '${args.newType}' は安全リストに含まれていません。互換性が無い場合データ破損の可能性があります。慎重に。`;

  const applyFn = (a: AppDef) => {
    const target = findAttribute(a, args.tableName, args.columnName);
    target.Type = args.newType;
  };
  applyFn(app);

  if (!args.apply) {
    return {
      dryRun: true,
      applied: false,
      table: args.tableName,
      column: args.columnName,
      before,
      requested: args.newType,
      warning,
      message: "dry-run。apply: true で送信。",
    };
  }

  const { refreshed } = await applyChangesAndSave(credential, appName, applyFn, app);
  const refreshedAttr = findAttribute(refreshed, args.tableName, args.columnName);
  const after = (refreshedAttr.Type ?? "Unknown") as string;
  await writeFile(snapshotPath(credential.appId), JSON.stringify(refreshed, null, 2), "utf8");

  return {
    dryRun: false,
    applied: true,
    table: args.tableName,
    column: args.columnName,
    before,
    requested: args.newType,
    after,
    verified: after === args.newType,
    warning,
    message: after === args.newType ? "✅ 適用完了・検証 OK" : `⚠️ 期待 '${args.newType}' だが現在 '${after}'。AppSheet 側で型変換が拒否された可能性。`,
  };
}

function generateComponentId(): string {
  // AppSheet の ComponentId は「K + 26 文字」= 27 文字。"K" 固定プレフィックス。
  // Issue #3 で判明: 26 文字 + ランダム先頭で生成すると Editor が SYSTEM GENERATED に分類してしまう。
  // 観測値: App owner 手動作成 / System 自動生成 ともに `K` 始まり 27 文字。
  // 文字集合は Crockford base32 風（A-Z + 2-7、I/O/L/U 含む）。
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let id = "K";
  for (let i = 0; i < 26; i++) id += chars[Math.floor(Math.random() * 32)];
  return id;
}

const TYPE_AUX_DEFAULTS: Record<string, string> = {
  Text: '{"MaxLength":null,"MinLength":null,"LongTextFormatting":"Plain Text","IsMulticolumnKey":false,"Valid_If":null,"Error_Message_If_Invalid":null,"Show_If":null,"Required_If":null,"Editable_If":null,"Reset_If":null,"Suggested_Values":null}',
  LongText: '{"MaxLength":null,"MinLength":null,"LongTextFormatting":"Plain Text","IsMulticolumnKey":false,"Valid_If":null,"Error_Message_If_Invalid":null,"Show_If":null,"Required_If":null,"Editable_If":null,"Reset_If":null,"Suggested_Values":null}',
  Name: '{"MaxLength":null,"MinLength":null,"LongTextFormatting":"Plain Text","IsMulticolumnKey":false,"Valid_If":null,"Error_Message_If_Invalid":null,"Show_If":null,"Required_If":null,"Editable_If":null,"Reset_If":null,"Suggested_Values":null}',
  Number: '{"MaxValue":null,"MinValue":null,"StepValue":null,"NumericDigits":null,"ShowThousandsSeparator":false,"PlaceholderText":null,"Valid_If":null,"Error_Message_If_Invalid":null,"Show_If":null,"Required_If":null,"Editable_If":null,"Reset_If":null,"Suggested_Values":null}',
  Decimal: '{"MaxValue":null,"MinValue":null,"StepValue":null,"NumericDigits":null,"ShowThousandsSeparator":false,"PlaceholderText":null,"Valid_If":null,"Error_Message_If_Invalid":null,"Show_If":null,"Required_If":null,"Editable_If":null,"Reset_If":null,"Suggested_Values":null}',
  Url: '{"Valid_If":null,"Error_Message_If_Invalid":null,"Show_If":null,"Required_If":null,"Editable_If":null,"Reset_If":null,"Suggested_Values":null,"LaunchExternal":false,"IsHyperLink":false}',
  Email: '{"Valid_If":null,"Error_Message_If_Invalid":null,"Show_If":null,"Required_If":null,"Editable_If":null,"Reset_If":null,"Suggested_Values":null}',
  Date: '{"Valid_If":null,"Error_Message_If_Invalid":null,"Show_If":null,"Required_If":null,"Editable_If":null,"Reset_If":null,"Suggested_Values":null}',
  DateTime: '{"Valid_If":null,"Error_Message_If_Invalid":null,"Show_If":null,"Required_If":null,"Editable_If":null,"Reset_If":null,"Suggested_Values":null}',
  Yes_No: '{"Valid_If":null,"Error_Message_If_Invalid":null,"Show_If":null,"Required_If":null,"Editable_If":null,"Reset_If":null,"Suggested_Values":null}',
};

export async function addVirtualColumn(args: {
  appId?: string;
  appName?: string;
  tableName: string;
  columnName: string;
  formula: string;
  resultType?: string;
  description?: string;
  displayName?: string;
  isHidden?: boolean;
  isLabel?: boolean;
  apply?: boolean;
}): Promise<{
  dryRun: boolean;
  applied: boolean;
  table: string;
  column: string;
  componentId?: string;
  message: string;
  warning?: string;
}> {
  const credential = resolveCredential(args.appId);
  const appName = await lookupAppName(credential.appId, args.appName);
  const { app } = await fetchLoadApp(appName);

  const schemas = app.AppData?.DataSchemas ?? [];
  const sch = schemas.find((s) => s.AutoSchemaFrom === args.tableName);
  if (!sch) {
    const known = schemas.map((s) => s.AutoSchemaFrom || s.Name).join(", ");
    throw new Error(`スキーマ '${args.tableName}' が見つかりません。既知: ${known}`);
  }
  const attrs = (sch.Attributes ?? []) as Array<Record<string, unknown>>;
  if (attrs.find((a) => a.Name === args.columnName)) {
    throw new Error(`列 '${args.columnName}' は既に存在します`);
  }

  const resultType = args.resultType ?? "Text";
  const typeAux = TYPE_AUX_DEFAULTS[resultType] ?? TYPE_AUX_DEFAULTS.Text;
  const componentId = generateComponentId();
  const formulaText = args.formula.startsWith("=") ? args.formula : "=" + args.formula;
  const newIndex = attrs.length;

  const newAttr: Record<string, unknown> = {
    ExprLookup: {},
    Name: args.columnName,
    Type: resultType,
    TypeFromProvider: null,
    TypeAuxData: typeAux,
    Description: args.description ?? null,
    DisplayName: args.displayName ?? null,
    IsRequired: false,
    Default: null,
    DefaultExpression: null,
    DefEdit: true,
    IsSys: false,
    DefinitionIsFixed: false,
    IsKey: false,
    IsKeyPart: false,
    IsReadOnly: true,
    ResetOnEdit: false,
    IsHidden: args.isHidden ?? false,
    Formula: null,
    AsdbFormula: null,
    Category: null,
    FormulaVersion: 0,
    AppFormula: formulaText,
    IsLabel: args.isLabel ?? false,
    IsScannable: null,
    IsNfcScannable: null,
    Searchable: null,
    IsVirtual: true,
    IsAutoGenerated: false,
    IsSensitive: false,
    LocaleName: null,
    IsValid: true,
    Visibility: "ALWAYS",
    DisableAutoUpdate: false,
    ComponentId: componentId,
    _isNew: true,
    _version: 0,
    _index: newIndex,
    _path: `AppData.DataSchemas[${schemas.indexOf(sch)}].Attributes[${newIndex}]`,
  };

  attrs.push(newAttr);
  sch.Attributes = attrs;

  if (!args.apply) {
    return {
      dryRun: true,
      applied: false,
      table: args.tableName,
      column: args.columnName,
      message: `dry-run。新規バーチャル列 '${args.columnName}' (${resultType}) を追加するペイロードを構築済み。apply: true で送信。`,
    };
  }

  const result = await postSaveApp(credential.appId, appName, app);
  const refreshed = result.app ?? (await fetchLoadApp(appName)).app;
  const refreshedSch = (refreshed.AppData?.DataSchemas ?? []).find(
    (s) => s.AutoSchemaFrom === args.tableName,
  );
  const created = (refreshedSch?.Attributes ?? []).find((a) => a.Name === args.columnName) as Record<string, unknown> | undefined;
  await writeFile(snapshotPath(credential.appId), JSON.stringify(refreshed, null, 2), "utf8");

  return {
    dryRun: false,
    applied: !!created,
    table: args.tableName,
    column: args.columnName,
    componentId: created?.ComponentId as string,
    message: created
      ? `✅ 新規バーチャル列 '${args.columnName}' (${resultType}) 作成完了・検証 OK`
      : `⚠️ saveapp は Success だが事後検証で列が見当たらない`,
  };
}

export async function cloneView(args: {
  appId?: string;
  appName?: string;
  sourceViewName: string;
  newViewName: string;
  targetTable?: string;
  position?: string;
  apply?: boolean;
}): Promise<{
  dryRun: boolean;
  applied: boolean;
  source: string;
  newView: string;
  table?: string;
  componentId?: string;
  message: string;
}> {
  const credential = resolveCredential(args.appId);
  const appName = await lookupAppName(credential.appId, args.appName);
  const { app } = await fetchLoadApp(appName);
  const controls = ((app as Record<string, unknown>).Presentation as Record<string, unknown>)?.Controls as Array<Record<string, unknown>> | undefined;
  if (!controls) throw new Error("Presentation.Controls が見つかりません");

  const source = controls.find((c) => c.Name === args.sourceViewName);
  if (!source) {
    const known = controls.map((c) => c.Name).join(", ");
    throw new Error(`元の View '${args.sourceViewName}' が見つかりません。既知: ${known}`);
  }
  if (controls.find((c) => c.Name === args.newViewName)) {
    throw new Error(`View '${args.newViewName}' は既に存在します`);
  }

  const clone = JSON.parse(JSON.stringify(source)) as Record<string, unknown>;
  clone.Name = args.newViewName;
  if (args.targetTable) clone.TableOrFolderName = args.targetTable;
  if (args.position) clone.Position = args.position;
  clone.ComponentId = generateComponentId();
  clone._isNew = true;
  clone._version = 0;
  clone._index = controls.length;
  clone._path = `Presentation.Controls[${controls.length}]`;
  controls.push(clone);

  if (!args.apply) {
    return {
      dryRun: true,
      applied: false,
      source: args.sourceViewName,
      newView: args.newViewName,
      table: args.targetTable ?? (source.TableOrFolderName as string | undefined),
      message: `dry-run。'${args.sourceViewName}' をクローンして '${args.newViewName}' を作るペイロード構築済み。apply: true で送信。`,
    };
  }

  const result = await postSaveApp(credential.appId, appName, app);
  const refreshed = result.app ?? (await fetchLoadApp(appName)).app;
  const refreshedControls = ((refreshed as Record<string, unknown>).Presentation as Record<string, unknown>)?.Controls as Array<Record<string, unknown>> | undefined;
  const created = refreshedControls?.find((c) => c.Name === args.newViewName) as Record<string, unknown> | undefined;
  await writeFile(snapshotPath(credential.appId), JSON.stringify(refreshed, null, 2), "utf8");

  return {
    dryRun: false,
    applied: !!created,
    source: args.sourceViewName,
    newView: args.newViewName,
    table: created?.TableOrFolderName as string | undefined,
    componentId: created?.ComponentId as string,
    message: created
      ? `✅ View '${args.newViewName}' を '${args.sourceViewName}' からクローン作成完了`
      : `⚠️ saveapp は Success だが事後検証で View が見当たらない`,
  };
}

export async function cloneAction(args: {
  appId?: string;
  appName?: string;
  sourceActionName: string;
  newActionName: string;
  targetTable?: string;
  targetColumn?: string;
  apply?: boolean;
}): Promise<{
  dryRun: boolean;
  applied: boolean;
  source: string;
  newAction: string;
  table?: string;
  componentId?: string;
  message: string;
}> {
  const credential = resolveCredential(args.appId);
  const appName = await lookupAppName(credential.appId, args.appName);
  const { app } = await fetchLoadApp(appName);
  const actions = ((app as Record<string, unknown>).AppData as Record<string, unknown>)?.DataActions as Array<Record<string, unknown>> | undefined;
  if (!actions) throw new Error("AppData.DataActions が見つかりません");

  const source = actions.find((a) => a.Name === args.sourceActionName);
  if (!source) {
    const known = actions.slice(0, 10).map((a) => a.Name).join(", ");
    throw new Error(`元の Action '${args.sourceActionName}' が見つかりません。既知（先頭 10 件）: ${known}`);
  }
  if (actions.find((a) => a.Name === args.newActionName)) {
    throw new Error(`Action '${args.newActionName}' は既に存在します`);
  }

  const clone = JSON.parse(JSON.stringify(source)) as Record<string, unknown>;
  clone.Name = args.newActionName;
  if (args.targetTable) clone.Table = args.targetTable;
  if (args.targetColumn !== undefined) clone.ColumnToEdit = args.targetColumn;
  clone.ComponentId = generateComponentId();
  clone._isNew = true;
  clone._version = 0;
  clone._index = actions.length;
  clone._path = `AppData.DataActions[${actions.length}]`;
  actions.push(clone);

  if (!args.apply) {
    return {
      dryRun: true,
      applied: false,
      source: args.sourceActionName,
      newAction: args.newActionName,
      table: args.targetTable ?? (source.Table as string | undefined),
      message: `dry-run。'${args.sourceActionName}' をクローンして '${args.newActionName}' を作るペイロード構築済み。apply: true で送信。`,
    };
  }

  const result = await postSaveApp(credential.appId, appName, app);
  const refreshed = result.app ?? (await fetchLoadApp(appName)).app;
  const refreshedActions = ((refreshed as Record<string, unknown>).AppData as Record<string, unknown>)?.DataActions as Array<Record<string, unknown>> | undefined;
  const created = refreshedActions?.find((a) => a.Name === args.newActionName) as Record<string, unknown> | undefined;
  await writeFile(snapshotPath(credential.appId), JSON.stringify(refreshed, null, 2), "utf8");

  return {
    dryRun: false,
    applied: !!created,
    source: args.sourceActionName,
    newAction: args.newActionName,
    table: created?.Table as string | undefined,
    componentId: created?.ComponentId as string,
    message: created
      ? `✅ Action '${args.newActionName}' を '${args.sourceActionName}' からクローン作成完了`
      : `⚠️ saveapp は Success だが事後検証で Action が見当たらない`,
  };
}

export async function cloneBot(args: {
  appId?: string;
  appName?: string;
  sourceBotName: string;
  newBotName: string;
  apply?: boolean;
}): Promise<{
  dryRun: boolean;
  applied: boolean;
  source: string;
  newBot: string;
  componentIds?: { bot: string; event: string; process: string; tasks: string[] };
  message: string;
}> {
  const credential = resolveCredential(args.appId);
  const appName = await lookupAppName(credential.appId, args.appName);
  const { app } = await fetchLoadApp(appName);
  const behavior = (app as Record<string, unknown>).Behavior as Record<string, unknown>;
  const bots = (behavior.AppBots ?? []) as Array<Record<string, unknown>>;
  const events = (behavior.AppEvents ?? []) as Array<Record<string, unknown>>;
  const processes = (behavior.AppProcesses ?? []) as Array<Record<string, unknown>>;
  const tasks = (behavior.Tasks ?? []) as Array<Record<string, unknown>>;

  const sourceBot = bots.find((b) => b.Name === args.sourceBotName);
  if (!sourceBot) {
    const known = bots.map((b) => b.Name).join(", ");
    throw new Error(`元の Bot '${args.sourceBotName}' が見つかりません。既知: ${known}`);
  }
  if (bots.find((b) => b.Name === args.newBotName)) {
    throw new Error(`Bot '${args.newBotName}' は既に存在します`);
  }

  const sourceEvent = events.find((e) => e.Name === sourceBot.EventName);
  const sourceProcess = processes.find((p) => p.Name === sourceBot.ProcessName);
  if (!sourceEvent) throw new Error(`Bot に紐づく Event '${sourceBot.EventName}' が見つかりません`);
  if (!sourceProcess) throw new Error(`Bot に紐づく Process '${sourceBot.ProcessName}' が見つかりません`);

  // Process.Nodes が参照する Action/Task 名を集める（name フィールド）
  const sourceNodes = (sourceProcess.Nodes ?? []) as Array<Record<string, unknown>>;
  const referencedTaskNames = new Set<string>();
  for (const node of sourceNodes) {
    if (typeof node.Action === "string") referencedTaskNames.add(node.Action);
  }
  const sourceTasks = tasks.filter((t) => referencedTaskNames.has(t.Name as string));

  // 新しい名前体系
  const newEventName = `event_${args.newBotName}`;
  const newProcessName = `Process for ${args.newBotName}`;
  const newTaskNameMap = new Map<string, string>();
  for (const t of sourceTasks) {
    newTaskNameMap.set(t.Name as string, `Task for ${args.newBotName} - ${t.Name}`);
  }

  // Bot
  const newBot = JSON.parse(JSON.stringify(sourceBot)) as Record<string, unknown>;
  newBot.Name = args.newBotName;
  newBot.EventName = newEventName;
  newBot.ProcessName = newProcessName;
  newBot.ComponentId = generateComponentId();
  newBot._isNew = true;
  newBot._version = 0;
  newBot._index = bots.length;
  newBot._path = `Behavior.AppBots[${bots.length}]`;

  // Event
  const newEvent = JSON.parse(JSON.stringify(sourceEvent)) as Record<string, unknown>;
  newEvent.Name = newEventName;
  newEvent.ComponentId = generateComponentId();
  if ((newEvent.AppEventDefinition as Record<string, unknown>)?.ComponentId) {
    (newEvent.AppEventDefinition as Record<string, unknown>).ComponentId = generateComponentId();
  }
  newEvent._isNew = true;
  newEvent._version = 0;
  newEvent._index = events.length;
  newEvent._path = `Behavior.AppEvents[${events.length}]`;

  // Process（Nodes 内の Action 参照を新しい Task 名に置換）
  const newProcess = JSON.parse(JSON.stringify(sourceProcess)) as Record<string, unknown>;
  newProcess.Name = newProcessName;
  newProcess.ComponentId = generateComponentId();
  newProcess._isNew = true;
  newProcess._version = 0;
  newProcess._index = processes.length;
  newProcess._path = `Behavior.AppProcesses[${processes.length}]`;
  newProcess.ProcessStateTableName = `${newProcessName} State Table`;
  const newNodes = (newProcess.Nodes ?? []) as Array<Record<string, unknown>>;
  for (const node of newNodes) {
    if (typeof node.Action === "string" && newTaskNameMap.has(node.Action)) {
      node.Action = newTaskNameMap.get(node.Action);
    }
    node.ComponentId = generateComponentId();
  }

  // Tasks（複数ありうる）
  const newTasks: Array<Record<string, unknown>> = [];
  for (const t of sourceTasks) {
    const newTask = JSON.parse(JSON.stringify(t)) as Record<string, unknown>;
    newTask.Name = newTaskNameMap.get(t.Name as string)!;
    newTask.ComponentId = generateComponentId();
    newTask._isNew = true;
    newTask._version = 0;
    newTask._index = tasks.length + newTasks.length;
    newTask._path = `Behavior.Tasks[${tasks.length + newTasks.length}]`;
    newTasks.push(newTask);
  }

  // 配列に push
  bots.push(newBot);
  events.push(newEvent);
  processes.push(newProcess);
  for (const t of newTasks) tasks.push(t);

  if (!args.apply) {
    return {
      dryRun: true,
      applied: false,
      source: args.sourceBotName,
      newBot: args.newBotName,
      message: `dry-run。Bot/Event/Process/Tasks(${newTasks.length}) のクローン構築済み。apply: true で送信。`,
    };
  }

  const result = await postSaveApp(credential.appId, appName, app);
  const refreshed = result.app ?? (await fetchLoadApp(appName)).app;
  const refreshedBots = ((refreshed as Record<string, unknown>).Behavior as Record<string, unknown>)?.AppBots as Array<Record<string, unknown>> | undefined;
  const created = refreshedBots?.find((b) => b.Name === args.newBotName);
  await writeFile(snapshotPath(credential.appId), JSON.stringify(refreshed, null, 2), "utf8");

  return {
    dryRun: false,
    applied: !!created,
    source: args.sourceBotName,
    newBot: args.newBotName,
    componentIds: {
      bot: newBot.ComponentId as string,
      event: newEvent.ComponentId as string,
      process: newProcess.ComponentId as string,
      tasks: newTasks.map((t) => t.ComponentId as string),
    },
    message: created
      ? `✅ Bot '${args.newBotName}' を '${args.sourceBotName}' からクローン作成完了（Event/Process/Tasks も含む）`
      : `⚠️ saveapp は Success だが事後検証で Bot が見当たらない`,
  };
}

export async function removeBot(args: {
  appId?: string;
  appName?: string;
  botName: string;
  apply?: boolean;
}): Promise<{
  dryRun: boolean;
  applied: boolean;
  botName: string;
  removedEvent?: string;
  removedProcess?: string;
  removedTasks?: string[];
  message: string;
}> {
  const credential = resolveCredential(args.appId);
  const appName = await lookupAppName(credential.appId, args.appName);
  const { app } = await fetchLoadApp(appName);
  const behavior = (app as Record<string, unknown>).Behavior as Record<string, unknown>;
  const bots = (behavior.AppBots ?? []) as Array<Record<string, unknown>>;
  const events = (behavior.AppEvents ?? []) as Array<Record<string, unknown>>;
  const processes = (behavior.AppProcesses ?? []) as Array<Record<string, unknown>>;
  const tasks = (behavior.Tasks ?? []) as Array<Record<string, unknown>>;

  const botIdx = bots.findIndex((b) => b.Name === args.botName);
  if (botIdx < 0) throw new Error(`Bot '${args.botName}' が見つかりません`);
  const bot = bots[botIdx];

  const eventName = bot.EventName as string | undefined;
  const processName = bot.ProcessName as string | undefined;

  // 紐づく Process の Nodes が参照する Task 名を集める
  const taskNamesToRemove = new Set<string>();
  if (processName) {
    const proc = processes.find((p) => p.Name === processName);
    const nodes = (proc?.Nodes ?? []) as Array<Record<string, unknown>>;
    for (const n of nodes) {
      if (typeof n.Action === "string") taskNamesToRemove.add(n.Action);
    }
  }

  bots.splice(botIdx, 1);
  if (eventName) {
    const eIdx = events.findIndex((e) => e.Name === eventName);
    if (eIdx >= 0) events.splice(eIdx, 1);
  }
  if (processName) {
    const pIdx = processes.findIndex((p) => p.Name === processName);
    if (pIdx >= 0) processes.splice(pIdx, 1);
  }
  const removedTaskNames: string[] = [];
  for (let i = tasks.length - 1; i >= 0; i--) {
    const tn = tasks[i].Name as string;
    if (taskNamesToRemove.has(tn)) {
      tasks.splice(i, 1);
      removedTaskNames.push(tn);
    }
  }

  if (!args.apply) {
    return {
      dryRun: true,
      applied: false,
      botName: args.botName,
      removedEvent: eventName,
      removedProcess: processName,
      removedTasks: removedTaskNames,
      message: "dry-run。apply: true で削除送信。",
    };
  }

  const result = await postSaveApp(credential.appId, appName, app);
  const refreshed = result.app ?? (await fetchLoadApp(appName)).app;
  const stillThere = (((refreshed as Record<string, unknown>).Behavior as Record<string, unknown>)?.AppBots as Array<Record<string, unknown>> | undefined)?.find((b) => b.Name === args.botName);
  await writeFile(snapshotPath(credential.appId), JSON.stringify(refreshed, null, 2), "utf8");

  return {
    dryRun: false,
    applied: !stillThere,
    botName: args.botName,
    removedEvent: eventName,
    removedProcess: processName,
    removedTasks: removedTaskNames,
    message: stillThere ? "⚠️ 削除拒否された可能性" : `✅ Bot '${args.botName}' とその Event/Process/Tasks を削除完了`,
  };
}

export async function removeView(args: {
  appId?: string;
  appName?: string;
  viewName: string;
  apply?: boolean;
}): Promise<{ dryRun: boolean; applied: boolean; viewName: string; message: string }> {
  const credential = resolveCredential(args.appId);
  const appName = await lookupAppName(credential.appId, args.appName);
  const { app } = await fetchLoadApp(appName);
  const controls = ((app as Record<string, unknown>).Presentation as Record<string, unknown>)?.Controls as Array<Record<string, unknown>> | undefined;
  if (!controls) throw new Error("Controls 不明");
  const idx = controls.findIndex((c) => c.Name === args.viewName);
  if (idx < 0) throw new Error(`View '${args.viewName}' が見つかりません`);
  controls.splice(idx, 1);

  if (!args.apply) return { dryRun: true, applied: false, viewName: args.viewName, message: "dry-run" };

  const result = await postSaveApp(credential.appId, appName, app);
  const refreshed = result.app ?? (await fetchLoadApp(appName)).app;
  const refreshedControls = ((refreshed as Record<string, unknown>).Presentation as Record<string, unknown>)?.Controls as Array<Record<string, unknown>> | undefined;
  const stillThere = refreshedControls?.find((c) => c.Name === args.viewName);
  await writeFile(snapshotPath(credential.appId), JSON.stringify(refreshed, null, 2), "utf8");
  return {
    dryRun: false,
    applied: !stillThere,
    viewName: args.viewName,
    message: stillThere ? "⚠️ 削除拒否された可能性" : `✅ View '${args.viewName}' 削除完了`,
  };
}

export async function removeAction(args: {
  appId?: string;
  appName?: string;
  actionName: string;
  apply?: boolean;
}): Promise<{ dryRun: boolean; applied: boolean; actionName: string; message: string }> {
  const credential = resolveCredential(args.appId);
  const appName = await lookupAppName(credential.appId, args.appName);
  const { app } = await fetchLoadApp(appName);
  const actions = ((app as Record<string, unknown>).AppData as Record<string, unknown>)?.DataActions as Array<Record<string, unknown>> | undefined;
  if (!actions) throw new Error("DataActions 不明");
  const idx = actions.findIndex((a) => a.Name === args.actionName);
  if (idx < 0) throw new Error(`Action '${args.actionName}' が見つかりません`);
  actions.splice(idx, 1);

  if (!args.apply) return { dryRun: true, applied: false, actionName: args.actionName, message: "dry-run" };

  const result = await postSaveApp(credential.appId, appName, app);
  const refreshed = result.app ?? (await fetchLoadApp(appName)).app;
  const refreshedActions = ((refreshed as Record<string, unknown>).AppData as Record<string, unknown>)?.DataActions as Array<Record<string, unknown>> | undefined;
  const stillThere = refreshedActions?.find((a) => a.Name === args.actionName);
  await writeFile(snapshotPath(credential.appId), JSON.stringify(refreshed, null, 2), "utf8");
  return {
    dryRun: false,
    applied: !stillThere,
    actionName: args.actionName,
    message: stillThere ? "⚠️ 削除拒否された可能性" : `✅ Action '${args.actionName}' 削除完了`,
  };
}

export async function removeColumn(args: {
  appId?: string;
  appName?: string;
  tableName: string;
  columnName: string;
  apply?: boolean;
}): Promise<{
  dryRun: boolean;
  applied: boolean;
  table: string;
  column: string;
  isVirtual: boolean;
  message: string;
  warning?: string;
}> {
  const credential = resolveCredential(args.appId);
  const appName = await lookupAppName(credential.appId, args.appName);
  const { app } = await fetchLoadApp(appName);

  const schemas = app.AppData?.DataSchemas ?? [];
  const schIndex = schemas.findIndex((s) => s.AutoSchemaFrom === args.tableName);
  if (schIndex < 0) throw new Error(`スキーマ '${args.tableName}' が見つかりません`);
  const sch = schemas[schIndex];
  const attrs = (sch.Attributes ?? []) as Array<Record<string, unknown>>;
  const idx = attrs.findIndex((a) => a.Name === args.columnName);
  if (idx < 0) throw new Error(`列 '${args.columnName}' が見つかりません`);

  const target = attrs[idx];
  const isVirtual = !!target.IsVirtual;
  const isKey = !!target.IsKey;
  const warnings: string[] = [];
  if (isKey) warnings.push("キー列の削除は推奨されません（参照系が崩壊する可能性）");
  if (!isVirtual) warnings.push("非バーチャル列を削除する場合、データソース側の列が残ります");

  attrs.splice(idx, 1);
  sch.Attributes = attrs;

  if (!args.apply) {
    return {
      dryRun: true,
      applied: false,
      table: args.tableName,
      column: args.columnName,
      isVirtual,
      warning: warnings.join(" / ") || undefined,
      message: "dry-run。apply: true で削除送信。",
    };
  }

  const result = await postSaveApp(credential.appId, appName, app);
  const refreshed = result.app ?? (await fetchLoadApp(appName)).app;
  const refreshedSch = (refreshed.AppData?.DataSchemas ?? []).find(
    (s) => s.AutoSchemaFrom === args.tableName,
  );
  const stillThere = (refreshedSch?.Attributes ?? []).find((a) => a.Name === args.columnName);
  await writeFile(snapshotPath(credential.appId), JSON.stringify(refreshed, null, 2), "utf8");

  return {
    dryRun: false,
    applied: !stillThere,
    table: args.tableName,
    column: args.columnName,
    isVirtual,
    warning: warnings.join(" / ") || undefined,
    message: stillThere
      ? "⚠️ saveapp は Success だが列がまだ存在する（AppSheet が削除を拒否した可能性）"
      : `✅ 列 '${args.columnName}' 削除完了・検証 OK`,
  };
}

interface Evaluatable {
  SourceExpr?: string;
}

function extractEvalSource(e: unknown): string | null {
  if (!e || typeof e !== "object") return null;
  const ev = e as Evaluatable;
  return ev.SourceExpr ?? null;
}

function normalizeFormula(formula: string): string {
  return formula.startsWith("=") ? formula : "=" + formula;
}

export async function setColumnFormula(args: {
  appId?: string;
  appName?: string;
  tableName: string;
  columnName: string;
  kind: "AppFormula" | "InitialValue";
  formula: string;
  apply?: boolean;
}): Promise<{
  dryRun: boolean;
  applied: boolean;
  table: string;
  column: string;
  kind: string;
  before: string | null;
  requested: string;
  after?: string | null;
  verified?: boolean;
  message: string;
}> {
  const credential = resolveCredential(args.appId);
  const appName = await lookupAppName(credential.appId, args.appName);
  const { app } = await fetchLoadApp(appName);
  const attr = findAttribute(app, args.tableName, args.columnName);
  const newFormula = normalizeFormula(args.formula);

  let before: string | null;
  if (args.kind === "AppFormula") {
    before = (attr.AppFormula ?? null) as string | null;
  } else {
    before = (attr.Default ?? null) as string | null;
  }

  const applyFn = (a: AppDef) => {
    const target = findAttribute(a, args.tableName, args.columnName);
    if (args.kind === "AppFormula") {
      target.AppFormula = newFormula;
      if (target.InternalQualifier && typeof target.InternalQualifier === "object") {
        const iq = target.InternalQualifier as Record<string, unknown>;
        delete iq.AppFormulaExpression;
      }
    } else {
      target.Default = newFormula;
      if (target.InternalQualifier && typeof target.InternalQualifier === "object") {
        const iq = target.InternalQualifier as Record<string, unknown>;
        delete iq.DefaultExpression;
      }
    }
  };
  applyFn(app);

  if (before === newFormula) {
    return {
      dryRun: !args.apply,
      applied: false,
      table: args.tableName,
      column: args.columnName,
      kind: args.kind,
      before,
      requested: newFormula,
      message: "変更不要（既に同じ式）",
    };
  }

  if (!args.apply) {
    return {
      dryRun: true,
      applied: false,
      table: args.tableName,
      column: args.columnName,
      kind: args.kind,
      before,
      requested: newFormula,
      message: "dry-run。apply: true で送信。",
    };
  }

  const { refreshed } = await applyChangesAndSave(credential, appName, applyFn, app);
  const refreshedAttr = findAttribute(refreshed, args.tableName, args.columnName);
  const after = (args.kind === "AppFormula" ? refreshedAttr.AppFormula : refreshedAttr.Default) as string | null;
  await writeFile(snapshotPath(credential.appId), JSON.stringify(refreshed, null, 2), "utf8");

  return {
    dryRun: false,
    applied: true,
    table: args.tableName,
    column: args.columnName,
    kind: args.kind,
    before,
    requested: newFormula,
    after,
    verified: after === newFormula,
    message: after === newFormula ? "✅ 式更新完了・検証 OK" : `⚠️ 期待 '${newFormula}' だが現在 '${after}'`,
  };
}

export async function setActionCondition(args: {
  appId?: string;
  appName?: string;
  actionName: string;
  condition: string;
  apply?: boolean;
}): Promise<{
  dryRun: boolean;
  applied: boolean;
  actionName: string;
  before: string | null;
  requested: string;
  after?: string | null;
  verified?: boolean;
  message: string;
}> {
  const credential = resolveCredential(args.appId);
  const appName = await lookupAppName(credential.appId, args.appName);
  const { app } = await fetchLoadApp(appName);
  const actions = ((app as Record<string, unknown>).AppData as Record<string, unknown>)?.DataActions as Array<Record<string, unknown>> | undefined;
  if (!actions) throw new Error("DataActions 不明");
  const action = actions.find((a) => a.Name === args.actionName);
  if (!action) throw new Error(`Action '${args.actionName}' が見つかりません`);
  const newCond = normalizeFormula(args.condition);
  const before = (action.Condition ?? extractEvalSource(action.ConditionEvaluatable as Evaluatable | null | undefined)) as string | null;

  action.Condition = newCond;
  action.ConditionEvaluatable = null; // 再パースを促す

  if (before === newCond) {
    return { dryRun: !args.apply, applied: false, actionName: args.actionName, before, requested: newCond, message: "変更不要" };
  }
  if (!args.apply) {
    return { dryRun: true, applied: false, actionName: args.actionName, before, requested: newCond, message: "dry-run" };
  }

  const result = await postSaveApp(credential.appId, appName, app);
  const refreshed = result.app ?? (await fetchLoadApp(appName)).app;
  const refreshedAction = (((refreshed as Record<string, unknown>).AppData as Record<string, unknown>)?.DataActions as Array<Record<string, unknown>> | undefined)?.find((a) => a.Name === args.actionName);
  const after = (refreshedAction?.Condition ?? extractEvalSource(refreshedAction?.ConditionEvaluatable as Evaluatable | null | undefined)) as string | null;
  await writeFile(snapshotPath(credential.appId), JSON.stringify(refreshed, null, 2), "utf8");
  return {
    dryRun: false,
    applied: true,
    actionName: args.actionName,
    before,
    requested: newCond,
    after,
    verified: after === newCond,
    message: after === newCond ? "✅ 条件式更新完了" : `⚠️ 期待 '${newCond}' だが現在 '${after}'`,
  };
}

export async function setActionValue(args: {
  appId?: string;
  appName?: string;
  actionName: string;
  value: string;
  apply?: boolean;
}): Promise<{
  dryRun: boolean;
  applied: boolean;
  actionName: string;
  before: string | null;
  requested: string;
  after?: string | null;
  verified?: boolean;
  message: string;
}> {
  const credential = resolveCredential(args.appId);
  const appName = await lookupAppName(credential.appId, args.appName);
  const { app } = await fetchLoadApp(appName);
  const actions = ((app as Record<string, unknown>).AppData as Record<string, unknown>)?.DataActions as Array<Record<string, unknown>> | undefined;
  if (!actions) throw new Error("DataActions 不明");
  const action = actions.find((a) => a.Name === args.actionName);
  if (!action) throw new Error(`Action '${args.actionName}' が見つかりません`);
  const newVal = normalizeFormula(args.value);
  const before = (action.Value ?? extractEvalSource(action.ValueEvaluatable as Evaluatable | null | undefined)) as string | null;

  action.Value = newVal;
  action.ValueEvaluatable = null;

  if (before === newVal) {
    return { dryRun: !args.apply, applied: false, actionName: args.actionName, before, requested: newVal, message: "変更不要" };
  }
  if (!args.apply) {
    return { dryRun: true, applied: false, actionName: args.actionName, before, requested: newVal, message: "dry-run" };
  }

  const result = await postSaveApp(credential.appId, appName, app);
  const refreshed = result.app ?? (await fetchLoadApp(appName)).app;
  const refreshedAction = (((refreshed as Record<string, unknown>).AppData as Record<string, unknown>)?.DataActions as Array<Record<string, unknown>> | undefined)?.find((a) => a.Name === args.actionName);
  const after = (refreshedAction?.Value ?? extractEvalSource(refreshedAction?.ValueEvaluatable as Evaluatable | null | undefined)) as string | null;
  await writeFile(snapshotPath(credential.appId), JSON.stringify(refreshed, null, 2), "utf8");
  return {
    dryRun: false,
    applied: true,
    actionName: args.actionName,
    before,
    requested: newVal,
    after,
    verified: after === newVal,
    message: after === newVal ? "✅ 値式更新完了" : `⚠️ 期待 '${newVal}' だが現在 '${after}'`,
  };
}

export async function setEnumValues(args: {
  appId?: string;
  appName?: string;
  tableName: string;
  columnName: string;
  values: string[];
  apply?: boolean;
}): Promise<{
  dryRun: boolean;
  applied: boolean;
  table: string;
  column: string;
  before?: string[];
  requested: string[];
  after?: string[];
  verified?: boolean;
  message: string;
}> {
  const credential = resolveCredential(args.appId);
  const appName = await lookupAppName(credential.appId, args.appName);
  const { app } = await fetchLoadApp(appName);
  const attr = findAttribute(app, args.tableName, args.columnName);
  const type = attr.Type as string;
  if (type !== "Enum" && type !== "EnumList") {
    throw new Error(`列 '${args.columnName}' の型は ${type}。Enum / EnumList のみ対応`);
  }
  const auxStr = attr.TypeAuxData as string;
  const aux = auxStr ? JSON.parse(auxStr) : {};
  const before = (aux.EnumValues ?? aux.Values ?? []) as string[];

  const applyFn = (a: AppDef) => {
    const target = findAttribute(a, args.tableName, args.columnName);
    const tAux = target.TypeAuxData ? JSON.parse(target.TypeAuxData as string) : {};
    tAux.EnumValues = args.values;
    target.TypeAuxData = JSON.stringify(tAux);
  };
  applyFn(app);

  if (!args.apply) {
    return { dryRun: true, applied: false, table: args.tableName, column: args.columnName, before, requested: args.values, message: "dry-run" };
  }

  const { refreshed } = await applyChangesAndSave(credential, appName, applyFn, app);
  const refreshedAttr = findAttribute(refreshed, args.tableName, args.columnName);
  const refreshedAux = refreshedAttr.TypeAuxData ? JSON.parse(refreshedAttr.TypeAuxData as string) : {};
  const after = (refreshedAux.EnumValues ?? refreshedAux.Values ?? []) as string[];
  await writeFile(snapshotPath(credential.appId), JSON.stringify(refreshed, null, 2), "utf8");
  const verified = JSON.stringify(after) === JSON.stringify(args.values);
  return {
    dryRun: false,
    applied: true,
    table: args.tableName,
    column: args.columnName,
    before,
    requested: args.values,
    after,
    verified,
    message: verified ? "✅ Enum 値更新完了" : `⚠️ 期待 [${args.values.join(",")}] だが現在 [${after.join(",")}]`,
  };
}

export async function addEnumValue(args: {
  appId?: string;
  appName?: string;
  tableName: string;
  columnName: string;
  value: string;
  apply?: boolean;
}): Promise<unknown> {
  const credential = resolveCredential(args.appId);
  const appName = await lookupAppName(credential.appId, args.appName);
  const { app } = await fetchLoadApp(appName);
  const attr = findAttribute(app, args.tableName, args.columnName);
  const aux = attr.TypeAuxData ? JSON.parse(attr.TypeAuxData as string) : {};
  const values = (aux.EnumValues ?? aux.Values ?? []) as string[];
  if (values.includes(args.value)) {
    return { applied: false, message: "既に存在", values };
  }
  return setEnumValues({ ...args, values: [...values, args.value] });
}

export async function removeEnumValue(args: {
  appId?: string;
  appName?: string;
  tableName: string;
  columnName: string;
  value: string;
  apply?: boolean;
}): Promise<unknown> {
  const credential = resolveCredential(args.appId);
  const appName = await lookupAppName(credential.appId, args.appName);
  const { app } = await fetchLoadApp(appName);
  const attr = findAttribute(app, args.tableName, args.columnName);
  const aux = attr.TypeAuxData ? JSON.parse(attr.TypeAuxData as string) : {};
  const values = (aux.EnumValues ?? aux.Values ?? []) as string[];
  if (!values.includes(args.value)) {
    return { applied: false, message: "存在しない", values };
  }
  return setEnumValues({ ...args, values: values.filter((v) => v !== args.value) });
}

export async function cloneTable(args: {
  appId?: string;
  appName?: string;
  sourceTableName: string;
  newTableName: string;
  apply?: boolean;
}): Promise<{
  dryRun: boolean;
  applied: boolean;
  source: string;
  newTable: string;
  cloned: { dataSet: boolean; schema: boolean; actions: number; views: string[] };
  warning?: string;
  message: string;
}> {
  const credential = resolveCredential(args.appId);
  const appName = await lookupAppName(credential.appId, args.appName);
  const { app } = await fetchLoadApp(appName);
  const appData = (app as Record<string, unknown>).AppData as Record<string, unknown>;
  const presentation = (app as Record<string, unknown>).Presentation as Record<string, unknown>;
  const datasets = (appData.DataSets ?? []) as Array<Record<string, unknown>>;
  const schemas = (appData.DataSchemas ?? []) as Array<Record<string, unknown>>;
  const actions = (appData.DataActions ?? []) as Array<Record<string, unknown>>;
  const controls = (presentation.Controls ?? []) as Array<Record<string, unknown>>;

  // 衝突チェック
  if (datasets.find((d) => d.Name === args.newTableName)) {
    throw new Error(`DataSet '${args.newTableName}' は既に存在します`);
  }
  if (schemas.find((s) => s.Name === `${args.newTableName}_Schema`)) {
    throw new Error(`DataSchema '${args.newTableName}_Schema' は既に存在します`);
  }

  const sourceDataSet = datasets.find((d) => d.Name === args.sourceTableName);
  const sourceSchema = schemas.find((s) => s.AutoSchemaFrom === args.sourceTableName);
  if (!sourceDataSet) throw new Error(`DataSet '${args.sourceTableName}' が見つかりません`);
  if (!sourceSchema) throw new Error(`DataSchema for '${args.sourceTableName}' が見つかりません`);

  const sourceActions = actions.filter((a) => a.Table === args.sourceTableName);
  const sourceViews = controls.filter((c) => c.TableOrFolderName === args.sourceTableName);

  // === DataSet クローン ===
  const newDataSet = JSON.parse(JSON.stringify(sourceDataSet)) as Record<string, unknown>;
  newDataSet.Name = args.newTableName;
  newDataSet.ComponentId = generateComponentId();
  newDataSet._isNew = true;
  newDataSet._version = 0;
  newDataSet._index = datasets.length;
  newDataSet._path = `AppData.DataSets[${datasets.length}]`;
  datasets.push(newDataSet);

  // === DataSchema クローン ===
  const newSchema = JSON.parse(JSON.stringify(sourceSchema)) as Record<string, unknown>;
  newSchema.Name = `${args.newTableName}_Schema`;
  newSchema.AutoSchemaFrom = args.newTableName;
  newSchema.ComponentId = generateComponentId();
  newSchema._isNew = true;
  newSchema._version = 0;
  newSchema._index = schemas.length;
  newSchema._path = `AppData.DataSchemas[${schemas.length}]`;
  // Attributes の各 ComponentId を再生成
  const newAttrs = (newSchema.Attributes ?? []) as Array<Record<string, unknown>>;
  for (const a of newAttrs) {
    a.ComponentId = generateComponentId();
  }
  schemas.push(newSchema);

  // === Actions クローン（Table 名のみ書換）===
  let actionCount = 0;
  for (const src of sourceActions) {
    const clone = JSON.parse(JSON.stringify(src)) as Record<string, unknown>;
    clone.Table = args.newTableName;
    clone.ComponentId = generateComponentId();
    clone._isNew = true;
    clone._version = 0;
    clone._index = actions.length;
    clone._path = `AppData.DataActions[${actions.length}]`;
    actions.push(clone);
    actionCount++;
  }

  // === Views クローン（Name と TableOrFolderName 書換）===
  const viewNamesAdded: string[] = [];
  for (const src of sourceViews) {
    const clone = JSON.parse(JSON.stringify(src)) as Record<string, unknown>;
    const oldName = src.Name as string;
    let newName: string;
    if (oldName === args.sourceTableName) {
      newName = args.newTableName;
    } else if (oldName.startsWith(`${args.sourceTableName}_`)) {
      newName = `${args.newTableName}_${oldName.slice(args.sourceTableName.length + 1)}`;
    } else {
      newName = `${args.newTableName} ${oldName}`;
    }
    // 衝突回避
    if (controls.find((c) => c.Name === newName) || viewNamesAdded.includes(newName)) {
      newName = `${newName}_${Math.random().toString(36).slice(2, 7)}`;
    }
    clone.Name = newName;
    clone.TableOrFolderName = args.newTableName;
    clone.ComponentId = generateComponentId();
    clone._isNew = true;
    clone._version = 0;
    clone._index = controls.length;
    clone._path = `Presentation.Controls[${controls.length}]`;
    controls.push(clone);
    viewNamesAdded.push(newName);
  }

  const warning = "DataSet.Source は元のシートを参照したまま。物理シートを別にしたい場合は AppSheet Editor で個別に変更してください。";

  if (!args.apply) {
    return {
      dryRun: true,
      applied: false,
      source: args.sourceTableName,
      newTable: args.newTableName,
      cloned: { dataSet: true, schema: true, actions: actionCount, views: viewNamesAdded },
      warning,
      message: `dry-run。DataSet + Schema(${newAttrs.length} cols) + Actions(${actionCount}) + Views(${viewNamesAdded.length}) を構築済み。apply: true で送信。`,
    };
  }

  const result = await postSaveApp(credential.appId, appName, app);
  const refreshed = result.app ?? (await fetchLoadApp(appName)).app;
  const refreshedDatasets = (((refreshed as Record<string, unknown>).AppData as Record<string, unknown>).DataSets ?? []) as Array<Record<string, unknown>>;
  const created = refreshedDatasets.find((d) => d.Name === args.newTableName);
  await writeFile(snapshotPath(credential.appId), JSON.stringify(refreshed, null, 2), "utf8");

  return {
    dryRun: false,
    applied: !!created,
    source: args.sourceTableName,
    newTable: args.newTableName,
    cloned: { dataSet: true, schema: true, actions: actionCount, views: viewNamesAdded },
    warning,
    message: created
      ? `✅ Table '${args.newTableName}' をクローン作成完了（DataSet/Schema/Actions x${actionCount}/Views x${viewNamesAdded.length}）`
      : `⚠️ saveapp は Success だが事後検証で DataSet が見当たらない`,
  };
}

export async function removeTable(args: {
  appId?: string;
  appName?: string;
  tableName: string;
  apply?: boolean;
}): Promise<{
  dryRun: boolean;
  applied: boolean;
  tableName: string;
  removed: { dataSet: boolean; schema: boolean; actions: number; views: number };
  message: string;
}> {
  const credential = resolveCredential(args.appId);
  const appName = await lookupAppName(credential.appId, args.appName);
  const { app } = await fetchLoadApp(appName);
  const appData = (app as Record<string, unknown>).AppData as Record<string, unknown>;
  const presentation = (app as Record<string, unknown>).Presentation as Record<string, unknown>;
  const datasets = (appData.DataSets ?? []) as Array<Record<string, unknown>>;
  const schemas = (appData.DataSchemas ?? []) as Array<Record<string, unknown>>;
  const actions = (appData.DataActions ?? []) as Array<Record<string, unknown>>;
  const controls = (presentation.Controls ?? []) as Array<Record<string, unknown>>;

  const dsIdx = datasets.findIndex((d) => d.Name === args.tableName);
  if (dsIdx < 0) throw new Error(`DataSet '${args.tableName}' が見つかりません`);

  const removed = { dataSet: false, schema: false, actions: 0, views: 0 };
  datasets.splice(dsIdx, 1);
  removed.dataSet = true;
  const schIdx = schemas.findIndex((s) => s.AutoSchemaFrom === args.tableName);
  if (schIdx >= 0) {
    schemas.splice(schIdx, 1);
    removed.schema = true;
  }
  for (let i = actions.length - 1; i >= 0; i--) {
    if (actions[i].Table === args.tableName) {
      actions.splice(i, 1);
      removed.actions++;
    }
  }
  for (let i = controls.length - 1; i >= 0; i--) {
    if (controls[i].TableOrFolderName === args.tableName) {
      controls.splice(i, 1);
      removed.views++;
    }
  }

  if (!args.apply) {
    return {
      dryRun: true,
      applied: false,
      tableName: args.tableName,
      removed,
      message: `dry-run。DataSet + Schema + Actions(${removed.actions}) + Views(${removed.views}) を削除予定。`,
    };
  }

  const result = await postSaveApp(credential.appId, appName, app);
  const refreshed = result.app ?? (await fetchLoadApp(appName)).app;
  const refreshedDS = (((refreshed as Record<string, unknown>).AppData as Record<string, unknown>).DataSets ?? []) as Array<Record<string, unknown>>;
  const stillThere = refreshedDS.find((d) => d.Name === args.tableName);
  await writeFile(snapshotPath(credential.appId), JSON.stringify(refreshed, null, 2), "utf8");
  return {
    dryRun: false,
    applied: !stillThere,
    tableName: args.tableName,
    removed,
    message: stillThere
      ? "⚠️ saveapp は Success だが Table がまだ存在する"
      : `✅ Table '${args.tableName}' とその全関連エンティティを削除完了`,
  };
}

export async function setColumnDescription(args: {
  appId?: string;
  appName?: string;
  tableName: string;
  columnName: string;
  description: string;
  apply?: boolean;
}): Promise<{ dryRun: boolean; applied: boolean; table: string; column: string; before: string | null; requested: string; after?: string | null; verified?: boolean; message: string; }> {
  const credential = resolveCredential(args.appId);
  const appName = await lookupAppName(credential.appId, args.appName);
  const { app } = await fetchLoadApp(appName);
  const attr = findAttribute(app, args.tableName, args.columnName);
  const before = (attr.Description ?? null) as string | null;

  if (before === args.description) {
    return {
      dryRun: !args.apply,
      applied: false,
      table: args.tableName,
      column: args.columnName,
      before,
      requested: args.description,
      message: "変更不要（既に同じ値）",
    };
  }

  const applyFn = (a: AppDef) => {
    const target = findAttribute(a, args.tableName, args.columnName);
    target.Description = args.description;
  };
  applyFn(app);

  if (!args.apply) {
    return {
      dryRun: true,
      applied: false,
      table: args.tableName,
      column: args.columnName,
      before,
      requested: args.description,
      message: "dry-run。apply: true で実際送信。",
    };
  }

  const { refreshed } = await applyChangesAndSave(credential, appName, applyFn, app);
  const refreshedAttr = findAttribute(refreshed, args.tableName, args.columnName);
  const after = (refreshedAttr.Description ?? null) as string | null;
  await writeFile(snapshotPath(credential.appId), JSON.stringify(refreshed, null, 2), "utf8");

  return {
    dryRun: false,
    applied: true,
    table: args.tableName,
    column: args.columnName,
    before,
    requested: args.description,
    after,
    verified: after === args.description || after === `=${args.description}` || after === `=\"${args.description}\"`,
    message: "送信完了・スナップショット更新済み",
  };
}

export async function createTable(args: {
  appId?: string;
  appName?: string;
  newTableName: string;
  sourceQualifier: string;
  templateTableName?: string;
  sourceQualifierId?: string;
  apply?: boolean;
}): Promise<{
  dryRun: boolean;
  applied: boolean;
  newTableName: string;
  templateTableName: string;
  componentId?: string;
  schemaReady?: boolean;
  message: string;
  warning?: string;
}> {
  const credential = resolveCredential(args.appId);
  const appName = await lookupAppName(credential.appId, args.appName);
  const { app } = await fetchLoadApp(appName);

  const appData = (app as Record<string, unknown>).AppData as Record<string, unknown> | undefined;
  if (!appData) throw new Error("AppData が見つかりません");

  const dataSets = (appData.DataSets as Array<Record<string, unknown>> | undefined) ?? [];
  if (dataSets.find((d) => d.Name === args.newTableName)) {
    throw new Error(`テーブル '${args.newTableName}' は既に存在します`);
  }

  // テンプレ DataSet を選定（同じデータソースの既存テーブル）
  let template: Record<string, unknown> | undefined;
  if (args.templateTableName) {
    template = dataSets.find((d) => d.Name === args.templateTableName);
    if (!template) {
      throw new Error(`テンプレ '${args.templateTableName}' が見つかりません`);
    }
  } else {
    template = dataSets.find((d) => d.IsAutoCreated === false && d.Name && !(d.Name as string).startsWith("_") && !(d.Name as string).includes("Process"));
    if (!template) template = dataSets[0];
    if (!template) throw new Error("テンプレに使える既存テーブルがありません。templateTableName で明示指定してください");
  }
  const templateName = template.Name as string;
  const templateRef = template;
  const componentId = generateComponentId();

  const applyFn = (a: AppDef) => {
    const ad = (a as Record<string, unknown>).AppData as Record<string, unknown> | undefined;
    if (!ad) throw new Error("AppData が見つかりません（リトライ時）");
    if (!ad.DataSets) ad.DataSets = [];
    const list = ad.DataSets as Array<Record<string, unknown>>;
    if (list.find((d) => d.Name === args.newTableName)) return;
    const idx = list.length;
    list.push({
      ExprLookup: {},
      Name: args.newTableName,
      SchemaName: "auto",
      PriorSchemaName: null,
      AllowedUpdates: 0,
      UpdateMode: 7,
      HideExistingRows: false,
      UpdateModeExpression: null,
      DataFilter: null,
      DataFilterEvaluatable: null,
      LocaleName: templateRef.LocaleName ?? "ja-JP",
      DataAccessMode: templateRef.DataAccessMode ?? "as app creator",
      IsShared: templateRef.IsShared ?? true,
      DataSourceName: templateRef.DataSourceName,
      ProviderName: templateRef.ProviderName,
      Source: templateRef.Source,
      SourcePath: templateRef.SourcePath,
      SourceQualifier: args.sourceQualifier,
      SourceQualifierId: args.sourceQualifierId ?? null,
      SourceType: templateRef.SourceType ?? "TABLE",
      ColumnOrder: ["_RowNumber"],
      EnablePartitioning: false,
      SourcePartitionDefinition: { Expression: null, Partitions: [], DefaultValue: null },
      EnableWorksheetPartitioning: false,
      WorksheetPartitionDefinition: { Expression: null, Partitions: [], DefaultValue: null },
      CloudObjectStore: templateRef.CloudObjectStore ?? "_Default",
      IsAutoCreated: false,
      ServerCachingInterval: templateRef.ServerCachingInterval ?? "FIVE_MINUTE",
      NeedsSchemaRegen: true,
      ProviderSpecificSchema: null,
      CreatedBy: null,
      AutomationPurpose: 0,
      DocumentCache: null,
      DocumentRefreshRegion: "",
      Comment: null,
      IsValid: true,
      Visibility: "ALWAYS",
      DisableAutoUpdate: false,
      ComponentId: componentId,
      _isNew: true,
      _version: 1,
      _index: idx,
      _path: `AppData.DataSets[${idx}]`,
    });
  };
  applyFn(app);

  const warning = `Schema/Initial View/Default Actions は AppSheet 側で自動生成（SchemaName: "auto", NeedsSchemaRegen: true）。SourceQualifier '${args.sourceQualifier}' がデータソース上に実在しないと saveapp は失敗します。`;

  if (!args.apply) {
    return {
      dryRun: true,
      applied: false,
      newTableName: args.newTableName,
      templateTableName: templateName,
      warning,
      message: `dry-run。テンプレ '${templateName}' のデータソース接続情報をコピーして新テーブル '${args.newTableName}' (SourceQualifier: ${args.sourceQualifier}) を構築。apply: true で送信。`,
    };
  }

  const { refreshed: firstRefreshed } = await applyChangesAndSave(credential, appName, applyFn, app);

  // #4 対応: saveapp 直後は AppSheet 側でスキーマ再生成中の可能性があるため、
  // 最大 5 回まで再 fetchLoadApp して Schema が現れるまで待機する。
  const maxSchemaWait = 5;
  let schemaReady = false;
  let refreshed = firstRefreshed;
  for (let attempt = 0; attempt < maxSchemaWait; attempt++) {
    const schemas = (refreshed as AppDef).AppData?.DataSchemas ?? [];
    const sch = schemas.find(
      (s) => s.AutoSchemaFrom === args.newTableName || s.Name === `${args.newTableName}_Schema` || s.Name === args.newTableName,
    );
    if (sch && Array.isArray(sch.Attributes) && sch.Attributes.length > 0) {
      schemaReady = true;
      break;
    }
    if (attempt < maxSchemaWait - 1) {
      const wait = 1500 + 1000 * attempt; // 1.5s, 2.5s, 3.5s, 4.5s
      log.info("waiting for schema regen", { table: args.newTableName, attempt: attempt + 1, waitMs: wait });
      await new Promise((r) => setTimeout(r, wait));
      refreshed = (await fetchLoadApp(appName)).app;
    }
  }

  await writeFile(snapshotPath(credential.appId), JSON.stringify(refreshed, null, 2), "utf8");

  const refreshedDS = ((refreshed as Record<string, unknown>).AppData as Record<string, unknown>)?.DataSets as Array<Record<string, unknown>> | undefined;
  const created = refreshedDS?.find((d) => d.Name === args.newTableName);

  return {
    dryRun: false,
    applied: !!created,
    newTableName: args.newTableName,
    templateTableName: templateName,
    componentId: created?.ComponentId as string | undefined,
    schemaReady,
    warning,
    message: created
      ? schemaReady
        ? `✅ テーブル '${args.newTableName}' 作成完了。Schema 自動生成も確認済み。`
        : `⚠️ テーブル '${args.newTableName}' は登録されたが Schema 自動生成が ${maxSchemaWait} 回待機しても完了せず。手動で refresh_app_def を呼ぶか時間を置いて再確認してください。`
      : `⚠️ saveapp Success だが事後検証でテーブル不在。SourceQualifier がデータソース上に実在しない可能性。`,
  };
}

type ViewType =
  | "table"
  | "card"
  | "detail"
  | "form"
  | "deck"
  | "dashboard"
  | "calendar"
  | "map"
  | "chart"
  | "gallery"
  | "onboarding";

const VIEW_VERSION: Record<ViewType, number> = {
  table: 3,
  card: 2,
  detail: 2,
  form: 2,
  deck: 2,
  dashboard: 2,
  calendar: 2,
  map: 2,
  chart: 2,
  gallery: 2,
  onboarding: 2,
};

function buildViewDefinition(
  viewType: ViewType,
  options: Record<string, unknown>,
  icon: string,
  menuOrder: number,
): Record<string, unknown> {
  const common = { Icon: icon, IconRunnerUps: null, MenuOrder: menuOrder };
  switch (viewType) {
    case "table":
      // Issue #3 真因: "**auto**" を残すと SYSTEM GENERATED 化する。
      return {
        $type: "Jeenee.DataTypes.TableViewSettings, Jeenee.DataTypes",
        ColumnWidth: options.columnWidth ?? "Default",
        EnableQuickEdit: options.enableQuickEdit ?? false,
        ColumnOrder: options.columnOrder ?? [],
        GroupBy: [],
        GroupAggregate: "NONE",
        SortBy: [],
        PrimarySortColumn: null,
        IsPrimarySortDescending: false,
        Events: [],
        ...common,
      };
    case "card":
      // Issue #3 真因: DeckHeader 系を "**auto**" のまま送ると Editor が
      // 「未完成」と判定して SYSTEM GENERATED 化する。null デフォルトにする。
      return {
        $type: "Jeenee.DataTypes.CardViewSettings, Jeenee.DataTypes",
        Layout: options.layout ?? null,
        MainDeckImageColumn: options.mainDeckImageColumn ?? null,
        ImageShape: options.imageShape ?? "Square Image",
        PrimaryDeckHeaderColumn: options.primaryDeckHeaderColumn ?? null,
        SecondaryDeckHeaderColumn: options.secondaryDeckHeaderColumn ?? null,
        DeckSummaryColumn: options.deckSummaryColumn ?? null,
        DeckNestedTableColumn: options.deckNestedTableColumn ?? null,
        ShowActionBar: options.showActionBar ?? true,
        ActionColumns: null,
        ActionBarEntries: [],
        GroupBy: [],
        GroupAggregate: "NONE",
        SortBy: [],
        PrimarySortColumn: null,
        IsPrimarySortDescending: false,
        Events: [],
        ...common,
      };
    case "detail":
      return {
        $type: "Jeenee.DataTypes.SlideshowViewSettings, Jeenee.DataTypes",
        MainSlideshowImageColumn: options.mainSlideshowImageColumn ?? null,
        DetailContentColumn: options.detailContentColumn ?? null,
        HeaderColumns: options.headerColumns ?? [],
        QuickEditColumns: options.quickEditColumns ?? [],
        ColumnOrder: options.columnOrder ?? [],
        ImageStyle: options.imageStyle ?? "Fill",
        Layout: options.layout ?? null,
        UseCardLayout: options.useCardLayout ?? false,
        DisplayMode: options.displayMode ?? "Automatic",
        MaxNestedRows: options.maxNestedRows ?? 5,
        SlideshowMode: options.slideshowMode ?? true,
        DesktopSplitMode: options.desktopSplitMode ?? "Split view",
        UseDesktopMultiColumn: options.useDesktopMultiColumn ?? true,
        SortBy: [],
        PrimarySortColumn: null,
        IsPrimarySortDescending: false,
        Events: [],
        ...common,
      };
    case "form":
      return {
        $type: "Jeenee.DataTypes.FormViewSettings, Jeenee.DataTypes",
        ColumnOrder: options.columnOrder ?? null,
        AutoSave: options.autoSave ?? false,
        AutoReopen: options.autoReopen ?? false,
        FinishView: options.finishView ?? "**Automatic**",
        RowKey: options.rowKey ?? "",
        FormStyle: options.formStyle ?? "Automatic",
        PageStyle: options.pageStyle ?? "Automatic",
        FormFooterStyle: options.formFooterStyle ?? "Bottom",
        MaxNestedRows: options.maxNestedRows ?? 5,
        AudioInput: options.audioInput ?? false,
        Events: [],
        ...common,
      };
    case "deck":
      // Issue #3 真因: DeckHeader 系・Events の "**auto**" を残すと
      // SYSTEM GENERATED 化する。null デフォルト + Events 空配列にする。
      return {
        $type: "Jeenee.DataTypes.DeckViewSettings, Jeenee.DataTypes",
        MainDeckImageColumn: options.mainDeckImageColumn ?? null,
        ImageShape: options.imageShape ?? "Square Image",
        PrimaryDeckHeaderColumn: options.primaryDeckHeaderColumn ?? null,
        SecondaryDeckHeaderColumn: options.secondaryDeckHeaderColumn ?? null,
        DeckSummaryColumn: options.deckSummaryColumn ?? null,
        DeckNestedTableColumn: options.deckNestedTableColumn ?? null,
        ShowActionBar: options.showActionBar ?? true,
        ActionColumns: null,
        ActionBarEntries: [],
        GroupBy: [],
        GroupAggregate: "NONE",
        SortBy: [],
        PrimarySortColumn: null,
        IsPrimarySortDescending: false,
        Events: [],
        ...common,
      };
    case "dashboard": {
      const viewEntries = options.viewEntries;
      if (!Array.isArray(viewEntries) || viewEntries.length === 0) {
        throw new Error(
          "dashboard には options.viewEntries が必須。例: [{ ViewName: 'XX_Detail', ViewSize: 'Tall' }]",
        );
      }
      return {
        $type: "Jeenee.DataTypes.DashboardViewSettings, Jeenee.DataTypes",
        ViewEntries: viewEntries,
        InteractiveMode: options.interactiveMode ?? false,
        ShowTabs: options.showTabs ?? false,
        Events: [],
        ...common,
      };
    }
    case "calendar":
      if (!options.startDateColumn) {
        throw new Error("calendar には options.startDateColumn が必須");
      }
      return {
        $type: "Jeenee.DataTypes.CalendarViewSettings, Jeenee.DataTypes",
        StartDateColumn: options.startDateColumn,
        StartTimeColumn: options.startTimeColumn ?? options.startDateColumn,
        EndDateColumn: options.endDateColumn ?? options.startDateColumn,
        EndTimeColumn: options.endTimeColumn ?? options.startDateColumn,
        LabelColumn: options.labelColumn ?? null,
        CategoryColumn: options.categoryColumn ?? null,
        DefaultCalendarView: options.defaultCalendarView ?? "Month",
        ColumnOrder: options.columnOrder ?? [],
        GroupBy: [],
        GroupAggregate: "NONE",
        SortBy: [],
        PrimarySortColumn: null,
        IsPrimarySortDescending: false,
        Events: [],
        ...common,
      };
    case "map":
      return {
        $type: "Jeenee.DataTypes.MapViewSettings, Jeenee.DataTypes",
        MapType: options.mapType ?? "Automatic",
        MapColumn: options.mapColumn ?? null,
        LocationMode: options.locationMode ?? "Normal",
        SecondaryTable: options.secondaryTable ?? null,
        SecondaryColumn: options.secondaryColumn ?? null,
        MinimumClusterSize: options.minimumClusterSize ?? 0,
        Events: [],
        ...common,
      };
    case "chart":
      return {
        $type: "Jeenee.DataTypes.ChartViewSettings, Jeenee.DataTypes",
        ChartType: options.chartType ?? "Histogram",
        UseNewChartExperience: options.useNewChartExperience ?? false,
        ChartConfig: options.chartConfig ?? null,
        ChartColumns: options.chartColumns ?? [],
        GroupAggregate: options.groupAggregate ?? "COUNT",
        TrendLine: options.trendLine ?? "None",
        ChartColors: options.chartColors ?? [],
        LabelType: options.labelType ?? "Percent",
        ShowLegend: options.showLegend ?? true,
        SortBy: [],
        Events: [],
        ...common,
      };
    case "gallery":
      // Issue #3 真因: "**auto**" を残すと SYSTEM GENERATED 化する。
      return {
        $type: "Jeenee.DataTypes.GalleryViewSettings, Jeenee.DataTypes",
        ImageSize: options.imageSize ?? "Medium",
        ActionBarEntries: null,
        SortBy: [],
        PrimarySortColumn: null,
        IsPrimarySortDescending: false,
        Events: [],
        ...common,
      };
    case "onboarding":
      return {
        $type: "Jeenee.DataTypes.OnboardingViewSettings, Jeenee.DataTypes",
        Image: options.image ?? "",
        Title: options.title ?? "",
        FirstBlurb: options.firstBlurb ?? "",
        FinishView: options.finishView ?? null,
        GroupBy: [],
        GroupAggregate: "NONE",
        SortBy: [],
        PrimarySortColumn: null,
        IsPrimarySortDescending: false,
        Events: [],
        ...common,
      };
  }
}

export async function createView(args: {
  appId?: string;
  appName?: string;
  viewName: string;
  tableName: string;
  viewType: ViewType;
  // Position 値の実物 (Issue #3 再調査結果):
  //   left / center / right → PRIMARY NAVIGATION (画面下タブ)
  //   menu                  → MENU NAVIGATION (左メニュー)
  //   ref                   → REFERENCE VIEWS (参照のみ)
  //   none                  → 隠し View
  // UI ラベル (first/next/middle/later/last) と "primary" は内部で
  // left/center/right にマップ:
  //   first/next/primary → left
  //   middle             → center
  //   later/last         → right
  position?: "left" | "center" | "right" | "menu" | "ref" | "none" | "first" | "next" | "middle" | "later" | "last" | "primary";
  showIf?: string;
  icon?: string;
  menuOrder?: number;
  options?: Record<string, unknown>;
  apply?: boolean;
}): Promise<{
  dryRun: boolean;
  applied: boolean;
  viewName: string;
  tableName: string;
  viewType: string;
  componentId?: string;
  message: string;
}> {
  const credential = resolveCredential(args.appId);
  const appName = await lookupAppName(credential.appId, args.appName);
  const { app } = await fetchLoadApp(appName);

  const presentation = (app as Record<string, unknown>).Presentation as Record<string, unknown> | undefined;
  if (!presentation) throw new Error("Presentation が見つかりません");
  const controls = (presentation.Controls as Array<Record<string, unknown>> | undefined) ?? [];

  if (controls.find((v) => v.Name === args.viewName)) {
    throw new Error(`View '${args.viewName}' は既に存在します`);
  }

  // テーブル or Slice 存在確認
  const dataSets = (((app as Record<string, unknown>).AppData as Record<string, unknown>)?.DataSets as Array<Record<string, unknown>> | undefined) ?? [];
  const slices = (((app as Record<string, unknown>).AppData as Record<string, unknown>)?.TableSlices as Array<Record<string, unknown>> | undefined) ?? [];
  const tableExists = dataSets.find((d) => d.Name === args.tableName) || slices.find((s) => s.Name === args.tableName);
  if (!tableExists) {
    throw new Error(`テーブル/Slice '${args.tableName}' が見つかりません`);
  }

  // 実物 loadApp 観察 (Issue #3 再調査)で判明した PRIMARY NAVIGATION の正解値:
  //   left / center / right （UI ラベル first/next/middle/later/last は内部でこの 3 値にマップ）
  // first/next を渡された場合は left、middle は center、later/last は right に変換。
  // primary もここで left にフォールバック。
  const positionRaw = args.position ?? "menu";
  const positionMap: Record<string, string> = {
    primary: "left",
    first: "left",
    next: "left",
    middle: "center",
    later: "right",
    last: "right",
  };
  const position = positionMap[positionRaw] ?? positionRaw;
  const icon = args.icon ?? "fa-list-ul";
  const menuOrder = args.menuOrder ?? 1;
  const showIf = args.showIf ? normalizeFormula(args.showIf) : null;

  // タイプ別 ViewDefinition を buildViewDefinition で構築
  const opts = args.options ?? {};
  const viewDefinition = buildViewDefinition(args.viewType, opts, icon, menuOrder);
  const settings = JSON.stringify(viewDefinition);
  const componentId = generateComponentId();

  const applyFn = (a: AppDef) => {
    const pres = (a as Record<string, unknown>).Presentation as Record<string, unknown> | undefined;
    if (!pres) throw new Error("Presentation が見つかりません（リトライ時）");
    const ctrls = (pres.Controls as Array<Record<string, unknown>> | undefined) ?? [];
    if (ctrls.find((v) => v.Name === args.viewName)) return; // 既に追加済み
    const idx = ctrls.length;
    const newView: Record<string, unknown> = {
      ExprLookup: {},
      Name: args.viewName,
      DisplayName: null,
      ShowIf: showIf,
      TableOrFolderName: args.tableName,
      Action: args.viewType,
      Position: position,
      Description: null,
      ActionType: null,
      Parameters: [],
      Settings: settings,
      ViewDefinition: viewDefinition,
      CreatedBy: "App owner",
      Comment: null,
      IsValid: true,
      Visibility: "ALWAYS",
      DisableAutoUpdate: false,
      ComponentId: componentId,
      _isCopy: false,
      _isNew: true,
      _version: VIEW_VERSION[args.viewType] ?? 2,
      _index: idx,
      _path: `Presentation.Controls[${idx}]`,
      _isSystemGenerated: false,
      _isMinor: false,
    };
    if (!pres.Controls) pres.Controls = [];
    (pres.Controls as Array<Record<string, unknown>>).push(newView);
  };
  applyFn(app);

  if (!args.apply) {
    return {
      dryRun: true,
      applied: false,
      viewName: args.viewName,
      tableName: args.tableName,
      viewType: args.viewType,
      message: `dry-run。${args.viewType} View '${args.viewName}' (table: '${args.tableName}', position: ${position}) を構築。apply: true で送信。`,
    };
  }

  const { refreshed } = await applyChangesAndSave(credential, appName, applyFn, app);
  const refreshedControls = ((refreshed as Record<string, unknown>).Presentation as Record<string, unknown>)?.Controls as Array<Record<string, unknown>> | undefined;
  const created = refreshedControls?.find((v) => v.Name === args.viewName);
  await writeFile(snapshotPath(credential.appId), JSON.stringify(refreshed, null, 2), "utf8");

  return {
    dryRun: false,
    applied: !!created,
    viewName: args.viewName,
    tableName: args.tableName,
    viewType: args.viewType,
    componentId,
    message: created
      ? `✅ ${args.viewType} View '${args.viewName}' 作成完了`
      : `⚠️ saveapp Success だが事後検証で View 不在`,
  };
}

export async function addCallScriptTask(args: {
  appId?: string;
  appName?: string;
  processName: string;
  taskName: string;
  scriptId: string;
  functionName: string;
  functionArguments?: Array<{ name: string; expression: string }>;
  tableName: string;
  stepName?: string;
  asyncExec?: boolean;
  forEntireTable?: boolean;
  apply?: boolean;
}): Promise<{
  dryRun: boolean;
  applied: boolean;
  taskName: string;
  processName: string;
  componentIds?: { task: string; node: string };
  message: string;
}> {
  const credential = resolveCredential(args.appId);
  const appName = await lookupAppName(credential.appId, args.appName);
  const { app } = await fetchLoadApp(appName);

  const behavior = (app as Record<string, unknown>).Behavior as Record<string, unknown> | undefined;
  if (!behavior) throw new Error("Behavior が見つかりません");

  const tasks = (behavior.Tasks as Array<Record<string, unknown>> | undefined) ?? [];
  const processes = (behavior.AppProcesses as Array<Record<string, unknown>> | undefined) ?? [];

  if (tasks.find((t) => t.Name === args.taskName)) {
    throw new Error(`Task '${args.taskName}' は既に存在します`);
  }

  const targetProcess = processes.find((p) => p.Name === args.processName);
  if (!targetProcess) {
    const known = processes.map((p) => p.Name as string).join(", ");
    throw new Error(`Process '${args.processName}' が見つかりません。既知: ${known}`);
  }

  // 対象テーブルの存在確認
  const dataSets = (((app as Record<string, unknown>).AppData as Record<string, unknown>)?.DataSets as Array<Record<string, unknown>> | undefined) ?? [];
  if (!dataSets.find((d) => d.Name === args.tableName)) {
    throw new Error(`テーブル '${args.tableName}' が見つかりません`);
  }

  const taskComponentId = generateComponentId();
  const nodeComponentId = generateComponentId();
  const outputColComponentId = generateComponentId();
  const stepName = args.stepName ?? args.taskName;

  const functionArgs = (args.functionArguments ?? []).map((a) => ({
    Name: a.name,
    Expression: normalizeFormula(a.expression),
  }));

  const outputSchema = {
    ExprLookup: {},
    Name: "Apps Script Output Schema",
    Attributes: [
      {
        ExprLookup: {},
        Name: "Output",
        Type: "LongText",
        TypeFromProvider: null,
        TypeAuxData: null,
        InternalQualifier: null,
        Description: null,
        DisplayName: null,
        IsRequired: false,
        Default: null,
        DefaultExpression: null,
        DefEdit: true,
        IsSys: false,
        DefinitionIsFixed: false,
        IsKey: false,
        IsKeyPart: false,
        IsReadOnly: true,
        ResetOnEdit: false,
        IsHidden: false,
        Formula: null,
        AsdbFormula: null,
        Category: null,
        FormulaVersion: 0,
        AppFormula: null,
        IsLabel: false,
        IsScannable: null,
        IsNfcScannable: null,
        Searchable: null,
        IsVirtual: false,
        IsAutoGenerated: false,
        IsSensitive: false,
        LocaleName: null,
        IsValid: true,
        Visibility: "ALWAYS",
        DisableAutoUpdate: false,
        ComponentId: outputColComponentId,
        _isNew: true,
        _version: 0,
        _index: 0,
        _path: `Behavior.Tasks[${tasks.length}].OutputSchema.Attributes[0]`,
        MetaData: {},
      },
    ],
    AutoSchemaFrom: null,
    IsAutoCreated: false,
    IsDependent: false,
    CreatedBy: null,
    AutomationPurpose: 0,
    IsValid: true,
    Visibility: "NEVER",
    DisableAutoUpdate: false,
    ComponentId: null,
    _index: 0,
    _path: `Behavior.Tasks[${tasks.length}].OutputSchema`,
  };

  const newTask: Record<string, unknown> = {
    $type: "Jeenee.DataTypes.AppWorkflowActionAppsScript, Jeenee.DataTypes",
    ExprLookup: {},
    ScriptId: args.scriptId,
    FunctionName: args.functionName,
    FunctionArguments: functionArgs,
    OutputAppsScriptType: "String",
    OutputSchema: outputSchema,
    AsyncExec: args.asyncExec ?? false,
    Name: args.taskName,
    Type: "AppsScript",
    IsAiTask: false,
    TableName: args.tableName,
    ForEntireTable: args.forEntireTable ?? true,
    AlwaysRunAsDeployed: false,
    IsEmbedded: false,
    Scope: "PROCESS",
    CreatedBy: "App owner",
    Inputs: [],
    Comment: null,
    IsValid: true,
    Visibility: "ALWAYS",
    DisableAutoUpdate: false,
    ComponentId: taskComponentId,
    _isNew: true,
    _version: 10,
    _index: tasks.length,
    _path: `Behavior.Tasks[${tasks.length}]`,
  };

  // Process の Nodes に TaskNode を追加
  const newNode: Record<string, unknown> = {
    $type: "Jeenee.DataTypes.ProcessNodes.TaskNode, Jeenee.DataTypes",
    ExprLookup: {},
    NodeType: "RUN_TASK",
    Task: args.taskName,
    InputAssignments: [],
    ActionType: "AppsScript",
    StepName: stepName,
    OutputTableName: null,
    Comment: null,
    IsValid: true,
    Visibility: "ALWAYS",
    DisableAutoUpdate: false,
    ComponentId: nodeComponentId,
  };

  if (!behavior.Tasks) behavior.Tasks = [];
  (behavior.Tasks as Array<Record<string, unknown>>).push(newTask);
  if (!targetProcess.Nodes) targetProcess.Nodes = [];
  (targetProcess.Nodes as Array<Record<string, unknown>>).push(newNode);

  if (!args.apply) {
    return {
      dryRun: true,
      applied: false,
      taskName: args.taskName,
      processName: args.processName,
      message: `dry-run。AppsScript Task '${args.taskName}' (関数: ${args.functionName}) と Process '${args.processName}' への TaskNode を構築。apply: true で送信。戻り値は [${stepName}].[Output] で参照可能。`,
    };
  }

  const result = await postSaveApp(credential.appId, appName, app);
  const refreshed = result.app ?? (await fetchLoadApp(appName)).app;
  const refreshedTasks = ((refreshed as Record<string, unknown>).Behavior as Record<string, unknown>)?.Tasks as Array<Record<string, unknown>> | undefined;
  const created = refreshedTasks?.find((t) => t.Name === args.taskName);
  await writeFile(snapshotPath(credential.appId), JSON.stringify(refreshed, null, 2), "utf8");

  return {
    dryRun: false,
    applied: !!created,
    taskName: args.taskName,
    processName: args.processName,
    componentIds: { task: taskComponentId, node: nodeComponentId },
    message: created
      ? `✅ AppsScript Task '${args.taskName}' 作成 + Process '${args.processName}' 連結完了。戻り値は [${stepName}].[Output] で参照可能。`
      : `⚠️ saveapp Success だが事後検証で Task 不在`,
  };
}

export async function addSlice(args: {
  appId?: string;
  appName?: string;
  sliceName: string;
  sourceTable: string;
  filterCondition?: string;
  columns?: string[];
  actions?: string[];
  apply?: boolean;
}): Promise<{
  dryRun: boolean;
  applied: boolean;
  sliceName: string;
  sourceTable: string;
  componentId?: string;
  message: string;
}> {
  const credential = resolveCredential(args.appId);
  const appName = await lookupAppName(credential.appId, args.appName);
  const { app } = await fetchLoadApp(appName);

  const appData = (app as Record<string, unknown>).AppData as Record<string, unknown> | undefined;
  if (!appData) throw new Error("AppData が見つかりません");

  // ソーステーブルの存在確認
  const dataSets = (appData.DataSets as Array<Record<string, unknown>> | undefined) ?? [];
  if (!dataSets.find((d) => d.Name === args.sourceTable)) {
    const known = dataSets.map((d) => d.Name as string).join(", ");
    throw new Error(`ソーステーブル '${args.sourceTable}' が見つかりません。既知: ${known}`);
  }

  const slices = (appData.TableSlices as Array<Record<string, unknown>> | undefined) ?? [];
  if (slices.find((s) => s.Name === args.sliceName)) {
    throw new Error(`Slice '${args.sliceName}' は既に存在します`);
  }

  // columns 省略時はソーステーブルの全列を自動取得
  let columns = args.columns;
  if (!columns) {
    const schemas = app.AppData?.DataSchemas ?? [];
    const sourceSchema =
      schemas.find((s) => s.AutoSchemaFrom === args.sourceTable) ??
      schemas.find((s) => s.Name === `${args.sourceTable}_Schema`);
    if (sourceSchema?.Attributes) {
      columns = sourceSchema.Attributes.map((a) => a.Name as string).filter((n) => !!n);
    } else {
      columns = [];
    }
  }

  const actions = args.actions ?? ["**auto**"];
  const filterCondition = args.filterCondition ? normalizeFormula(args.filterCondition) : null;

  const componentId = generateComponentId();
  const cols = columns;
  const applyFn = (a: AppDef) => {
    const ad = (a as Record<string, unknown>).AppData as Record<string, unknown> | undefined;
    if (!ad) throw new Error("AppData が見つかりません（リトライ時）");
    if (!ad.TableSlices) ad.TableSlices = [];
    const list = ad.TableSlices as Array<Record<string, unknown>>;
    if (list.find((s) => s.Name === args.sliceName)) return;
    const idx = list.length;
    list.push({
      ExprLookup: {},
      Name: args.sliceName,
      SourceTable: args.sourceTable,
      SourceColumn: null,
      RowFilterCondition: null,
      RowFilterParameter: null,
      Columns: cols,
      Actions: actions,
      FilterExpression: { Description: { Content: "" } },
      FilterCondition: filterCondition,
      FilterEvaluatable: null,
      AllowedUpdates: 0,
      UpdateMode: 7,
      Comment: null,
      IsValid: true,
      Visibility: "ALWAYS",
      DisableAutoUpdate: false,
      ComponentId: componentId,
      _isNew: true,
      _version: 6,
      _index: idx,
      _path: `AppData.TableSlices[${idx}]`,
    });
  };
  applyFn(app);

  if (!args.apply) {
    return {
      dryRun: true,
      applied: false,
      sliceName: args.sliceName,
      sourceTable: args.sourceTable,
      message: `dry-run。Slice '${args.sliceName}' (source: '${args.sourceTable}', columns: ${cols.length} 件) を構築。apply: true で送信。`,
    };
  }

  const { refreshed } = await applyChangesAndSave(credential, appName, applyFn, app);
  const refreshedSlices = ((refreshed as Record<string, unknown>).AppData as Record<string, unknown>)?.TableSlices as Array<Record<string, unknown>> | undefined;
  const created = refreshedSlices?.find((s) => s.Name === args.sliceName);
  await writeFile(snapshotPath(credential.appId), JSON.stringify(refreshed, null, 2), "utf8");

  return {
    dryRun: false,
    applied: !!created,
    sliceName: args.sliceName,
    sourceTable: args.sourceTable,
    componentId: created?.ComponentId as string | undefined,
    message: created
      ? `✅ Slice '${args.sliceName}' 作成完了`
      : `⚠️ saveapp Success だが事後検証で Slice 不在`,
  };
}

export async function removeSlice(args: {
  appId?: string;
  appName?: string;
  sliceName: string;
  apply?: boolean;
}): Promise<{
  dryRun: boolean;
  applied: boolean;
  sliceName: string;
  message: string;
}> {
  const credential = resolveCredential(args.appId);
  const appName = await lookupAppName(credential.appId, args.appName);
  const { app } = await fetchLoadApp(appName);

  const appData = (app as Record<string, unknown>).AppData as Record<string, unknown> | undefined;
  const slices = (appData?.TableSlices as Array<Record<string, unknown>> | undefined) ?? [];
  const idx = slices.findIndex((s) => s.Name === args.sliceName);
  if (idx === -1) {
    throw new Error(`Slice '${args.sliceName}' が見つかりません`);
  }

  slices.splice(idx, 1);

  if (!args.apply) {
    return { dryRun: true, applied: false, sliceName: args.sliceName, message: "dry-run。apply: true で送信。" };
  }

  const result = await postSaveApp(credential.appId, appName, app);
  const refreshed = result.app ?? (await fetchLoadApp(appName)).app;
  const refreshedSlices = ((refreshed as Record<string, unknown>).AppData as Record<string, unknown>)?.TableSlices as Array<Record<string, unknown>> | undefined;
  const stillThere = refreshedSlices?.find((s) => s.Name === args.sliceName);
  await writeFile(snapshotPath(credential.appId), JSON.stringify(refreshed, null, 2), "utf8");

  return {
    dryRun: false,
    applied: !stillThere,
    sliceName: args.sliceName,
    message: stillThere ? `⚠️ saveapp Success だが Slice '${args.sliceName}' がまだ残っている` : `✅ Slice '${args.sliceName}' 削除完了`,
  };
}

export async function createBot(args: {
  appId?: string;
  appName?: string;
  botName: string;
  tableName: string;
  actionName: string;
  // Data Change 系 (デフォルト) または "Scheduled" を指定可能
  eventType?: "ADDS_ONLY" | "UPDATES_ONLY" | "DELETES_ONLY" | "ADDS_AND_UPDATES" | "ADDS_UPDATES_DELETES" | "Scheduled";
  filterCondition?: string;
  // Schedule トリガーの場合のみ指定（eventType: "Scheduled"）
  scheduleConfig?: {
    cron: string;             // 5 フィールド cron 形式。例: "0 12 1 * *" (月初 12:00)
    timeZone?: string;        // Windows タイムゾーン形式。例: "Tokyo Standard Time" / "Pacific Standard Time" / "UTC"
    forEachRowInTable?: boolean; // 各行に対して実行するか。デフォルト true
    region?: string;          // 通常 "" のまま
  };
  disabled?: boolean;
  apply?: boolean;
}): Promise<{
  dryRun: boolean;
  applied: boolean;
  botName: string;
  eventName: string;
  processName: string;
  componentIds?: { bot: string; event: string; process: string };
  message: string;
  warning?: string;
}> {
  const credential = resolveCredential(args.appId);
  const appName = await lookupAppName(credential.appId, args.appName);
  const { app } = await fetchLoadApp(appName);

  const behavior = (app as Record<string, unknown>).Behavior as Record<string, unknown> | undefined;
  if (!behavior) throw new Error("Behavior が見つかりません");

  const bots = (behavior.AppBots as Array<Record<string, unknown>> | undefined) ?? [];
  const events = (behavior.AppEvents as Array<Record<string, unknown>> | undefined) ?? [];
  const processes = (behavior.AppProcesses as Array<Record<string, unknown>> | undefined) ?? [];

  if (bots.find((b) => b.Name === args.botName)) {
    throw new Error(`Bot '${args.botName}' は既に存在します`);
  }

  // 対象 Action の存在確認
  const dataActions = (((app as Record<string, unknown>).AppData as Record<string, unknown>)?.DataActions as Array<Record<string, unknown>> | undefined) ?? [];
  const targetAction = dataActions.find((a) => a.Name === args.actionName && a.Table === args.tableName);
  if (!targetAction) {
    throw new Error(`Action '${args.actionName}' (Table: '${args.tableName}') が見つかりません`);
  }

  // 対象テーブルの Schema 名を解決
  const schemas = app.AppData?.DataSchemas ?? [];
  const schema =
    schemas.find((s) => s.AutoSchemaFrom === args.tableName) ??
    schemas.find((s) => s.Name === `${args.tableName}_Schema`) ??
    schemas.find((s) => s.Name === args.tableName);
  if (!schema) {
    throw new Error(`テーブル '${args.tableName}' の Schema が見つかりません`);
  }
  const schemaName = schema.Name;

  const eventName = args.botName.replace(/^_+/, "") + "_event";
  const processName = `Process for ${args.botName}`;

  if (events.find((e) => e.Name === eventName)) {
    throw new Error(`Event '${eventName}' は既に存在します（Bot 名から自動生成された名前）。別の Bot 名にしてください`);
  }
  if (processes.find((p) => p.Name === processName)) {
    throw new Error(`Process '${processName}' は既に存在します`);
  }

  const eventType = args.eventType ?? "ADDS_AND_UPDATES";
  const isSchedule = eventType === "Scheduled";

  if (isSchedule && !args.scheduleConfig) {
    throw new Error("eventType: 'Scheduled' の場合は scheduleConfig.cron が必須");
  }
  if (isSchedule && !args.scheduleConfig?.cron) {
    throw new Error("scheduleConfig.cron が必須。例: '0 12 1 * *' (月初 12:00)");
  }

  // Step Action ノードの ComponentId
  const stepNodeComponentId = generateComponentId();
  const eventDefComponentId = generateComponentId();
  const eventComponentId = generateComponentId();
  const processComponentId = generateComponentId();
  const botComponentId = generateComponentId();

  // Event 構造を eventType によって切替
  let appEventDefinition: Record<string, unknown>;
  let outerEventType: string;
  let outerFilterCondition: string | null;
  if (isSchedule) {
    const cfg = args.scheduleConfig!;
    appEventDefinition = {
      $type: "Jeenee.DataTypes.AppScheduledEventDefinition, Jeenee.DataTypes",
      ExprLookup: {},
      RecurrentRuleName: null,
      Schedule: cfg.cron,
      TimeZone: cfg.timeZone ?? "Tokyo Standard Time",
      Table: args.tableName,
      FilterCondition: args.filterCondition ?? "true",
      ForEachRowInTable: cfg.forEachRowInTable ?? true,
      Region: cfg.region ?? "",
      IsValid: true,
      Visibility: "ALWAYS",
      DisableAutoUpdate: false,
      ComponentId: eventDefComponentId,
    };
    outerEventType = "Scheduled";
    outerFilterCondition = null; // Scheduled の場合 outer FilterCondition は null（AppEventDefinition.FilterCondition 側で持つ）
  } else {
    appEventDefinition = {
      $type: "Jeenee.DataTypes.AppChangeEventDefinition, Jeenee.DataTypes",
      ExprLookup: {},
      ChangeEvent: eventType,
      SchemaName: schemaName,
      IsValid: true,
      Visibility: "ALWAYS",
      DisableAutoUpdate: false,
      ComponentId: eventDefComponentId,
    };
    outerEventType = "Change";
    outerFilterCondition = args.filterCondition ? normalizeFormula(args.filterCondition) : "=TRUE";
  }

  const newEvent = {
    ExprLookup: {},
    Name: eventName,
    EventType: outerEventType,
    AppEventDefinition: appEventDefinition,
    FilterCondition: outerFilterCondition,
    Disabled: false,
    CreatedBy: null,
    AutomationPurpose: 0,
    AssociatedStepName: null,
    ExecutionId: null,
    IgnoreSecurityFilters: false,
    Id: null,
    Icon: null,
    IsEmbedded: false,
    Scope: "LOCAL",
    Comment: null,
    IsValid: true,
    Visibility: "ALWAYS",
    DisableAutoUpdate: false,
    ComponentId: eventComponentId,
    _isNew: true,
    _version: isSchedule ? 7 : 6,
    _index: events.length,
    _path: `Behavior.AppEvents[${events.length}]`,
  };

  const newProcess = {
    ExprLookup: {},
    Name: processName,
    InputSchemaName: schemaName,
    Icon: null,
    Nodes: [
      {
        $type: "Jeenee.DataTypes.ProcessNodes.RunActionNode, Jeenee.DataTypes",
        ExprLookup: {},
        NodeType: "RUN_ACTION",
        Action: args.actionName,
        InputAssignments: [],
        StepName: "Run Action",
        OutputTableName: null,
        Comment: null,
        IsValid: true,
        Visibility: "ALWAYS",
        DisableAutoUpdate: false,
        ComponentId: stepNodeComponentId,
      },
    ],
    ProcessStateTableName: `${processName} Process Table`,
    UseProcessEntityNativeTable: false,
    OutputSchema: null,
    ExecutionId: null,
    AlwaysRunAsDeployed: false,
    IsEmbedded: false,
    Scope: "LOCAL",
    Id: null,
    Comment: null,
    IsValid: true,
    Visibility: "ALWAYS",
    DisableAutoUpdate: false,
    ComponentId: processComponentId,
    _isNew: true,
    _version: 2,
    _index: processes.length,
    _path: `Behavior.AppProcesses[${processes.length}]`,
  };

  const newBot = {
    ExprLookup: {},
    Name: args.botName,
    EventName: eventName,
    ProcessName: processName,
    CreatedBy: null,
    AutomationPurpose: 0,
    Disabled: args.disabled ?? false,
    Icon: null,
    TriggerDataChangeEvent: false,
    TriggerDataChangeEventSync: false,
    TriggerDataChangeEventAsync: false,
    ExecutionId: null,
    Id: null,
    Comment: null,
    IsValid: true,
    Visibility: "ALWAYS",
    DisableAutoUpdate: false,
    ComponentId: botComponentId,
    _isNew: true,
    _version: 3,
    _index: bots.length,
    _path: `Behavior.AppBots[${bots.length}]`,
  };

  const applyFn = (a: AppDef) => {
    const beh = (a as Record<string, unknown>).Behavior as Record<string, unknown> | undefined;
    if (!beh) throw new Error("Behavior が見つかりません（リトライ時）");
    if (!beh.AppBots) beh.AppBots = [];
    if (!beh.AppEvents) beh.AppEvents = [];
    if (!beh.AppProcesses) beh.AppProcesses = [];
    const bb = beh.AppBots as Array<Record<string, unknown>>;
    const ee = beh.AppEvents as Array<Record<string, unknown>>;
    const pp = beh.AppProcesses as Array<Record<string, unknown>>;
    if (bb.find((b) => b.Name === args.botName)) return; // 既に追加済み
    // _index / _path を新しい配列長で更新して push
    const bIdx = bb.length;
    const eIdx = ee.length;
    const pIdx = pp.length;
    bb.push({ ...newBot, _index: bIdx, _path: `Behavior.AppBots[${bIdx}]` });
    ee.push({ ...newEvent, _index: eIdx, _path: `Behavior.AppEvents[${eIdx}]` });
    pp.push({ ...newProcess, _index: pIdx, _path: `Behavior.AppProcesses[${pIdx}]` });
  };
  applyFn(app);

  const warning =
    "Process State Table が AppSheet 側で自動生成されない場合は手動でテーブル作成が必要かも。saveapp 後に必ず Manage→Monitor で動作確認すること。";

  if (!args.apply) {
    return {
      dryRun: true,
      applied: false,
      botName: args.botName,
      eventName,
      processName,
      warning,
      message: `dry-run。Bot '${args.botName}' + Event '${eventName}' + Process '${processName}' を構築。apply: true で送信。`,
    };
  }

  const { refreshed } = await applyChangesAndSave(credential, appName, applyFn, app);
  const refreshedBots = ((refreshed as Record<string, unknown>).Behavior as Record<string, unknown>)?.AppBots as Array<Record<string, unknown>> | undefined;
  const created = refreshedBots?.find((b) => b.Name === args.botName);
  await writeFile(snapshotPath(credential.appId), JSON.stringify(refreshed, null, 2), "utf8");

  return {
    dryRun: false,
    applied: !!created,
    botName: args.botName,
    eventName,
    processName,
    componentIds: { bot: botComponentId, event: eventComponentId, process: processComponentId },
    warning,
    message: created
      ? `✅ Bot '${args.botName}' 作成完了（4 配列リンク済み・Tasks は別途追加可能）`
      : `⚠️ saveapp Success だが事後検証で Bot 不在。4 配列のいずれかが拒否された可能性。`,
  };
}

export async function addOpenUrlAction(args: {
  appId?: string;
  appName?: string;
  tableName: string;
  actionName: string;
  urlExpression: string;
  condition?: string;
  prominence?: "Display_Inline" | "Display_Prominently" | "Display_Overlay";
  launchExternal?: boolean;
  needsConfirmation?: boolean;
  confirmationMessage?: string;
  icon?: string;
  apply?: boolean;
}): Promise<{
  dryRun: boolean;
  applied: boolean;
  table: string;
  actionName: string;
  componentId?: string;
  message: string;
  warning?: string;
}> {
  const credential = resolveCredential(args.appId);
  const appName = await lookupAppName(credential.appId, args.appName);
  const { app } = await fetchLoadApp(appName);

  const dataSets = ((app as Record<string, unknown>).AppData as Record<string, unknown>)?.DataSets as Array<Record<string, unknown>> | undefined;
  if (!dataSets || !dataSets.find((d) => d.Name === args.tableName)) {
    const known = (dataSets ?? []).map((d) => d.Name as string).join(", ");
    throw new Error(`テーブル '${args.tableName}' が見つかりません。既知: ${known}`);
  }

  const actions = ((app as Record<string, unknown>).AppData as Record<string, unknown>)?.DataActions as Array<Record<string, unknown>> | undefined;
  if (!actions) throw new Error("AppData.DataActions が見つかりません");
  if (actions.find((a) => a.Name === args.actionName)) {
    throw new Error(`Action '${args.actionName}' は既に存在します`);
  }

  const url = normalizeFormula(args.urlExpression);
  const cond = args.condition ? normalizeFormula(args.condition) : null;
  const prominence = args.prominence ?? "Display_Inline";
  const launchExternal = args.launchExternal ?? false;
  const needsConfirmation = args.needsConfirmation ?? false;
  const confirmationMessage = args.confirmationMessage ?? "";
  const icon = args.icon ?? "fa-external-link";

  let warning: string | undefined;
  const m = args.urlExpression.match(/https?:\/\//i);
  if (m && m[0].toLowerCase().startsWith("http://")) {
    warning = "URL に http:// が含まれています。AppSheet モバイルでは HTTPS が推奨されます。";
  }

  const actionSettings = {
    NavigateTarget: args.urlExpression,
    LaunchExternal: launchExternal,
    Prominence: prominence,
    NeedsConfirmation: needsConfirmation,
    ConfirmationMessage: confirmationMessage,
    ModifiesData: false,
    BulkApplicable: false,
  };
  const actionDefinition = {
    $type: "Jeenee.DataTypes.DataActionNavigateUrl, Jeenee.DataTypes",
    NavigateTarget: args.urlExpression,
    LaunchExternal: launchExternal,
    Prominence: prominence,
    NeedsConfirmation: needsConfirmation,
    ConfirmationMessage: confirmationMessage,
    ModifiesData: false,
    BulkApplicable: false,
  };

  const componentId = generateComponentId();
  const applyFn = (a: AppDef) => {
    const targetActions = ((a as Record<string, unknown>).AppData as Record<string, unknown>)?.DataActions as Array<Record<string, unknown>> | undefined;
    if (!targetActions) throw new Error("AppData.DataActions が見つかりません（リトライ時）");
    if (targetActions.find((x) => x.Name === args.actionName)) return; // 既に追加済み
    const idx = targetActions.length;
    targetActions.push({
      Value: url,
      ValueEvaluatable: null,
      ConditionEvaluatable: null,
      ActionType: "NAVIGATE_URL",
      ActionSettings: JSON.stringify(actionSettings),
      IsEmbedded: false,
      Scope: "UNSET",
      Inputs: [],
      Name: args.actionName,
      DisplayName: null,
      CreatedBy: "App owner",
      Icon: icon,
      IconRunnerUps: null,
      Table: args.tableName,
      TableScope: false,
      Condition: cond,
      ColumnToEdit: null,
      ColumnAttachment: null,
      ActionOrder: idx,
      ActionDefinition: actionDefinition,
      Comment: null,
      IsValid: true,
      Visibility: "ALWAYS",
      DisableAutoUpdate: false,
      ComponentId: componentId,
      ExprLookup: {},
      _isNew: true,
      _version: 0,
      _index: idx,
      _path: `AppData.DataActions[${idx}]`,
    });
  };
  applyFn(app);

  if (!args.apply) {
    return {
      dryRun: true,
      applied: false,
      table: args.tableName,
      actionName: args.actionName,
      warning,
      message: `dry-run。OpenUrl Action '${args.actionName}' を構築。apply: true で送信。`,
    };
  }

  const { refreshed } = await applyChangesAndSave(credential, appName, applyFn, app);
  const refreshedActions = ((refreshed as Record<string, unknown>).AppData as Record<string, unknown>)?.DataActions as Array<Record<string, unknown>> | undefined;
  const created = refreshedActions?.find((a) => a.Name === args.actionName);
  await writeFile(snapshotPath(credential.appId), JSON.stringify(refreshed, null, 2), "utf8");

  return {
    dryRun: false,
    applied: !!created,
    table: args.tableName,
    actionName: args.actionName,
    componentId: created?.ComponentId as string | undefined,
    warning,
    message: created
      ? `✅ OpenUrl Action '${args.actionName}' 作成完了`
      : `⚠️ saveapp Success だが事後検証で Action 不在`,
  };
}

export async function promoteToRef(args: {
  appId?: string;
  appName?: string;
  tableName: string;
  columnName: string;
  parentTableName: string;
  isAPartOf?: boolean;
  relationshipName?: string;
  inputMode?: string;
  apply?: boolean;
}): Promise<{
  dryRun: boolean;
  applied: boolean;
  table: string;
  column: string;
  parentTable: string;
  parentKeyColumn: string;
  parentKeyType: string;
  before: { Type: string; TypeAuxData: unknown };
  after?: { Type: string; TypeAuxData: unknown };
  verified?: boolean;
  warning?: string;
  message: string;
}> {
  const credential = resolveCredential(args.appId);
  const appName = await lookupAppName(credential.appId, args.appName);
  const { app } = await fetchLoadApp(appName);

  // 親テーブルの Schema を取得
  const schemas = app.AppData?.DataSchemas ?? [];
  const parentSchema =
    schemas.find((s) => s.AutoSchemaFrom === args.parentTableName) ??
    schemas.find((s) => s.Name === `${args.parentTableName}_Schema`) ??
    schemas.find((s) => s.Name === args.parentTableName);
  if (!parentSchema) {
    const known = schemas.map((s) => s.AutoSchemaFrom || s.Name).join(", ");
    throw new Error(`親テーブル '${args.parentTableName}' が見つかりません。既知: ${known}`);
  }

  // 親のキー列を特定
  const parentKey = (parentSchema.Attributes ?? []).find((a) => a.IsKey === true);
  if (!parentKey) {
    throw new Error(`親テーブル '${args.parentTableName}' にキー列（IsKey: true）が見つかりません`);
  }

  // 子側の対象列
  const attr = findAttribute(app, args.tableName, args.columnName);
  const beforeType = (attr.Type ?? "Unknown") as string;
  const beforeAux = attr.TypeAuxData;

  let parsedBeforeAux: Record<string, unknown> = {};
  if (typeof beforeAux === "string") {
    try {
      parsedBeforeAux = JSON.parse(beforeAux);
    } catch {
      parsedBeforeAux = {};
    }
  } else if (beforeAux && typeof beforeAux === "object") {
    parsedBeforeAux = { ...(beforeAux as Record<string, unknown>) };
  }

  const newAux = {
    ReferencedTableName: args.parentTableName,
    ReferencedRootTableName: null,
    ReferencedType: parentKey.Type ?? "Text",
    ReferencedTypeQualifier: null,
    ReferencedKeyColumn: parentKey.Name,
    IsAPartOf: args.isAPartOf ?? false,
    RelationshipName: args.relationshipName ?? null,
    InputMode: args.inputMode ?? "Auto",
    Valid_If: parsedBeforeAux.Valid_If ?? null,
    Error_Message_If_Invalid: parsedBeforeAux.Error_Message_If_Invalid ?? null,
    Show_If: parsedBeforeAux.Show_If ?? null,
    Required_If: parsedBeforeAux.Required_If ?? null,
    Editable_If: parsedBeforeAux.Editable_If ?? null,
    Reset_If: parsedBeforeAux.Reset_If ?? null,
    Suggested_Values: parsedBeforeAux.Suggested_Values ?? null,
  };

  const auxJson = JSON.stringify(newAux);
  const applyFn = (a: AppDef) => {
    const target = findAttribute(a, args.tableName, args.columnName);
    target.Type = "Ref";
    target.TypeAuxData = auxJson;
  };
  applyFn(app);

  // 既存値の互換性をざっくり警告
  let warning: string | undefined;
  if (beforeType !== "Text" && beforeType !== "Ref") {
    warning = `'${beforeType}' → 'Ref' は安全リスト外。既存データが '${parentKey.Name}' (${parentKey.Type}) に対する有効値でないと "Invalid value" になります。事前にデータクレンジングを推奨。`;
  }

  const before = { Type: beforeType, TypeAuxData: beforeAux };

  if (!args.apply) {
    return {
      dryRun: true,
      applied: false,
      table: args.tableName,
      column: args.columnName,
      parentTable: args.parentTableName,
      parentKeyColumn: parentKey.Name as string,
      parentKeyType: (parentKey.Type ?? "Text") as string,
      before,
      warning,
      message: "dry-run。apply: true で送信。",
    };
  }

  const { refreshed } = await applyChangesAndSave(credential, appName, applyFn, app);
  const refreshedAttr = findAttribute(refreshed, args.tableName, args.columnName);
  const after = { Type: (refreshedAttr.Type ?? "Unknown") as string, TypeAuxData: refreshedAttr.TypeAuxData };
  await writeFile(snapshotPath(credential.appId), JSON.stringify(refreshed, null, 2), "utf8");

  let verified = after.Type === "Ref";
  if (verified && typeof after.TypeAuxData === "string") {
    try {
      const aux = JSON.parse(after.TypeAuxData) as Record<string, unknown>;
      verified = aux.ReferencedTableName === args.parentTableName && aux.ReferencedKeyColumn === parentKey.Name;
    } catch {
      verified = false;
    }
  }

  return {
    dryRun: false,
    applied: true,
    table: args.tableName,
    column: args.columnName,
    parentTable: args.parentTableName,
    parentKeyColumn: parentKey.Name as string,
    parentKeyType: (parentKey.Type ?? "Text") as string,
    before,
    after,
    verified,
    warning,
    message: verified ? "✅ Ref 化完了" : "⚠️ Ref 化したが verify 失敗。AppSheet 側で型変換が拒否された可能性。",
  };
}

// Security Filter 式が「対象テーブルの仮想列」を直接参照していないかチェック。
// Security Filter は実カラム式のみ評価される（spec.md §7.1）。
// 別テーブル参照（ANY(別表[列]) や LOOKUP）はサーバ側で実列のみ評価可能なので OK。
// このチェックは「対象テーブル直下の [列名] が仮想列でないか」を見る。
function detectVirtualColsInFilter(
  filterExpr: string,
  targetTableSchema: { Attributes?: Array<Record<string, unknown>> } | undefined,
): string[] {
  if (!filterExpr || !targetTableSchema?.Attributes) return [];
  const virtualCols = new Set<string>();
  for (const a of targetTableSchema.Attributes) {
    if (a.IsVirtual === true && typeof a.Name === "string") virtualCols.add(a.Name);
  }
  if (virtualCols.size === 0) return [];

  // [列名] パターンを抽出。[テーブル名][列名] のような連続形は除外
  // (?<![\]\w]) ... 直前が ] または \w だと別テーブル参照とみなす
  const matches = filterExpr.matchAll(/(?<![\]\w])\[([^\[\]]+)\]/g);
  const found: string[] = [];
  for (const m of matches) {
    if (virtualCols.has(m[1])) found.push(m[1]);
  }
  return [...new Set(found)];
}

export async function setSecurityFilter(args: {
  appId?: string;
  appName?: string;
  tableName: string;
  filter: string;
  apply?: boolean;
  allowVirtualCols?: boolean;
}): Promise<{
  dryRun: boolean;
  applied: boolean;
  tableName: string;
  before: string | null;
  requested: string | null;
  after?: string | null;
  verified?: boolean;
  warning?: string;
  message: string;
}> {
  const credential = resolveCredential(args.appId);
  const appName = await lookupAppName(credential.appId, args.appName);
  const { app } = await fetchLoadApp(appName);
  const dataSets = ((app as Record<string, unknown>).AppData as Record<string, unknown>)?.DataSets as Array<Record<string, unknown>> | undefined;
  if (!dataSets) throw new Error("DataSets 不明");
  const ds = dataSets.find((d) => d.Name === args.tableName);
  if (!ds) {
    const known = dataSets.map((d) => d.Name as string).join(", ");
    throw new Error(`テーブル '${args.tableName}' が見つかりません。既知: ${known}`);
  }

  // 対象テーブルの Schema を取得して仮想列を確認
  const schemas = app.AppData?.DataSchemas ?? [];
  const targetSchema =
    schemas.find((s) => s.AutoSchemaFrom === args.tableName) ??
    schemas.find((s) => s.Name === `${args.tableName}_Schema`) ??
    schemas.find((s) => s.Name === args.tableName);

  const virtualColsInFilter = detectVirtualColsInFilter(args.filter, targetSchema);
  if (virtualColsInFilter.length > 0 && !args.allowVirtualCols) {
    throw new Error(
      `Security Filter 式に対象テーブルの仮想列が含まれています: [${virtualColsInFilter.join("], [")}]。Security Filter はサーバ側で実列のみ評価されるので、仮想列を使うと絞り込みが機能しません（spec.md §7.1）。実列に書き換えるか、明示的に許可する場合は allowVirtualCols: true を指定してください。`,
    );
  }
  const warning =
    virtualColsInFilter.length > 0
      ? `仮想列 [${virtualColsInFilter.join("], [")}] が含まれています（allowVirtualCols: true により許可）。サーバ側で評価できず絞り込みが機能しない可能性があります。`
      : undefined;

  const before = (ds.DataFilter ?? extractEvalSource(ds.DataFilterEvaluatable as Evaluatable | null | undefined)) as string | null;
  const trimmed = args.filter.trim();
  const newFilter: string | null = trimmed === "" ? null : normalizeFormula(trimmed);

  const applyFn = (a: AppDef) => {
    const ds2 = ((a as Record<string, unknown>).AppData as Record<string, unknown>)?.DataSets as Array<Record<string, unknown>> | undefined;
    const target = ds2?.find((d) => d.Name === args.tableName);
    if (!target) throw new Error(`テーブル '${args.tableName}' が見つかりません（リトライ時）`);
    target.DataFilter = newFilter;
    target.DataFilterEvaluatable = null;
  };
  applyFn(app);

  if (before === newFilter) {
    return {
      dryRun: !args.apply,
      applied: false,
      tableName: args.tableName,
      before,
      requested: newFilter,
      warning,
      message: "変更不要",
    };
  }
  if (!args.apply) {
    return {
      dryRun: true,
      applied: false,
      tableName: args.tableName,
      before,
      requested: newFilter,
      warning,
      message: "dry-run。apply: true で実際送信。Security Filter は実カラム式のみ評価される（仮想列・dereference は使用不可）。",
    };
  }

  const { refreshed } = await applyChangesAndSave(credential, appName, applyFn, app);
  const refreshedDs = (((refreshed as Record<string, unknown>).AppData as Record<string, unknown>)?.DataSets as Array<Record<string, unknown>> | undefined)?.find((d) => d.Name === args.tableName);
  const after = (refreshedDs?.DataFilter ?? extractEvalSource(refreshedDs?.DataFilterEvaluatable as Evaluatable | null | undefined)) as string | null;
  await writeFile(snapshotPath(credential.appId), JSON.stringify(refreshed, null, 2), "utf8");

  return {
    dryRun: false,
    applied: true,
    tableName: args.tableName,
    before,
    requested: newFilter,
    after,
    verified: after === newFilter,
    warning,
    message: after === newFilter ? "✅ Security Filter 更新完了" : `⚠️ 期待 '${newFilter}' だが現在 '${after}'。複雑式は再パースされない可能性。`,
  };
}

export async function setColumnYNLabels(args: {
  appId?: string;
  appName?: string;
  tableName: string;
  columnName: string;
  yesLabel: string;
  noLabel: string;
  apply?: boolean;
}): Promise<{ dryRun: boolean; applied: boolean; table: string; column: string; before: { yes: string; no: string }; requested: { yes: string; no: string }; after?: { yes: string; no: string }; verified?: boolean; message: string; }> {
  const credential = resolveCredential(args.appId);
  const appName = await lookupAppName(credential.appId, args.appName);
  const { app } = await fetchLoadApp(appName);
  const attr = findAttribute(app, args.tableName, args.columnName);
  if (attr.Type !== "Yes/No") {
    throw new Error(`列 '${args.columnName}' は Yes/No 型ではありません (Type=${attr.Type})`);
  }
  const auxRaw = (attr.TypeAuxData ?? "{}") as string;
  let aux: Record<string, unknown>;
  try { aux = JSON.parse(auxRaw); } catch { aux = {}; }
  const before = { yes: (aux.YesLabel ?? "") as string, no: (aux.NoLabel ?? "") as string };

  if (before.yes === args.yesLabel && before.no === args.noLabel) {
    return { dryRun: !args.apply, applied: false, table: args.tableName, column: args.columnName, before, requested: { yes: args.yesLabel, no: args.noLabel }, message: "変更不要（既に同じ値）" };
  }

  const applyFn = (a: AppDef) => {
    const target = findAttribute(a, args.tableName, args.columnName);
    const targetAuxRaw = (target.TypeAuxData ?? "{}") as string;
    let targetAux: Record<string, unknown>;
    try { targetAux = JSON.parse(targetAuxRaw); } catch { targetAux = {}; }
    targetAux.YesLabel = args.yesLabel;
    targetAux.NoLabel = args.noLabel;
    target.TypeAuxData = JSON.stringify(targetAux);
  };
  applyFn(app);

  if (!args.apply) {
    return { dryRun: true, applied: false, table: args.tableName, column: args.columnName, before, requested: { yes: args.yesLabel, no: args.noLabel }, message: "dry-run。apply: true で実際送信。" };
  }

  const { refreshed } = await applyChangesAndSave(credential, appName, applyFn, app);
  const refreshedAttr = findAttribute(refreshed, args.tableName, args.columnName);
  const refreshedAuxRaw = (refreshedAttr.TypeAuxData ?? "{}") as string;
  let refreshedAux: Record<string, unknown>;
  try { refreshedAux = JSON.parse(refreshedAuxRaw); } catch { refreshedAux = {}; }
  const after = { yes: (refreshedAux.YesLabel ?? "") as string, no: (refreshedAux.NoLabel ?? "") as string };
  await writeFile(snapshotPath(credential.appId), JSON.stringify(refreshed, null, 2), "utf8");

  return { dryRun: false, applied: true, table: args.tableName, column: args.columnName, before, requested: { yes: args.yesLabel, no: args.noLabel }, after, verified: after.yes === args.yesLabel && after.no === args.noLabel, message: "送信完了・スナップショット更新済み" };
}

export async function setViewDisplayMode(args: {
  appId?: string;
  appName?: string;
  viewName: string;
  displayMode: string;
  apply?: boolean;
}): Promise<{ dryRun: boolean; applied: boolean; viewName: string; before: string | null; requested: string; after?: string | null; verified?: boolean; message: string; }> {
  const credential = resolveCredential(args.appId);
  const appName = await lookupAppName(credential.appId, args.appName);
  const { app } = await fetchLoadApp(appName);
  const controls = ((app as Record<string, unknown>).Presentation as Record<string, unknown>)?.Controls as Array<Record<string, unknown>> | undefined;
  if (!controls) throw new Error("Controls 不明");
  const view = controls.find((c) => c.Name === args.viewName);
  if (!view) throw new Error(`View '${args.viewName}' が見つかりません`);

  const viewDef = view.ViewDefinition as Record<string, unknown> | undefined;
  if (!viewDef) throw new Error(`View '${args.viewName}' に ViewDefinition がありません`);
  const $type = (viewDef.$type ?? "") as string;
  if (!$type.includes("SlideshowViewSettings")) {
    throw new Error(`View '${args.viewName}' は detail view ではありません ($type=${$type})。displayMode は detail view のみ対応`);
  }
  const before = (viewDef.DisplayMode ?? null) as string | null;

  if (before === args.displayMode) {
    return { dryRun: !args.apply, applied: false, viewName: args.viewName, before, requested: args.displayMode, message: "変更不要（既に同じ値）" };
  }

  const applyFn = (a: AppDef) => {
    const ctrls = ((a as Record<string, unknown>).Presentation as Record<string, unknown>)?.Controls as Array<Record<string, unknown>> | undefined;
    const target = ctrls?.find((c) => c.Name === args.viewName);
    if (!target) throw new Error(`View '${args.viewName}' が見つかりません（リトライ時）`);
    const targetDef = target.ViewDefinition as Record<string, unknown>;
    targetDef.DisplayMode = args.displayMode;
    const settingsRaw = (target.Settings ?? "{}") as string;
    let settings: Record<string, unknown>;
    try { settings = JSON.parse(settingsRaw); } catch { settings = {}; }
    settings.DisplayMode = args.displayMode;
    target.Settings = JSON.stringify(settings);
  };
  applyFn(app);

  if (!args.apply) {
    return { dryRun: true, applied: false, viewName: args.viewName, before, requested: args.displayMode, message: "dry-run。apply: true で実際送信。" };
  }

  const { refreshed } = await applyChangesAndSave(credential, appName, applyFn, app);
  const refreshedCtrls = ((refreshed as Record<string, unknown>).Presentation as Record<string, unknown>)?.Controls as Array<Record<string, unknown>> | undefined;
  const refreshedView = refreshedCtrls?.find((c) => c.Name === args.viewName);
  const after = ((refreshedView?.ViewDefinition as Record<string, unknown>)?.DisplayMode ?? null) as string | null;
  await writeFile(snapshotPath(credential.appId), JSON.stringify(refreshed, null, 2), "utf8");

  return { dryRun: false, applied: true, viewName: args.viewName, before, requested: args.displayMode, after, verified: after === args.displayMode, message: after === args.displayMode ? "✅ DisplayMode 更新完了" : `⚠️ 期待 '${args.displayMode}' だが現在 '${after}'。AppSheet 側で再正規化された可能性` };
}

// View Options camelCase → ViewDefinition PascalCase field 名 マッピング
// create_view の buildViewDefinition と語彙を揃える
const VIEW_OPTION_FIELD_MAP: Record<string, string> = {
  // common
  icon: "Icon",
  menuOrder: "MenuOrder",
  // table
  columnWidth: "ColumnWidth",
  enableQuickEdit: "EnableQuickEdit",
  columnOrder: "ColumnOrder",
  // card / deck
  layout: "Layout",
  mainDeckImageColumn: "MainDeckImageColumn",
  imageShape: "ImageShape",
  primaryDeckHeaderColumn: "PrimaryDeckHeaderColumn",
  secondaryDeckHeaderColumn: "SecondaryDeckHeaderColumn",
  deckSummaryColumn: "DeckSummaryColumn",
  deckNestedTableColumn: "DeckNestedTableColumn",
  showActionBar: "ShowActionBar",
  // detail
  mainSlideshowImageColumn: "MainSlideshowImageColumn",
  detailContentColumn: "DetailContentColumn",
  headerColumns: "HeaderColumns",
  quickEditColumns: "QuickEditColumns",
  imageStyle: "ImageStyle",
  useCardLayout: "UseCardLayout",
  displayMode: "DisplayMode",
  maxNestedRows: "MaxNestedRows",
  slideshowMode: "SlideshowMode",
  desktopSplitMode: "DesktopSplitMode",
  useDesktopMultiColumn: "UseDesktopMultiColumn",
  // form
  autoSave: "AutoSave",
  autoReopen: "AutoReopen",
  finishView: "FinishView",
  rowKey: "RowKey",
  formStyle: "FormStyle",
  pageStyle: "PageStyle",
  formFooterStyle: "FormFooterStyle",
  audioInput: "AudioInput",
  // dashboard
  viewEntries: "ViewEntries",
  interactiveMode: "InteractiveMode",
  showTabs: "ShowTabs",
  // calendar
  startDateColumn: "StartDateColumn",
  startTimeColumn: "StartTimeColumn",
  endDateColumn: "EndDateColumn",
  endTimeColumn: "EndTimeColumn",
  labelColumn: "LabelColumn",
  categoryColumn: "CategoryColumn",
  defaultCalendarView: "DefaultCalendarView",
  // map
  mapType: "MapType",
  mapColumn: "MapColumn",
  locationMode: "LocationMode",
  secondaryTable: "SecondaryTable",
  secondaryColumn: "SecondaryColumn",
  minimumClusterSize: "MinimumClusterSize",
  // chart
  chartType: "ChartType",
  useNewChartExperience: "UseNewChartExperience",
  chartConfig: "ChartConfig",
  chartColumns: "ChartColumns",
  groupAggregate: "GroupAggregate",
  trendLine: "TrendLine",
  chartColors: "ChartColors",
  labelType: "LabelType",
  showLegend: "ShowLegend",
  // gallery
  imageSize: "ImageSize",
  // onboarding
  image: "Image",
  title: "Title",
  firstBlurb: "FirstBlurb",
  // grouping (各 view 共通系)
  groupBy: "GroupBy",
  sortBy: "SortBy",
  primarySortColumn: "PrimarySortColumn",
  isPrimarySortDescending: "IsPrimarySortDescending",
  events: "Events",
};

export async function setViewOptions(args: {
  appId?: string;
  appName?: string;
  viewName: string;
  newName?: string;
  tableName?: string;
  position?: string;
  showIf?: string | null;
  displayName?: string | null;
  description?: string | null;
  options?: Record<string, unknown>;
  apply?: boolean;
}): Promise<{ dryRun: boolean; applied: boolean; viewName: string; changes: Record<string, { before: unknown; after?: unknown }>; message: string; }> {
  const credential = resolveCredential(args.appId);
  const appName = await lookupAppName(credential.appId, args.appName);
  const { app } = await fetchLoadApp(appName);
  const controls = ((app as Record<string, unknown>).Presentation as Record<string, unknown>)?.Controls as Array<Record<string, unknown>> | undefined;
  if (!controls) throw new Error("Controls 不明");
  const view = controls.find((c) => c.Name === args.viewName);
  if (!view) throw new Error(`View '${args.viewName}' が見つかりません`);

  const viewDef = view.ViewDefinition as Record<string, unknown> | undefined;
  if (!viewDef) throw new Error(`View '${args.viewName}' に ViewDefinition がありません`);

  // 変更前の値を記録
  const changes: Record<string, { before: unknown; after?: unknown }> = {};
  const recordChange = (key: string, before: unknown) => { changes[key] = { before }; };

  if (args.newName !== undefined && args.newName !== view.Name) recordChange("Name", view.Name);
  if (args.tableName !== undefined && args.tableName !== view.TableOrFolderName) recordChange("TableOrFolderName", view.TableOrFolderName);
  if (args.position !== undefined && args.position !== view.Position) recordChange("Position", view.Position);
  if (args.showIf !== undefined) recordChange("ShowIf", view.ShowIf);
  if (args.displayName !== undefined) recordChange("DisplayName", view.DisplayName);
  if (args.description !== undefined) recordChange("Description", view.Description);

  if (args.options) {
    for (const [optKey] of Object.entries(args.options)) {
      const fieldKey = VIEW_OPTION_FIELD_MAP[optKey] ?? optKey;
      const before = viewDef[fieldKey];
      recordChange(fieldKey, before);
    }
  }

  if (Object.keys(changes).length === 0) {
    return { dryRun: !args.apply, applied: false, viewName: args.viewName, changes: {}, message: "変更なし（指定値が既存値と同じ or オプション未指定）" };
  }

  const applyFn = (a: AppDef) => {
    const ctrls = ((a as Record<string, unknown>).Presentation as Record<string, unknown>)?.Controls as Array<Record<string, unknown>> | undefined;
    const target = ctrls?.find((c) => c.Name === args.viewName);
    if (!target) throw new Error(`View '${args.viewName}' が見つかりません（リトライ時）`);

    if (args.newName !== undefined) target.Name = args.newName;
    if (args.tableName !== undefined) target.TableOrFolderName = args.tableName;
    if (args.position !== undefined) target.Position = args.position;
    if (args.showIf !== undefined) target.ShowIf = args.showIf === null ? null : args.showIf;
    if (args.displayName !== undefined) target.DisplayName = args.displayName;
    if (args.description !== undefined) target.Description = args.description;

    if (args.options) {
      const targetDef = target.ViewDefinition as Record<string, unknown>;
      let settings: Record<string, unknown>;
      try { settings = JSON.parse((target.Settings ?? "{}") as string); } catch { settings = {}; }
      for (const [optKey, value] of Object.entries(args.options)) {
        const fieldKey = VIEW_OPTION_FIELD_MAP[optKey] ?? optKey;
        targetDef[fieldKey] = value;
        settings[fieldKey] = value;
      }
      target.Settings = JSON.stringify(settings);
    }
  };
  applyFn(app);

  if (!args.apply) {
    return { dryRun: true, applied: false, viewName: args.viewName, changes, message: "dry-run。apply: true で実際送信。" };
  }

  const { refreshed } = await applyChangesAndSave(credential, appName, applyFn, app);
  const refreshedCtrls = ((refreshed as Record<string, unknown>).Presentation as Record<string, unknown>)?.Controls as Array<Record<string, unknown>> | undefined;
  // newName がある場合は新名で探す
  const lookupName = args.newName ?? args.viewName;
  const refreshedView = refreshedCtrls?.find((c) => c.Name === lookupName);
  if (refreshedView) {
    const refreshedDef = refreshedView.ViewDefinition as Record<string, unknown> | undefined;
    for (const key of Object.keys(changes)) {
      let after: unknown;
      if (key === "Name") after = refreshedView.Name;
      else if (key === "TableOrFolderName") after = refreshedView.TableOrFolderName;
      else if (key === "Position") after = refreshedView.Position;
      else if (key === "ShowIf") after = refreshedView.ShowIf;
      else if (key === "DisplayName") after = refreshedView.DisplayName;
      else if (key === "Description") after = refreshedView.Description;
      else after = refreshedDef?.[key];
      changes[key].after = after;
    }
  }
  await writeFile(snapshotPath(credential.appId), JSON.stringify(refreshed, null, 2), "utf8");

  const changeCount = Object.keys(changes).length;
  return { dryRun: false, applied: true, viewName: lookupName, changes, message: `✅ View options 更新完了 (${changeCount} 件)` };
}
