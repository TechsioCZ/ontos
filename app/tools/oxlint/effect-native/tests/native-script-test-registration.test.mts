import { mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

import { expect, it } from 'effect-rstest';

import {
  allowsNativeScriptImport,
  importsNativeScriptTestRunner,
  nativeScriptAppRoot,
  validateNativeScriptRegistration,
} from '../shared/native-script-test-registration.ts';
import { nativeScriptTestGlob, isNativeScriptTest } from '../shared/native-script-test-filenames.ts';
import { testRestrictedImports } from '../shared/test-restricted-imports.ts';
import { testEffectNativeRule } from './rule-tester.mts';
import { withTemporaryWorkspace } from './temporary-workspace.mts';

const configurationFile = 'rstest.config.ts';
const configurationExport = 'export default defineConfig';
const specFile = 'scripts/example.spec.mts';
const productionFile = 'scripts/demo/production.mts';
const overlayFile = 'scripts/ci-matrices.demo.json';
const workflowFile = '../.github/workflows/ultramodern-workspace-gates.yml';
const dispatchStep = `- name: Run \${{ matrix.name }}\n        working-directory: app`;
const proof = validateNativeScriptRegistration(nativeScriptAppRoot);
const nativeSource = "import { test } from 'node:test'; import assert from 'node:assert/strict';";
const dynamicRunnerSource = `const runner = import(\`node:\${api}\`);`;
const nativeFile = proof.files[0] ?? 'scripts/missing.test.mts';
const read = (root: string, file: string) => readFileSync(path.join(root, file), 'utf-8');
const write = (root: string, file: string, source: string) => {
  const target = path.join(root, file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, source);
};
const mutate = (root: string, file: string, from: string, to: string) => {
  const source = read(root, file);
  expect(source, `Mutation anchor missing in ${file}`).toContain(from);
  write(root, file, source.replace(from, to));
};

/** Copy only immutable registration inputs, never run a test/config module in the fixture checkout. */
const fixture = (exercise: (root: string) => void) =>
  withTemporaryWorkspace((directory) => {
    const root = path.join(directory, 'app');
    for (const file of [configurationFile, overlayFile, workflowFile, 'scripts/ci-matrices.json']) {
      write(root, file, read(nativeScriptAppRoot, file));
    }
    for (const file of proof.files) {
      write(root, file, nativeSource);
    }
    exercise(root);
  });

it('the actual checkout has zero registration errors and authorizes only the two native APIs', () => {
  expect(proof.errors).toEqual([]);
  expect(proof.files.length).toBeGreaterThan(0);
  for (const file of proof.files) {
    expect(allowsNativeScriptImport(proof, path.join(nativeScriptAppRoot, file), 'node:test')).toBe(true);
    expect(allowsNativeScriptImport(proof, path.join(nativeScriptAppRoot, file), 'node:assert/strict')).toBe(true);
    expect(allowsNativeScriptImport(proof, path.join(nativeScriptAppRoot, file), 'node:assert')).toBe(false);
    expect(allowsNativeScriptImport(proof, path.join(nativeScriptAppRoot, file), '@rstest/core')).toBe(false);
  }
  expect(testRestrictedImports.map(({ name }) => name)).toEqual(['node:assert', '@rstest/core']);
});

it('the census sees actual native imports but not import-looking comments or fixture strings', () => {
  expect(importsNativeScriptTestRunner(nativeFile, nativeSource)).toBe(true);
  expect(importsNativeScriptTestRunner(nativeFile, `const fixture = ${JSON.stringify(nativeSource)};`)).toBe(false);
  expect(importsNativeScriptTestRunner(nativeFile, `// ${nativeSource}`)).toBe(false);
});

for (const source of [
  'const runner = import(`node:test`);',
  'const runner = require(`node:test`);',
  'const runner = module.require(`node:test`);',
  "export * from 'node:test';",
  "const runner = import('node:' + 'test');",
]) {
  it(`the census recognizes native runner access: ${source}`, () => {
    expect(importsNativeScriptTestRunner(nativeFile, source)).toBe(true);
  });
}

it('the census rejects unresolved native module access instead of silently omitting it', () => {
  expect(() => importsNativeScriptTestRunner(nativeFile, dynamicRunnerSource)).toThrow();
});

it('the census recognizes native access through static type wrappers', () => {
  expect(importsNativeScriptTestRunner(nativeFile, "const runner = import(('node:test' as const));")).toBe(true);
});

it('a genuine structurally registered native test is authorized without evaluating config', () =>
  fixture((root) => {
    const registration = validateNativeScriptRegistration(root);
    expect(registration.errors).toEqual([]);
    expect(allowsNativeScriptImport(registration, path.join(root, nativeFile), 'node:test')).toBe(true);
    expect(allowsNativeScriptImport(registration, path.join(root, productionFile), 'node:test')).toBe(false);
    expect(allowsNativeScriptImport(registration, path.join(root, '../foreign', nativeFile), 'node:test')).toBe(false);
  }));

it('shares the .spec.mts policy across census and registration, without authorizing an unregistered spec', () =>
  fixture((root) => {
    expect(path.matchesGlob(specFile, nativeScriptTestGlob)).toBe(true);
    expect(isNativeScriptTest(specFile)).toBe(true);
    write(root, specFile, nativeSource);
    expect(importsNativeScriptTestRunner(specFile, read(root, specFile))).toBe(true);
    expect(
      allowsNativeScriptImport(validateNativeScriptRegistration(root), path.join(root, specFile), 'node:test'),
    ).toBe(false);
    for (const file of [configurationFile, overlayFile]) {
      mutate(root, file, nativeFile, specFile);
    }
    const registration = validateNativeScriptRegistration(root);
    expect(registration.errors).toEqual([]);
    expect(allowsNativeScriptImport(registration, path.join(root, specFile), 'node:test')).toBe(true);
  }));

it('uses the effective step shell rather than an overridden workflow default', () =>
  fixture((root) => {
    mutate(root, workflowFile, '    shell: bash', "    shell: 'bash -n {0}'");
    mutate(root, workflowFile, dispatchStep, `${dispatchStep}\n        shell: bash`);
    expect(validateNativeScriptRegistration(root).errors).toEqual([]);
  }));

const invocation = `node --test --test-concurrency=1 ${proof.files.filter((file) => file.endsWith('.mts')).join(' ')}`;
const mutations: readonly (readonly [string, (root: string) => void])[] = [
  ['missing metadata', (root) => unlinkSync(path.join(root, configurationFile))],
  ['malformed metadata', (root) => write(root, configurationFile, 'export const = ;')],
  [
    'type-only configuration factory',
    (root) => mutate(root, configurationFile, 'import { defineConfig }', 'import type { defineConfig }'),
  ],
  ['false project identity', (root) => mutate(root, configurationFile, "name: 'scripts'", 'name: false')],
  [
    'collection by another project',
    (root) => mutate(root, configurationFile, 'include: operatorTests', "include: ['scripts/**/*.test.mts']"),
  ],
  [
    'comment-forged metadata',
    (root) => write(root, configurationFile, `// ${read(root, configurationFile).replaceAll('\n', '\n// ')}`),
  ],
  [
    'mutated registration',
    (root) =>
      write(
        root,
        configurationFile,
        `${read(root, configurationFile)}\nnativeScriptTests.push('scripts/forged.test.mts');`,
      ),
  ],
  [
    'hidden eager mutation',
    (root) =>
      mutate(
        root,
        configurationFile,
        configurationExport,
        "const forged = nativeScriptTests.push('scripts/forged.test.mts');\nexport default defineConfig",
      ),
  ],
  [
    'hidden deletion',
    (root) =>
      mutate(
        root,
        configurationFile,
        configurationExport,
        'const forged = delete nativeScriptTests[0];\nexport default defineConfig',
      ),
  ],
  [
    'tagged-template mutation',
    (root) =>
      mutate(
        root,
        configurationFile,
        configurationExport,
        'const forged = nativeScriptTests.pop``;\nexport default defineConfig',
      ),
  ],
  [
    'missing exclusion',
    (root) => mutate(root, configurationFile, `...nativeScriptTests.map((file) => \`!\${file}\`)`, ''),
  ],
  [
    'async exclusion mapper',
    (root) => mutate(root, configurationFile, 'nativeScriptTests.map((file)', 'nativeScriptTests.map(async (file)'),
  ],
  [
    'duplicate registration',
    (root) =>
      mutate(
        root,
        configurationFile,
        'export const nativeScriptTests = [',
        `export const nativeScriptTests = [\n'${nativeFile}',`,
      ),
  ],
  ['missing invocation', (root) => mutate(root, overlayFile, invocation, `echo ${proof.files.join(' ')}`)],
  ['duplicate invocation', (root) => mutate(root, overlayFile, invocation, `${invocation}\\n${invocation}`)],
  [
    'duplicate unit-job invocation',
    (root) =>
      mutate(
        root,
        'scripts/ci-matrices.json',
        '"unit": [',
        `"unit": [\n{"name":"forged native duplicate","commands":"node --test ${nativeFile}"},`,
      ),
  ],
  ['filtered invocation', (root) => mutate(root, overlayFile, '--test-concurrency=1', '--test-name-pattern=one')],
  ['conditional invocation', (root) => mutate(root, overlayFile, invocation, `false && ${invocation}`)],
  ['shell-masked invocation', (root) => mutate(root, overlayFile, invocation, `${invocation} || true`)],
  ['early-exit invocation', (root) => mutate(root, overlayFile, invocation, `exit 0\\n${invocation}`)],
  ['dynamic invocation', (root) => mutate(root, overlayFile, invocation, 'node --test $NATIVE_TEST_FILES')],
  ['implicit native autodiscovery', (root) => mutate(root, overlayFile, invocation, `${invocation}\\nnode --test`)],
  ['dynamic native executor', (root) => mutate(root, overlayFile, invocation, `$NODE --test ${proof.files.join(' ')}`)],
  [
    'direct Node invocation outside test mode',
    (root) => mutate(root, overlayFile, invocation, `${invocation}\\nnode ${nativeFile}`),
  ],
  [
    'syntax-only CI dispatcher',
    (root) => mutate(root, workflowFile, 'mise exec -- bash -c "$command"', 'mise exec -- bash -n "$command"'),
  ],
  [
    'syntax-only step shell',
    (root) => mutate(root, workflowFile, dispatchStep, `${dispatchStep}\n        shell: 'bash -n {0}'`),
  ],
  ['syntax-only workflow shell', (root) => mutate(root, workflowFile, '    shell: bash', "    shell: 'bash -n {0}'")],
  [
    'syntax-only job shell',
    (root) =>
      mutate(
        root,
        workflowFile,
        '  workspace-gate:\n',
        "  workspace-gate:\n    defaults:\n      run:\n        shell: 'bash -n {0}'\n",
      ),
  ],
  [
    'duplicate direct workflow invocation',
    (root) =>
      mutate(
        root,
        workflowFile,
        dispatchStep,
        `- name: Duplicate native suite\n        working-directory: app\n        run: node --test ${nativeFile}\n\n      ${dispatchStep}`,
      ),
  ],
  [
    'alternate source-matrix dispatcher',
    (root) =>
      mutate(
        root,
        workflowFile,
        dispatchStep,
        `- name: Duplicate matrix execution\n        env:\n          COMMANDS: \${{ matrix.commands }}\n        run: eval "$COMMANDS"\n\n      ${dispatchStep}`,
      ),
  ],
  [
    'duplicate invocation in another workflow job',
    (root) =>
      write(
        root,
        workflowFile,
        `${read(root, workflowFile)}\n  duplicate-native:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: node --test ${nativeFile}\n`,
      ),
  ],
  [
    'duplicate source-matrix consumer',
    (root) =>
      write(
        root,
        workflowFile,
        `${read(root, workflowFile)}\n  duplicate-native:\n    runs-on: ubuntu-24.04\n    strategy:\n      matrix:\n        include: \${{ fromJSON(needs.ci-plan.outputs.source) }}\n    steps:\n      - run: echo duplicate\n`,
      ),
  ],
  [
    'duplicate matrix setup invocation',
    (root) =>
      mutate(
        root,
        overlayFile,
        '"name": "Storefront Artifact Native Tests",',
        `"name": "Storefront Artifact Native Tests", "setup": "node --test ${nativeFile}",`,
      ),
  ],
  [
    'false CI step',
    (root) =>
      mutate(
        root,
        workflowFile,
        dispatchStep,
        `- name: Run \${{ matrix.name }}\n        if: false\n        working-directory: app`,
      ),
  ],
  [
    'production-file registration',
    (root) => {
      for (const file of [configurationFile, overlayFile]) {
        mutate(root, file, nativeFile, productionFile);
      }
      write(root, productionFile, nativeSource);
    },
  ],
  ['path traversal', (root) => mutate(root, configurationFile, nativeFile, 'scripts/demo/../production.test.mts')],
  ['missing test file', (root) => unlinkSync(path.join(root, nativeFile))],
  [
    'symlink escape',
    (root) => {
      const target = path.join(root, nativeFile);
      const foreign = path.join(root, '../production.mts');
      writeFileSync(foreign, nativeSource);
      unlinkSync(target);
      symlinkSync(foreign, target);
    },
  ],
];

for (const [name, change] of mutations) {
  it(`fails closed for ${name}`, () =>
    fixture((root) => {
      change(root);
      const registration = validateNativeScriptRegistration(root);
      expect(registration.errors.length).toBeGreaterThan(0);
      expect(registration.files).toEqual([]);
      expect(allowsNativeScriptImport(registration, path.join(root, nativeFile), 'node:test')).toBe(false);
    }));
}

testEffectNativeRule('no-unregistered-native-test-imports', {
  invalid: [
    { code: nativeSource, errors: 2, filename: path.join(nativeScriptAppRoot, specFile) },
    { code: nativeSource, errors: 2, filename: path.join(nativeScriptAppRoot, 'scripts/demo/unregistered.test.mts') },
    { code: nativeSource, errors: 2, filename: path.join(nativeScriptAppRoot, productionFile) },
    { code: nativeSource, errors: 2, filename: path.join(tmpdir(), 'foreign-checkout', nativeFile) },
    {
      code: "export * from 'node:test'; const assertions = import('node:assert/strict');",
      errors: 2,
      filename: path.join(nativeScriptAppRoot, 'scripts/demo/unregistered.test.mts'),
    },
    ...[
      'const runner = import(`node:test`); const assertion = import(`node:assert/strict`);',
      'const runner = require(`node:test`); const assertion = require(`node:assert/strict`);',
      'const runner = module.require(`node:test`); const assertion = module.require(`node:assert/strict`);',
      "const runner = import('node:' + 'test'); const assertion = require('node:assert/' + 'strict');",
      "const runner = import(('node:test' as const)); const assertion = require(('node:assert/strict')!);",
      `const runner = import(\`node:\${api}\`); const assertion = require(\`node:assert/\${mode}\`);`,
    ].map((code) => ({ code, errors: 2, filename: path.join(nativeScriptAppRoot, productionFile) })),
    {
      code: dynamicRunnerSource,
      errors: 1,
      filename: path.join(nativeScriptAppRoot, nativeFile),
    },
  ],
  valid: [
    { code: nativeSource, filename: path.join(nativeScriptAppRoot, nativeFile) },
    {
      code: 'const runner = import(`node:test`); const assertion = require(`node:assert/strict`);',
      filename: path.join(nativeScriptAppRoot, nativeFile),
    },
    {
      code: `const fs = import(\`node:fs\`); const owner = import(\`./owners/\${name}.ts\`);`,
      filename: path.join(nativeScriptAppRoot, productionFile),
    },
  ],
});
