import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { log } from "../util/log.js";
import { resolveCredential } from "../auth/appsheet.js";

interface OpenApiDoc {
  openapi: string;
  info: { title?: string; version?: string };
  servers?: Array<{ url: string }>;
  paths: Record<string, Record<string, unknown>>;
  components: {
    schemas: Record<string, OpenApiSchema>;
    securitySchemes?: Record<string, unknown>;
  };
}

interface OpenApiSchema {
  type?: string;
  required?: string[];
  properties?: Record<string, OpenApiProperty>;
  title?: string;
}

interface OpenApiProperty {
  title?: string;
  type?: string;
  format?: string;
  enum?: string[];
  description?: string;
}

interface ColumnInfo {
  name: string;
  type: string;
  format?: string;
  enumValues?: string[];
  required: boolean;
  description?: string;
}

interface TableInfo {
  name: string;
  schemaName: string;
  columns: ColumnInfo[];
  operations: string[];
}

const cache = new Map<string, OpenApiDoc>();

function defaultPath(appId: string): string {
  return resolve(process.cwd(), "snapshots", `openapi-${appId}.json`);
}

function samplesPath(): string {
  return resolve(process.cwd(), "samples", "openapi.json");
}

async function loadFromFile(filePath: string): Promise<OpenApiDoc> {
  const text = await readFile(filePath, "utf8");
  const parsed = JSON.parse(text) as OpenApiDoc;
  if (!parsed.openapi || !parsed.paths || !parsed.components) {
    throw new Error(`OpenAPI 形式として認識できません: ${filePath}`);
  }
  return parsed;
}

async function resolveAndLoad(appId: string, explicitPath?: string): Promise<OpenApiDoc> {
  const candidates = [
    explicitPath,
    defaultPath(appId),
    samplesPath(),
  ].filter((p): p is string => Boolean(p));

  for (const c of candidates) {
    if (existsSync(c)) {
      const doc = await loadFromFile(c);
      cache.set(appId, doc);
      log.info("openapi loaded", { path: c, paths: Object.keys(doc.paths).length });
      return doc;
    }
  }

  throw new Error(
    `OpenAPI スナップショットが見つかりません。次のいずれかに保存してください:\n  - ${defaultPath(appId)}\n  - ${samplesPath()}\n取得 URL: https://www.appsheet.com/api/v2/apps/${appId}/openapi.json (ブラウザで開く)`,
  );
}

function tablesFromPaths(doc: OpenApiDoc): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const path of Object.keys(doc.paths)) {
    const decoded = decodeURIComponent(path);
    const m = decoded.match(/^\/([^/]+)\/(.+)$/);
    if (!m) continue;
    const [, table, op] = m;
    if (!map.has(table)) map.set(table, new Set());
    map.get(table)!.add(op);
  }
  return map;
}

function findSchemaForTable(doc: OpenApiDoc, tableName: string): OpenApiSchema | undefined {
  for (const sch of Object.values(doc.components.schemas)) {
    if (sch.properties && sch.title === tableName) return sch;
  }
  return undefined;
}

function extractColumns(schema: OpenApiSchema): ColumnInfo[] {
  if (!schema.properties) return [];
  const required = new Set(schema.required ?? []);
  return Object.entries(schema.properties).map(([key, prop]) => ({
    name: prop.title ?? key,
    type: prop.type ?? "unknown",
    format: prop.format,
    enumValues: prop.enum,
    required: required.has(key),
    description: prop.description,
  }));
}

export async function loadSpec(args: { appId?: string; path?: string }): Promise<{
  appId: string;
  source: string;
  title?: string;
  tableCount: number;
}> {
  const credential = resolveCredential(args.appId);
  const explicit = args.path ? resolve(args.path) : undefined;
  const doc = await resolveAndLoad(credential.appId, explicit);
  return {
    appId: credential.appId,
    source: explicit ?? defaultPath(credential.appId),
    title: doc.info.title,
    tableCount: tablesFromPaths(doc).size,
  };
}

export async function saveSpec(args: { appId?: string; openapiJson: string }): Promise<{ path: string }> {
  const credential = resolveCredential(args.appId);
  const path = defaultPath(credential.appId);
  await mkdir(dirname(path), { recursive: true });
  JSON.parse(args.openapiJson);
  await writeFile(path, args.openapiJson, "utf8");
  cache.delete(credential.appId);
  log.info("openapi saved", { path });
  return { path };
}

async function ensureLoaded(appId: string): Promise<OpenApiDoc> {
  if (cache.has(appId)) return cache.get(appId)!;
  return resolveAndLoad(appId);
}

export async function getTables(args: { appId?: string }): Promise<Array<{ name: string; operations: string[]; columnCount: number }>> {
  const credential = resolveCredential(args.appId);
  const doc = await ensureLoaded(credential.appId);
  const tables = tablesFromPaths(doc);
  const result: Array<{ name: string; operations: string[]; columnCount: number }> = [];
  for (const [name, ops] of tables.entries()) {
    const sch = findSchemaForTable(doc, name);
    result.push({
      name,
      operations: [...ops].sort(),
      columnCount: sch?.properties ? Object.keys(sch.properties).length : 0,
    });
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

export async function getColumns(args: { appId?: string; tableName: string }): Promise<ColumnInfo[]> {
  const credential = resolveCredential(args.appId);
  const doc = await ensureLoaded(credential.appId);
  const sch = findSchemaForTable(doc, args.tableName);
  if (!sch) {
    const tables = tablesFromPaths(doc);
    if (tables.has(args.tableName)) {
      throw new Error(
        `テーブル '${args.tableName}' は OpenAPI のパスに存在しますがスキーマが空です。AppSheet OpenAPI 生成のバグ（同名長テーブル衝突）の可能性があります。回避策: appsheet_find_records で 1 行取得し、キー一覧から列名を得てください。`,
      );
    }
    throw new Error(
      `テーブル '${args.tableName}' が OpenAPI にありません。利用可能: ${[...tables.keys()].join(", ")}`,
    );
  }
  return extractColumns(sch);
}

export async function getTableSummary(args: { appId?: string; tableName: string }): Promise<TableInfo> {
  const credential = resolveCredential(args.appId);
  const doc = await ensureLoaded(credential.appId);
  const tables = tablesFromPaths(doc);
  const ops = tables.get(args.tableName);
  if (!ops) {
    throw new Error(`テーブル '${args.tableName}' が OpenAPI にありません。利用可能: ${[...tables.keys()].join(", ")}`);
  }
  const sch = findSchemaForTable(doc, args.tableName);
  return {
    name: args.tableName,
    schemaName: sch?.title ?? "",
    columns: sch ? extractColumns(sch) : [],
    operations: [...ops].sort(),
  };
}

export async function getAppOverview(args: { appId?: string }): Promise<{
  appId: string;
  title?: string;
  openapiVersion: string;
  serverUrl?: string;
  tables: Array<{ name: string; operations: string[]; columnCount: number }>;
  refreshUrl: string;
}> {
  const credential = resolveCredential(args.appId);
  const doc = await ensureLoaded(credential.appId);
  return {
    appId: credential.appId,
    title: doc.info.title,
    openapiVersion: doc.openapi,
    serverUrl: doc.servers?.[0]?.url,
    tables: await getTables({ appId: credential.appId }),
    refreshUrl: `https://www.appsheet.com/api/v2/apps/${credential.appId}/openapi.json`,
  };
}
