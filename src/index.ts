#!/usr/bin/env node
import { config as dotenvConfig } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// MCP サーバーは process.cwd() が呼出側次第で変わるため、
// __dirname 基準で .env を絶対パスで読み込む（dist/ から見て ../.env）
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenvConfig({ path: resolve(__dirname, "..", ".env") });

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
  setColumnFormula,
  addVirtualColumn,
  removeColumn,
  cloneView,
  cloneAction,
  removeView,
  removeAction,
  cloneBot,
  removeBot,
  setActionCondition,
  setActionValue,
  setEnumValues,
  addEnumValue,
  removeEnumValue,
  cloneTable,
  removeTable,
  setSecurityFilter,
  promoteToRef,
  addOpenUrlAction,
  createBot,
  addSlice,
  removeSlice,
  addCallScriptTask,
  setCallScriptTask,
  createTable,
  createView,
  setColumnYNLabels,
  setViewDisplayMode,
  setViewOptions,
  setColumnOptions,
  addSendEmailTask,
  addWebhookTask,
  addBranchStep,
  removeStep,
  moveStep,
  setBotTrigger,
  setBotOptions,
} from "./tools/edit.js";

const tools: Tool[] = [
  {
    name: "appsheet_find_records",
    description:
      "AppSheet API v2 の Find アクションでテーブルからレコードを取得する。\n" +
      "selector の書式: \n" +
      '・推奨: \'Filter("テーブル名", boolean式)\' / \'Select(テーブル[列], cond)\'\n' +
      "・boolean 式単体（例: '[ステータス] = \"未処理\"'）を渡すと**自動的に Filter() でラップ**される（DX 改善）\n" +
      "・空文字 / 省略時は全件取得（ただし AppSheet 側の上限あり）\n" +
      "AppSheet API は selector 不一致だとエラーでなく **0 件返却**するので注意。",
    inputSchema: {
      type: "object",
      properties: {
        tableName: { type: "string", description: "AppSheet 上のテーブル名（日本語可）" },
        selector: {
          type: "string",
          description:
            'AppSheet 式。Filter("table", expr) ラッパー必須（boolean 単体は自動ラップ）。' +
            '例: \'Filter("記事管理", [ステータス] = "未処理")\' / \'[ステータス] = "未処理"\' (自動ラップ)',
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
    name: "appsheet_add_virtual_column",
    description:
      "テーブルに新規バーチャル列（仮想列）を追加。AppFormula 必須。AppSheet が自動で式パース・依存解決・ComponentId 確定する。デフォルト dry-run。",
    inputSchema: {
      type: "object",
      properties: {
        appId: { type: "string" },
        appName: { type: "string" },
        tableName: { type: "string" },
        columnName: { type: "string", description: "新しい列の名前" },
        formula: { type: "string", description: "AppFormula。例: '[テーマ] & \" - \" & [カテゴリ]'。先頭の = は省略可" },
        resultType: { type: "string", description: "結果の型。Text/LongText/Number/Decimal/Url/Email/Date/DateTime/Yes_No/Name 等。既定 Text" },
        description: { type: "string" },
        displayName: { type: "string" },
        isHidden: { type: "boolean" },
        isLabel: { type: "boolean" },
        apply: { type: "boolean" },
      },
      required: ["tableName", "columnName", "formula"],
    },
  },
  {
    name: "appsheet_clone_view",
    description:
      "既存 View をクローンして新規 View を作成（名前・対象テーブル・Position を置換可）。Capture-and-Replay 安全パターン。デフォルト dry-run。",
    inputSchema: {
      type: "object",
      properties: {
        appId: { type: "string" },
        appName: { type: "string" },
        sourceViewName: { type: "string", description: "コピー元の View 名（例: 記事管理_Detail）" },
        newViewName: { type: "string" },
        targetTable: { type: "string", description: "対象テーブル変更時に指定" },
        position: { type: "string", description: "center / left / right / ref / menu" },
        apply: { type: "boolean" },
      },
      required: ["sourceViewName", "newViewName"],
    },
  },
  {
    name: "appsheet_clone_action",
    description:
      "既存 Action をクローンして新規 Action を作成（名前・対象テーブル・列を置換可）。式は基本コピー元のままなので、後で setColumnFlag 系や直接修正で式を変更する想定。",
    inputSchema: {
      type: "object",
      properties: {
        appId: { type: "string" },
        appName: { type: "string" },
        sourceActionName: { type: "string", description: "コピー元の Action 名" },
        newActionName: { type: "string" },
        targetTable: { type: "string" },
        targetColumn: { type: "string" },
        apply: { type: "boolean" },
      },
      required: ["sourceActionName", "newActionName"],
    },
  },
  {
    name: "appsheet_remove_view",
    description: "View を削除する。デフォルト dry-run。",
    inputSchema: {
      type: "object",
      properties: {
        appId: { type: "string" },
        appName: { type: "string" },
        viewName: { type: "string" },
        apply: { type: "boolean" },
      },
      required: ["viewName"],
    },
  },
  {
    name: "appsheet_clone_bot",
    description:
      "既存 Bot をクローンして新規 Bot 作成。AppBots/AppEvents/AppProcesses/Tasks の 4 配列に分散する Bot 構造を一括コピーし、名前と ComponentId を再生成する。Capture-and-Replay 安全パターン。デフォルト dry-run。",
    inputSchema: {
      type: "object",
      properties: {
        appId: { type: "string" },
        appName: { type: "string" },
        sourceBotName: { type: "string", description: "コピー元の Bot 名" },
        newBotName: { type: "string" },
        apply: { type: "boolean" },
      },
      required: ["sourceBotName", "newBotName"],
    },
  },
  {
    name: "appsheet_clone_table",
    description:
      "テーブル丸ごとクローン作成。DataSet + DataSchema(全カラム) + 関連 Action 全部 + 関連 View 全部を一括コピーし、ComponentId 再生成。注意: DataSet.Source は元シートを参照したまま（必要なら別途編集）。デフォルト dry-run。",
    inputSchema: {
      type: "object",
      properties: {
        appId: { type: "string" },
        appName: { type: "string" },
        sourceTableName: { type: "string" },
        newTableName: { type: "string" },
        apply: { type: "boolean" },
      },
      required: ["sourceTableName", "newTableName"],
    },
  },
  {
    name: "appsheet_remove_table",
    description: "テーブルを削除（紐づく DataSet/Schema/Actions/Views を一括削除）。デフォルト dry-run。",
    inputSchema: {
      type: "object",
      properties: {
        appId: { type: "string" },
        appName: { type: "string" },
        tableName: { type: "string" },
        apply: { type: "boolean" },
      },
      required: ["tableName"],
    },
  },
  {
    name: "appsheet_set_column_formula",
    description:
      "列の AppFormula（仮想列の式）または Initial Value を更新。先頭 = は省略可。InternalQualifier の式木は再パース用にクリアする。デフォルト dry-run。",
    inputSchema: {
      type: "object",
      properties: {
        appId: { type: "string" },
        appName: { type: "string" },
        tableName: { type: "string" },
        columnName: { type: "string" },
        kind: { type: "string", enum: ["AppFormula", "InitialValue"] },
        formula: { type: "string", description: "AppSheet 式。例: '[テーマ] & \" - \" & [カテゴリ]'" },
        apply: { type: "boolean" },
      },
      required: ["tableName", "columnName", "kind", "formula"],
    },
  },
  {
    name: "appsheet_set_action_condition",
    description: "Action の Condition（実行可否の条件式）を更新。デフォルト dry-run。",
    inputSchema: {
      type: "object",
      properties: {
        appId: { type: "string" },
        appName: { type: "string" },
        actionName: { type: "string" },
        condition: { type: "string", description: "AppSheet 式。例: 'NOT(ISBLANK([WP投稿URL]))'" },
        apply: { type: "boolean" },
      },
      required: ["actionName", "condition"],
    },
  },
  {
    name: "appsheet_set_action_value",
    description: "Action の Value（操作対象値の式）を更新。デフォルト dry-run。",
    inputSchema: {
      type: "object",
      properties: {
        appId: { type: "string" },
        appName: { type: "string" },
        actionName: { type: "string" },
        value: { type: "string", description: "AppSheet 式" },
        apply: { type: "boolean" },
      },
      required: ["actionName", "value"],
    },
  },
  {
    name: "appsheet_set_enum_values",
    description: "Enum / EnumList 型の列の選択肢を一括置換。TypeAuxData.Values 配列を更新。",
    inputSchema: {
      type: "object",
      properties: {
        appId: { type: "string" },
        appName: { type: "string" },
        tableName: { type: "string" },
        columnName: { type: "string" },
        values: { type: "array", items: { type: "string" } },
        apply: { type: "boolean" },
      },
      required: ["tableName", "columnName", "values"],
    },
  },
  {
    name: "appsheet_add_enum_value",
    description: "Enum / EnumList 列に選択肢を 1 つ追加（既存値は維持）。",
    inputSchema: {
      type: "object",
      properties: {
        appId: { type: "string" },
        appName: { type: "string" },
        tableName: { type: "string" },
        columnName: { type: "string" },
        value: { type: "string" },
        apply: { type: "boolean" },
      },
      required: ["tableName", "columnName", "value"],
    },
  },
  {
    name: "appsheet_remove_enum_value",
    description: "Enum / EnumList 列から選択肢を 1 つ削除。",
    inputSchema: {
      type: "object",
      properties: {
        appId: { type: "string" },
        appName: { type: "string" },
        tableName: { type: "string" },
        columnName: { type: "string" },
        value: { type: "string" },
        apply: { type: "boolean" },
      },
      required: ["tableName", "columnName", "value"],
    },
  },
  {
    name: "appsheet_remove_bot",
    description: "Bot を削除（紐づく Event / Process / Tasks も自動的に削除）。デフォルト dry-run。",
    inputSchema: {
      type: "object",
      properties: {
        appId: { type: "string" },
        appName: { type: "string" },
        botName: { type: "string" },
        apply: { type: "boolean" },
      },
      required: ["botName"],
    },
  },
  {
    name: "appsheet_remove_action",
    description: "Action を削除する。System Action（Add/Edit/Delete）の削除は推奨されない。デフォルト dry-run。",
    inputSchema: {
      type: "object",
      properties: {
        appId: { type: "string" },
        appName: { type: "string" },
        actionName: { type: "string" },
        apply: { type: "boolean" },
      },
      required: ["actionName"],
    },
  },
  {
    name: "appsheet_remove_column",
    description:
      "テーブルから列を削除。バーチャル列は安全。実列の削除はデータソース側に影響しないが AppSheet 上の参照（Action/View/Slice）が壊れる可能性。キー列は推奨されない。デフォルト dry-run。",
    inputSchema: {
      type: "object",
      properties: {
        appId: { type: "string" },
        appName: { type: "string" },
        tableName: { type: "string" },
        columnName: { type: "string" },
        apply: { type: "boolean" },
      },
      required: ["tableName", "columnName"],
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
  {
    name: "appsheet_set_column_yn_labels",
    description:
      "Yes/No 型列の表示ラベル (YesLabel / NoLabel) を設定する。データ型は変更しない (TypeAuxData の YesLabel / NoLabel を更新)。例: 完了フラグ → '完了' / '未完了'。デフォルト dry-run。",
    inputSchema: {
      type: "object",
      properties: {
        appId: { type: "string" },
        appName: { type: "string" },
        tableName: { type: "string" },
        columnName: { type: "string" },
        yesLabel: { type: "string", description: "Yes (TRUE) 時の表示文字列" },
        noLabel: { type: "string", description: "No (FALSE) 時の表示文字列" },
        apply: { type: "boolean" },
      },
      required: ["tableName", "columnName", "yesLabel", "noLabel"],
    },
  },
  {
    name: "appsheet_add_send_email_task",
    description:
      "Bot の Process に Send Email Task を追加する。Behavior.Tasks に Email Task ($type=AppWorkflowActionEmail) を作成し、Process.Nodes に TaskNode (NodeType=RUN_TASK, ActionType=Email) を append。\n\n## 必須\n- processName: 既存 Process の Name (Bot 作成時に Process が同時生成される)\n- taskName: Task のユニーク名\n- tableName: 対象テーブル\n- subject: メール件名 ('<<[列名]>>' で動的展開可)\n\n## 任意\n- toList / ccList / bccList: 宛先メール配列\n- body: 本文 ('<<[列名]>>' 展開可)\n- emailType: 'CustomTemplate' (default) / 'AppDefault'\n- attachmentTemplate / attachmentContentType (PDF/DOCX/XLSX/HTML/CSV)\n- forEntireTable: true でスケジュール時テーブル全行送信\n\nデフォルト dry-run。",
    inputSchema: {
      type: "object",
      properties: {
        appId: { type: "string" }, appName: { type: "string" },
        processName: { type: "string" },
        taskName: { type: "string" },
        tableName: { type: "string" },
        toList: { type: "array", items: { type: "string" } },
        ccList: { type: "array", items: { type: "string" } },
        bccList: { type: "array", items: { type: "string" } },
        fromAddress: { type: "string" },
        fromDisplay: { type: "string" },
        replyTo: { type: "string" },
        preHeader: { type: "string" },
        subject: { type: "string" },
        body: { type: "string" },
        emailType: { type: "string", enum: ["CustomTemplate", "AppDefault"] },
        bodyTemplate: { type: ["string", "null"] },
        attachmentTemplate: { type: ["string", "null"] },
        attachmentName: { type: ["string", "null"] },
        attachmentContentType: { type: "string", enum: ["PDF", "DOCX", "XLSX", "HTML", "CSV"] },
        useDefaultContent: { type: "boolean" },
        forEntireTable: { type: "boolean" },
        stepName: { type: "string" },
        apply: { type: "boolean" },
      },
      required: ["processName", "taskName", "tableName", "subject"],
    },
  },
  {
    name: "appsheet_add_webhook_task",
    description:
      "Bot の Process に Webhook Task を追加する。Behavior.Tasks に Webhook Task ($type=AppWorkflowActionWebhook) を作成し、Process.Nodes に TaskNode (NodeType=RUN_TASK, ActionType=Webhook) を append。\n\n## 必須\n- processName / taskName / tableName / url\n\n## 任意\n- preset: 'Custom' (default) / 'Slack Hook' / 'AppSheet API'\n- verb: 'Get' / 'Post' (default) / 'Put' / 'Delete' / 'Patch'\n- contentType: 'JSON' (default) / 'XML' / 'FormUrlEncoded'\n- body: リクエストボディ (templating可)\n- headers: [{name, value}] 配列\n- timeoutSeconds: default 180\n- maxRetryCount: default 3\n- asyncExec: 非同期実行\n- targetAppId: AppSheet API preset 用の対象 App ID\n\nデフォルト dry-run。",
    inputSchema: {
      type: "object",
      properties: {
        appId: { type: "string" }, appName: { type: "string" },
        processName: { type: "string" },
        taskName: { type: "string" },
        tableName: { type: "string" },
        url: { type: "string" },
        preset: { type: "string", enum: ["Custom", "Slack Hook", "AppSheet API"] },
        verb: { type: "string", enum: ["Get", "Post", "Put", "Delete", "Patch"] },
        contentType: { type: "string", enum: ["JSON", "XML", "FormUrlEncoded"] },
        body: { type: "string" },
        bodyTemplate: { type: ["string", "null"] },
        headers: {
          type: "array",
          items: { type: "object", properties: { name: { type: "string" }, value: { type: "string" } }, required: ["name", "value"] },
        },
        timeoutSeconds: { type: "number" },
        maxRetryCount: { type: "number" },
        asyncExec: { type: "boolean" },
        forEntireTable: { type: "boolean" },
        stepName: { type: "string" },
        targetAppId: { type: "string" },
        apply: { type: "boolean" },
      },
      required: ["processName", "taskName", "tableName", "url"],
    },
  },
  {
    name: "appsheet_remove_step",
    description:
      "Bot の Process から指定 Step を削除する。Process.Nodes から該当 Node を splice、TaskNode の場合は対応 Task も他参照が無ければ自動削除。\n\n## 識別方法\n- stepName で指定 (推奨・デフォルト)\n- 同名 step 複数の場合は componentId で指定\n\n## 動作\n- TaskNode 削除時: 他 Process/Step から参照されていない Task は Behavior.Tasks からも削除 (removeOrphanedTask=false で抑止可)\n- IfElseNode 削除時: IfNodes/ElseNodes 配下の子 Step も連動削除 (再帰的に消える)\n- RunActionNode / その他: Node のみ削除\n\nデフォルト dry-run。",
    inputSchema: {
      type: "object",
      properties: {
        appId: { type: "string" }, appName: { type: "string" },
        processName: { type: "string" },
        stepName: { type: "string", description: "削除対象の StepName" },
        componentId: { type: "string", description: "ComponentId による削除 (重複名がある場合)" },
        removeOrphanedTask: { type: "boolean", description: "TaskNode 削除時に紐づく Task も削除するか (default: true)" },
        apply: { type: "boolean" },
      },
      required: ["processName"],
    },
  },
  {
    name: "appsheet_move_step",
    description:
      "Process.Nodes 内で Step を任意の位置に移動する (並び替え)。IfNodes/ElseNodes 配下のネストは範囲外。\n\n## 必須\n- processName: 対象 Process 名\n- toIndex: 移動先 index (0 始まり、Process.Nodes の長さ未満)\n\n## 識別 (どちらか必須)\n- stepName: StepName で識別 (推奨)\n- componentId: 同名 step がある場合に使用\n\nデフォルト dry-run。",
    inputSchema: {
      type: "object",
      properties: {
        appId: { type: "string" }, appName: { type: "string" },
        processName: { type: "string" },
        stepName: { type: "string", description: "移動対象の StepName" },
        componentId: { type: "string" },
        toIndex: { type: "number", description: "移動先 index (0 始まり)" },
        apply: { type: "boolean" },
      },
      required: ["processName", "toIndex"],
    },
  },
  {
    name: "appsheet_add_branch_step",
    description:
      "Bot の Process に Branch (If/Else) Step を追加する。Process.Nodes に IfElseNode ($type=ProcessNodes.IfElseNode, NodeType=IF_ELSE) を append。Task は不要。\n\n## 必須\n- processName / stepName / condition (式、'=' 自動付与)\n\n## 補足\n- IfNodes / ElseNodes は空で作成。子 Step は Editor 上 or 別途追加が必要 (現状本ツールは branch 作成のみ)\n\nデフォルト dry-run。",
    inputSchema: {
      type: "object",
      properties: {
        appId: { type: "string" }, appName: { type: "string" },
        processName: { type: "string" },
        stepName: { type: "string" },
        condition: { type: "string", description: "条件式。'=' 自動付与" },
        apply: { type: "boolean" },
      },
      required: ["processName", "stepName", "condition"],
    },
  },
  {
    name: "appsheet_set_bot_trigger",
    description:
      "既存 Bot の Trigger (AppEvent) を編集する。eventType の切替 (DataChange ↔ Scheduled)、ChangeEvent 種別変更、cron / timeZone 編集、filterCondition 編集、bot.Disabled の切替に対応。\n\n## 必須\n- botName: 編集対象 Bot 名\n\n## 任意 (どれか 1 つ以上)\n- eventType: 'ADDS_ONLY' / 'UPDATES_ONLY' / 'DELETES_ONLY' / 'ADDS_AND_UPDATES' / 'ADDS_UPDATES_DELETES' / 'Scheduled'\n- filterCondition: 条件式 ('=' 自動付与)。空文字は変更なし扱い\n- tableName: Schedule の Table or DataChange の SchemaName 解決対象\n- scheduleConfig: { cron, timeZone, forEachRowInTable, region } の部分更新\n- disabled: Bot 有効/無効\n\n## 切替時のルール\n- DataChange → Scheduled: scheduleConfig.cron が必須\n- Scheduled → DataChange: eventType (ADDS_ONLY 等) が必須\n\nデフォルト dry-run。",
    inputSchema: {
      type: "object",
      properties: {
        appId: { type: "string" }, appName: { type: "string" },
        botName: { type: "string" },
        eventType: { type: "string", enum: ["ADDS_ONLY", "UPDATES_ONLY", "DELETES_ONLY", "ADDS_AND_UPDATES", "ADDS_UPDATES_DELETES", "Scheduled"] },
        filterCondition: { type: "string", description: "条件式。'=' 自動付与。空文字は変更なし" },
        tableName: { type: "string" },
        scheduleConfig: {
          type: "object",
          properties: {
            cron: { type: "string", description: "5 フィールド cron。例: '0 12 1 * *' (月初 12:00)" },
            timeZone: { type: "string", description: "Windows TZ。例: 'Tokyo Standard Time'" },
            forEachRowInTable: { type: "boolean" },
            region: { type: "string" },
          },
        },
        disabled: { type: "boolean" },
        apply: { type: "boolean" },
      },
      required: ["botName"],
    },
  },
  {
    name: "appsheet_set_bot_options",
    description:
      "Bot のメタ情報のみを編集する (Trigger/Process/Tasks は触らない)。改名 / アイコン / コメント / 有効・無効 を partial update。\n\n## 必須\n- botName: 編集対象 Bot 名\n\n## 任意 (どれか 1 つ以上)\n- newName: Bot 改名 (Event/Process は EventName/ProcessName で参照されており影響なし)\n- icon: アイコン (FontAwesome / Material Icons 名)。null で削除\n- comment: コメント。null で削除\n- disabled: 有効/無効\n\n## set_bot_trigger との使い分け\n- Trigger 関連 (eventType/cron/filterCondition) を変えたい → set_bot_trigger\n- Bot 名やアイコン/コメントだけ変えたい → set_bot_options\n- Disabled だけはどちらでも可\n\nデフォルト dry-run。",
    inputSchema: {
      type: "object",
      properties: {
        appId: { type: "string" }, appName: { type: "string" },
        botName: { type: "string" },
        newName: { type: "string" },
        icon: { type: ["string", "null"], description: "アイコン名。null で削除" },
        comment: { type: ["string", "null"], description: "コメント。null で削除" },
        disabled: { type: "boolean" },
        apply: { type: "boolean" },
      },
      required: ["botName"],
    },
  },
  {
    name: "appsheet_set_column_options",
    description:
      "既存列の任意プロパティを部分更新する汎用ツール。Column の attribute トップレベル / TypeAuxData (JSON) / InternalQualifier (コンパイル済みキャッシュ) を適切な箇所に振り分けて PATCH 的に同時更新。\n\n## 編集対象 (camelCase キー → AppSheet 内部表記)\n### Display 系\n- displayName / description (Column edit screen の Display name / Description)\n\n### Other Properties (boolean フラグ)\n- isLabel / isHidden / searchable / isScannable / isNfcScannable / isSensitive\n\n### Update Behavior\n- isKey / isRequired / resetOnEdit / defEdit (Editable?)\n\n### Auto Compute\n- appFormula (App formula。'=' が無ければ自動付与) / initialValue (Default。式は '=' 付与)\n\n### Data Validity (式)\n- validIf / errorMessageIfInvalid / requiredIf / editableIf / resetIf / showIf / suggestedValues\n  (式は '=' を自動 normalize、null で削除)\n\n### Type-specific (TypeAuxData)\n- yesLabel / noLabel (Yes/No 型)\n- inputMode (Ref 型: 'Auto' / 'Buttons' / 'Dropdown')\n- isPartOf (Ref 型: 'Is a part of?' boolean)\n- referencedTableName (Ref 型: Source table)\n- externalRelationshipName (Ref 型: External relationship name)\n\n### Rename\n- newName で列名変更 (注意: 他箇所で参照されている場合は手動修正が必要)\n\n## キャッシュ無効化\n式系を更新したとき、対応する InternalQualifier の AppEval キャッシュを自動削除して AppSheet に再コンパイルさせる。\n\nデフォルト dry-run。",
    inputSchema: {
      type: "object",
      properties: {
        appId: { type: "string" },
        appName: { type: "string" },
        tableName: { type: "string" },
        columnName: { type: "string", description: "現在の列名 (識別子)" },
        newName: { type: "string", description: "rename 後の新列名 (任意)" },
        options: {
          type: "object",
          description: "更新するプロパティを camelCase で指定。指定キーのみ更新、他はそのまま。未知キーは無視 (結果に unknownKeys として返却)",
          additionalProperties: true,
        },
        apply: { type: "boolean" },
      },
      required: ["tableName", "columnName"],
    },
  },
  {
    name: "appsheet_set_view_options",
    description:
      "既存 view の任意プロパティを部分更新する汎用ツール。Settings JSON と ViewDefinition を PATCH 的に同時更新。\n\n## 編集対象\n- **トップレベル**: newName (rename) / tableName / position / showIf / displayName / description\n- **ViewDefinition (options)**: create_view と同じ camelCase キー語彙。指定したキーのみ上書き、他はそのまま。\n\n## options の主な対応キー (camelCase → AppSheet 内部 PascalCase)\n- table: columnWidth / enableQuickEdit / columnOrder / sortBy / groupBy / groupAggregate\n- card / deck: imageShape / mainDeckImageColumn / primaryDeckHeaderColumn / secondaryDeckHeaderColumn / deckSummaryColumn / deckNestedTableColumn / showActionBar\n- detail: useCardLayout / mainSlideshowImageColumn / detailContentColumn / headerColumns / quickEditColumns / columnOrder / imageStyle / displayMode (Side-by-side 等) / maxNestedRows / slideshowMode / desktopSplitMode / useDesktopMultiColumn\n- form: pageStyle / formStyle / columnOrder / formFooterStyle (Bottom/Top) / autoSave / autoReopen / finishView / maxNestedRows / audioInput\n- dashboard: viewEntries / interactiveMode / showTabs\n- chart: chartType / chartColumns / groupAggregate / trendLine / showLegend\n- 共通: icon / menuOrder / sortBy / groupBy\n\n## 値の注意\n- displayMode は AppSheet 内部表記必須: Automatic / Normal / Centered / 'No headings' / 'Side-by-side'\n- imageShape: 'Square Image' / 'Round Image' / 'Full Image'\n- formStyle: Automatic / Default / 'Side-by-side'\n\nデフォルト dry-run。",
    inputSchema: {
      type: "object",
      properties: {
        appId: { type: "string" },
        appName: { type: "string" },
        viewName: { type: "string", description: "編集対象 view 名 (識別子)" },
        newName: { type: "string", description: "rename 後の新 view 名 (任意)" },
        tableName: { type: "string", description: "ソーステーブル/Slice 変更 (任意)" },
        position: {
          type: "string",
          description: "left/center/right (PRIMARY) / menu (MENU) / ref (REFERENCE) / none (隠し)。first/next/middle/later/last は内部マップなしで直接送信されるので AppSheet 内部値を使用",
        },
        showIf: { type: ["string", "null"], description: "ShowIf 式。null で削除" },
        displayName: { type: ["string", "null"], description: "DisplayName。null で削除" },
        description: { type: ["string", "null"], description: "Description。null で削除" },
        options: {
          type: "object",
          description: "ViewDefinition のプロパティを camelCase で指定。指定キーのみ更新、他はそのまま",
          additionalProperties: true,
        },
        apply: { type: "boolean" },
      },
      required: ["viewName"],
    },
  },
  {
    name: "appsheet_set_view_displaymode",
    description:
      "既存 detail view の DisplayMode を変更。view の Settings JSON と ViewDefinition.DisplayMode を同時更新。detail view ($type=SlideshowViewSettings) のみ対応。デフォルト dry-run。\n\n値は AppSheet 内部表記に厳密一致が必要 (大文字小文字・ハイフン)。'SideBySide' ではなく 'Side-by-side'。",
    inputSchema: {
      type: "object",
      properties: {
        appId: { type: "string" },
        appName: { type: "string" },
        viewName: { type: "string" },
        displayMode: {
          type: "string",
          enum: ["Automatic", "Normal", "Centered", "No headings", "Side-by-side"],
          description: "AppSheet 内部値。Automatic / Normal / Centered / No headings / Side-by-side",
        },
        apply: { type: "boolean" },
      },
      required: ["viewName", "displayMode"],
    },
  },
  {
    name: "appsheet_create_view",
    description:
      "View (Presentation.Controls の要素) を新規作成する。対応: table / card / detail / form / deck / dashboard / calendar / map / chart / gallery / onboarding (11 種)。kanban / gantt は AppSheet 現行 UI から削除されているため未対応。viewType ごとに ViewDefinition の $type と必須/特徴フィールドが異なる。Settings (JSON 文字列) と ViewDefinition (オブジェクト) を両方構築。デフォルト dry-run。",
    inputSchema: {
      type: "object",
      properties: {
        appId: { type: "string" },
        appName: { type: "string" },
        viewName: { type: "string", description: "View 名（アプリ内一意）" },
        tableName: { type: "string", description: "対象テーブル or Slice 名" },
        viewType: {
          type: "string",
          enum: ["table", "card", "detail", "form", "deck", "dashboard", "calendar", "map", "chart", "gallery", "onboarding"],
          description: "View タイプ。calendar は startDateColumn 必須・dashboard は viewEntries 必須・detail の $type は SlideshowViewSettings",
        },
        position: {
          type: "string",
          enum: ["left", "center", "right", "menu", "ref", "none", "first", "next", "middle", "later", "last", "primary"],
          description:
            "表示位置（実物 loadApp 観察値・Issue #3 再調査結果）:\n" +
            "・left / center / right → PRIMARY NAVIGATION (画面下タブ・3 段階)\n" +
            "・menu → MENU NAVIGATION (左メニュー)\n" +
            "・ref → REFERENCE VIEWS (参照のみ・ナビ非表示)\n" +
            "・none → 隠し View\n" +
            "UI ラベル系の自動マップ:\n" +
            "・primary / first / next → left\n" +
            "・middle → center\n" +
            "・later / last → right",
        },
        showIf: { type: "string", description: "表示条件式（任意）" },
        icon: { type: "string", description: "FontAwesome アイコン名。デフォルト fa-list-ul" },
        menuOrder: { type: "number", description: "メニュー内の並び順。デフォルト 1" },
        options: {
          type: "object",
          description:
            "viewType 別の固有設定。\n" +
            "・table: {columnWidth, enableQuickEdit, columnOrder}\n" +
            "・card/deck: {imageShape, mainDeckImageColumn, primaryDeckHeaderColumn, secondaryDeckHeaderColumn, deckSummaryColumn, showActionBar}\n" +
            "・detail: {mainSlideshowImageColumn, detailContentColumn, headerColumns, quickEditColumns, columnOrder, imageStyle, displayMode, useCardLayout}\n" +
            "・form: {columnOrder, autoSave, autoReopen, finishView, formStyle, pageStyle, audioInput}\n" +
            "・dashboard: {viewEntries: [{ViewName, ViewSize: 'Tall'|'Short'}], interactiveMode, showTabs} ★viewEntries 必須\n" +
            "・calendar: {startDateColumn, endDateColumn, labelColumn, categoryColumn, defaultCalendarView} ★startDateColumn 必須\n" +
            "・map: {mapColumn, mapType, locationMode, secondaryTable, secondaryColumn}\n" +
            "・chart: {chartType, chartColumns, groupAggregate, trendLine, chartColors, labelType, showLegend}\n" +
            "・gallery: {imageSize}\n" +
            "・onboarding: {image, title, firstBlurb, finishView}",
        },
        apply: { type: "boolean" },
      },
      required: ["viewName", "tableName", "viewType"],
    },
  },
  {
    name: "appsheet_create_table",
    description:
      "既存データソースの別シート/SQL テーブルを AppSheet に取り込む（DataSet 1 件追加・Schema は AppSheet 側で自動生成）。テンプレ既存テーブルからデータソース接続情報をコピー。SourceQualifier はデータソース上のシート名や SQL テーブル名。新規データソース接続は GUI 必須でこのツールでは扱えない。デフォルト dry-run。",
    inputSchema: {
      type: "object",
      properties: {
        appId: { type: "string" },
        appName: { type: "string" },
        newTableName: { type: "string", description: "アプリ内で使う新テーブル名" },
        sourceQualifier: {
          type: "string",
          description: "データソース上のシート名 / SQL テーブル名。スプシなら『シートタブ名』、SQL なら『テーブル名』",
        },
        templateTableName: {
          type: "string",
          description: "データソース接続情報をコピーする元テーブル名。省略時はユーザー作成テーブルから自動選定",
        },
        sourceQualifierId: {
          type: "string",
          description: "スプシのシート ID 等。省略可",
        },
        apply: { type: "boolean" },
      },
      required: ["newTableName", "sourceQualifier"],
    },
  },
  {
    name: "appsheet_add_call_script_task",
    description:
      "AppsScript Task (Call a Script) を新規追加し、指定 Process の Nodes に呼出ノードを連結する。GAS 関数呼出 + 戻り値受取の構造を一括構築。戻り値は LongText 1 個で、Process 内では [<stepName>].[Output] で参照可能。デフォルト dry-run。",
    inputSchema: {
      type: "object",
      properties: {
        appId: { type: "string" },
        appName: { type: "string" },
        processName: { type: "string", description: "Task ノードを追加する対象 Process 名" },
        taskName: { type: "string", description: "Task 名（アプリ内一意）" },
        scriptId: { type: "string", description: "GAS スクリプト ID。'DocId=...' 形式" },
        functionName: { type: "string", description: "呼出す GAS 関数名" },
        functionArguments: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              expression: { type: "string", description: "AppSheet 式。例: '記事管理[ID]'" },
            },
            required: ["name", "expression"],
          },
          description: "GAS 関数のパラメータ。各要素 {name, expression}",
        },
        tableName: { type: "string", description: "Task のスコープ対象テーブル" },
        stepName: {
          type: "string",
          description: "Process 内での Step 表示名。省略時は taskName。戻り値参照は [<stepName>].[Output]",
        },
        asyncExec: { type: "boolean", description: "非同期実行。デフォルト false" },
        forEntireTable: { type: "boolean", description: "テーブル全体に対して 1 回実行。デフォルト true" },
        apply: { type: "boolean" },
      },
      required: ["processName", "taskName", "scriptId", "functionName", "tableName"],
    },
  },
  {
    name: "appsheet_set_call_script_task",
    description:
      "既存 AppsScript Task の編集。scriptId / functionName / functionArguments / tableName / asyncExec / forEntireTable / Task 名 (newName) を部分更新。\n\n## 必須\n- taskName: 編集対象 Task 名\n\n## 任意 (どれか 1 つ以上)\n- newName: Task 改名 (全 Process の TaskNode.Task 参照も自動更新)\n- scriptId: 'DocId=...' 形式\n- functionName: 呼出関数名\n- functionArguments: [{name, expression}] 配列。指定時は **全置換**\n- tableName: スコープ対象テーブル\n- asyncExec / forEntireTable: 実行モード\n\nデフォルト dry-run。",
    inputSchema: {
      type: "object",
      properties: {
        appId: { type: "string" },
        appName: { type: "string" },
        taskName: { type: "string", description: "編集対象 Task 名" },
        newName: { type: "string", description: "新しい Task 名 (TaskNode 参照も同時更新)" },
        scriptId: { type: "string", description: "GAS スクリプト ID。'DocId=...' 形式" },
        functionName: { type: "string" },
        functionArguments: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              expression: { type: "string", description: "AppSheet 式。'=' 自動付与" },
            },
            required: ["name", "expression"],
          },
          description: "GAS 関数引数の **全置換**。空配列で全削除",
        },
        tableName: { type: "string" },
        asyncExec: { type: "boolean" },
        forEntireTable: { type: "boolean" },
        apply: { type: "boolean" },
      },
      required: ["taskName"],
    },
  },
  {
    name: "appsheet_add_slice",
    description:
      "Slice (TableSlice) を新規追加する。クライアント側でフィルタ評価・列順カスタムができる。データ秘匿には使えない（→ Security Filter）。デフォルト dry-run。",
    inputSchema: {
      type: "object",
      properties: {
        appId: { type: "string" },
        appName: { type: "string" },
        sliceName: { type: "string", description: "Slice 名（アプリ内一意）" },
        sourceTable: { type: "string", description: "ソーステーブル名" },
        filterCondition: {
          type: "string",
          description: 'フィルタ条件式。例: \'[ステータス] = "レビュー待ち"\'。省略時は全行',
        },
        columns: {
          type: "array",
          items: { type: "string" },
          description: "公開する列名の配列（順序付き）。省略時はソーステーブルの全列を自動取得",
        },
        actions: {
          type: "array",
          items: { type: "string" },
          description: '使える Action 名の配列。省略時は ["**auto**"]（全 Action 継承）',
        },
        apply: { type: "boolean" },
      },
      required: ["sliceName", "sourceTable"],
    },
  },
  {
    name: "appsheet_remove_slice",
    description: "Slice を削除する。デフォルト dry-run。",
    inputSchema: {
      type: "object",
      properties: {
        appId: { type: "string" },
        appName: { type: "string" },
        sliceName: { type: "string" },
        apply: { type: "boolean" },
      },
      required: ["sliceName"],
    },
  },
  {
    name: "appsheet_create_bot",
    description:
      "Bot を新規作成する（AppBots / AppEvents / AppProcesses の 3 配列を同時追加・名前リンク自動）。\n" +
      "Data Change Event または Scheduled Event でトリガー可能:\n" +
      "・eventType: ADDS_ONLY/UPDATES_ONLY/DELETES_ONLY/ADDS_AND_UPDATES/ADDS_UPDATES_DELETES → Data Change Bot\n" +
      "・eventType: Scheduled → 時刻トリガー Bot (scheduleConfig.cron 必須)\n" +
      "Email Task / AppsScript Task 等は別途 Tasks 配列に追加可能。デフォルト dry-run。",
    inputSchema: {
      type: "object",
      properties: {
        appId: { type: "string" },
        appName: { type: "string" },
        botName: { type: "string", description: "Bot 名（アプリ内一意）" },
        tableName: { type: "string", description: "監視対象テーブル名（Scheduled 時は対象テーブル）" },
        actionName: {
          type: "string",
          description: "Bot が実行する既存 Action の名前。Action は tableName と一致するテーブル所属である必要あり",
        },
        eventType: {
          type: "string",
          enum: ["ADDS_ONLY", "UPDATES_ONLY", "DELETES_ONLY", "ADDS_AND_UPDATES", "ADDS_UPDATES_DELETES", "Scheduled"],
          description: "発火種別。デフォルト ADDS_AND_UPDATES。Scheduled の場合は scheduleConfig 必須",
        },
        filterCondition: {
          type: "string",
          description: "イベントフィルタ条件式。例: '[ステータス] = \"承認済み\"'。デフォルト Change 系は TRUE / Scheduled 系は \"true\"",
        },
        scheduleConfig: {
          type: "object",
          description: "eventType: 'Scheduled' の場合のみ必須",
          properties: {
            cron: {
              type: "string",
              description: "5 フィールド cron 形式。例: '0 12 * * *' (毎日 12:00) / '0 9 * * 1' (毎週月曜 9:00) / '0 12 1 * *' (毎月 1 日 12:00)",
            },
            timeZone: {
              type: "string",
              description: "Windows タイムゾーン形式。例: 'Tokyo Standard Time' (デフォルト) / 'Pacific Standard Time' / 'UTC'。IANA 形式 (Asia/Tokyo) ではない",
            },
            forEachRowInTable: {
              type: "boolean",
              description: "true でテーブルの各行に対して実行、false でテーブル単位で 1 回実行。デフォルト true",
            },
            region: { type: "string", description: "通常 \"\" のまま。リージョン指定が必要な場合のみ" },
          },
          required: ["cron"],
        },
        disabled: { type: "boolean", description: "Bot 無効状態で作成。デフォルト false" },
        apply: { type: "boolean" },
      },
      required: ["botName", "tableName", "actionName"],
    },
  },
  {
    name: "appsheet_add_openurl_action",
    description:
      "OpenUrl (NAVIGATE_URL) 系 Action を新規追加する。外部 WebApp や HTTPS URL に遷移するボタン用。URL 式は CONCATENATE で動的組立可能。HTTP は警告。デフォルト dry-run。",
    inputSchema: {
      type: "object",
      properties: {
        appId: { type: "string" },
        appName: { type: "string" },
        tableName: { type: "string", description: "対象テーブル名" },
        actionName: { type: "string", description: "Action 名（アプリ内一意）" },
        urlExpression: {
          type: "string",
          description: 'URL 式。例: \'CONCATENATE("https://example.com/?id=", ENCODEURL([案件ID]))\'',
        },
        condition: {
          type: "string",
          description: "実行可否条件式（任意）。例: 'NOT(ISBLANK([URL]))'",
        },
        prominence: {
          type: "string",
          enum: ["Display_Inline", "Display_Prominently", "Display_Overlay"],
          description: "表示位置。デフォルト Display_Inline",
        },
        launchExternal: {
          type: "boolean",
          description: "true で外部ブラウザで開く。デフォルト false（内蔵ビューア）",
        },
        needsConfirmation: { type: "boolean", description: "実行時に確認ダイアログ。デフォルト false" },
        confirmationMessage: { type: "string" },
        icon: { type: "string", description: "FontAwesome アイコン名。デフォルト fa-external-link" },
        apply: { type: "boolean" },
      },
      required: ["tableName", "actionName", "urlExpression"],
    },
  },
  {
    name: "appsheet_promote_to_ref",
    description:
      "テキスト型の親キー列を Ref 型に格上げする。親テーブルのキー列を自動検出し、TypeAuxData の ReferencedTableName / ReferencedKeyColumn / ReferencedType / IsAPartOf 等を組み立てる。dereference や REF_ROWS が使えるようになる。デフォルト dry-run。",
    inputSchema: {
      type: "object",
      properties: {
        appId: { type: "string" },
        appName: { type: "string" },
        tableName: { type: "string", description: "子テーブル名（Ref 化対象列を持つテーブル）" },
        columnName: { type: "string", description: "Ref 化する列名（既存値は親キーと整合している必要あり）" },
        parentTableName: { type: "string", description: "参照先（親）テーブル名" },
        isAPartOf: {
          type: "boolean",
          description: "is-a-part-of 親子関係。true で親削除時に子も連鎖削除。デフォルト false",
        },
        relationshipName: { type: "string" },
        inputMode: {
          type: "string",
          description: "Auto / Buttons / Stack / Dropdown 等。デフォルト Auto",
        },
        apply: { type: "boolean" },
      },
      required: ["tableName", "columnName", "parentTableName"],
    },
  },
  {
    name: "appsheet_set_security_filter",
    description:
      "テーブルの Security Filter (DataSet.DataFilter) を設定する。サーバ側で評価されデータ秘匿に使える。空文字を渡すとフィルタ削除。実カラム式のみ評価される（仮想列・dereference は不可）— 対象テーブル直下の仮想列を式中に検出した場合はエラー。allowVirtualCols: true で警告に降格可能。デフォルト dry-run。",
    inputSchema: {
      type: "object",
      properties: {
        appId: { type: "string" },
        appName: { type: "string" },
        tableName: { type: "string", description: "DataSet 名（テーブル名）" },
        filter: {
          type: "string",
          description: 'AppSheet 式。例: \'[担当者メール] = USEREMAIL()\' / \'IF(ANY(個人設定[フラグ]), [担当] = ANY(個人設定[ID]), TRUE)\'。空文字でフィルタ削除。',
        },
        allowVirtualCols: {
          type: "boolean",
          description: "true で、対象テーブルの仮想列を式中に含むことを許可（デフォルト false: エラー）。許可しても warning は出る。",
        },
        apply: { type: "boolean" },
      },
      required: ["tableName", "filter"],
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
    case "appsheet_add_virtual_column":
      return addVirtualColumn(args as Parameters<typeof addVirtualColumn>[0]);
    case "appsheet_remove_column":
      return removeColumn(args as Parameters<typeof removeColumn>[0]);
    case "appsheet_clone_view":
      return cloneView(args as Parameters<typeof cloneView>[0]);
    case "appsheet_clone_action":
      return cloneAction(args as Parameters<typeof cloneAction>[0]);
    case "appsheet_remove_view":
      return removeView(args as Parameters<typeof removeView>[0]);
    case "appsheet_remove_action":
      return removeAction(args as Parameters<typeof removeAction>[0]);
    case "appsheet_clone_bot":
      return cloneBot(args as Parameters<typeof cloneBot>[0]);
    case "appsheet_remove_bot":
      return removeBot(args as Parameters<typeof removeBot>[0]);
    case "appsheet_set_column_formula":
      return setColumnFormula(args as Parameters<typeof setColumnFormula>[0]);
    case "appsheet_set_action_condition":
      return setActionCondition(args as Parameters<typeof setActionCondition>[0]);
    case "appsheet_set_action_value":
      return setActionValue(args as Parameters<typeof setActionValue>[0]);
    case "appsheet_set_enum_values":
      return setEnumValues(args as Parameters<typeof setEnumValues>[0]);
    case "appsheet_add_enum_value":
      return addEnumValue(args as Parameters<typeof addEnumValue>[0]);
    case "appsheet_remove_enum_value":
      return removeEnumValue(args as Parameters<typeof removeEnumValue>[0]);
    case "appsheet_clone_table":
      return cloneTable(args as Parameters<typeof cloneTable>[0]);
    case "appsheet_remove_table":
      return removeTable(args as Parameters<typeof removeTable>[0]);
    case "appsheet_set_column_description":
      return setColumnDescription(args as Parameters<typeof setColumnDescription>[0]);
    case "appsheet_set_column_yn_labels":
      return setColumnYNLabels(args as Parameters<typeof setColumnYNLabels>[0]);
    case "appsheet_set_view_displaymode":
      return setViewDisplayMode(args as Parameters<typeof setViewDisplayMode>[0]);
    case "appsheet_set_view_options":
      return setViewOptions(args as Parameters<typeof setViewOptions>[0]);
    case "appsheet_set_column_options":
      return setColumnOptions(args as Parameters<typeof setColumnOptions>[0]);
    case "appsheet_add_send_email_task":
      return addSendEmailTask(args as Parameters<typeof addSendEmailTask>[0]);
    case "appsheet_add_webhook_task":
      return addWebhookTask(args as Parameters<typeof addWebhookTask>[0]);
    case "appsheet_add_branch_step":
      return addBranchStep(args as Parameters<typeof addBranchStep>[0]);
    case "appsheet_remove_step":
      return removeStep(args as Parameters<typeof removeStep>[0]);
    case "appsheet_move_step":
      return moveStep(args as Parameters<typeof moveStep>[0]);
    case "appsheet_set_bot_trigger":
      return setBotTrigger(args as Parameters<typeof setBotTrigger>[0]);
    case "appsheet_set_bot_options":
      return setBotOptions(args as Parameters<typeof setBotOptions>[0]);
    case "appsheet_set_security_filter":
      return setSecurityFilter(args as Parameters<typeof setSecurityFilter>[0]);
    case "appsheet_promote_to_ref":
      return promoteToRef(args as Parameters<typeof promoteToRef>[0]);
    case "appsheet_add_openurl_action":
      return addOpenUrlAction(args as Parameters<typeof addOpenUrlAction>[0]);
    case "appsheet_create_bot":
      return createBot(args as Parameters<typeof createBot>[0]);
    case "appsheet_add_slice":
      return addSlice(args as Parameters<typeof addSlice>[0]);
    case "appsheet_remove_slice":
      return removeSlice(args as Parameters<typeof removeSlice>[0]);
    case "appsheet_add_call_script_task":
      return addCallScriptTask(args as Parameters<typeof addCallScriptTask>[0]);
    case "appsheet_set_call_script_task":
      return setCallScriptTask(args as Parameters<typeof setCallScriptTask>[0]);
    case "appsheet_create_table":
      return createTable(args as Parameters<typeof createTable>[0]);
    case "appsheet_create_view":
      return createView(args as Parameters<typeof createView>[0]);
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
