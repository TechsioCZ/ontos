import { mkdirSync, writeFileSync } from 'node:fs';
import nodePath from 'node:path';

import { expect, it } from 'effect-rstest';

import { appRoot, runOxlint, testsDirectory } from './oxlint.mts';
import type { LintRun } from './oxlint.mts';
import { withTemporaryWorkspace } from './temporary-workspace.mts';
import { provesDataFactoryImport } from '../../anti-slop/effect/rules/data-factory-proof.ts';

const consumerSuffix = '/consumer.ts';
const factoryFilename = 'factory.ts';
const consumerFilename = 'consumer.ts';
const factorySource = './factory.ts';
const schemaImport = "import { Schema } from 'effect';";
const dataFactoryConsumer = "import { makeData } from './factory.ts'; void makeData;";
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
    const factory = nodePath.join(directory, factoryFilename);
    const consumer = nodePath.join(directory, consumerFilename);
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
        '  readonly read: () => number;',
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
        '  const build = (tag: string) => ({ read: () => tag });',
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

it('accepts literal data factories while preserving dependency, executable, and effectful controls', () => {
  withTemporaryWorkspace((directory) => {
    const factory = nodePath.join(directory, factoryFilename);
    const consumer = nodePath.join(directory, consumerFilename);
    writeFileSync(
      consumer,
      [
        "import { makeCustomerSchema, makeCustomerSchema as makeAliasedSchema } from './factory.ts';",
        'void makeCustomerSchema;',
        'void makeAliasedSchema;',
      ].join('\n'),
    );
    for (const declaration of [
      'export const makeCustomerSchema = (tag: string) => ({ tag, entries: [], nested: { enabled: true } });',
      `export const makeCustomerSchema = (tag: string) => { const label = \`module:\${tag}\`; return { label }; };`,
      'export const makeCustomerSchema = () => [{ label: "module" }];',
    ]) {
      writeFileSync(factory, declaration);
      const run = runOxlint(lintConfig, [consumer], appRoot);
      expect(
        run.diagnostics.filter(({ code }) => code === ruleCode),
        declaration,
      ).toEqual([]);
    }
    for (const declaration of [
      'type Dependency = { readonly read: () => string }; export const makeCustomerSchema = (dependency: Dependency) => ({ dependency });',
      'export const makeCustomerSchema = (tag: string) => ({ read: () => tag });',
      'export const makeCustomerSchema = (tag: string) => ({ get label() { return tag; } });',
      'export const makeCustomerSchema = (tag: string) => { const read = (value: string) => fetch(value); return { data: read(tag) }; };',
      'export const makeCustomerSchema = (tag: string) => ({ value: fetch(tag) });',
      'export const makeCustomerSchema = (tag: string) => { const value = fetch(tag); return { tag }; };',
      'export const makeCustomerSchema = (tag: string = fetch("dependency")) => ({ tag });',
      'export const makeCustomerSchema = (tag: string) => ({ [fetch(tag)]: true });',
    ]) {
      writeFileSync(factory, declaration);
      expectServiceReports(runOxlint(lintConfig, [consumer], appRoot), declaration);
    }
  }, testsDirectory);
});

it('proves closed DTO construction across imports and rejects executable reachable behavior', () => {
  withTemporaryWorkspace((directory) => {
    const factory = nodePath.join(directory, factoryFilename);
    const helper = nodePath.join(directory, 'helper.ts');
    const consumer = nodePath.join(directory, consumerFilename);
    const dto = 'interface Input { readonly id: string; readonly entries: readonly { readonly id: string }[]; }';
    writeFileSync(consumer, dataFactoryConsumer);
    writeFileSync(helper, `export const label = (value: string) => \`entry:\${value}\`;`);
    writeFileSync(
      factory,
      [
        "import { label } from './helper.ts';",
        dto,
        'export const makeData = ({ id, entries = [] }: Input) => ({ id, entries: entries.map(({ id }) => ({ label: label(id) })) });',
      ].join('\n'),
    );
    expect(provesDataFactoryImport(consumer, factorySource, 'makeData')).toBe(true);
    writeFileSync(helper, 'export const label = (value: string) => { fetch(value); return value; };');
    expect(provesDataFactoryImport(consumer, factorySource, 'makeData')).toBe(false);
    const controls = [
      'export const makeData = (value: { readonly read: () => string }) => ({ value });',
      'export const makeData = (value: { readonly id: string }) => value;',
      'export const makeData = (value: { readonly id: string }) => ({ ...value });',
      'export const makeData = (value: { readonly id: string }) => Object.values(value);',
      'export const makeData = (value: { readonly id: string }, enabled: boolean) => enabled ? value : null;',
      'export const makeData = (value: { readonly id: string } | null) => value;',
      'interface Dependency { readonly read: () => string } interface Input extends Dependency { readonly label: string } export const makeData = (value: Input) => value;',
      'export const makeData = (value: unknown = {}) => ({ value });',
      'export const makeData = (mode: string = "safe") => mode === "safe" ? { value: "data" } : { read: () => mode };',
      'export const makeData = (mode: "safe" | "danger" = "safe") => mode === "safe" ? { value: "data" } : { read: () => mode };',
      'type Readonly<Value> = { readonly read: () => string }; export const makeData = (value: Readonly<string>) => value;',
      'interface Input { readonly read: () => string } type Keys = "read"; export const makeData = (value: Pick<Input, Keys>) => value;',
      'import { Effect, Schema } from "effect"; const getSchema = () => { Effect.runSync(Effect.succeed("effect")); return Schema.String; }; const seeded = Schema.decodeUnknownSync(getSchema())("x"); export const makeData = () => ({ id: "data" });',
      'import { Schema } from "effect"; const codec = Schema.fromJsonString(Schema.String, { reviver: () => fetch("service") }); const decode = Schema.decodeUnknownSync(codec); export const makeData = (value: string) => decode(value);',
      'import { Schema } from "effect"; const codec = Schema.String.pipe(Schema.decodeTo(Schema.String, { decode: () => fetch("service") })); const decode = Schema.decodeUnknownSync(codec); export const makeData = (value: string) => decode(value);',
      'import { Schema } from "effect"; const unknownSchema = Schema.Unknown; type Input = typeof unknownSchema.Type; export const makeData = (value: Input) => value;',
      'export const makeData = () => [() => fetch("service")].slice();',
      'import { Effect, Order } from "effect"; const compare = Order.Struct({ id: (a: string, b: string) => Effect.runSync(Effect.succeed(a)) }); export const makeData = (values: readonly { readonly id: string }[]) => values.toSorted(compare);',
      'import { Effect } from "effect"; const literal = () => "data"; export const makeData = () => literal(Effect.runSync(Effect.succeed("effect")));',
      'import { Effect } from "effect"; export const makeData = () => [].toSorted(Effect.runSync(Effect.succeed(() => 0)));',
      'import { Effect } from "effect"; export const makeData = () => ({ ...{ value: Effect.runSync(Effect.succeed("effect")) }, value: "data" });',
      'import { Effect } from "effect"; export const makeData = () => ({ ignored: Effect.runSync(Effect.succeed("effect")), value: "data" }).value;',
      'import { Effect } from "effect"; export const makeData = () => [Effect.runSync(Effect.succeed("effect"))].length;',
      'import { Effect } from "effect"; export const makeData = () => (("1" as unknown) == 1 ? Effect.runSync(Effect.succeed("effect")) : "data");',
      'import { Effect } from "effect"; const recurse = (value: string): string => value === "safe" ? recurse("danger") : Effect.runSync(Effect.succeed("effect")); export const makeData = () => recurse("safe");',
      'import { Effect } from "effect"; const recurse = (mode: string, values: readonly string[]): string => values.map((value: string) => mode === "safe" ? recurse("danger", values) : Effect.runSync(Effect.succeed("effect")))[0]!; export const makeData = (values: readonly string[]) => recurse("safe", values);',
      'import { Effect } from "effect"; const initialized = Effect.runSync(Effect.succeed("side effect")); export const makeData = () => ({ id: "data" });',
      'class Initialized { static value = fetch("module-initializer"); } export const makeData = () => ({ id: "data" });',
      'export const makeData = <Value extends object>(value: Value) => ({ value });',
      'export const makeData = (value: string) => ({ read: () => value });',
      'export const makeData = (value: string) => ({ get id() { return value; } });',
      'export const makeData = (value: string = fetch("dependency")) => ({ value });',
      'export const makeData = (value: readonly string[]) => value.toSorted((a, b) => { fetch(a); return a.localeCompare(b); });',
      'export const makeData = (value: readonly string[]) => { value.push("changed"); return value; };',
      'const Object = { freeze: (value: string) => fetch(value) }; export const makeData = (value: string) => Object.freeze(value);',
      'import { Effect } from "effect"; export const makeData = (value: string) => Effect.succeed(value);',
      'import { Schema } from "effect"; const unsafe = Schema.String.check(Schema.makeFilter((value) => { fetch(value); return undefined; })); const decode = Schema.decodeUnknownSync(unsafe); export const makeData = (value: string) => ({ value: decode(value) });',
      'import { label } from "./helper.ts"; export const makeData = (value: string) => ({ value: label(value) });',
      'fetch("module-initializer"); export const makeData = (value: string) => ({ value });',
    ];
    for (const control of controls) {
      writeFileSync(factory, control);
      expect(provesDataFactoryImport(consumer, factorySource, 'makeData'), control).toBe(false);
    }
  }, testsDirectory);
});

it('proves native array predicates in DTO codecs without admitting executable callbacks', () => {
  withTemporaryWorkspace((directory) => {
    const factory = nodePath.join(directory, factoryFilename);
    const consumer = nodePath.join(directory, consumerFilename);
    writeFileSync(consumer, dataFactoryConsumer);
    const dataFactories = [
      'export const makeData = (values: readonly string[]) => ({ found: values.some((value, index, all) => value === "reserved" || index === all.length) });',
      'export const makeData = (values: readonly string[]) => ({ found: values.some((value) => value) });',
      'import { Schema } from "effect"; const codec = Schema.String.check(Schema.makeFilter((value) => { const names = value.split("/"); return names.some((name) => name === "constructor") || new Set(names).size !== names.length ? "reserved" : undefined; })); const decode = Schema.decodeUnknownSync(codec); export const makeData = (value: string) => ({ value: decode(value) });',
    ];
    for (const declaration of dataFactories) {
      writeFileSync(factory, declaration);
      expect(provesDataFactoryImport(consumer, factorySource, 'makeData'), declaration).toBe(true);
    }
    const controls = [
      'export const makeData = (values: readonly string[]) => values.some((value) => { fetch(value); return false; });',
      'import { Effect } from "effect"; export const makeData = (values: readonly string[]) => values.some((value) => Effect.runSync(Effect.succeed(value)));',
      'export const makeData = (values: readonly (() => string)[]) => values.some((value) => value() === "reserved");',
      'export const makeData = () => [() => fetch("service")].some(() => false);',
      'export const makeData = (value: string) => value.some(() => true);',
      'export const makeData = (values: readonly { readonly id: string }[]) => values.some((value) => value);',
      'export const makeData = (values: readonly string[]) => values.some(() => true, fetch("service"));',
    ];
    for (const declaration of controls) {
      writeFileSync(factory, declaration);
      expect(provesDataFactoryImport(consumer, factorySource, 'makeData'), declaration).toBe(false);
    }
  }, testsDirectory);
});

it('proves native UUID and URL codecs with closed array bindings and rejects executable alternatives', () => {
  withTemporaryWorkspace((directory) => {
    const factory = nodePath.join(directory, factoryFilename);
    const consumer = nodePath.join(directory, consumerFilename);
    writeFileSync(consumer, dataFactoryConsumer);
    const dataFactories = [
      'import { Schema } from "effect"; const decode = Schema.decodeUnknownSync(Schema.String.check(Schema.isUUID())); export const makeData = (value: string) => ({ id: decode(value) });',
      'export const makeData = (value: string) => { const [name, , provider, suffix] = value.split("."); return { name, provider, suffix }; };',
      'export const makeData = (value: string) => { const url = URL.parse(value); if (url === null) return { port: "" }; const [name, subdomain, provider, suffix, extra] = url.hostname.split("."); return { name, subdomain, provider, suffix, extra, port: url.port }; };',
      'import { Schema } from "effect"; const codec = Schema.Struct({ id: Schema.String.check(Schema.isUUID()), origin: Schema.String.check(Schema.makeFilter((value) => { const url = URL.parse(value); if (url === null) return "invalid"; const [name, subdomain] = url.hostname.split("."); return url.port === "" && name !== undefined && subdomain !== undefined ? undefined : "invalid"; })) }); const decode = Schema.decodeUnknownSync(codec); export const makeData = (value: { readonly id: string; readonly origin: string }) => ({ value: decode(value) });',
    ];
    for (const declaration of dataFactories) {
      writeFileSync(factory, declaration);
      expect(provesDataFactoryImport(consumer, factorySource, 'makeData'), declaration).toBe(true);
    }
    const controls = [
      'import { Effect, Schema } from "effect"; const codec = Schema.String.check(Schema.isUUID(Effect.runSync(Effect.succeed({})))); const decode = Schema.decodeUnknownSync(codec); export const makeData = (value: string) => ({ value: decode(value) });',
      'import { Schema } from "effect"; const codec = Schema.String.check(Schema.isUUID()).check(Schema.makeFilter((value) => { fetch(value); return undefined; })); const decode = Schema.decodeUnknownSync(codec); export const makeData = (value: string) => ({ value: decode(value) });',
      'const Schema = { isUUID: () => fetch("service") }; export const makeData = () => ({ value: Schema.isUUID() });',
      'export const makeData = () => { const [read] = [() => fetch("service")]; return { read }; };',
      'export const makeData = (value: string) => { const [name = fetch("service")] = value.split("."); return { name }; };',
      'export const makeData = (value: string) => { const [name = () => fetch("service")] = value.split("."); return { name }; };',
      'export const makeData = (value: readonly { readonly name: string }[]) => { const [entry] = value; return entry; };',
      'export const makeData = (value: { readonly name: string }) => { const [name] = value; return { name }; };',
      'const URL = { parse: (value: string) => { fetch(value); return { port: "" }; } }; export const makeData = (value: string) => ({ port: URL.parse(value).port });',
      'export const makeData = (value: string) => { const url = URL.parse(fetch(value)); return { port: url.port }; };',
      'import { Schema } from "foreign-runtime"; const decode = Schema.decodeUnknownSync(Schema.String.check(Schema.isUUID())); export const makeData = (value: string) => ({ value: decode(value) });',
    ];
    for (const declaration of controls) {
      writeFileSync(factory, declaration);
      expect(provesDataFactoryImport(consumer, factorySource, 'makeData'), declaration).toBe(false);
    }
  }, testsDirectory);
});

it('requires concrete data calls for opaque generic payloads', () => {
  withTemporaryWorkspace((directory) => {
    const factory = nodePath.join(directory, factoryFilename);
    const consumer = nodePath.join(directory, consumerFilename);
    writeFileSync(
      factory,
      'export const makePayload = <Value extends object>({ id, entries }: { readonly id: string; readonly entries: readonly Value[] }) => ({ id, entries });',
    );
    const declaration = [
      "import { makePayload } from './factory.ts';",
      'interface Input { readonly id: string; readonly entries: readonly { readonly label: string }[]; }',
      'export const makeEnvelope = (input: Input) => makePayload({ id: input.id, entries: input.entries.map(({ label }) => ({ label })) });',
    ].join('\n');
    writeFileSync(consumer, declaration);
    expect(provesDataFactoryImport(consumer, factorySource, 'makePayload')).toBe(true);
    writeFileSync(consumer, declaration.replace('readonly label: string', 'readonly label: () => string'));
    expect(provesDataFactoryImport(consumer, factorySource, 'makePayload')).toBe(false);
    writeFileSync(consumer, `${declaration}\nconst escaped = makePayload;`);
    expect(provesDataFactoryImport(consumer, factorySource, 'makePayload')).toBe(false);
    writeFileSync(factory, 'export const makePayload = (value: { readonly id: string }) => ({ ...value });');
    writeFileSync(
      consumer,
      'import { makePayload } from "./factory.ts"; export const makeEnvelope = () => makePayload({ id: "data" });',
    );
    expect(provesDataFactoryImport(consumer, factorySource, 'makePayload')).toBe(true);
    writeFileSync(
      consumer,
      'import { makePayload } from "./factory.ts"; export const makeEnvelope = () => makePayload({ id: "data", read: () => fetch("service") });',
    );
    expect(provesDataFactoryImport(consumer, factorySource, 'makePayload')).toBe(false);
  }, testsDirectory);
});

it('rejects typed effectful schema helpers and shadowed native assignments', () => {
  withTemporaryWorkspace((directory) => {
    const factory = nodePath.join(directory, factoryFilename);
    const consumer = nodePath.join(directory, consumerFilename);
    writeFileSync(
      consumer,
      "import { makeCustomerSchema, makeCustomerSchema as makeAliasedSchema } from './factory.ts'; void makeCustomerSchema; void makeAliasedSchema;",
    );
    for (const declaration of [
      'import { Schema } from "effect"; const poisoned = (value: string) => { fetch(value); return Schema.String; }; export const makeCustomerSchema = (tag: string) => Schema.Struct({ value: poisoned(tag) });',
      'import { Schema } from "effect"; const Object = { assign: (value: string) => fetch(value) }; export const makeCustomerSchema = (tag: string) => Schema.Struct({ value: Object.assign(tag) });',
    ]) {
      writeFileSync(factory, declaration);
      expectServiceReports(runOxlint(lintConfig, [consumer], appRoot), declaration);
    }
  }, testsDirectory);
});

it('proves the concrete Outbox fixture imports without an ownership or name exemption', () => {
  const support = nodePath.join(appRoot, 'packages/core-runtime/tests/support/outbox-worker-composition.ts');
  const processFixture = nodePath.join(
    appRoot,
    'packages/core-runtime/tests/fixtures/outbox-worker-process.fixture.ts',
  );
  expect(provesDataFactoryImport(support, '../../src/testing/module-contract.ts', 'makeModuleContractFixture')).toBe(
    true,
  );
  expect(
    provesDataFactoryImport(processFixture, '../support/outbox-worker-composition.ts', 'makeOutboxWorkerComposition'),
  ).toBe(true);
});

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
