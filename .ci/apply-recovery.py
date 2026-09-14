"""Apply exact, locally tested UTF-8 source edits; never access a live runtime."""
import hashlib
import json
import pathlib
import subprocess
import sys

root = pathlib.Path.cwd().resolve()
parts = sorted(root.glob('.ci/recovery-part*.json'))
if len(parts) != 5:
    raise SystemExit('Expected all five reviewed source manifests')
entries = [entry for part in parts for entry in json.loads(part.read_text())]
if len(entries) != 27 or len({e['path'] for e in entries}) != 27:
    raise SystemExit('Unexpected or duplicate source files')

def blob(data):
    return hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()

outputs = []
for entry in entries:
    name = entry['path']
    path = root / name
    if '..' in pathlib.PurePosixPath(name).parts or pathlib.PurePosixPath(name).is_absolute():
        raise SystemExit('Invalid source path')
    if not (name.startswith(('src/', 'agents/advanced/src/', 'agents/advanced/tests/', 'tests/', 'docs/', 'scripts/')) or name in ('package.json', '.github/workflows/agency-tests.yml')):
        raise SystemExit('Source path outside reviewed scope')
    if path.is_symlink():
        raise SystemExit('Refusing source symlink')
    old = path.read_bytes() if path.exists() else b''
    if '--commit' in sys.argv:
        if blob(old) != entry['after']:
            raise SystemExit('Tested source changed: ' + name)
        continue
    actual = blob(old) if path.exists() else None
    if actual != entry['before']:
        raise SystemExit('Original source mismatch: ' + name)
    lines = old.decode('utf-8').splitlines(keepends=True)
    end = len(lines)
    for start, stop, replacement in reversed(entry['edits']):
        if not (0 <= start <= stop <= end):
            raise SystemExit('Invalid source edit')
        lines[start:stop] = [replacement]
        end = start
    data = ''.join(lines).encode('utf-8')
    if blob(data) != entry['after']:
        restored = data.replace(bytes([39,10,39]), bytes([39,92,110,39]))
        if blob(restored) != entry['after']:
            raise SystemExit('Published source differs from tested source: ' + name)
        data = restored
    outputs.append((path, data))

if '--commit' not in sys.argv:
    for path, data in outputs:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    print('Verified and applied all 27 tested source files; no live state accessed.')
else:
    # This token has contents permission, not workflow-write permission.
    # Publish only source/tests/docs. Do not add, modify, or remove any workflows.
    workflow_paths = [e['path'] for e in entries if e['path'].startswith('.github/workflows/')]
    if workflow_paths:
        subprocess.run(['git', 'restore', '--source=HEAD', '--', *workflow_paths], check=True)
    source_paths = [e['path'] for e in entries if not e['path'].startswith('.github/workflows/')]
    subprocess.run(['git', 'add', '--', *source_paths], check=True)
    delivery = [str(p.relative_to(root)) for p in parts] + ['.ci/apply-recovery.py']
    subprocess.run(['git', 'rm', '-f', '--', *delivery], check=True)
    changed = subprocess.check_output(['git', 'diff', '--cached', '--name-only'], text=True).splitlines()
    if any(p.startswith('.github/workflows/') for p in changed):
        raise SystemExit('Refusing workflow changes with contents-only permission')
    subprocess.run(['git', 'commit', '-m', 'Fix Astra startup diagnostics and reconcile legacy journals without replay'], check=True)
    subprocess.run(['git', 'push', 'origin', 'HEAD:refs/heads/codex/astra-startup-journal-recovery'], check=True)
