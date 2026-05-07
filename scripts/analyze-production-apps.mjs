#!/usr/bin/env node
// 本番アプリ snapshot から 4 観点を集計してパターン抽出する。
// (a) Action / (b) リレーション / (c) 関数式 / (d) Virtual Column

import { readFile } from "node:fs/promises";
import path from "node:path";

const APPS = [
  { id: "aa5925f1-be2d-4cac-97f8-1e5fe55f9526", label: "歯科訪問診療" },
  { id: "cb7c927c-be45-4fc6-8d6f-38689dfc9331", label: "HopeCareDX" },
];

function pct(n, total) {
  return total > 0 ? `${((n / total) * 100).toFixed(1)}%` : "0%";
}

function topN(map, n = 15) {
  return Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, n);
}

async function loadApp(id) {
  const p = path.resolve("snapshots", `appdef-${id}.json`);
  const buf = await readFile(p, "utf8");
  return JSON.parse(buf);
}

// ============ (a) Actions ============
function analyzeActions(app) {
  const actions = app.AppData?.DataActions ?? [];
  const typeCounts = {};
  const subtypeNames = [];
  const tablesByAction = {};

  for (const a of actions) {
    const t = a.ActionType ?? "(none)";
    typeCounts[t] = (typeCounts[t] ?? 0) + 1;
    if (!tablesByAction[t]) tablesByAction[t] = new Set();
    tablesByAction[t].add(a.Table);
    if (a.Name) subtypeNames.push({ Name: a.Name, ActionType: t, Table: a.Table });
  }

  // Action 参照元の集計
  const usage = {};  // actionName -> { fromBots: count, fromComposite: count, fromRef: count, fromView: count }
  const refActions = actions.filter((a) => a.ActionType === "REF_ACTION");
  for (const ra of refActions) {
    const referenced = ra.ActionDefinition?.ReferencedAction ?? null;
    if (referenced) {
      usage[referenced] = usage[referenced] ?? { fromComposite: 0, fromRef: 0, fromBot: 0 };
      usage[referenced].fromRef++;
    }
  }
  const compositeActions = actions.filter((a) => a.ActionType === "COMPOSITE");
  for (const ca of compositeActions) {
    const children = ca.ActionDefinition?.Actions ?? [];
    for (const c of children) {
      const name = c.ActionName;
      usage[name] = usage[name] ?? { fromComposite: 0, fromRef: 0, fromBot: 0 };
      usage[name].fromComposite++;
    }
  }

  // Bot Process Step (RUN_ACTION) からの参照
  const procs = app.Behavior?.AppProcesses ?? [];
  let botActionRefs = 0;
  const botRefByAction = {};
  for (const p of procs) {
    const nodes = p.Nodes ?? [];
    for (const n of nodes) {
      if (n.NodeType === "RUN_ACTION" && n.Action) {
        botActionRefs++;
        botRefByAction[n.Action] = (botRefByAction[n.Action] ?? 0) + 1;
        usage[n.Action] = usage[n.Action] ?? { fromComposite: 0, fromRef: 0, fromBot: 0 };
        usage[n.Action].fromBot++;
      }
    }
  }

  return {
    total: actions.length,
    typeCounts,
    botActionRefs,
    topActionsCalledByBot: topN(botRefByAction, 10),
    actionsWithMultipleUsages: Object.entries(usage)
      .map(([name, u]) => ({ name, total: u.fromComposite + u.fromRef + u.fromBot, ...u }))
      .filter((x) => x.total > 1)
      .sort((a, b) => b.total - a.total)
      .slice(0, 15),
    sampleByType: Object.fromEntries(
      Object.entries(typeCounts).map(([t]) => [t, subtypeNames.filter((s) => s.ActionType === t).slice(0, 3)]),
    ),
  };
}

// ============ (b) Relationships ============
function analyzeRelationships(app) {
  const schemas = app.AppData?.DataSchemas ?? [];
  const refLinks = [];     // { from: tableName, fromCol, to: refTable, isPartOf }
  const tableRefDegree = {};  // tableName -> {out: count, in: count}

  for (const sch of schemas) {
    const tableName = sch.AutoSchemaFrom ?? sch.Name;
    if (!tableName) continue;
    tableRefDegree[tableName] = tableRefDegree[tableName] ?? { out: 0, in: 0 };
    const cols = sch.Attributes ?? [];
    for (const c of cols) {
      let aux = {};
      try { aux = JSON.parse(c.TypeAuxData ?? "{}"); } catch {}
      // Ref 型検出 (ColumnType=Ref or AppType=Ref)
      const t = c.ColumnType ?? c.AppType;
      if (t === "Ref" || (typeof t === "string" && t.toLowerCase().includes("ref"))) {
        const refTable = aux.ReferencedTableName ?? aux.referencedTableName ?? null;
        if (refTable) {
          refLinks.push({ from: tableName, fromCol: c.Name, to: refTable, isPartOf: !!aux.IsPartOf });
          tableRefDegree[tableName].out++;
          tableRefDegree[refTable] = tableRefDegree[refTable] ?? { out: 0, in: 0 };
          tableRefDegree[refTable].in++;
        }
      }
    }
  }

  // Slice -> source table mapping
  const slices = app.AppData?.TableSlices ?? [];
  const sliceRefs = slices.map((s) => ({ name: s.Name, source: s.Source ?? s.SourceTable, condition: s.Condition?.slice(0, 80) }));

  // View -> table/slice
  const views = app.Presentation?.Views ?? [];
  const viewBindings = views.map((v) => ({ name: v.Name, source: v.TableName ?? v.SourceTable, viewType: v.ViewType }));

  return {
    refLinks,
    sliceRefs,
    viewBindings,
    tableDegreesTop: Object.entries(tableRefDegree)
      .map(([t, d]) => ({ table: t, ...d, total: d.out + d.in }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 20),
    refCount: refLinks.length,
    isPartOfCount: refLinks.filter((r) => r.isPartOf).length,
  };
}

// ============ (c) Formulas ============
function analyzeFormulas(app) {
  const allFormulas = [];
  const fnFreq = {};
  const sources = {};

  function record(formula, source) {
    if (!formula || typeof formula !== "string") return;
    const f = formula.trim();
    if (!f.startsWith("=") && !/[A-Z_]+\s*\(/.test(f)) return;
    allFormulas.push({ formula: f, source });
    sources[source] = (sources[source] ?? 0) + 1;
    // 関数名抽出 (UPPER 関数のみ AppSheet)
    const matches = f.match(/[A-Z][A-Z_0-9]+\s*\(/g) ?? [];
    for (const m of matches) {
      const fn = m.replace(/\s*\($/, "");
      fnFreq[fn] = (fnFreq[fn] ?? 0) + 1;
    }
  }

  // 列式
  const schemas = app.AppData?.DataSchemas ?? [];
  for (const sch of schemas) {
    for (const c of (sch.Attributes ?? [])) {
      record(c.AppFormula, "Column.AppFormula");
      record(c.InitialValue, "Column.InitialValue");
      let aux = {};
      try { aux = JSON.parse(c.TypeAuxData ?? "{}"); } catch {}
      record(aux.Show_If, "Column.Show_If");
      record(aux.Required_If, "Column.Required_If");
      record(aux.Editable_If, "Column.Editable_If");
      record(aux.Reset_If, "Column.Reset_If");
      record(aux.Valid_If, "Column.Valid_If");
      record(aux.Error_Message_If_Invalid, "Column.Error_Message");
      record(aux.Suggested_Values, "Column.Suggested_Values");
    }
  }

  // Slice
  const slices = app.AppData?.TableSlices ?? [];
  for (const s of slices) record(s.Condition, "Slice.Condition");

  // Action
  for (const a of (app.AppData?.DataActions ?? [])) {
    record(a.Condition, "Action.Condition");
    record(a.Value, "Action.Value");
    if (a.ActionDefinition) {
      record(a.ActionDefinition.ReferencedRows, "Action.ReferencedRows");
      for (const as of (a.ActionDefinition.Assignments ?? [])) {
        record(as.NewColumnValue, "Action.Assignment");
      }
    }
  }

  // View
  const views = app.Presentation?.Views ?? [];
  for (const v of views) {
    record(v.ShowIf, "View.ShowIf");
  }

  // Bot
  const procs = app.Behavior?.AppProcesses ?? [];
  for (const p of procs) {
    for (const n of (p.Nodes ?? [])) {
      record(n.Condition, "Bot.WaitCondition");
      record(n.Period, "Bot.WaitPeriod");
      for (const rv of (n.ReturnValues ?? [])) {
        record(rv.NewColumnValue, "Bot.ReturnValue");
      }
    }
  }

  return {
    totalFormulas: allFormulas.length,
    sources,
    topFunctions: topN(fnFreq, 30),
    sampleFormulas: allFormulas.slice(0, 20).map((x) => ({ ...x, formula: x.formula.length > 100 ? x.formula.slice(0, 100) + "..." : x.formula })),
  };
}

// ============ (d) Virtual Columns ============
function analyzeVirtualColumns(app) {
  const schemas = app.AppData?.DataSchemas ?? [];
  let total = 0;
  const byPattern = { listAggregate: 0, refRows: 0, lookupSelect: 0, conditionalIfs: 0, simpleConcat: 0, dateCalc: 0, userContext: 0, count: 0, other: 0 };
  const byType = {};
  const samples = [];

  for (const sch of schemas) {
    const tableName = sch.AutoSchemaFrom ?? sch.Name;
    for (const c of (sch.Attributes ?? [])) {
      if (!c.IsVirtual) continue;
      total++;
      const typ = c.AppType ?? c.ColumnType ?? "(unknown)";
      byType[typ] = (byType[typ] ?? 0) + 1;
      const f = (c.AppFormula ?? "").trim();
      if (samples.length < 30) samples.push({ table: tableName, name: c.Name, type: typ, formula: f.length > 120 ? f.slice(0, 120) + "..." : f });

      // パターン分類
      if (/REF_ROWS\s*\(/i.test(f)) byPattern.refRows++;
      else if (/(LOOKUP|SELECT)\s*\(/i.test(f)) byPattern.lookupSelect++;
      else if (/(SUM|MIN|MAX|AVERAGE|COUNT)\s*\(/i.test(f)) byPattern.listAggregate++;
      else if (/IFS?\s*\(|SWITCH\s*\(/i.test(f)) byPattern.conditionalIfs++;
      else if (/CONCATENATE\s*\(|&|TEXT\s*\(/i.test(f)) byPattern.simpleConcat++;
      else if (/(NOW|TODAY|DATETIME|HOUR|MINUTE|DAY)\s*\(/i.test(f)) byPattern.dateCalc++;
      else if (/(USEREMAIL|USERROLE|USERSETTINGS)\s*\(/i.test(f)) byPattern.userContext++;
      else byPattern.other++;
    }
  }

  return { total, byType, byPattern, samples: samples.slice(0, 15) };
}

// ============ メイン ============
const reports = {};
for (const a of APPS) {
  const app = await loadApp(a.id);
  reports[a.label] = {
    overview: {
      Name: app.Name ?? a.label,
      Tables: (app.AppData?.DataSchemas ?? []).length,
      Actions: (app.AppData?.DataActions ?? []).length,
      Slices: (app.AppData?.TableSlices ?? []).length,
      Views: (app.Presentation?.Views ?? []).length,
      Bots: (app.Behavior?.AppBots ?? []).length,
      Tasks: (app.Behavior?.Tasks ?? []).length,
    },
    actions: analyzeActions(app),
    relationships: analyzeRelationships(app),
    formulas: analyzeFormulas(app),
    virtualColumns: analyzeVirtualColumns(app),
  };
}

// 出力
console.log(JSON.stringify(reports, (k, v) => v instanceof Set ? [...v] : v, 2));
