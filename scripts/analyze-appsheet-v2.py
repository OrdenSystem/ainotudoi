"""appdef snapshot 完全解析 v2。Views=MenuEntries, Webhook=NAVIGATE_URL の URL 抽出を含む。"""
import json
import re
from pathlib import Path

APP_ID = 'b9e4f84d-f9b9-4376-97f1-83e3b07122e3'
SNAPSHOT = Path(rf'C:/dev/ainotudoi/snapshots/appdef-{APP_ID}.json')

with open(SNAPSHOT, encoding='utf-8') as f:
    d = json.load(f)

t = d['Template']
ad = t['AppData']
bh = t['Behavior']
pres = t['Presentation']

# === Tables ===
tables = []
for ds in ad['DataSets']:
    tables.append({
        'name': ds.get('Name'),
        'source_type': ds.get('SourceType'),
        'is_user_table': ds.get('IsUserTable'),
        'allow_adds': ds.get('AllowAdds'),
        'allow_updates': ds.get('AllowUpdates'),
        'allow_deletes': ds.get('AllowDeletes'),
        'security_filter': str(ds.get('SecurityFilter', ''))[:300] if ds.get('SecurityFilter') else None,
    })

# === Schemas: 列定義 ===
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
            'formula': str(col.get('Formula', ''))[:300] if col.get('Formula') else None,
            'ref_table': col.get('RefTable'),
        })
    schemas[s.get('Name')] = {
        'is_valid': s.get('IsValid'),
        'columns': cols,
        'column_count': len(cols),
    }

# === Slices ===
slices = []
for s in ad.get('TableSlices', []):
    slices.append({
        'name': s.get('Name'),
        'source': s.get('SourceName'),
        'row_filter': str(s.get('RowFilter', ''))[:300] if s.get('RowFilter') else None,
        'allow_adds': s.get('AllowAdds'),
        'allow_updates': s.get('AllowUpdates'),
        'allow_deletes': s.get('AllowDeletes'),
    })

# === Actions（特に NAVIGATE_URL / NAVIGATE_DIFFERENT_APP / IMPORT_FILE / COMPOSITE / REF_ACTION を詳細） ===
actions = []
for a in ad['DataActions']:
    record = {
        'name': a.get('Name'),
        'table': a.get('SourceName'),
        'action_type': a.get('ActionType'),
        'execution_scope': a.get('ExecutionScope'),
        'condition': str(a.get('Condition', ''))[:300] if a.get('Condition') else None,
        'is_only_for_action': a.get('IsOnlyForAction'),
        'icon': a.get('Icon'),
    }
    # extract URL/value formulas for navigate/url types
    vds = a.get('ValueDefinitions') or []
    if vds:
        vd_summary = []
        for vd in vds:
            vd_summary.append({
                'col': vd.get('ColumnName'),
                'expr': str(vd.get('Expression', ''))[:400] if vd.get('Expression') else None,
            })
        record['value_definitions'] = vd_summary
    # subactions
    sub_actions = a.get('SubActions') or a.get('ReferencedActions')
    if sub_actions:
        record['sub_actions'] = sub_actions
    actions.append(record)

# === Views (= MenuEntries) ===
views = []
for v in pres.get('MenuEntries', []):
    views.append({
        'view_name': v.get('ViewName'),
        'display_name': str(v.get('DisplayName', ''))[:150] if v.get('DisplayName') else None,
        'menu_order': v.get('MenuOrder'),
        'position': v.get('Position'),
        'icon': v.get('Icon'),
        'show_if': str(v.get('ShowIf', ''))[:200] if v.get('ShowIf') else None,
        'deep_link': v.get('DeepLink'),
        'visibility': v.get('Visibility'),
    })

# === User Roles ===
user_roles = []
for ur in t.get('UserRoles', []):
    user_roles.append({
        'name': ur.get('Name'),
        'access_mode': ur.get('AccessMode'),
        'description': str(ur.get('Description', ''))[:150] if ur.get('Description') else None,
    })

# === Auth / Behavior ===
behavior = {
    'auth_provider': bh.get('AuthProvider'),
    'auth_required': bh.get('AuthRequired'),
    'launch_offline': bh.get('LaunchOffline'),
    'usage_scopes': bh.get('UsageScopes'),
    'api_settings_keys': list((bh.get('APISettings') or {}).keys()),
    'all_data_is_public': bh.get('AllDataIsPublic'),
    'auth_domain_required': bh.get('DomainAuthRequired'),
    'app_bots_count': len(bh.get('AppBots', [])),
    'app_processes_count': len(bh.get('AppProcesses', [])),
    'app_events_count': len(bh.get('AppEvents', [])),
    'app_workflow_rules_count': len(bh.get('AppWorkflowRules', [])),
    'tasks_count': len(bh.get('Tasks', [])),
}

# === Summary ===
summary = {
    'app_id': APP_ID,
    'app_name': t.get('Name'),
    'short_name': t.get('ShortName'),
    'version': t.get('Version'),
    'owner_id': t.get('OwnerId'),
    'is_deployable': t.get('IsDeployable'),
    'last_modified': t.get('LastModified'),
    'cloned_from': t.get('CloneFrom'),
    'counts': {
        'tables': len(tables),
        'schemas': len(schemas),
        'actions': len(actions),
        'slices': len(slices),
        'views_menu_entries': len(views),
        'user_roles': len(user_roles),
        'bots': behavior['app_bots_count'],
        'processes': behavior['app_processes_count'],
        'events': behavior['app_events_count'],
        'workflow_rules': behavior['app_workflow_rules_count'],
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
(tmp / 'appsheet-userroles.json').write_text(json.dumps(user_roles, ensure_ascii=False, indent=2), encoding='utf-8')
(tmp / 'appsheet-behavior.json').write_text(json.dumps(behavior, ensure_ascii=False, indent=2), encoding='utf-8')

print(json.dumps(summary, ensure_ascii=False, indent=2))

# Extract webhook-like URL patterns from NAVIGATE_URL/IMPORT_FILE actions
webhook_re = re.compile(r'https?://[^"\s]+')
print('\n=== Actions with potential GAS WebApp URLs ===')
hit = 0
for a in actions:
    if a.get('action_type') in ('NAVIGATE_URL', 'IMPORT_FILE', 'NAVIGATE_DIFFERENT_APP', 'OPEN_FILE'):
        text_blob = json.dumps(a, ensure_ascii=False)
        urls = webhook_re.findall(text_blob)
        if urls:
            hit += 1
            print(f'\n[{a["action_type"]}] {a["name"]} (table={a["table"]})')
            for u in urls[:3]:
                print(f'   URL: {u[:200]}')
print(f'\nTotal action with URLs: {hit}')
