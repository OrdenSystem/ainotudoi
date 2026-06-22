"""請求アプリ appdef を解析。app キーが JSON 文字列なのでパースしてから処理。"""
import json
from pathlib import Path

APP_ID = 'f6ddf60e-a346-4d4c-a143-eeb9aed81287'
SNAPSHOT = Path(rf'C:/dev/ainotudoi/snapshots/appdef-{APP_ID}.json')

with open(SNAPSHOT, encoding='utf-8') as f:
    d = json.load(f)

# 構造判定
if 'app' in d and isinstance(d['app'], str):
    # 請求アプリは loadApp レスポンスがそのまま入っている。app は JSON 文字列
    print('Format: app is JSON string, parsing...')
    app = json.loads(d['app'])
    t = app  # Template相当
elif 'Template' in d:
    t = d['Template']
else:
    print('Unknown structure'); exit(1)

# 構造確認
print(f'\nTemplate keys ({len(t)}):')
for k in sorted(t.keys()):
    v = t[k]
    if isinstance(v, list): print(f'  {k}: list[{len(v)}]')
    elif isinstance(v, dict): print(f'  {k}: dict[{len(v)} keys]')
    else: print(f'  {k}: {str(v)[:60]}')

# AppData/Behavior 確認
if 'AppData' in t:
    ad = t['AppData']
    bh = t.get('Behavior') or {}
    pres = t.get('Presentation') or {}
    print(f'\n=== AppData keys ===')
    for k in sorted(ad.keys()):
        v = ad[k]
        if isinstance(v, list): print(f'  AppData.{k}: list[{len(v)}]')
        elif isinstance(v, dict): print(f'  AppData.{k}: dict[{len(v)} keys]')
    print(f'\n=== Behavior keys ===')
    for k in sorted(bh.keys()):
        v = bh[k]
        if isinstance(v, list) and len(v) >= 0: print(f'  Behavior.{k}: list[{len(v)}]')
    print(f'\n=== Presentation keys (lists) ===')
    for k in sorted(pres.keys()):
        v = pres[k]
        if isinstance(v, list): print(f'  Presentation.{k}: list[{len(v)}]')

    # Counts
    summary = {
        'app_id': APP_ID,
        'app_name': t.get('Name'),
        'short_name': t.get('ShortName'),
        'version': t.get('Version'),
        'cloned_from': t.get('CloneFrom'),
        'last_modified': t.get('LastModified'),
        'counts': {
            'tables': len(ad.get('DataSets', [])),
            'schemas': len(ad.get('DataSchemas', [])),
            'actions': len(ad.get('DataActions', [])),
            'slices': len(ad.get('TableSlices', [])),
            'views_menu_entries': len(pres.get('MenuEntries', [])),
            'bots': len(bh.get('AppBots', [])),
            'processes': len(bh.get('AppProcesses', [])),
            'workflow_rules': len(bh.get('AppWorkflowRules', [])),
            'events': len(bh.get('AppEvents', [])),
            'user_roles': len(t.get('UserRoles', [])),
        },
    }

    # Tables
    tables = []
    for ds in ad['DataSets']:
        tables.append({
            'name': ds.get('Name'),
            'source_type': ds.get('SourceType'),
            'allow_adds': ds.get('AllowAdds'),
            'allow_updates': ds.get('AllowUpdates'),
            'allow_deletes': ds.get('AllowDeletes'),
        })

    # Slices
    slices = []
    for s in ad.get('TableSlices', []):
        slices.append({
            'name': s.get('Name'),
            'source': s.get('SourceName'),
            'row_filter': str(s.get('RowFilter', ''))[:300] if s.get('RowFilter') else None,
        })

    # Actions
    actions = []
    for a in ad['DataActions']:
        actions.append({
            'name': a.get('Name'),
            'table': a.get('SourceName'),
            'action_type': a.get('ActionType'),
        })

    # Views
    views = []
    for v in pres.get('MenuEntries', []):
        views.append({
            'view_name': v.get('ViewName'),
            'display_name': str(v.get('DisplayName', ''))[:150] if v.get('DisplayName') else None,
            'position': v.get('Position'),
        })

    tmp = Path('C:/tmp')
    (tmp / 'seikyu-summary.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding='utf-8')
    (tmp / 'seikyu-tables.json').write_text(json.dumps(tables, ensure_ascii=False, indent=2), encoding='utf-8')
    (tmp / 'seikyu-actions.json').write_text(json.dumps(actions, ensure_ascii=False, indent=2), encoding='utf-8')
    (tmp / 'seikyu-slices.json').write_text(json.dumps(slices, ensure_ascii=False, indent=2), encoding='utf-8')
    (tmp / 'seikyu-views.json').write_text(json.dumps(views, ensure_ascii=False, indent=2), encoding='utf-8')

    print('\n=== SUMMARY ===')
    print(json.dumps(summary, ensure_ascii=False, indent=2))

    # action type breakdown
    from collections import Counter
    print('\n=== Action types ===')
    for at, n in Counter(a['action_type'] for a in actions).most_common():
        print(f'  {at}: {n}')
