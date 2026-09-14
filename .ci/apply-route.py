"""Apply only exact, tested source edits on the dedicated repair branch."""
import gzip
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

BRANCH = 'codex/route-progress-startup-v2'
ALLOWED = '''.github/workflows/agency-tests.yml
.github/workflows/route-repair-snapshot.yml
agents/advanced/src/agency-bridge.ts
agents/advanced/src/arbiter.ts
agents/advanced/src/live-policy.ts
agents/advanced/tests/agency-policy.test.ts
docs/AGENCY_INTEGRATION.md
scripts/supervise.ts
scripts/test-agency-controller.cjs
src/action-outcome.ts
src/agency/director.ts
src/agency/live-adapter.ts
src/agency/types.ts
src/agent.ts
src/navigation/controller.ts
docs/ROUTE_PROGRESS_FIX.md
tests/agency/route-progress.test.ts
src/navigation/agency-route.test.ts'''.splitlines()
PARTS = [Path(f'.ci/route-part{i}') for i in range(7)]
DIGEST = '425cdc398b18bb537c016bbe24f535a260acc2b59ceb66d874b361781de22486'

def blob(data):
    return hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()

def run(*args):
    return subprocess.check_output(args, text=True).strip()

if os.environ.get('GITHUB_REPOSITORY') != 'StingingT/clawscape-agents':
    raise SystemExit('Unexpected repository')
if run('git', 'branch', '--show-current') != BRANCH:
    raise SystemExit('Unexpected branch')
packed = b''.join(p.read_bytes() for p in PARTS)
if len(packed) != 13715 or hashlib.sha256(packed).hexdigest() != DIGEST:
    raise SystemExit('Source transport hash mismatch')
entries = json.loads(gzip.decompress(packed))
if [e['path'] for e in entries] != ALLOWED:
    raise SystemExit('Unexpected source file set')
prepared = []
for e in entries:
    p = Path(e['path'])
    if p.is_absolute() or '..' in p.parts or any(x.is_symlink() for x in [p, *p.parents]):
        raise SystemExit('Unsafe source path')
    data = p.read_bytes() if p.exists() else None
    expected = e['after'] if '--commit' in sys.argv else e['before']
    if (blob(data) if data is not None else None) != expected:
        raise SystemExit('Source version mismatch: ' + str(p))
    if '--commit' in sys.argv:
        continue
    if e['after'] is None:
        target = None
    elif 'content' in e:
        target = e['content'].encode('utf-8')
    else:
        lines = data.decode('utf-8').splitlines(keepends=True)
        boundary = len(lines)
        for start, end, replacement in reversed(e['edits']):
            if not (0 <= start <= end <= boundary):
                raise SystemExit('Invalid edit range')
            lines[start:end] = replacement.splitlines(keepends=True)
            boundary = start
        target = ''.join(lines).encode('utf-8')
    if (blob(target) if target is not None else None) != e['after']:
        raise SystemExit('Tested output hash mismatch: ' + str(p))
    prepared.append((p, target))
if '--commit' not in sys.argv:
    for p, target in prepared:
        if target is None:
            p.unlink()
        else:
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(target)
    print('Applied and hash-verified 18 source changes; no local configuration or game actions accessed.')
else:
    run('git', 'config', 'user.name', 'github-actions[bot]')
    run('git', 'config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com')
    run('git', 'add', '--', *ALLOWED)
    run('git', 'rm', '--', *map(str, PARTS), '.ci/apply-route.py', '.github/workflows/apply-route.yml')
    run('git', 'commit', '-m', 'Fix route-leg reconciliation and preserve outcome goals across travel')
    run('git', 'push', 'origin', 'HEAD:refs/heads/' + BRANCH)
    print('Committed tested readable source to repair branch only.')
