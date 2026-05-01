#!/usr/bin/env node
import "dotenv/config";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { log } from "./util/log.js";
import {
  findRecords,
  addRecords,
  editRecords,
  deleteRecords,
  invokeAction,
} from "./tools/data.js";
import {
  loadSpec,
  saveSpec,
  getTables,
  getColumns,
  getTableSummary,
  getAppOverview,
} from "./tools/spec.js";
import {
  importHar,
  loadAppDef,
  getAppMetadata,
  getFullColumns,
  getActions,
  getActionDetail,
  getViews,
  getBots,
} from "./tools/appdef.js";
import {
  refreshAppDef,
  setColumnFlag,
  setColumnDescription,
  setColumnType,
} from "./tools/edit.js";

const tools: Tool[] = [
  {
    name: "appsheet_find_records",
    description:
      "AppSheet API v2 の Find アクションでテーブルからレコードを取得する。selector に AppSheet 式（FILTER/SELECT 等）を渡せる。",
    inputSchema: {
      type: "object",
      properties: {
        tableName: { type: "string", description: "AppSheet 上のテーブル名（日本語可）" },
        selector: {
          type: "string",
          description: 'AppSheet 式。例: \'Filter("記事管理", [ステータス] = "未処理")\'',
        },
        appId: { type: "string", description: "対象 App ID（省略時は .env 既定）" },
        locale: { type: "string" },
        timezone: { type: "string" },
      },
      required: ["tableName"],
    },
  },
  {
    name: "appsheet_add_records",
    description: "AppSheet API v2 の Add で複数行を追加する。",
    inputSchema: {
      type: "object",
      properties: {
        tableName: { type: "string" },
        rows: { type: "array", items: { type: "object" } },
        appId: { type: "string" },
      },
      required: ["tableName", "rows"],
    },
  },
  {
    name: "appsheet_edit_records",
    description: "AppSheet API v2 の Edit で既存行を更新する。各行はキー列を含む必要がある。",
    inputSchema: {
      type: "object",
      properties: {
        tableName: { type: "string" },
        rows: { type: "array", items: { type: "object" } },
        appId: { type: "string" },
      },
      required: ["tableName", "rows"],
    },
  },
  {
    name: "appsheet_delete_records",
    description: "AppSheet API v2 の Delete で行を削除する。各行はキー列のみで OK。",
    inputSchema: {
      type: "object",
      properties: {
        tableName: { type: "string" },
        rows: { type: "array", items: { type: "object" } },
        appId: { type: "string" },
      },
      required: ["tableName", "rows"],
    },
  },
  {
    name: "appsheet_invoke_action",
    description: "AppSheet で定義された任意のアクションを実行する。",
    inputSchema: {
      type: "object",
      properties: {
        tableName: { type: "string" },
        actionName: { type: "string", description: "AppSheet 上の Action 名" },
        rows: { type: "array", items: { type: "object" } },
        appId: { type: "string" },
      },
      required: ["tableName", "actionName"],
    },
  },
  {
    name: "appsheet_load_spec",
    description:
      "OpenAPI スナップショット（snapshots/openapi-<appId>.json または samples/openapi.json）を読み込む。`path` を指定すれば任意のファイルを読める。最新化はブラウザで https://www.appsheet.com/api/v2/apps/<App ID>/openapi.json を開いて保存。",
    inputSchema: {
      type: "object",
      properties: {
        appId: { type: "string" },
        path: { type: "string", description: "明示的な OpenAPI JSON ファイルパス" },
      },
    },
  },
  {
    name: "appsheet_save_spec",
    description:
      "OpenAPI JSON 文字列を snapshots/openapi-<appId>.json に保存する。ブラウザで取得した内容を貼って渡せば永続化される。",
    inputSchema: {
      type: "object",
      properties: {
        appId: { type: "string" },
        openapiJson: { type: "string", description: "OpenAPI JSON 全体（文字列）" },
      },
      required: ["openapiJson"],
    },
  },
  {
    name: "appsheet_get_app_overview",
    description: "OpenAPI から取れる範囲のアプリ全体メタ（タイトル・テーブル一覧・列数・操作）。",
    inputSchema: {
      type: "object",
      properties: {
        appId: { type: "string" },
      },
    },
  },
  {
    name: "appsheet_get_tables",
    description: "OpenAPI に含まれる全テーブル名と利用可能な操作・列数を返す。",
    inputSchema: {
      type: "object",
      properties: {
        appId: { type: "string" },
      },
    },
  },
  {
    name: "appsheet_get_columns",
    description:
      "指定テーブルの列情報（名前・型・format・enum・required）を OpenAPI から返す。式や仮想列は含まれない（Phase 3 で Editor 経由予定）。",
    inputSchema: {
      type: "object",
      properties: {
        tableName: { type: "string" },
        appId: { type: "string" },
      },
      required: ["tableName"],
    },
  },
  {
    name: "appsheet_get_table_summary",
    description: "テーブルの操作一覧 + 列定義を一括取得（get_columns + 操作リスト）。",
    inputSchema: {
      type: "object",
      properties: {
        tableName: { type: "string" },
        appId: { type: "string" },
      },
      required: ["tableName"],
    },
  },
  {
    name: "appsheet_import_har",
    description:
      "DevTools で保存した HAR ファイルから loadApp レスポンスを抽出して snapshots/appdef-<appId>.json に保存する。HAR 取得手順は AppSheet Editor で F12 → Network → 右クリック → Save all as HAR with content。",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "HAR ファイルのパス（絶対 or cwd 相対）" },
        appId: { type: "string" },
      },
      required: ["path"],
    },
  },
  {
    name: "appsheet_load_app_def",
    description: "snapshots/appdef-<appId>.json を読み込みキャッシュする。テーブル/Action/View/Bot 件数を返す。",
    inputSchema: {
      type: "object",
      properties: {
        appId: { type: "string" },
        path: { type: "string", description: "明示的な appdef JSON ファイルパス" },
      },
    },
  },
  {
    name: "appsheet_get_app_metadata",
    description: "アプリのトップレベルメタ（タイトル・バージョン・テーブル名一覧）。",
    inputSchema: {
      type: "object",
      properties: {
        appId: { type: "string" },
      },
    },
  },
  {
    name: "appsheet_get_full_columns",
    description:
      "appdef スナップショットから列の完全情報（型・式・初期値・仮想列・enum・各種フラグ）を取得する。Phase 2 の get_columns より詳細。",
    inputSchema: {
      type: "object",
      properties: {
        tableName: { type: "string" },
        appId: { type: "string" },
      },
      required: ["tableName"],
    },
  },
  {
    name: "appsheet_get_actions",
    description: "Action 一覧（名前・テーブル・条件式・値式・スコープ・アイコン）。table または name でフィルタ可。",
    inputSchema: {
      type: "object",
      properties: {
        appId: { type: "string" },
        tableFilter: { type: "string", description: "対象テーブル名でフィルタ" },
        nameContains: { type: "string", description: "Action 名に含まれる文字列" },
      },
    },
  },
  {
    name: "appsheet_get_action_detail",
    description: "指定 Action の生データを丸ごと返す（評価ツリー・ActionSettings・ActionDefinition 含む）。",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        appId: { type: "string" },
      },
      required: ["name"],
    },
  },
  {
    name: "appsheet_get_views",
    description: "View 一覧（名前・対象テーブル・タイプ・Position・ShowIf 条件）。",
    inputSchema: {
      type: "object",
      properties: {
        appId: { type: "string" },
        tableFilter: { type: "string" },
      },
    },
  },
  {
    name: "appsheet_get_bots",
    description: "Bot/Automation 一覧（このアプリで未作成なら空配列）。",
    inputSchema: {
      type: "object",
      properties: {
        appId: { type: "string" },
      },
    },
  },
  {
    name: "appsheet_refresh_app_def",
    description:
      "Cookie 認証で /api/loadApp を叩き snapshots/appdef-<appId>.json を再生成する。HAR 取得手順を省略できる。Cookie が期限切れなら .env の APPSHEET_COOKIE を再取得する必要あり。",
    inputSchema: {
      type: "object",
      properties: {
        appId: { type: "string" },
        appName: { type: "string", description: "AppSheet 内部 App Name（省略時はスナップショットから取得）" },
      },
    },
  },
  {
    name: "appsheet_set_column_flag",
    description:
      "列のブール系フラグを書き換え。対象は IsHidden / Searchable / IsLabel / IsScannable / IsNfcScannable / IsSensitive / ResetOnEdit / IsRequired / DefEdit のみ。デフォルトは dry-run。実適用は apply: true 指定が必須。",
    inputSchema: {
      type: "object",
      properties: {
        appId: { type: "string" },
        appName: { type: "string" },
        tableName: { type: "string" },
        columnName: { type: "string" },
        flag: {
          type: "string",
          enum: ["IsHidden", "Searchable", "IsLabel", "IsScannable", "IsNfcScannable", "IsSensitive", "ResetOnEdit", "IsRequired", "DefEdit"],
        },
        value: { type: "boolean" },
        apply: { type: "boolean", description: "true で実際に saveapp に POST。省略時 false（dry-run）" },
      },
      required: ["tableName", "columnName", "flag", "value"],
    },
  },
  {
    name: "appsheet_set_column_type",
    description:
      "列の Type を変更（Text/LongText/Number/Decimal/Url/Email/Phone 等）。互換性ある変換は安全リストで判定し、リスト外は warning を返す。デフォルト dry-run。",
    inputSchema: {
      type: "object",
      properties: {
        appId: { type: "string" },
        appName: { type: "string" },
        tableName: { type: "string" },
        columnName: { type: "string" },
        newType: { type: "string", description: "Text / LongText / Number / Decimal / Percent / Url / Email / Phone / Name / Date / DateTime / Time / Enum / Ref など" },
        apply: { type: "boolean" },
      },
      required: ["tableName", "columnName", "newType"],
    },
  },
  {
    name: "appsheet_set_column_description",
    description:
      "列の Description を更新。デフォルトは dry-run。AppSheet 側は = で始まると式扱いになる点に注意。",
    inputSchema: {
      type: "object",
      properties: {
        appId: { type: "string" },
        appName: { type: "string" },
        tableName: { type: "string" },
        columnName: { type: "string" },
        description: { type: "string" },
        apply: { type: "boolean" },
      },
      required: ["tableName", "columnName", "description"],
    },
  },
];

type ToolArgs = Record<string, unknown>;

async function dispatch(name: string, args: ToolArgs): Promise<unknown> {
  switch (name) {
    case "appsheet_find_records":
      return findRecords(args as Parameters<typeof findRecords>[0]);
    case "appsheet_add_records":
      return addRecords(args as Parameters<typeof addRecords>[0]);
    case "appsheet_edit_records":
      return editRecords(args as Parameters<typeof editRecords>[0]);
    case "appsheet_delete_records":
      return deleteRecords(args as Parameters<typeof deleteRecords>[0]);
    case "appsheet_invoke_action":
      return invokeAction(args as Parameters<typeof invokeAction>[0]);
    case "appsheet_load_spec":
      return loadSpec(args as Parameters<typeof loadSpec>[0]);
    case "appsheet_save_spec":
      return saveSpec(args as Parameters<typeof saveSpec>[0]);
    case "appsheet_get_app_overview":
      return getAppOverview(args as Parameters<typeof getAppOverview>[0]);
    case "appsheet_get_tables":
      return getTables(args as Parameters<typeof getTables>[0]);
    case "appsheet_get_columns":
      return getColumns(args as Parameters<typeof getColumns>[0]);
    case "appsheet_get_table_summary":
      return getTableSummary(args as Parameters<typeof getTableSummary>[0]);
    case "appsheet_import_har":
      return importHar(args as Parameters<typeof importHar>[0]);
    case "appsheet_load_app_def":
      return loadAppDef(args as Parameters<typeof loadAppDef>[0]);
    case "appsheet_get_app_metadata":
      return getAppMetadata(args as Parameters<typeof getAppMetadata>[0]);
    case "appsheet_get_full_columns":
      return getFullColumns(args as Parameters<typeof getFullColumns>[0]);
    case "appsheet_get_actions":
      return getActions(args as Parameters<typeof getActions>[0]);
    case "appsheet_get_action_detail":
      return getActionDetail(args as Parameters<typeof getActionDetail>[0]);
    case "appsheet_get_views":
      return getViews(args as Parameters<typeof getViews>[0]);
    case "appsheet_get_bots":
      return getBots(args as Parameters<typeof getBots>[0]);
    case "appsheet_refresh_app_def":
      return refreshAppDef(args as Parameters<typeof refreshAppDef>[0]);
    case "appsheet_set_column_flag":
      return setColumnFlag(args as Parameters<typeof setColumnFlag>[0]);
    case "appsheet_set_column_type":
      return setColumnType(args as Parameters<typeof setColumnType>[0]);
    case "appsheet_set_column_description":
      return setColumnDescription(args as Parameters<typeof setColumnDescription>[0]);
    default:
      throw new Error(`未知のツール: ${name}`);
  }
}

async function main(): Promise<void> {
  const server = new Server(
    { name: "appsheet-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    log.info("call_tool", { name });
    try {
      const result = await dispatch(name, (args ?? {}) as ToolArgs);
      return {
        content: [
          { type: "text", text: typeof result === "string" ? result : JSON.stringify(result, null, 2) },
        ],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("tool_error", { name, message });
      return {
        content: [{ type: "text", text: `エラー: ${message}` }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info("appsheet-mcp ready");
}

main().catch((err) => {
  log.error("fatal", { message: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
