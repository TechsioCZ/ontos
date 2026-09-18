import { mkdirSync, writeFileSync } from 'node:fs';
import nodePath from 'node:path';

import { expect, it } from 'effect-rstest';

import { appRoot, runOxlint, testsDirectory } from './oxlint.mts';
import type { LintRun } from './oxlint.mts';
import { withTemporaryWorkspace } from './temporary-workspace.mts';

const consumerSuffix = '/consumer.ts';
const schemaImport = "import { Schema } from 'effect';";
const lintConfig = nodePath.join(appRoot, 'oxlint.config.ts');

const ruleCode = 'anti-slop-effect(no-service-constructor-imports)';
const serviceConstructorMessage =
  'Do not import Effect service constructor "makeCustomerSchema" into runtime code. Import the owning Layer, yield the contextual service, and allow its requirements to propagate to the composition root.';

const expectServiceReports = (run: LintRun, description: string): void => {
  expect(
    run.diagnostics
      .filter(({ code, filename }) => code === ruleCode && filename.endsWith(consumerSuffix))
      .map(({ message }) => message),
    description,
  ).toEqual([serviceConstructorMessage, serviceConstructorMessage]);
};

it('proves schema factory implementations and rejects the same export after it gains a dependency', () => {
  withTemporaryWorkspace((directory) => {
    const factory = nodePath.join(directory, 'factory.ts');
    const consumer = nodePath.join(directory, 'consumer.ts');
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      factory,
      [
        schemaImport,
        '',
        'export const makeCustomerSchema = (tag: string) => Schema.Struct({',
        '  tag: Schema.Literal(tag),',
        '});',
        '',
      ].join('\n'),
    );
    writeFileSync(
      consumer,
      [
        "import { makeCustomerSchema, makeCustomerSchema as makeAliasedSchema } from './factory.ts';",
        '',
        'void makeCustomerSchema;',
        'void makeAliasedSchema;',
        '',
      ].join('\n'),
    );

    const validRun = runOxlint(lintConfig, [consumer], appRoot);
    const validDiagnostics = validRun.diagnostics.filter(({ code }) => code === ruleCode);

    expect(
      validDiagnostics.filter(({ filename }) => filename.endsWith(consumerSuffix)),
      'a direct and aliased import of a proven schema factory must be accepted',
    ).toEqual([]);

    writeFileSync(
      factory,
      [
        'interface CustomerSchemaDependency {',
        '  readonly value: number;',
        '}',
        '',
        'export const makeCustomerSchema = (dependency: CustomerSchemaDependency) => dependency;',
        '',
      ].join('\n'),
    );

    const invalidRun = runOxlint(lintConfig, [consumer], appRoot);
    expectServiceReports(
      invalidRun,
      'changing the same export to a dependency-bearing constructor must restore both diagnostics',
    );

    writeFileSync(
      factory,
      [
        schemaImport,
        '',
        'const toService = () => ({ live: true });',
        'export const makeCustomerSchema = (tag: string) => Schema.Struct({}).pipe(toService);',
        '',
      ].join('\n'),
    );
    const pipeRun = runOxlint(lintConfig, [consumer], appRoot);
    expectServiceReports(
      pipeRun,
      'an arbitrary local function passed to Schema.pipe must remain a service constructor diagnostic',
    );

    writeFileSync(
      factory,
      [
        "import { HttpApiSchema } from '@modern-js/bff-effect/effect-client';",
        schemaImport,
        '',
        "const schemaRepresentation = HttpApiSchema.asJson({ contentType: 'application/problem+json' });",
        'export const makeCustomerSchema = () => Schema.Struct({}).pipe(schemaRepresentation);',
        '',
      ].join('\n'),
    );
    const pipeAliasRun = runOxlint(lintConfig, [consumer], appRoot);
    const pipeAliasDiagnostics = pipeAliasRun.diagnostics.filter(({ code }) => code === ruleCode);
    expect(
      pipeAliasDiagnostics.filter(({ filename }) => filename.endsWith(consumerSuffix)),
      'an immutable alias of the pure HttpApiSchema JSON annotation must be accepted by Schema.pipe',
    ).toEqual([]);

    writeFileSync(
      factory,
      [
        schemaImport,
        '',
        'const createTransform = (tag: string) => () => ({ live: true });',
        "const toService = createTransform('customer');",
        'export const makeCustomerSchema = () => Schema.Struct({}).pipe(toService);',
        '',
      ].join('\n'),
    );
    const pipeAliasInvalidRun = runOxlint(lintConfig, [consumer], appRoot);
    expectServiceReports(
      pipeAliasInvalidRun,
      'an alias initialized through a local service-producing transform must remain rejected by Schema.pipe',
    );

    writeFileSync(
      factory,
      [
        schemaImport,
        '',
        'const build = (tag: string) => Schema.Struct({});',
        'export const makeCustomerSchema = (tag: string) => {',
        '  const build = (tag: string) => ({ live: true });',
        '  return build(tag);',
        '};',
        '',
      ].join('\n'),
    );
    const shadowRun = runOxlint(lintConfig, [consumer], appRoot);
    expectServiceReports(shadowRun, 'a function-local shadow must not resolve to a top-level schema helper');

    writeFileSync(
      factory,
      [
        schemaImport,
        '',
        'export let makeCustomerSchema = (tag: string) => Schema.Struct({});',
        'makeCustomerSchema = () => ({ live: true });',
        '',
      ].join('\n'),
    );
    const mutationRun = runOxlint(lintConfig, [consumer], appRoot);
    expectServiceReports(mutationRun, 'a mutable exported binding and executable reassignment must fail closed');

    writeFileSync(
      nodePath.join(directory, 'service-types.ts'),
      [
        'export declare namespace Schema {',
        '  namespace Struct {',
        '    interface Fields {',
        '      readonly client: { readonly read: () => string };',
        '    }',
        '  }',
        '}',
        '',
      ].join('\n'),
    );
    writeFileSync(
      factory,
      [
        "import { Schema as S } from 'effect';",
        '',
        'export const makeCustomerSchema = <const Fields extends S.Struct.Fields>(',
        '  fields: Fields,',
        ') => S.Struct(fields);',
        '',
      ].join('\n'),
    );
    const genuineSchemaAliasRun = runOxlint(lintConfig, [consumer], appRoot);
    const genuineSchemaAliasDiagnostics = genuineSchemaAliasRun.diagnostics.filter(({ code }) => code === ruleCode);
    expect(
      genuineSchemaAliasDiagnostics.filter(({ filename }) => filename.endsWith(consumerSuffix)),
      'a generic schema factory using an aliased genuine Effect Schema import must be accepted',
    ).toEqual([]);

    writeFileSync(
      factory,
      [
        "import { Schema as S } from 'effect';",
        "import type { Schema } from './service-types.ts';",
        '',
        'export const makeCustomerSchema = <const Fields extends Schema.Struct.Fields>(',
        '  _fields: Fields,',
        ') => S.Struct({});',
        '',
      ].join('\n'),
    );
    const counterfeitSchemaAliasRun = runOxlint(lintConfig, [consumer], appRoot);
    expectServiceReports(
      counterfeitSchemaAliasRun,
      'a type-only counterfeit Schema.Struct.Fields root must not prove a schema factory',
    );
  }, testsDirectory);
});
