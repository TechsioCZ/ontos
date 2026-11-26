import { readdirSync, readFileSync, statSync } from 'node:fs';
import nodePath from 'node:path';

import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { listRuleNames } from '../shared/discover-rules.ts';
import { globToRegExp } from '../shared/paths.ts';
import {
  directiveSuppressedFixtures,
  fixtureConfigPath,
  fixtureOptions,
  fixturesDirectory,
  isProductionIgnored,
  productionOptions,
  testEffectNativeRule,
  virtualFile,
  virtualRoots,
  withOptions,
} from './rule-tester.mts';

/**
 * Effective production settings (`app/oxlint.config.ts`) resolved for each fixture's logical filename
 * (test-only imports use the tooling test scope) and applied at a neutral path
 * outside the repository, so root-anchored rules see the fixture-relative paths:
 * - the invalid fixture named in `fixtures/production-positives.json` reports with production
 *   settings, proving they are not inert;
 * - every `valid/**\/production-default.ts` stays clean;
 * - for rules whose fixtures use default options, every valid fixture outside a fixture override
 *   stays clean. Ignored filenames retain separate global-default rule assertions and explicitly
 *   reject production selection. Non-default option fixtures remain owned by the ordinary fixture suite.
 */
const productionPositives = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Record(
      Schema.String,
      Schema.Struct({ count: Schema.Int.check(Schema.isGreaterThan(0)), file: Schema.String }),
    ),
  ),
)(readFileSync(nodePath.join(fixturesDirectory, 'production-positives.json'), 'utf-8'));

const validKind = 'valid';
const listFiles = (directory: string): readonly string[] =>
  readdirSync(directory)
    .flatMap((entry) => {
      const full = nodePath.join(directory, entry);
      if (statSync(full).isDirectory()) {
        return listFiles(full);
      }
      return entry.startsWith('.') ? [] : [full];
    })
    .toSorted();

const FixtureOverrides = Schema.fromJsonString(
  Schema.Struct({
    overrides: Schema.optional(
      Schema.Array(
        Schema.Struct({ files: Schema.Array(Schema.String), rules: Schema.Record(Schema.String, Schema.Unknown) }),
      ),
    ),
  }),
);

it('every rule names one production-positive fixture', () => {
  expect(Object.keys(productionPositives).toSorted()).toEqual([...listRuleNames()]);
});

it('enables native-test import enforcement only in production test scopes', () => {
  const key = 'effect-native/no-unregistered-native-test-imports';
  for (const filename of [
    'apps/demo/tests/unit/example.test.ts',
    'apps/demo/.private/tests/unit/.generated/example.test.ts',
    'verticals/demo/tests/unit/example.test.tsx',
    'packages/demo/tests/support/example.ts',
    'scripts/tests/example.test.mts',
    'scripts/example.spec.mjs',
    'tools/oxlint/effect-native/tests/unregistered.test.mts',
    'tools/oxlint/effect-native/tests/.example.test.mts',
  ]) {
    expect(productionOptions(key, filename)).toBeUndefined();
  }
  for (const filename of [
    'apps/demo/api/runtime.ts',
    'packages/demo/src/runtime.ts',
    'scripts/runtime.mts',
    'tools/oxlint/effect-native/index.ts',
    'tools/oxlint/effect-native/tests/nested/example.test.mts',
    'apps/demo/tests/e2e/example.test.ts',
    'apps/demo/.private/tests/e2e/.generated/example.test.ts',
    'verticals/demo/tests/e2e/example.test.tsx',
    'packages/demo/tests/e2e/example.test.mts',
  ]) {
    expect(() => productionOptions(key, filename)).toThrow(`Rule is not enabled in production: ${key}`);
  }
  expect(() => productionOptions(key)).toThrow(`Rule is not enabled in production: ${key}`);
});

it('does not select production rules for ignored files', () => {
  for (const filename of [
    'tools/oxlint/effect-native/tests/fixtures/no-console-in-scripts/valid/scripts/tests/harness.test.mts',
    'tools/oxlint/anti-slop/example.test.mts',
    '.agents/example.ts',
    '.codex/skills/example.ts',
    '.output/example.ts',
    'packages/demo/dist/example.ts',
    'packages/demo/.cache/dist/example.ts',
    'packages/demo/node_modules/dependency/index.ts',
    'repos/demo/example.ts',
    'repos/.worktree/runtime.ts',
    'packages/demo/.modern/example.ts',
    'packages/demo/.modernjs/example.ts',
    'packages/demo/modern-tanstack/example.ts',
    'packages/demo/src/routes/routeTree.gen.ts',
    'packages/demo/src/routes/ultramodern-route-metadata.ts',
    'packages/demo/shared/ultramodern-build.ts',
    'scripts/integration/tests/example.old-release.mts',
  ]) {
    for (const key of ['effect-native/no-bare-effect-run', 'effect-native/no-unregistered-native-test-imports']) {
      expect(() => productionOptions(key, filename)).toThrow(`File is ignored in production: ${filename}`);
    }
  }
});

it('retains global options and applies production severity overrides', () => {
  const key = 'effect-native/no-bare-effect-run';
  expect(productionOptions(key, 'apps/demo/api/handlers.ts')).toEqual(productionOptions(key));
  expect(productionOptions(key, 'packages/demo/repos/.worktree/runtime.ts')).toEqual(productionOptions(key));
  expect(productionOptions(key, 'apps/demo/api/handlers.ts')).toEqual([
    {
      adapterFiles: [
        'apps/*/api/index.ts',
        'verticals/*/api/index.ts',
        'packages/core-runtime/src/outbox/process.ts',
        'packages/shared-contracts/src/page-data.ts',
      ],
    },
  ]);
  expect(productionOptions('effect-native/ui-kit-required-label', 'verticals/demo/src/required.tsx')).toBeUndefined();
  expect(() =>
    productionOptions('effect-native/ui-kit-required-label', 'packages/admin-ui/src/form-controls.tsx'),
  ).toThrow('must enable its rule as an error');
});

it('applies production overrides through hidden directories', () => {
  const key = 'effect-native/no-unbranded-identifier-schema';
  expect(() => productionOptions(key, 'verticals/party-registry/src/.generated/id.ts')).toThrow(
    'must enable its rule as an error',
  );
  expect(productionOptions(key, 'verticals/assortment/src/.generated/id.ts')).toBeUndefined();
});

for (const rule of listRuleNames()) {
  const key = `effect-native/${rule}`;
  const relative = (kind: string, file: string): string =>
    nodePath.relative(nodePath.join(fixturesDirectory, rule, kind), file).replaceAll('\\', '/');
  // This rule is enabled only in test scopes; bare fixture names need their real tooling scope.
  const productionFilename = (kind: string, file: string): string => {
    const path = relative(kind, file);
    return rule === 'no-unregistered-native-test-imports' ? `tools/oxlint/effect-native/tests/${path}` : path;
  };
  const productionCase = (kind: string, file: string) => {
    const path = relative(kind, file);
    const filename = productionFilename(kind, file);
    return {
      code: readFileSync(file, 'utf-8'),
      cwd: virtualRoots.temporary,
      filename: virtualFile(filename, 'temporary'),
      name: `${kind}/${path}`,
      ...withOptions(productionOptions(key, filename)),
    };
  };
  const { overrides = [] } = Schema.decodeUnknownSync(FixtureOverrides)(readFileSync(fixtureConfigPath(rule), 'utf-8'));
  const usesOverride = (path: string): boolean =>
    overrides.some((override) => key in override.rules && override.files.some((glob) => globToRegExp(glob).test(path)));
  const defaultOptions = fixtureOptions(rule) === undefined;
  const valid = listFiles(nodePath.join(fixturesDirectory, rule, validKind)).filter((file) => {
    const path = `${validKind}/${relative(validKind, file)}`;
    if (directiveSuppressedFixtures.has(`${rule}/${path}`)) {
      return false;
    }
    return path.endsWith('/production-default.ts') || (defaultOptions && !usesOverride(path));
  });
  // Ignored fixtures still exercise the global rule defaults, but cannot demonstrate production enforcement.
  const ignored = valid.filter((file) => isProductionIgnored(productionFilename(validKind, file)));
  if (ignored.length > 0) {
    for (const file of ignored) {
      const filename = productionFilename(validKind, file);
      it(`${key} rejects ignored production filename ${filename}`, () => {
        expect(() => productionOptions(key, filename)).toThrow(`File is ignored in production: ${filename}`);
      });
    }
    testEffectNativeRule(
      rule,
      {
        valid: ignored.map((file) => ({
          code: readFileSync(file, 'utf-8'),
          cwd: virtualRoots.temporary,
          filename: virtualFile(productionFilename(validKind, file), 'temporary'),
          name: `${validKind}/${relative(validKind, file)}`,
          ...withOptions(productionOptions(key)),
        })),
      },
      `${key} global defaults at ignored filenames (not production enforcement)`,
    );
  }
  const positive = productionPositives[rule];
  if (positive === undefined) {
    throw new Error(`${rule}: name a production-positive fixture`);
  }
  const { count: positiveCount, file: positiveFile } = positive;
  testEffectNativeRule(
    rule,
    {
      invalid: [
        {
          ...productionCase('invalid', nodePath.join(fixturesDirectory, rule, 'invalid', positiveFile)),
          errors: positiveCount,
        },
      ],
      valid: valid
        .filter((file) => !isProductionIgnored(productionFilename(validKind, file)))
        .map((file) => productionCase(validKind, file)),
    },
    `effect-native/${rule} production settings`,
  );
}
