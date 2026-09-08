import { expect, it } from '@app/effect-rstest';
import { Effect, Predicate } from 'effect';

import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { pathToFileURL } from 'node:url';

import { discoverRules } from '../shared/discover-rules.ts';
import { pluginDirectory } from './oxlint.mts';
import { withTemporaryWorkspace } from './temporary-workspace.mts';

it.effect('rule discovery loads the selected production rule and rejects unknown names', () =>
  Effect.gen(function* ruleDiscoveryEffect() {
    const rules = yield* Effect.tryPromise(() => discoverRules(['no-native-timers']));
    expect(Object.keys(rules)).toEqual(['no-native-timers']);
    expect(Predicate.isFunction(rules['no-native-timers']?.create)).toBe(true);
    const error = yield* Effect.flip(
      Effect.tryPromise({
        catch: (cause) => cause,
        try: () => discoverRules(['not-a-rule']),
      }),
    );
    const message: unknown = expect.stringMatching(/Unknown fixture rule: not-a-rule/u);
    expect(error).toMatchObject({ message });
  }),
);

it('rule discovery uses file URLs in workspaces containing spaces, URL delimiters, and Unicode', () => {
  withTemporaryWorkspace((directory) => {
    const workspace = path.join(directory, 'workspace #rules % café');
    const shared = path.join(workspace, 'shared');
    const rules = path.join(workspace, 'rules');
    const selectedFile = 'selected.ts';
    const discoveryFile = 'discover-rules.ts';
    mkdirSync(shared, { recursive: true });
    mkdirSync(rules, { recursive: true });
    writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({ type: 'module' }));
    copyFileSync(
      path.join(pluginDirectory, 'shared', discoveryFile),
      path.join(shared, discoveryFile),
    );
    writeFileSync(path.join(rules, selectedFile), 'export const rule = { marker: "selected" };');
    writeFileSync(
      path.join(rules, 'unselected.ts'),
      'throw new Error("unselected rule must not load"); export const rule = {};',
    );
    const moduleUrl = pathToFileURL(realpathSync(path.join(shared, discoveryFile))).href;
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
      { cwd: workspace, encoding: 'utf-8', timeout: 30_000 },
    );
    expect(result.error).toBe(undefined);
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stderr).toBe('');
  });
});
