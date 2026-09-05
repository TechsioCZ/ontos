import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { discoverRules } from '../shared/discover-rules.ts';
import { pluginDirectory } from './oxlint.mts';
import { withTemporaryWorkspace } from './temporary-workspace.mts';

test('rule discovery loads the selected production rule and rejects unknown names', async () => {
  const rules = await discoverRules(['no-native-timers']);
  assert.deepEqual(Object.keys(rules), ['no-native-timers']);
  assert.equal(typeof rules['no-native-timers']?.create, 'function');
  await assert.rejects(discoverRules(['not-a-rule']), /Unknown fixture rule: not-a-rule/u);
});

test('rule discovery uses file URLs in workspaces containing spaces, URL delimiters, and Unicode', () => {
  withTemporaryWorkspace((directory) => {
    const workspace = join(directory, 'workspace #rules % café');
    const shared = join(workspace, 'shared');
    const rules = join(workspace, 'rules');
    mkdirSync(shared, { recursive: true });
    mkdirSync(rules, { recursive: true });
    writeFileSync(join(workspace, 'package.json'), JSON.stringify({ type: 'module' }));
    copyFileSync(
      join(pluginDirectory, 'shared', 'discover-rules.ts'),
      join(shared, 'discover-rules.ts'),
    );
    writeFileSync(join(rules, 'selected.ts'), 'export const rule = { marker: "selected" };');
    writeFileSync(
      join(rules, 'unselected.ts'),
      'throw new Error("unselected rule must not load"); export const rule = {};',
    );
    const moduleUrl = pathToFileURL(join(shared, 'discover-rules.ts')).href;
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
        import assert from 'node:assert/strict';
        import { registerHooks } from 'node:module';
        import { discoverRules } from ${JSON.stringify(moduleUrl)};
        let imports = 0;
        const hooks = registerHooks({
          resolve(specifier, context, nextResolve) {
            if (context.parentURL === ${JSON.stringify(moduleUrl)} && specifier.includes('selected.ts')) {
              imports += 1;
              assert.equal(new URL(specifier).protocol, 'file:');
            }
            return nextResolve(specifier, context);
          },
        });
        try {
          const rules = await discoverRules(['selected']);
          assert.deepEqual(rules, { selected: { marker: 'selected' } });
          assert.equal(imports, 1);
          await assert.rejects(discoverRules(['missing']), /Unknown fixture rule: missing/);
        } finally {
          hooks.deregister();
        }
      `,
      ],
      { cwd: workspace, encoding: 'utf8', timeout: 30_000 },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stderr, '');
  });
});
