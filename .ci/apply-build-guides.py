"""Reconstruct only reviewed source, verify exact Git blobs, then test before publication."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

BRANCH = 'codex/strategic-hierarchy-builds'
EXPECTED = '''docs/BUILD_GUIDES.md
docs/RESEARCHED_BUILDS_SPEC.md
docs/STRATEGIC_HIERARCHY.md
scripts/agency-status.ts
scripts/check-agency.cjs
scripts/test-agency-controller.cjs
src/agency/build-guides.ts
src/agency/build-rules.ts
src/agency/development.ts
src/agency/live-adapter.ts
src/agency/world-model.ts
src/agent.ts
src/training/catalog.ts
src/training/discovery.test.ts
src/training/discovery.ts
src/training/guide-leads.ts
tests/agency/build-guides.test.ts
tests/agency/development-retry.test.ts'''.splitlines()
PARTS = [Path('.ci/build-guide-part%d.json' % i) for i in range(8)]
def git(*args):
    return subprocess.check_output(['git', *args], text=True).strip()
def blob(data):
    return hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()
if os.environ.get('GITHUB_REPOSITORY') != 'StingingT/clawscape-agents' or git('branch', '--show-current') != BRANCH:
    raise SystemExit('Unexpected repository or branch')
entries = [e for part in PARTS for e in json.loads(part.read_text(encoding='utf-8'))]
if [e['path'] for e in entries] != EXPECTED:
    raise SystemExit('Unexpected source manifest')
outputs = []
for e in entries:
    p = Path(e['path'])
    if p.is_absolute() or '..' in p.parts or any(q.is_symlink() for q in [p, *p.parents]):
        raise SystemExit('Unsafe source path')
    old = p.read_bytes() if p.exists() else None
    expected = e['after'] if '--commit' in sys.argv else e['before']
    if (blob(old) if old is not None else None) != expected:
        raise SystemExit('Source version differs from reviewed version: ' + str(p))
    if '--commit' in sys.argv:
        continue
    lines = (old or b'').decode('utf-8').splitlines(keepends=True)
    boundary = len(lines)
    for start, stop, replacement in reversed(e['edits']):
        if not 0 <= start <= stop <= boundary:
            raise SystemExit('Invalid edit range')
        lines[start:stop] = replacement.splitlines(keepends=True)
        boundary = start
    data = ''.join(lines).encode('utf-8')
    if blob(data) != e['after']:
        raise SystemExit('Output differs from tested source: ' + str(p))
    outputs.append((p, data))
if '--commit' not in sys.argv:
    for p, data in outputs:
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)
    print('Applied 18 hash-verified source/test/doc changes; no live runtime accessed.')
else:
    git('config', 'user.name', 'github-actions[bot]')
    git('config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com')
    git('add', '--', *EXPECTED)
    git('rm', '--', *map(str, PARTS), '.ci/apply-build-guides.py')
    git('commit', '-m', 'Integrate sourced build profiles, capped XP guards and measured training leads')
    git('push', 'origin', 'HEAD:refs/heads/' + BRANCH)
    print('Published tested source to the feature branch only; no workflow edits or deployment.')
