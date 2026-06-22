"""AppSheet snapshot から DisabilityCard__c 8 列追加 + Office__c.ServiceType__c picklist 値追加を verify。"""
import json
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding='utf-8')

snap = Path('snapshots/appdef-b9e4f84d-f9b9-4376-97f1-83e3b07122e3.json')
with snap.open(encoding='utf-8') as f:
    d = json.load(f)

schemas = d['Template']['AppData']['DataSchemas']

# DisabilityCard__c 8 columns
target = ['ContractRowNumber__c','ContractStartDate__c','ContractEndDate__c','MonthlyAllotmentDays__c',
          'UpperLimitFacilityNumber__c','UpperLimitFacilityName__c','UpperLimitResult__c','ContractType__c']
for s in schemas:
    if s.get('Name') == 'DisabilityCard__c_Schema':
        attrs = s.get('Attributes', [])
        names = [a.get('Name') for a in attrs]
        print(f'=== DisabilityCard__c: {len(attrs)} attributes ===')
        for tc in target:
            ok = tc in names
            mark = 'OK' if ok else 'NG'
            t = next((a.get('Type') for a in attrs if a.get('Name')==tc), '?')
            print(f'  [{mark}] {tc} ({t})')
        break

# Office__c.ServiceType__c picklist values
print()
for s in schemas:
    if s.get('Name') == 'Office__c_Schema':
        for a in s.get('Attributes', []):
            if a.get('Name') == 'ServiceType__c':
                aux = json.loads(a.get('TypeAuxData', '{}'))
                vals = aux.get('EnumValues', [])
                print(f'=== Office__c.ServiceType__c: {len(vals)} enum values ===')
                checks = ['児童入所施設', '日中一時支援', '短期入所']
                for v in checks:
                    ok = v in vals
                    mark = 'OK' if ok else 'NG'
                    print(f'  [{mark}] {v}')
                # Show full list
                print(f'  full list: {vals}')
                break
        break
