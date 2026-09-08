import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { appRoot, runOxlint } from './oxlint.mts';
import { withTemporaryWorkspace } from './temporary-workspace.mts';

const plugin = fileURLToPath(
  import.meta.resolve('eslint-plugin-perfectionist')
);
const applicationRequire = createRequire(join(appRoot, 'package.json'));
const cases = [
  {
    rule: 'sort-enums',
    options: { partitionByComment: true, sortByValue: 'always' },
    invalid: 'enum Status { Alpha = 20, Zulu = 1 }',
    valid: 'enum Status { Zulu = 1, Alpha = 20 }',
  },
  {
    rule: 'sort-heritage-clauses',
    invalid: 'interface View extends Zebra, Alpha {}',
    valid: 'interface View extends Alpha, Zebra {}',
  },
  {
    rule: 'sort-interfaces',
    invalid: 'interface View { zebra: string; alpha: string }',
    valid: 'interface View { alpha: string; zebra: string }',
  },
  {
    rule: 'sort-jsx-props',
    invalid: 'const view = <View zebra="" alpha="" />;',
    valid: 'const view = <View alpha="" zebra="" />;',
  },
  {
    rule: 'sort-object-types',
    invalid: 'type View = { zebra: string; alpha: string };',
    valid: 'type View = { alpha: string; zebra: string };',
  },
  {
    rule: 'sort-objects',
    options: { partitionByComment: true },
    invalid: 'const view = { zebra: 1, alpha: 2 };',
    valid: 'const view = { alpha: 2, zebra: 1 };',
  },
];

test('native sorting integration does not resolve the ESLint runner', () => {
  assert.throws(
    () => applicationRequire.resolve('eslint'),
    /Cannot find module 'eslint'/u
  );
});

for (const fixture of cases) {
  test(`Oxlint executes ${fixture.rule} positives and negatives without ESLint`, () => {
    withTemporaryWorkspace((directory) => {
      const config = join(directory, 'oxlint.json');
      writeFileSync(
        config,
        JSON.stringify({
          // Isolate each actual plugin rule; the application rule configuration is untouched.
          categories: { correctness: 'off' },
          jsPlugins: [{ name: 'perfectionist', specifier: plugin }],
          rules: {
            [`perfectionist/${fixture.rule}`]: ['error', fixture.options ?? {}],
          },
        })
      );
      const source = join(directory, 'fixture.tsx');
      writeFileSync(source, fixture.invalid);
      const negative = runOxlint(config, [source], directory);
      assert.equal(negative.exitCode, 1);
      assert.ok(
        negative.diagnostics.some(
          ({ code }) => code === `perfectionist(${fixture.rule})`
        )
      );
      writeFileSync(source, fixture.valid);
      const positive = runOxlint(config, [source], directory);
      assert.equal(positive.exitCode, 0, JSON.stringify(positive.diagnostics));
      assert.deepEqual(positive.diagnostics, []);
    });
  });
}

test('native enum and object sorting preserves explicit comment partitions', () => {
  withTemporaryWorkspace((directory) => {
    const config = join(directory, 'oxlint.json');
    writeFileSync(
      config,
      JSON.stringify({
        categories: { correctness: 'off' },
        jsPlugins: [{ name: 'perfectionist', specifier: plugin }],
        rules: {
          'perfectionist/sort-enums': [
            'error',
            { partitionByComment: true, sortByValue: 'always' },
          ],
          'perfectionist/sort-objects': ['error', { partitionByComment: true }],
        },
      })
    );
    const source = join(directory, 'fixture.ts');
    writeFileSync(
      source,
      `enum Status {
  Alpha = 20,
  // separate partition
  Zulu = 1,
}
const value = {
  zebra: 1,
  // separate partition
  alpha: 2,
};
`
    );
    const result = runOxlint(config, [source], directory);
    assert.equal(result.exitCode, 0, JSON.stringify(result.diagnostics));
    assert.deepEqual(result.diagnostics, []);
  });
});
