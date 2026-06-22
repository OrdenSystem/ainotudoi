"""appdef snapshot を解析して、入所系3サービス追加計画書に必要な情報を抽出する。

出力:
- C:/tmp/appsheet-summary.json: テーブル/Slice/Action のサマリ
- C:/tmp/appsheet-tables.json: テーブル詳細
- C:/tmp/appsheet-actions.json: Action 詳細
- C:/tmp/appsheet-views.json: View 詳細（あれば）
"""
import json
from pathlib import Path

APP_ID = 'b9e4f84d-f9b9-4376-97f1-83e3b07122e3'
SNAPSHOT = Path(rf'C:/dev/ainotudoi/snapshots/appdef-{APP_ID}.json')

with open(SNAPSHOT, encoding='utf-8') as f:
    d = json.load(f)

t = d['Template']
ad = t['AppData']
bh = t['Behavior']

# === Tables ===
tables = []
for ds in ad['DataSets']:
    tables.append({
        'name': ds.get('Name'),
        'source': ds.get('SourceName'),
        'schema_name': ds.get('SchemaName'),
        'is_user_table': ds.get('IsUserTable'),
        'is_security_filter_pii': ds.get('IsSecurityFilterUsedForPII'),
        'allow_adds': ds.get('AllowAdds'),
        'allow_updates': ds.get('AllowUpdates'),
        'allow_deletes': ds.get('AllowDeletes'),
        'security_filter': str(ds.get('SecurityFilter', ''))[:200] if ds.get('SecurityFilter') else None,
    })

# === DataSchemas (列定義) ===
schemas = {}
for s in ad['DataSchemas']:
    cols = []
    for col in s.get('Columns', []):
        cols.append({
            'name': col.get('Name'),
            'type': col.get('Type'),
            'is_key': col.get('IsKey'),
            'is_label': col.get('IsLabel'),
            'is_required': col.get('IsRequired'),
            'is_pii': col.get('IsPii'),
            'is_virtual': col.get('IsVirtual'),
            'formula': str(col.get('Formula', ''))[:200] if col.get('Formula') else None,
            'ref_table': col.get('RefTable'),
            'enum_values': col.get('EnumValues')[:10] if col.get('EnumValues') else None,
        })
    schemas[s.get('Name')] = {
        'name': s.get('Name'),
        'is_valid': s.get('IsValid'),
        'columns': cols,
    }

# === Actions ===
actions = []
for a in ad['DataActions']:
    actions.append({
        'name': a.get('Name'),
        'table': a.get('SourceName'),
        'action_type': a.get('ActionType'),
        'execution_scope': a.get('ExecutionScope'),
        'condition': str(a.get('Condition', ''))[:200] if a.get('Condition') else None,
        'attachment_template': str(a.get('AttachmentTemplate', ''))[:80] if a.get('AttachmentTemplate') else None,
        'value_definitions_count': len(a.get('ValueDefinitions') or []),
        'is_only_for_action': a.get('IsOnlyForAction'),
        'webhook_url': a.get('WebhookUrl'),
        'webhook_target_action': a.get('WebhookTargetAction'),
        'workflow_template_name': a.get('WorkflowTemplateName'),
    })

# === Slices ===
slices = []
for s in ad.get('TableSlices', []):
    slices.append({
        'name': s.get('Name'),
        'source': s.get('SourceName'),
        'row_filter': str(s.get('RowFilter', ''))[:200] if s.get('RowFilter') else None,
        'column_names_count': len(s.get('ColumnNames') or []),
        'allow_adds': s.get('AllowAdds'),
        'allow_updates': s.get('AllowUpdates'),
        'allow_deletes': s.get('AllowDeletes'),
    })

# === Bots / Processes / Workflows ===
bots = bh.get('AppBots', [])
processes = bh.get('AppProcesses', [])
workflows = bh.get('AppWorkflowRules', []) + bh.get('WorkflowRules', [])
events = bh.get('AppEvents', [])

# === Views ===
views = []
controls = t.get('Controls') or t.get('AppControls') or t.get('ViewControls')
if controls is None:
    for key in t.keys():
        v = t[key]
        if isinstance(v, list) and len(v) > 0 and isinstance(v[0], dict):
            if any('ViewType' in (item or {}) or 'View_Type' in (item or {}) for item in v[:5]):
                controls = v
                break
if controls:
    for v in controls:
        views.append({
            'name': v.get('Name'),
            'view_type': v.get('ViewType') or v.get('View_Type'),
            'for_table': v.get('SourceName') or v.get('For_Table'),
            'position': v.get('Position'),
            'show_if': str(v.get('ShowIf', ''))[:120] if v.get('ShowIf') else None,
        })

# === User Roles / Security ===
user_roles = t.get('UserRoles', [])
auth_provider = bh.get('AuthProvider')
auth_required = bh.get('AuthRequired')

# Summary
summary = {
    'app_id': APP_ID,
    'app_name': t.get('Name'),
    'short_name': t.get('ShortName'),
    'version': t.get('Version'),
    'owner_id': t.get('OwnerId'),
    'is_deployable': t.get('IsDeployable'),
    'last_modified': t.get('LastModified'),
    'cloned_from': t.get('CloneFrom'),
    'auth_provider': auth_provider,
    'auth_required': auth_required,
    'counts': {
        'tables': len(tables),
        'schemas': len(schemas),
        'actions': len(actions),
        'slices': len(slices),
        'views': len(views),
        'bots': len(bots),
        'processes': len(processes),
        'workflow_rules': len(workflows),
        'events': len(events),
        'user_roles': len(user_roles),
    },
}

tmp = Path('C:/tmp')
tmp.mkdir(parents=True, exist_ok=True)
(tmp / 'appsheet-summary.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding='utf-8')
(tmp / 'appsheet-tables.json').write_text(json.dumps(tables, ensure_ascii=False, indent=2), encoding='utf-8')
(tmp / 'appsheet-schemas.json').write_text(json.dumps(schemas, ensure_ascii=False, indent=2), encoding='utf-8')
(tmp / 'appsheet-actions.json').write_text(json.dumps(actions, ensure_ascii=False, indent=2), encoding='utf-8')
(tmp / 'appsheet-slices.json').write_text(json.dumps(slices, ensure_ascii=False, indent=2), encoding='utf-8')
(tmp / 'appsheet-views.json').write_text(json.dumps(views, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(summary, ensure_ascii=False, indent=2))
print(f'\nSaved 6 files under C:/tmp/appsheet-*.json')
print(f'\nFirst 5 table names:')
for t_ in tables[:5]:
    print(f'  {t_["name"]} (source={t_["source"]})')
print(f'\nAction types breakdown:')
from collections import Counter
ac_types = Counter([a.get('action_type') for a in actions])
for at, n in ac_types.most_common():
    print(f'  {at}: {n}')
print(f'\nActions with webhook_url (GAS or external):')
hooks = [a for a in actions if a.get('webhook_url')]
print(f'  Count: {len(hooks)}')
for a in hooks[:20]:
    print(f'  - {a["name"]} -> {(a["webhook_url"] or "")[:100]}')
