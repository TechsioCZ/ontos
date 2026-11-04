import { expect, it } from 'effect-rstest';

import { runProductionOxlint } from './production-oxlint.mts';

// End-to-end checks of the production configuration through the Oxlint binary: the plugins load,
// the configuration enables their rules, and its path overrides apply. Rule behaviour itself is
// covered in-process by the RuleTester suites.

const codesFor = (run: ReturnType<typeof runProductionOxlint>, file: string): readonly string[] =>
  run.diagnostics.filter(({ filename }) => filename === file).map(({ code }) => code);

const constructorFactory = [
  'interface CustomerSchemaDependency {',
  '  readonly read: () => number;',
  '}',
  '',
  'export const makeCustomerSchema = (dependency: CustomerSchemaDependency) => dependency;',
  '',
].join('\n');
const constructorConsumer = "import { makeCustomerSchema } from './factory.ts';\n\nvoid makeCustomerSchema;\n";
const restrictedImportDiagnostic = 'eslint(no-restricted-imports)';
const retiredConstructorDiagnostic = 'anti-slop-effect(no-service-constructor-imports)';
const nodeTestImport = "import { test } from 'node:test';\ntest('example', () => {});\n";

it('production configuration loads every repository plugin and scopes its overrides by path', () => {
  const source = 'apps/demo/src/check.ts';
  const serviceConsumer = 'apps/demo/src/services/consumer.ts';
  const testingConsumer = 'packages/core-runtime/src/testing/consumer.ts';
  const applicationTest = 'apps/demo/tests/y.test.ts';
  const e2eTest = 'apps/demo/tests/e2e/y.test.ts';
  const run = runProductionOxlint({
    [applicationTest]: nodeTestImport,
    'apps/demo/src/services/factory.ts': constructorFactory,
    [e2eTest]: nodeTestImport,
    'packages/core-runtime/src/testing/factory.ts': constructorFactory,
    [serviceConsumer]: constructorConsumer,
    [source]: 'export const check = (value: unknown) => value instanceof Error;\n',
    [testingConsumer]: constructorConsumer,
  });
  expect(run.numberOfFiles).toBe(7);
  expect(run.exitCode).toBe(1);
  // effect-native and anti-slop rules from the base configuration.
  expect(codesFor(run, source)).toContain('effect-native(no-instanceof)');
  expect(codesFor(run, source)).toContain('anti-slop(no-unknown-parameters)');
  // Constructor imports are legal. Effect requirements and explicit owner-boundary checks govern composition.
  expect(codesFor(run, serviceConsumer)).not.toContain(retiredConstructorDiagnostic);
  expect(codesFor(run, testingConsumer)).not.toContain(retiredConstructorDiagnostic);
  // The test import policy applies to application tests, not to e2e adapters.
  expect(codesFor(run, applicationTest)).toContain(restrictedImportDiagnostic);
  expect(codesFor(run, e2eTest)).not.toContain(restrictedImportDiagnostic);
});

it('production route filename override admits exact native splat filenames and keeps nearby rejections', () => {
  const valid = [
    'apps/shell-super-app/src/routes/[lang]/$.tsx',
    'apps/shell-super-app/src/routes/[lang]/$.data.ts',
    'apps/shell-super-app/src/routes/[lang]/$.data.client.ts',
    'apps/shell-super-app/src/routes/[lang]/modules/[moduleId]/page.data.client.ts',
  ];
  const invalid = [
    'apps/shell-super-app/src/routes/[lang]/$rogue.tsx',
    'apps/shell-super-app/src/routes/[lang]/$.custom.ts',
    'apps/shell-super-app/src/routes/[lang]/page.data.custom.ts',
    'apps/another-owner/src/routes/[lang]/$.tsx',
  ];
  const run = runProductionOxlint(
    Object.fromEntries([...valid, ...invalid].map((file) => [file, 'export const value = 1;\n'])),
  );
  expect(run.numberOfFiles).toBe(valid.length + invalid.length);
  const named = run.diagnostics
    .filter(({ code }) => code === 'github(filenames-match-regex)')
    .map(({ filename }) => filename)
    .toSorted();
  expect(named).toEqual(invalid.toSorted());
});

// Property keys that name domain vocabulary must not be read as function names.
it('production SonarJS configuration accepts Match.tags and discriminator keys that mirror domain vocabulary', () => {
  const source = 'apps/demo/src/handlers.ts';
  const run = runProductionOxlint({
    [source]: [
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
    ].join('\n'),
  });
  const sonarCodes = codesFor(run, source).filter((code) => code.startsWith('sonarjs('));
  expect(sonarCodes, 'the SonarJS plugin must run on the fixture').toContain('sonarjs(no-all-duplicated-branches)');
  expect(sonarCodes, 'domain-vocabulary keys are not function names').not.toContain('sonarjs(function-name)');
});

// This is a wire-contract choice, not evidence of an untyped API or an invalid domain model.
it('production lint accepts nullable wire schemas without prescribing a domain representation', () => {
  const file = 'verticals/demo/shared/domain/parent.ts';
  const run = runProductionOxlint({
    [file]: "import { Schema } from 'effect';\nexport const ParentSchema = Schema.NullOr(Schema.String);\n",
  });
  expect(codesFor(run, file)).not.toContain('effect-native(no-nullable-schema-field)');
});

it('test runner restrictions compose with the accessible select wrapper policy', () => {
  const files = [
    'apps/demo/tests/example.test.ts',
    'verticals/demo/tests/example.test.ts',
    'packages/demo/tests/example.test.ts',
  ];
  const source = `${nodeTestImport}import { SelectTemplate } from '@techsio/ui-kit/templates/select';\nvoid SelectTemplate;\n`;
  const script = 'scripts/ui.test.mts';
  const wrapper = 'packages/admin-ui/src/select-template.tsx';
  const run = runProductionOxlint({
    ...Object.fromEntries(files.map((file) => [file, source])),
    [script]: source,
    [wrapper]: "import { SelectTemplate } from '@techsio/ui-kit/templates/select';\nvoid SelectTemplate;\n",
  });
  for (const file of files) {
    expect(codesFor(run, file).filter((code) => code === restrictedImportDiagnostic)).toHaveLength(2);
  }
  expect(codesFor(run, script).filter((code) => code === restrictedImportDiagnostic)).toHaveLength(1);
  expect(codesFor(run, wrapper)).not.toContain(restrictedImportDiagnostic);
});
