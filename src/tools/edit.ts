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

  attr[args.flag] = args.value;

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

  const result = await postSaveApp(credential.appId, appName, app);
  const refreshed = result.app ?? (await fetchLoadApp(appName)).app;
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

  attr.Type = args.newType;

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

  const result = await postSaveApp(credential.appId, appName, app);
  const refreshed = result.app ?? (await fetchLoadApp(appName)).app;
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
  // 26 char Crockford base32 (uppercase + 2-7), AppSheet 互換形式
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let id = "";
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

  attr.Description = args.description;

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

  const result = await postSaveApp(credential.appId, appName, app);
  const refreshed = result.app ?? (await fetchLoadApp(appName)).app;
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
