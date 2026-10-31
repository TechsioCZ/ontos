import { mkdirSync, writeFileSync } from 'node:fs';
import nodePath from 'node:path';

import { expect, it } from 'effect-rstest';

import { appRoot, runOxlint, testsDirectory } from './oxlint.mts';
import { withTemporaryWorkspace } from './temporary-workspace.mts';
import { provesDataFactoryImport } from '../../anti-slop/effect/rules/data-factory-proof.ts';

const bootstrapFilename = 'bootstrap.ts';
const factoryFilename = 'factory.ts';
const supportDirectory = 'tests/support';
const consumerFilename = 'consumer.ts';
const factorySource = './factory.ts';
const dataFactoryConsumer = "import { makeData } from './factory.ts'; void makeData;";
const lintConfig = nodePath.join(appRoot, 'oxlint.config.ts');

const ruleCode = 'anti-slop-effect(no-service-constructor-imports)';

it('allows service constructor calls only within proven native service factory callbacks', () => {
  withTemporaryWorkspace((directory) => {
    const factory = nodePath.join(directory, factoryFilename);
    const consumer = nodePath.join(directory, consumerFilename);
    writeFileSync(factory, 'export const makeCustomerSchema = (value: string) => ({ read: () => value });');
    const nativeImport = "import type { ActionServiceFactory as NativeFactory } from '@app/core-runtime';";
    const constructorImport = "import { makeCustomerSchema } from './factory.ts';";
    for (const declaration of [
      `${nativeImport} ${constructorImport} const serviceFactory: NativeFactory<unknown, unknown> = (context, scope, revision) => makeCustomerSchema(revision);`,
      `${constructorImport} import { defineRead as nativeRead } from '@app/core-runtime'; nativeRead({}, (input) => input, (context, scope, revision) => makeCustomerSchema(revision), {});`,
      `${nativeImport} ${constructorImport} import { Effect as E } from 'effect'; const serviceFactory: NativeFactory<unknown, unknown> = E.fn('service')(function* (context, scope, revision) { return makeCustomerSchema(revision); });`,
    ]) {
      writeFileSync(consumer, declaration);
      expect(
        runOxlint(lintConfig, [consumer], appRoot).diagnostics.filter(({ code }) => code === ruleCode),
        declaration,
      ).toEqual([]);
    }
    for (const declaration of [
      `${constructorImport} type NativeFactory = (context: unknown) => unknown; const serviceFactory: NativeFactory = (context) => makeCustomerSchema('revision');`,
      `${constructorImport} import { defineRead } from '@app/core-runtime'; defineRead({}, (input) => makeCustomerSchema('revision'), (context, scope, revision) => ({ value: revision }), {});`,
      `${constructorImport} import { defineRead } from 'foreign-runtime'; defineRead({}, (input) => input, (context, scope, revision) => makeCustomerSchema(revision), {});`,
      `${nativeImport} ${constructorImport} const outside = makeCustomerSchema('revision'); const serviceFactory: NativeFactory<unknown, unknown> = (context, scope, revision) => outside;`,
      `${nativeImport} ${constructorImport} const serviceFactory: NativeFactory<unknown, unknown> = (context, scope, revision) => makeCustomerSchema;`,
      `${nativeImport} ${constructorImport} const wrap = (callback: unknown) => callback; const serviceFactory: NativeFactory<unknown, unknown> = wrap((context, scope, revision) => makeCustomerSchema(revision));`,
    ]) {
      writeFileSync(consumer, declaration);
      expect(
        runOxlint(lintConfig, [consumer], appRoot).diagnostics.filter(({ code }) => code === ruleCode).length,
        declaration,
      ).toBe(1);
    }
  }, testsDirectory);
});

it('accepts reference factories beside native domain contracts but rejects executable initializers', () => {
  withTemporaryWorkspace((directory) => {
    const factory = nodePath.join(directory, factoryFilename);
    const consumer = nodePath.join(directory, consumerFilename);
    writeFileSync(consumer, dataFactoryConsumer);
    const declarations = [
      [
        'import { Schema, Effect } from "effect"; const codec = Schema.OptionFromNullOr(Effect.runSync(Effect.succeed(Schema.Trim))); export const makeData = (id: string) => ({ id });',
        false,
      ],
      [
        'import { Schema } from "effect"; const revision = Schema.Finite.check(Schema.isGreaterThan(0)); export const makeData = (id: string) => ({ id });',
        true,
      ],
      [
        'import { Brand as B, Schema } from "effect"; const brand = B.nominal<string>(); const error = Schema.TaggedStruct("Error", { message: Schema.Trim }); const party = Schema.Struct({ name: Schema.OptionFromNullOr(Schema.Trim), revision: Schema.Finite.check(Schema.isGreaterThan(0)) }); export const makeData = (id: string) => ({ id });',
        true,
      ],
      [
        'const Brand = { nominal: () => fetch("initializer") }; const brand = Brand.nominal(); export const makeData = (id: string) => ({ id });',
        false,
      ],
      [
        'import { Brand, Effect } from "effect"; const brand = Brand.nominal(Effect.runSync(Effect.succeed("initializer"))); export const makeData = (id: string) => ({ id });',
        false,
      ],
    ] as const;
    for (const [declaration, expected] of declarations) {
      writeFileSync(factory, declaration);
      expect(provesDataFactoryImport(consumer, factorySource, 'makeData'), declaration).toBe(expected);
    }
  }, testsDirectory);
});

it('requires locally defined immutable constructors rather than imported declaration aliases', () => {
  withTemporaryWorkspace((directory) => {
    const owner = nodePath.join(directory, 'app/verticals/local-owner');
    const api = nodePath.join(owner, 'api');
    const support = nodePath.join(owner, supportDirectory);
    mkdirSync(api, { recursive: true });
    mkdirSync(support, { recursive: true });
    const factory = nodePath.join(api, factoryFilename);
    const consumer = nodePath.join(support, bootstrapFilename);
    writeFileSync(
      consumer,
      "import { NodeRuntime } from '@effect/platform-node'; import { Effect } from 'effect'; import { makeService } from '../../api/factory.ts'; void makeService; NodeRuntime.runMain(Effect.void);",
    );
    const dependency = '{ readonly read: () => string }';
    for (const declaration of [
      `export function makeService(dependency: ${dependency}) { return dependency; }`,
      `export const makeService = (dependency: ${dependency}) => dependency;`,
      `import { Effect as E } from 'effect'; export const makeService = E.fn('service')(function* (dependency: ${dependency}) { return dependency; });`,
    ]) {
      writeFileSync(factory, declaration);
      expect(
        runOxlint(lintConfig, [consumer], appRoot).diagnostics.filter(({ code }) => code === ruleCode),
        declaration,
      ).toEqual([]);
    }
    for (const declaration of [
      "import { makeService as foreign } from '../../../foreign/api/service.ts'; export const makeService = foreign;",
      "import * as foreign from '../../../foreign/api/service.ts'; export const makeService = foreign.makeService;",
      `export let makeService = (dependency: ${dependency}) => dependency;`,
      `export function makeService(dependency: ${dependency}) { return dependency; } makeService = foreign;`,
      `const E = { fn: () => (value: unknown) => value }; export const makeService = E.fn('service')(function* () {});`,
      `import { Effect } from 'effect'; import { Effect as Other } from 'effect'; Other.fn = foreign; export const makeService = Effect.fn('service')(function* () {});`,
      `import { Effect } from 'effect'; const alias = Effect; alias.fn = foreign; export const makeService = Effect.fn('service')(function* () {});`,
    ]) {
      writeFileSync(factory, declaration);
      expect(
        runOxlint(lintConfig, [consumer], appRoot).diagnostics.filter(({ code }) => code === ruleCode).length,
        declaration,
      ).toBe(1);
    }
  }, testsDirectory);
});

it('keeps scoped Effect-valued acquisitions inside the genuine native factory construction boundary', () => {
  withTemporaryWorkspace((directory) => {
    const ownerDirectory = nodePath.join(directory, 'verticals', 'module');
    mkdirSync(ownerDirectory, { recursive: true });
    const consumer = nodePath.join(ownerDirectory, consumerFilename);
    writeFileSync(
      nodePath.join(ownerDirectory, factoryFilename),
      "import { Effect } from 'effect';\n" +
        'export const makeScopedService = Effect.gen(function* () { return { verify: Effect.void }; });',
    );
    const imports = [
      "import type { ReadServiceFactory } from '@app/core-runtime';",
      "import { Context, Effect } from 'effect';",
      "import { makeScopedService } from './factory.ts';",
      "class Owner extends Context.Service<Owner, {}>()('Owner') {}",
    ].join('\n');
    const acquisition =
      'const verification = yield* makeScopedService.pipe(Effect.provideService(Owner, {})); return verification;';
    const native = (body: string) =>
      `${imports}\nconst makeOwner: ReadServiceFactory<{}> = Effect.fn('owner')(function* (transaction, scope, revision) { ${body} });`;
    const diagnostics = (source: string) => {
      writeFileSync(consumer, source);
      return runOxlint(lintConfig, [consumer], appRoot)
        .diagnostics.filter(({ code }) => [ruleCode, 'effect-native(no-effect-provide-in-library)'].includes(code))
        .map(({ code }) => code)
        .toSorted();
    };
    const rejected = [ruleCode, 'effect-native(no-effect-provide-in-library)'].toSorted();

    expect(diagnostics(native(acquisition))).toEqual([]);
    expect(diagnostics(`${imports}\nconst program = Effect.gen(function* () { ${acquisition} });`)).toEqual(rejected);
    expect(diagnostics(native(acquisition).replace("'@app/core-runtime'", "'./lookalike.ts'"))).toEqual(rejected);
    expect(diagnostics(native(`return { run: () => Effect.gen(function* () { ${acquisition} }) };`))).toEqual(rejected);
    expect(
      diagnostics(
        native(
          'const verification = makeScopedService.pipe(Effect.provideService(Owner, {})); return yield* verification;',
        ),
      ),
    ).toEqual(rejected);
    expect(diagnostics(native(acquisition.replace('const verification', 'let verification')))).toEqual(rejected);
    expect(diagnostics(`${native(acquisition)}\nvoid makeScopedService;`)).toEqual([ruleCode]);
  });
});
