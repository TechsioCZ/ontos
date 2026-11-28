import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'effect-rstest';
import { appRoot } from './oxlint.mts';

const expected = readFileSync(path.join(appRoot, 'quality-audit/effective-oxlint-policy.json'), 'utf-8');
const snapshot = (args: readonly string[] = []) =>
  execFileSync(
    process.execPath,
    [...args, path.join(appRoot, 'tools/oxlint/effective-policy.mjs'), 'snapshot', appRoot],
    {
      cwd: appRoot,
      encoding: 'utf-8',
    },
  );

it('retains resolved rules, ordered override scopes, local and published defaults and analyzer versions', () => {
  expect(JSON.parse(snapshot())).toEqual(JSON.parse(expected));
});

it('detects a weaker repository rule default without any configuration or version change', () => {
  const plugin = pathToFileURL(path.join(appRoot, 'tools/oxlint/effect-native/index.ts')).href;
  const mutation = `import plugin from ${JSON.stringify(plugin)}; plugin.rules['no-wide-factory-signature'].meta.defaultOptions[0].maxPositionalParams = 3;`;
  const actual = snapshot(['--import', `data:text/javascript,${encodeURIComponent(mutation)}`]);
  const rule = 'effect-native/no-wide-factory-signature';
  expect(JSON.parse(expected)).toMatchObject({ defaults: { [rule]: [{ maxPositionalParams: 2 }] } });
  expect(JSON.parse(actual)).toMatchObject({ defaults: { [rule]: [{ maxPositionalParams: 3 }] } });
  expect(JSON.parse(actual)).not.toEqual(JSON.parse(expected));
});
