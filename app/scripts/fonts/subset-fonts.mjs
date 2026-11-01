#!/usr/bin/env node
/**
 * Build the AKROS storefront Inter subsets (core + extended).
 *
 *   node app/scripts/fonts/subset-fonts.mjs
 *
 * Run it by hand whenever the source font or the covered character set changes,
 * then commit the generated files:
 *
 *   app/akros-storefront/src/fonts/InterVariable-core.woff2
 *   app/akros-storefront/src/fonts/InterVariable-ext.woff2
 *   app/akros-storefront/src/fonts/inter-extended.generated.css
 *   app/akros-storefront/src/fonts/inter-ranges.generated.ts
 *   app/akros-storefront/src/fonts/inter-subsets.generated.json
 *
 * The build never runs this; it only consumes the committed files.
 *
 * Tooling: uv (https://docs.astral.sh/uv/) runs the pinned fonttools and
 * uharfbuzz releases in an ephemeral environment, so nothing is added to the
 * workspace manifest. HarfBuzz is only used to detect kerning pairs, so no
 * kerned pair can end up split across the two files.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pythonScript = join(here, 'subset-fonts.py');

if (!existsSync(pythonScript)) {
  console.error(`missing ${pythonScript}`);
  process.exit(1);
}

const probe = spawnSync('uv', ['--version'], { encoding: 'utf8' });
if (probe.error || probe.status !== 0) {
  console.error(
    [
      'This script needs `uv` to run fonttools in a pinned throwaway environment.',
      'Install it (brew install uv, or https://docs.astral.sh/uv/getting-started/installation/)',
      'and run this script again. Nothing is added to the workspace dependencies.',
    ].join('\n'),
  );
  process.exit(1);
}

const result = spawnSync(
  'uv',
  [
    'run',
    '--no-project',
    '--with',
    'fonttools[woff]==4.59.2',
    '--with',
    'uharfbuzz==0.51.1',
    'python',
    resolve(pythonScript),
  ],
  { stdio: 'inherit' },
);

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
