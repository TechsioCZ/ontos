import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import nodePath from 'node:path';

import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { listRuleNames } from '../shared/discover-rules.ts';
import { globToRegExp } from '../shared/paths.ts';
import {
  appRoot,
  directiveSuppressedFixtures,
  fixtureConfigPath,
  fixtureOptions,
  fixturesDirectory,
  productionOptions,
  testEffectNativeRule,
  virtualFile,
  virtualRoots,
  withOptions,
  workspaceCase,
} from './rule-tester.mts';

/**
 * Production settings (`app/oxlint.config.ts`) applied to each rule's fixtures at a neutral path
 * outside the repository, so root-anchored rules see the fixture-relative paths:
 * - the invalid fixture named in `fixtures/production-positives.json` reports with production
 *   settings, proving they are not inert;
 * - every `valid/**\/production-default.ts` stays clean;
 * - for rules whose fixtures use default options, every valid fixture outside a fixture override
 *   stays clean. Non-default option fixtures remain owned by the ordinary fixture suite.
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

// The imported DTO fixtures follow these actual package exports without executing owner code.
const wideFactoryPackageFiles = [
  'core-runtime/package.json',
  'core-runtime/src/permissions/principal-ref.ts',
  'shared-contracts/package.json',
  'shared-contracts/src/index.ts',
  'shared-contracts/src/calendar-date.ts',
];

it('every rule names one production-positive fixture', () => {
  expect(Object.keys(productionPositives).toSorted()).toEqual([...listRuleNames()]);
});

for (const rule of listRuleNames()) {
  const key = `effect-native/${rule}`;
  const options = withOptions(productionOptions(key));
  const relative = (kind: string, file: string): string =>
    nodePath.relative(nodePath.join(fixturesDirectory, rule, kind), file).replaceAll('\\', '/');
  const support = nodePath.join(fixturesDirectory, rule, 'support');
  const packageFiles = rule === 'no-wide-factory-signature' ? wideFactoryPackageFiles : [];
  // Imported fixtures and package owners belong to the graph, not additional lint targets.
  const workspace =
    existsSync(support) || packageFiles.length > 0
      ? workspaceCase(
          [
            ...['invalid', 'valid', ...(existsSync(support) ? ['support'] : [])].flatMap((kind) =>
              listFiles(nodePath.join(fixturesDirectory, rule, kind)).map((file) => ({
                path: `${kind}/${relative(kind, file)}`,
                source: readFileSync(file, 'utf-8'),
              })),
            ),
            ...packageFiles.map((file) => ({
              path: `node_modules/@app/${file}`,
              source: readFileSync(nodePath.join(appRoot, 'packages', file), 'utf-8'),
            })),
          ],
          virtualRoots.temporary,
        )
      : undefined;
  const productionCase = (kind: string, file: string) => ({
    code: readFileSync(file, 'utf-8'),
    cwd: workspace?.directory ?? virtualRoots.temporary,
    filename:
      workspace?.file(`${kind}/${relative(kind, file)}`) ?? virtualFile(`${kind}/${relative(kind, file)}`, 'temporary'),
    name: `${kind}/${relative(kind, file)}`,
    ...workspace?.hooks,
    ...options,
  });
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
        // The same staged DTO graph must still reject service-shaped, opaque and unknown owners.
        ...(rule === 'no-wide-factory-signature'
          ? [
              {
                ...productionCase(
                  'invalid',
                  nodePath.join(fixturesDirectory, rule, 'invalid/packages/probe/src/imported-non-data-factories.ts'),
                ),
                errors: 7,
              },
            ]
          : []),
      ],
      valid: valid.map((file) => productionCase(validKind, file)),
    },
    `effect-native/${rule} production settings`,
  );
}
