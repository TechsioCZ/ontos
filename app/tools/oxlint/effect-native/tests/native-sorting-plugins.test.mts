import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { describe, expect, it } from 'effect-rstest';

import { appRoot, oxlintEntryPoint, parseOxlintOutput } from './oxlint.mts';
import { loadPluginRules, ruleTester, virtualFile } from './rule-tester.mts';
import { withTemporaryWorkspace } from './temporary-workspace.mts';

const applicationRequire = createRequire(path.join(appRoot, 'package.json'));
const applicationManifest = readFileSync(path.join(appRoot, 'package.json'), 'utf-8');
const plugin = applicationRequire.resolve('eslint-plugin-perfectionist');
const oxlint = path.join(path.dirname(applicationRequire.resolve('oxlint/package.json')), 'bin/oxlint');
const configFilename = 'oxlint.json';
interface SortingCase {
  readonly invalid: string;
  readonly options?: Record<string, boolean | string>;
  readonly output?: string;
  readonly rule: string;
  readonly valid: string;
}
const cases: readonly SortingCase[] = [
  {
    invalid: 'enum Status { Alpha = 20, Zulu = 1 }',
    options: { partitionByComment: true, sortByValue: 'always' },
    rule: 'sort-enums',
    valid: 'enum Status { Zulu = 1, Alpha = 20 }',
  },
  {
    invalid: 'interface View extends Zebra, Alpha {}',
    rule: 'sort-heritage-clauses',
    valid: 'interface View extends Alpha, Zebra {}',
  },
  {
    invalid: 'interface View { zebra: string; alpha: string }',
    output: 'interface View { alpha: string; zebra: string; }',
    rule: 'sort-interfaces',
    valid: 'interface View { alpha: string; zebra: string }',
  },
  {
    invalid: 'const view = <View zebra="" alpha="" />;',
    rule: 'sort-jsx-props',
    valid: 'const view = <View alpha="" zebra="" />;',
  },
  {
    invalid: 'type View = { zebra: string; alpha: string };',
    output: 'type View = { alpha: string; zebra: string; };',
    rule: 'sort-object-types',
    valid: 'type View = { alpha: string; zebra: string };',
  },
  {
    invalid: 'const view = { zebra: 1, alpha: 2 };',
    options: { partitionByComment: true },
    rule: 'sort-objects',
    valid: 'const view = { alpha: 2, zebra: 1 };',
  },
];

it('native sorting integration resolves the Oxlint runner directly', () => {
  expect(oxlintEntryPoint).toBe(
    path.join(path.dirname(applicationRequire.resolve('oxlint/package.json')), 'bin/oxlint'),
  );
  expect(oxlintEntryPoint).not.toContain(`${path.sep}eslint${path.sep}`);
});

it('native sorting integration does not declare the ESLint runner', () => {
  const hasDirectEslintDependency = /^[ ]{2}"(?:dependencies|devDependencies)"\s*:\s*\{[^{}]*"eslint"\s*:/msu.test(
    applicationManifest,
  );
  expect(hasDirectEslintDependency).toBe(false);
});

it('native sorting integration runs without loading the ESLint runner', () => {
  withTemporaryWorkspace((directory) => {
    const guard = path.join(directory, 'block-eslint.mjs');
    writeFileSync(
      guard,
      `import { registerHooks } from 'node:module';
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'eslint' || specifier.startsWith('eslint/')) {
      throw new Error('Native sorting loaded the ESLint runner: ' + specifier);
    }
    return nextResolve(specifier, context);
  },
});
`,
    );
    const config = path.join(directory, configFilename);
    writeFileSync(
      config,
      JSON.stringify({
        categories: { correctness: 'off' },
        jsPlugins: [{ name: 'perfectionist', specifier: plugin }],
        rules: { 'perfectionist/sort-objects': 'error' },
      }),
    );
    const source = path.join(directory, 'fixture.ts');
    writeFileSync(source, 'const view = { zebra: 1, alpha: 2 };');
    const result = spawnSync(
      process.execPath,
      [oxlint, '-c', config, '--format=json', '--disable-nested-config', source],
      {
        cwd: directory,
        encoding: 'utf-8',
        env: { ...process.env, NODE_OPTIONS: `--import=${guard}` },
        timeout: 120_000,
      },
    );
    if (result.error) {
      throw result.error;
    }
    const report = parseOxlintOutput(result.stdout ?? '', result.stderr ?? '', result.status);
    expect(report.exitCode).toBe(1);
    expect(report.diagnostics.some(({ code }) => code === 'perfectionist(sort-objects)')).toBeTruthy();
  });
});

const perfectionistRules = await loadPluginRules('eslint-plugin-perfectionist');
const perfectionistRule = (name: string) => {
  const rule = perfectionistRules[name];
  if (rule === undefined) {
    throw new Error(`eslint-plugin-perfectionist does not export ${name}`);
  }
  return rule;
};

// Each actual plugin rule runs in isolation inside Oxlint's JavaScript plugin runtime; the
// application rule configuration is untouched.
for (const fixture of cases) {
  ruleTester.run(`perfectionist/${fixture.rule} positives and negatives`, perfectionistRule(fixture.rule), {
    invalid: [
      {
        code: fixture.invalid,
        errors: 1,
        filename: virtualFile('fixture.tsx'),
        options: [fixture.options ?? {}],
        output: fixture.output ?? fixture.valid,
      },
    ],
    valid: [{ code: fixture.valid, filename: virtualFile('fixture.tsx'), options: [fixture.options ?? {}] }],
  });
}

const partitionedSource = `enum Status {
  Alpha = 20,
  // separate partition
  Zulu = 1,
}
const value = {
  zebra: 1,
  // separate partition
  alpha: 2,
};
`;
describe('native enum and object sorting preserves explicit comment partitions', () => {
  for (const [name, options] of [
    ['sort-enums', { partitionByComment: true, sortByValue: 'always' }],
    ['sort-objects', { partitionByComment: true }],
  ] as const) {
    ruleTester.run(`perfectionist/${name}`, perfectionistRule(name), {
      invalid: [],
      valid: [{ code: partitionedSource, filename: virtualFile('fixture.ts'), options: [options] }],
    });
  }
});
