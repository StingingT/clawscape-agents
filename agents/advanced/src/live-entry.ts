import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { runWithStartupStatus } from './startup.ts';

const codeRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
await runWithStartupStatus(codeRoot, process.argv.slice(2), async context => {
  try { createRequire(import.meta.url).resolve('zod'); } catch { throw new Error('RUNTIME_DEPENDENCY_MISSING'); }
  const { main } = await import('./live-cli.ts');
  await main(context);
});
