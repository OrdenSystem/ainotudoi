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
