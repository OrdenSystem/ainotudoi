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
    attr.AppFormula = newFormula;
    // InternalQualifier.AppFormulaExpression を消去して再パースさせる
    if (attr.InternalQualifier && typeof attr.InternalQualifier === "object") {
      const iq = attr.InternalQualifier as Record<string, unknown>;
      delete iq.AppFormulaExpression;
    }
  } else {
    before = (attr.Default ?? null) as string | null;
    attr.Default = newFormula;
    if (attr.InternalQualifier && typeof attr.InternalQualifier === "object") {
      const iq = attr.InternalQualifier as Record<string, unknown>;
      delete iq.DefaultExpression;
    }
  }

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

  const result = await postSaveApp(credential.appId, appName, app);
  const refreshed = result.app ?? (await fetchLoadApp(appName)).app;
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
  aux.EnumValues = args.values;
  attr.TypeAuxData = JSON.stringify(aux);

  if (!args.apply) {
    return { dryRun: true, applied: false, table: args.tableName, column: args.columnName, before, requested: args.values, message: "dry-run" };
  }

  const result = await postSaveApp(credential.appId, appName, app);
  const refreshed = result.app ?? (await fetchLoadApp(appName)).app;
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

  const newAction: Record<string, unknown> = {
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
    CreatedBy: "User",
    Icon: icon,
    IconRunnerUps: null,
    Table: args.tableName,
    TableScope: false,
    Condition: cond,
    ColumnToEdit: null,
    ColumnAttachment: null,
    ActionOrder: actions.length,
    ActionDefinition: actionDefinition,
    Comment: null,
    IsValid: true,
    Visibility: "ALWAYS",
    DisableAutoUpdate: false,
    ComponentId: generateComponentId(),
    ExprLookup: {},
    _isNew: true,
    _version: 0,
    _index: actions.length,
    _path: `AppData.DataActions[${actions.length}]`,
  };
  actions.push(newAction);

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

  const result = await postSaveApp(credential.appId, appName, app);
  const refreshed = result.app ?? (await fetchLoadApp(appName)).app;
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

  attr.Type = "Ref";
  attr.TypeAuxData = JSON.stringify(newAux);

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

  const result = await postSaveApp(credential.appId, appName, app);
  const refreshed = result.app ?? (await fetchLoadApp(appName)).app;
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

export async function setSecurityFilter(args: {
  appId?: string;
  appName?: string;
  tableName: string;
  filter: string;
  apply?: boolean;
}): Promise<{
  dryRun: boolean;
  applied: boolean;
  tableName: string;
  before: string | null;
  requested: string | null;
  after?: string | null;
  verified?: boolean;
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

  const before = (ds.DataFilter ?? extractEvalSource(ds.DataFilterEvaluatable as Evaluatable | null | undefined)) as string | null;
  const trimmed = args.filter.trim();
  const newFilter: string | null = trimmed === "" ? null : normalizeFormula(trimmed);

  ds.DataFilter = newFilter;
  ds.DataFilterEvaluatable = null;

  if (before === newFilter) {
    return {
      dryRun: !args.apply,
      applied: false,
      tableName: args.tableName,
      before,
      requested: newFilter,
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
      message: "dry-run。apply: true で実際送信。Security Filter は実カラム式のみ評価される（仮想列・dereference は使用不可）。",
    };
  }

  const result = await postSaveApp(credential.appId, appName, app);
  const refreshed = result.app ?? (await fetchLoadApp(appName)).app;
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
    message: after === newFilter ? "✅ Security Filter 更新完了" : `⚠️ 期待 '${newFilter}' だが現在 '${after}'。複雑式は再パースされない可能性。`,
  };
}
