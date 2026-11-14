#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { resolveTsrsCompiler } from './typecheck-compiler.mjs';

const compiler = resolveTsrsCompiler({ from: new URL('../package.json', import.meta.url) });
const args = process.argv.slice(2);
// Project names in the log distinguish a true finding from a file checked in the wrong environment.
if ((args.includes('--build') || args.includes('-b')) && !args.includes('--verbose')) {
  args.push('--verbose');
}
const result = spawnSync(
  'pnpm',
  ['exec', 'ultramodern-create', 'ultramodern', 'typecheck', ...args],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      EFFECT_TSGO_BIN: compiler,
      ULTRAMODERN_WORKSPACE_ROOT: fileURLToPath(new URL('..', import.meta.url)),
    },
  },
);
if (result.error) {
  throw result.error;
}
process.exit(result.status ?? 1);
