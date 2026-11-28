import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'effect-rstest';
import { appRoot } from './oxlint.mts';

it('retains resolved rules, ordered override scopes, published defaults and analyzer versions', () => {
  const output = execFileSync(
    process.execPath,
    [path.join(appRoot, 'tools/oxlint/effective-policy.mjs'), 'snapshot', appRoot],
    { cwd: appRoot, encoding: 'utf-8' },
  );
  const expected = readFileSync(path.join(appRoot, 'quality-audit/effective-oxlint-policy.json'), 'utf-8');
  expect(JSON.parse(output)).toEqual(JSON.parse(expected));
});
