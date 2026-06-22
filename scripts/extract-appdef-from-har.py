"""HAR ファイルから AppSheet appdef 相当のレスポンス本体を抽出して snapshot を生成する。

優先順位:
1. /api/loadApp/{appName} のレスポンス本体
2. POST /api/template/{appId}/ のレスポンス本体（フォールバック、saveapp 系）
"""
import json
import sys
from pathlib import Path

HAR_PATH = sys.argv[1] if len(sys.argv) > 1 else r'C:/Users/masuy/Downloads/hopecaredx.har'
APP_ID = sys.argv[2] if len(sys.argv) > 2 else 'b9e4f84d-f9b9-4376-97f1-83e3b07122e3'
OUT_PATH = Path(rf'C:/dev/ainotudoi/snapshots/appdef-{APP_ID}.json')

with open(HAR_PATH, encoding='utf-8') as f:
    har = json.load(f)

entries = har['log']['entries']

def get_body(e):
    c = e['response'].get('content', {})
    text = c.get('text', None)
    enc = c.get('encoding', '')
    if not text:
        return None
    if enc == 'base64':
        import base64
        try:
            text = base64.b64decode(text).decode('utf-8')
        except Exception:
            return None
    return text

# Step 1: try loadApp
load_app_entries = [e for e in entries if '/api/loadApp/' in e['request']['url']]
print(f'loadApp entries found: {len(load_app_entries)}')
best = None
best_len = 0
for i, e in enumerate(load_app_entries):
    text = get_body(e)
    text_len = len(text) if text else 0
    print(f'  loadApp[{i}] status={e["response"]["status"]} text_len={text_len}')
    if text_len > best_len:
        best, best_len = text, text_len

# Step 2: fallback to POST /api/template/{appId}/
if best_len < 100000:
    print(f'loadApp body unusable. Falling back to POST /api/template/{APP_ID}/')
    tmpl_entries = [e for e in entries
                    if e['request']['method'] == 'POST'
                    and f'/api/template/{APP_ID}/' in e['request']['url']]
    print(f'  template POST entries: {len(tmpl_entries)}')
    for i, e in enumerate(tmpl_entries):
        text = get_body(e)
        text_len = len(text) if text else 0
        print(f'  template[{i}] status={e["response"]["status"]} text_len={text_len}')
        if text_len > best_len:
            best, best_len = text, text_len

if best is None or best_len < 100000:
    print('NO usable body found. Failed.')
    sys.exit(1)

OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
OUT_PATH.write_text(best, encoding='utf-8')
print(f'\nSAVED: {OUT_PATH}')
print(f'Size: {OUT_PATH.stat().st_size} bytes')
try:
    parsed = json.loads(best)
    if isinstance(parsed, dict):
        top_keys = list(parsed.keys())[:30]
        print(f'\nTop-level keys ({len(parsed)}):')
        for k in top_keys:
            v = parsed[k]
            if isinstance(v, list):
                print(f'  {k}: list[{len(v)}]')
            elif isinstance(v, dict):
                print(f'  {k}: dict[{len(v)} keys]')
            else:
                vs = str(v)[:80]
                print(f'  {k}: {vs}')
except Exception as ex:
    print(f'JSON parse warning: {ex}')
