"""Apply reviewed static edits only when both original and resulting Git blob hashes match."""
import ast
import hashlib
from pathlib import Path

ROOT = Path.cwd().resolve()
EXPECTED = {
    '.github/workflows/agency-tests.yml': 'dfd386029994f5dbbfe4175b7e1e4c8cbc7185ef',
    'agents/advanced/src/agency-bridge.ts': 'ea6dfb0a2fae87732004d76c9869f0e77e96a50a',
    'agents/advanced/src/agency/director.ts': 'f8dc0960ba1b1d9bb38435e1640392d434836083',
    'agents/advanced/src/agency/types.ts': 'b72df1ecd7165ce7fddf0a7c595b146a0301d7c2',
    'agents/advanced/src/live-cli.ts': '90b7a8da6daf9651f8019e6685bca19d2694723a',
    'agents/advanced/src/live-policy.ts': 'f41e8727c2ad2d644b02b0654abf24fae1108280',
    'agents/advanced/tests/agency-policy.test.ts': '62fabb02df14a44aaf50f5aa735b62b2c315f62f',
    'docs/AGENCY_INTEGRATION.md': '525b93cd7c179e596ddb1ec243a2bbf641dacade',
    'docs/AGENCY_REQUIREMENTS.md': '22075aaf1ce2bca4af4b6bf4e4eab3e8a54ea8de',
    'package.json': 'b9af4e62b60345b75ab50d571f9e7ddcdc89db87',
    'scripts/check-agency.cjs': 'bf575220c406181b7762551c9b4d50fcd104b34c',
    'scripts/supervise.ts': 'd275a39f4e81cd7b5c15466bddbbc7379bdb37a9',
    'scripts/test-agency-controller.cjs': 'b3a89d8b0d8b9d3c0e78aebc085388812ed97e74',
    'src/action-outcome.test.ts': '713fc7095ec36da8f030fca6af6f9fe977cf4ede',
    'src/action-outcome.ts': '5502d2e6b8671c29659c18ab62a0e0b510696a1f',
    'src/agency/director.ts': '318f04836e2784baf7a985cac9717e0622bae1e0',
    'src/agency/live-adapter.ts': '6eca0b620174d2a473d645e7aebbcbb2e0b98a43',
    'src/agency/types.ts': '124bb98311ecfff7c21399bd1b8ce101b8c787da',
    'src/agency/world-model.ts': '8aee6f4db62ace9b6ea11df60deaf56ad36ac83b',
    'src/agent.ts': '6bf263edfdcff7833d5031113f1617d821daf1fe',
    'src/training/discovery.test.ts': '6917b8311568916886aaebd09d5fd81b82e48204',
    'src/training/discovery.ts': '2339286a4f6ff7a1abaaa3589afc4e8870aa9343',
    'tests/agency/live-integration.test.ts': 'fabc4517641475a8132440ef6b433d16263386e1',
}

def blob(data):
    return hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()

def safe_file(name):
    path = ROOT / name
    if path.is_symlink() or path.resolve() != path or not path.is_file():
        raise RuntimeError('Invalid source path: ' + name)
    return path

def read_manifest(name):
    tree = ast.parse(safe_file(name).read_text(encoding='utf-8'), filename=name)
    if len(tree.body) != 1 or not isinstance(tree.body[0], ast.Assign):
        raise RuntimeError('Manifest must be one literal assignment')
    assignment = tree.body[0]
    if len(assignment.targets) != 1 or not isinstance(assignment.targets[0], ast.Name) or assignment.targets[0].id != 'FILES':
        raise RuntimeError('Unexpected manifest target')
    value = ast.literal_eval(assignment.value)
    if not isinstance(value, list):
        raise RuntimeError('Invalid manifest data')
    return value

prepared = {}
for row in read_manifest('.ci/shared-edits.py') + read_manifest('.ci/other-edits.py'):
    name = row['path']
    if name not in EXPECTED or name in prepared or row['after'] != EXPECTED[name]:
        raise RuntimeError('Unexpected or duplicate edit: ' + name)
    data = safe_file(name).read_bytes()
    if blob(data) != row['before']:
        raise RuntimeError('Source changed; refusing overwrite: ' + name)
    lines = data.decode('utf-8').splitlines(keepends=True)
    previous_end = -1
    for edit in row['edits']:
        start, end = edit['start'], edit['end']
        if type(start) is not int or type(end) is not int or not 0 <= start <= end <= len(lines) or start < previous_end or not isinstance(edit['text'], str):
            raise RuntimeError('Invalid edit bounds: ' + name)
        previous_end = end
    for edit in reversed(row['edits']):
        lines[edit['start']:edit['end']] = edit['text'].splitlines(keepends=True)
    result = ''.join(lines).encode('utf-8')
    if blob(result) != EXPECTED[name]:
        raise RuntimeError('Edited output differs from tested source: ' + name)
    prepared[name] = result

# Validate every directly uploaded source too, before modifying any file.
for name, digest in EXPECTED.items():
    data = prepared.get(name)
    if data is None:
        data = safe_file(name).read_bytes()
    if blob(data) != digest:
        raise RuntimeError('Published source differs from tested source: ' + name)
for name, data in prepared.items():
    safe_file(name).write_bytes(data)
for name, digest in EXPECTED.items():
    if blob(safe_file(name).read_bytes()) != digest:
        raise RuntimeError('Final source verification failed: ' + name)
print('Verified and applied all 23 tested source files. No runtime configuration or game command was accessed.')
