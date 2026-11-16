#!/usr/bin/env python3
"""Pack source directories using only the Python standard library; never executes adapters."""
import argparse,json
from pathlib import Path
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('directories',nargs='+',type=Path)
parser.add_argument('--out',required=True,type=Path)
args=parser.parse_args()
packages=[]
for directory in args.directories:
    manifest=json.loads((directory/'manifest.json').read_text(encoding='utf-8'))
    if manifest.get('entry')!='adapter.js':parser.error('entry 必须为 adapter.js')
    script=(directory/'adapter.js').read_text(encoding='utf-8')
    if len(script.encode())>256*1024:parser.error('adapter.js 最多 256 KiB')
    packages.append({'manifest':manifest,'script':script})
ids=[p['manifest']['id'] for p in packages]
if len(ids)!=len(set(ids)):parser.error('渠道 ID 重复')
data=json.dumps({'version':2,'sources':packages},ensure_ascii=False,indent=2)+'\n'
if len(data.encode())>1024*1024:parser.error('渠道安装文件最多 1 MiB')
args.out.parent.mkdir(parents=True,exist_ok=True)
args.out.write_text(data,encoding='utf-8')
print(args.out)
