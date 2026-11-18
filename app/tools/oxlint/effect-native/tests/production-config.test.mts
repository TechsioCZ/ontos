import { expect, it } from 'effect-rstest';

import { runProductionOxlint } from './production-oxlint.mts';

// End-to-end checks of the production configuration through the Oxlint binary: the plugins load,
// the configuration enables their rules, and its path overrides apply. Rule behaviour itself is
// covered in-process by the RuleTester suites.
//
// Every assertion below reads one shared run. Loading each configured JavaScript plugin in a cold
// Oxlint process dominates the cost, the staged files below occupy disjoint paths, and each
// assertion selects its own files out of the report, so one run answers all three questions.

const constructorFactory = [
  'interface CustomerSchemaDependency {',
  '  readonly read: () => number;',
  '}',
  '',
  'export const makeCustomerSchema = (dependency: CustomerSchemaDependency) => dependency;',
  '',
].join('\n');
const constructorConsumer = "import { makeCustomerSchema } from './factory.ts';\n\nvoid makeCustomerSchema;\n";
const nodeTestImport = "import { test } from 'node:test';\ntest('example', () => {});\n";

const source = 'apps/demo/src/check.ts';
const serviceConsumer = 'apps/demo/src/services/consumer.ts';
const testingConsumer = 'packages/core-runtime/src/testing/consumer.ts';
const applicationTest = 'apps/demo/tests/y.test.ts';
const e2eTest = 'apps/demo/tests/e2e/y.test.ts';
const handlers = 'apps/demo/src/handlers.ts';
const discardedAssignment = 'apps/demo/src/discarded-assignment.ts';
const observedValues = 'apps/demo/src/observed-values.ts';

const validRoutes = [
  'apps/shell-super-app/src/routes/[lang]/$.tsx',
  'apps/shell-super-app/src/routes/[lang]/$.data.ts',
  'apps/shell-super-app/src/routes/[lang]/$.data.client.ts',
  'apps/shell-super-app/src/routes/[lang]/modules/[moduleId]/page.data.client.ts',
];
const invalidRoutes = [
  'apps/shell-super-app/src/routes/[lang]/$rogue.tsx',
  'apps/shell-super-app/src/routes/[lang]/$.custom.ts',
  'apps/shell-super-app/src/routes/[lang]/page.data.custom.ts',
  'apps/another-owner/src/routes/[lang]/$.tsx',
];
const routes: readonly string[] = [...validRoutes, ...invalidRoutes];

// Property keys that name domain vocabulary must not be read as function names.
const domainVocabulary = [
  "import { Match } from 'effect';",
  '',
  "type Event = { readonly _tag: 'OrderPlaced' } | { readonly _tag: 'OrderShipped' };",
  "type Row = { readonly kind: 'order_placed' } | { readonly kind: 'order_shipped' };",
  '',
  'export const describeEvent = Match.type<Event>().pipe(',
  '  Match.tags({',
  "    OrderPlaced: () => 'placed',",
  "    OrderShipped: () => 'shipped',",
  '  }),',
  '  Match.exhaustive,',
  ');',
  '',
  "export const describeRow = Match.type<Row>().pipe(Match.discriminatorsExhaustive('kind')({",
  "  order_placed: () => 'placed',",
  "  order_shipped: () => 'shipped',",
  '}));',
  '',
  '// A sibling SonarJS rule proves the plugin ran on this file.',
  'export const duplicated = (flag: boolean) => (flag ? describeEvent : describeEvent);',
  '',
].join('\n');

// Listed as pairs rather than an object literal so a duplicated path shortens the staged record
// without shortening this list, which the file-count assertion then reports.
const staged: readonly (readonly [string, string])[] = [
  [source, 'export const check = (value: unknown) => value instanceof Error;\n'],
  ['apps/demo/src/services/factory.ts', constructorFactory],
  [serviceConsumer, constructorConsumer],
  ['packages/core-runtime/src/testing/factory.ts', constructorFactory],
  [testingConsumer, constructorConsumer],
  [applicationTest, nodeTestImport],
  [e2eTest, nodeTestImport],
  [handlers, domainVocabulary],
  [discardedAssignment, 'export const read = () => { let value = 1; value = 2; return value; };\n'],
  [observedValues, 'export const read = () => 2;\n'],
  ...routes.map((file) => [file, 'export const value = 1;\n'] as const),
];

const run = runProductionOxlint(Object.fromEntries(staged));

const codesFor = (file: string): readonly string[] =>
  run.diagnostics.filter(({ filename }) => filename === file).map(({ code }) => code);

it('production configuration loads every repository plugin and scopes its overrides by path', () => {
  expect(run.numberOfFiles).toBe(staged.length);
  expect(run.exitCode).toBe(1);
  // effect-native and anti-slop rules from the base configuration.
  expect(codesFor(source)).toContain('effect-native(no-instanceof)');
  expect(codesFor(source)).toContain('anti-slop(no-unknown-parameters)');
  // anti-slop-effect is enabled, and switched off for the guarded core-runtime testing entrypoint.
  expect(codesFor(serviceConsumer)).toContain('anti-slop-effect(no-service-constructor-imports)');
  expect(codesFor(testingConsumer)).not.toContain('anti-slop-effect(no-service-constructor-imports)');
  // The test import policy applies to application tests, not to e2e adapters.
  expect(codesFor(applicationTest)).toContain('eslint(no-restricted-imports)');
  expect(codesFor(e2eTest)).not.toContain('eslint(no-restricted-imports)');
});

it('production route filename override admits exact native splat filenames and keeps nearby rejections', () => {
  // The shared run also lints files outside the route set, so the filename diagnostics are
  // selected from the staged routes rather than from the whole report.
  const named = run.diagnostics
    .filter(({ code, filename }) => code === 'github(filenames-match-regex)' && routes.includes(filename))
    .map(({ filename }) => filename)
    .toSorted();
  expect(named).toEqual(invalidRoutes.toSorted());
});

it('production SonarJS configuration accepts Match.tags and discriminator keys that mirror domain vocabulary', () => {
  const sonarCodes = codesFor(handlers).filter((code) => code.startsWith('sonarjs('));
  expect(sonarCodes, 'the SonarJS plugin must run on the fixture').toContain('sonarjs(no-all-duplicated-branches)');
  expect(sonarCodes, 'domain-vocabulary keys are not function names').not.toContain('sonarjs(function-name)');
});

it('production rejects overwritten assignments without rejecting observed values', () => {
  expect(codesFor(discardedAssignment)).toContain('eslint(no-useless-assignment)');
  expect(codesFor(observedValues)).not.toContain('eslint(no-useless-assignment)');
});
