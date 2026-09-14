"""Apply only the exact reviewed source edits; no configuration or game commands."""
import hashlib,json,subprocess,sys
from pathlib import Path
root=Path.cwd().resolve()
parts=sorted(Path('.ci').glob('recovery-*.json'))
records=[record for part in parts for record in json.loads(part.read_text())]
assert len(records)==37, 'Incomplete reviewed source manifest'
assert len({r['path'] for r in records})==len(records), 'Duplicate target'
def sha(data):return hashlib.sha1(b'blob '+str(len(data)).encode()+b'\0'+data).hexdigest()
def target(name):
 p=Path(name)
 assert not p.is_absolute() and '..' not in p.parts and p.parts[0] in ('src','scripts','agents','docs','tests','.github'), name
 assert (root/p).resolve().is_relative_to(root),name
 return p
if len(sys.argv)>1 and sys.argv[1]=='stage':
 for r in records:
  p=target(r['path']);assert (sha(p.read_bytes()) if p.exists() else None)==r['after'], 'Changed after validation: '+r['path']
 cleanup=[str(p) for p in parts]+['.ci/apply-recovery.py','.github/workflows/recovery-apply.yml']
 for name in cleanup:Path(name).unlink()
 subprocess.run(['git','add','--']+[r['path'] for r in records]+cleanup,check=True)
 print('Staged hash-verified source only; temporary delivery workflow removed.')
else:
 pending=[]
 for r in records:
  p=target(r['path']);old=p.read_bytes() if p.exists() else None
  # The repository connection already applied the exact reviewed test workflow.
  # The contents-only CI token must not create or update workflows itself.
  if r['path']=='.github/workflows/agency-tests.yml':
   assert old is not None and sha(old)==r['after'], 'Pre-applied test workflow differs'
   pending.append((p,old));continue
  assert (sha(old) if old is not None else None)==r['before'], 'Base changed: '+r['path']
  if r['after'] is None:new=None
  elif 'content' in r:new=r['content'].encode()
  else:
   lines=old.decode().splitlines(keepends=True)
   for a,b,text in reversed(r['edits']):lines[a:b]=[text]
   new=''.join(lines).encode()
  assert (sha(new) if new is not None else None)==r['after'], 'Output differs from tested source: '+r['path']
  pending.append((p,new))
 for p,new in pending:
  if new is None:p.unlink()
  else:p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(new)
 print('Applied all 37 exact, hash-verified source changes. No runtime state was accessed.')
