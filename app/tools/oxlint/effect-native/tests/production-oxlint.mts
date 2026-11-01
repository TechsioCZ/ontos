import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { appRoot, runOxlint } from './oxlint.mts';
import type { LintRun } from './oxlint.mts';
import { withTemporaryWorkspace } from './temporary-workspace.mts';

/**
 * Lint real files with the production configuration, `app/oxlint.config.ts`, through the Oxlint
 * binary. Its override globs are anchored at the configuration's directory, so the files are staged
 * in an operating-system temporary workspace beside a one-line configuration that re-exports the
 * production configuration object unchanged. The workspace links `tools/` and `node_modules/` so
 * the configuration's relative plugin specifiers resolve to the real plugins.
 */
export function runProductionOxlint(files: Readonly<Record<string, string>>): LintRun {
  return withTemporaryWorkspace((directory) => {
    symlinkSync(join(appRoot, 'tools'), join(directory, 'tools'), 'dir');
    symlinkSync(join(appRoot, 'node_modules'), join(directory, 'node_modules'), 'dir');
    const config = join(directory, 'oxlint.config.ts');
    writeFileSync(config, `export { default } from ${JSON.stringify(join(appRoot, 'oxlint.config.ts'))};\n`);
    for (const [file, source] of Object.entries(files)) {
      mkdirSync(dirname(join(directory, file)), { recursive: true });
      writeFileSync(join(directory, file), source);
    }
    return runOxlint(config, Object.keys(files), directory);
  }, realpathSync(tmpdir()));
}
