import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { expect, it } from 'effect-rstest';
import { appRoot, oxlintEntryPoint } from './oxlint.mts';

it('retains the complete resolved lint policy including ordered override scopes', () => {
  const output = execFileSync(process.execPath, [oxlintEntryPoint, '--print-config'], {
    cwd: appRoot,
    encoding: 'utf-8',
  });
  const stylesheet = '@techsio/ui-kit/styles.css';
  const resolved = createRequire(path.join(appRoot, 'apps/shell-super-app/package.json')).resolve(stylesheet);
  // Only this independently resolved package export varies by machine; a different asset still fails equality.
  const portable = output.replaceAll(JSON.stringify(resolved), JSON.stringify(stylesheet));
  const expected = readFileSync(path.join(appRoot, 'quality-audit/effective-oxlint-policy.json'), 'utf-8');
  expect(JSON.parse(portable)).toEqual(JSON.parse(expected));
});
