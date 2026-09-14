"""Apply exact tested source on the dedicated branch; never edit user runtime files."""
import base64
import gzip
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

BRANCH = 'codex/strategic-hierarchy-builds'
ALLOWED = '''docs/STRATEGIC_HIERARCHY.md
scripts/agency-status.ts
scripts/check-agency.cjs
scripts/test-agency-controller.cjs
src/action-outcome.ts
src/agency/development.ts
src/agency/director.ts
src/agency/live-adapter.ts
src/agency/step-retry.ts
src/agency/types.ts
src/agency/world-model.ts
src/agent.ts
tests/agency/development-retry.test.ts
tests/agency/hierarchy.test.ts'''.splitlines()
PARTS = ['part0', 'part1'] + ['rest' + str(i) for i in range(20)]
DIGEST = '78fd1af96076a9cb33cfc0e67389248f88444a9b7a667d9b3dbb979ac064acaf'

def run(*args):
    return subprocess.check_output(args, text=True).strip()

def blob(data):
    return hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()

if os.environ.get('GITHUB_REPOSITORY') != 'StingingT/clawscape-agents' or run('git', 'branch', '--show-current') != BRANCH:
    raise SystemExit('Unexpected repository or branch')
encoded = ''.join(Path('.ci/hierarchy-' + part + '.b64').read_text() for part in PARTS)
packed = base64.b64decode(encoded, validate=True)
if len(packed) != 23567 or hashlib.sha256(packed).hexdigest() != DIGEST:
    raise SystemExit('Source transport does not match tested bytes')
entries = json.loads(gzip.decompress(packed))
if [e['path'] for e in entries] != ALLOWED:
    raise SystemExit('Unexpected source file set')
commit = '--commit' in sys.argv
prepared = []
for entry in entries:
    p = Path(entry['path'])
    if p.is_absolute() or '..' in p.parts or any(q.is_symlink() for q in [p, *p.parents]):
        raise SystemExit('Unsafe source path')
    current = p.read_bytes() if p.exists() else None
    expected = entry['after'] if commit else entry['before']
    if (blob(current) if current is not None else None) != expected:
        raise SystemExit('Source version mismatch: ' + str(p))
    if commit:
        continue
    if 'content' in entry:
        updated = entry['content'].encode('utf-8')
    else:
        lines = current.decode('utf-8').splitlines(keepends=True)
        boundary = len(lines)
        for start, end, replacement in reversed(entry['edits']):
            if not 0 <= start <= end <= boundary:
                raise SystemExit('Invalid edit range')
            lines[start:end] = replacement.splitlines(keepends=True)
            boundary = start
        updated = ''.join(lines).encode('utf-8')
    if blob(updated) != entry['after']:
        raise SystemExit('Tested output hash mismatch: ' + str(p))
    prepared.append((p, updated))
if not commit:
    for p, updated in prepared:
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(updated)
    print('Applied 14 exact hash-verified source/test/doc files. No game or private runtime access.')
else:
    run('git', 'diff', '--check')
    run('git', 'config', 'user.name', 'github-actions[bot]')
    run('git', 'config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com')
    # This contents-only token must never stage workflow edits or cleanup files.
    run('git', 'add', '--', *ALLOWED)
    changed = run('git', 'diff', '--cached', '--name-only').splitlines()
    if sorted(changed) != sorted(ALLOWED):
        raise SystemExit('Unexpected staged file set')
    run('git', 'commit', '-m', 'Integrate persistent support hierarchy, build trials and evidence-based retries')
    run('git', 'push', 'origin', 'HEAD:refs/heads/' + BRANCH)
    print('Published only the tested readable source to the feature branch.')
