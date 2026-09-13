import { expect, test } from 'bun:test';
import { skillCommand } from '../src/skill-cli';

test('pins character and requests full raw state for every policy observation', () => {
  const env = { CLAWSCAPE_PYTHON: 'python-test', CLAWSCAPE_SKILL_CLI: '/installed/clawscape.py' };
  for (const name of ['clawscout', 'stinger', 'coincrafter']) {
    for (const args of [['state'], ['wait', '2'], ['act', 'walkTo', '--json', '{"x":1,"z":2}']]) {
      expect(skillCommand(name, args, env)).toEqual(['python-test', '/installed/clawscape.py', '--character', name, ...args, '--full']);
    }
  }
});
test('looks uses named character without changing it or adding full flag', () => {
  const command = skillCommand('stinger', ['looks']);
  expect(command.slice(2)).toEqual(['--character', 'stinger', 'looks']);
});
test('rejects identity overrides and does not duplicate full flag', () => {
  expect(() => skillCommand('astra; unsafe', ['state'])).toThrow();
  expect(() => skillCommand('stinger', ['state', '--character', 'astra'])).toThrow();
  expect(() => skillCommand('stinger', ['state', '--server', 'https://example.com'])).toThrow();
  expect(skillCommand('stinger', ['state', '--full']).filter(x => x === '--full')).toHaveLength(1);
});
