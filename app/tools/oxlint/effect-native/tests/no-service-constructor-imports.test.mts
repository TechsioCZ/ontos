import { mkdirSync, writeFileSync } from 'node:fs';
import nodePath from 'node:path';

import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { appRoot, runOxlint } from './oxlint.mts';
import type { LintRun } from './oxlint.mts';
import { withTemporaryWorkspace } from './temporary-workspace.mts';
import { provesDataFactoryImport } from '../../anti-slop/effect/rules/data-factory-proof.ts';

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
      .filter(({ code, filename }) => code === ruleCode && nodePath.basename(filename) === consumerFilename)
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

    const validRun = runOxlint(lintConfig, [consumer], directory);
    const validDiagnostics = validRun.diagnostics.filter(({ code }) => code === ruleCode);

    expect(
      validDiagnostics.filter(({ filename }) => nodePath.basename(filename) === consumerFilename),
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

    const invalidRun = runOxlint(lintConfig, [consumer], directory);
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
    const pipeRun = runOxlint(lintConfig, [consumer], directory);
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
    const pipeAliasRun = runOxlint(lintConfig, [consumer], directory);
    const pipeAliasDiagnostics = pipeAliasRun.diagnostics.filter(({ code }) => code === ruleCode);
    expect(
      pipeAliasDiagnostics.filter(({ filename }) => nodePath.basename(filename) === consumerFilename),
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
    const pipeAliasInvalidRun = runOxlint(lintConfig, [consumer], directory);
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
    const shadowRun = runOxlint(lintConfig, [consumer], directory);
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
    const mutationRun = runOxlint(lintConfig, [consumer], directory);
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
    const genuineSchemaAliasRun = runOxlint(lintConfig, [consumer], directory);
    const genuineSchemaAliasDiagnostics = genuineSchemaAliasRun.diagnostics.filter(({ code }) => code === ruleCode);
    expect(
      genuineSchemaAliasDiagnostics.filter(({ filename }) => nodePath.basename(filename) === consumerFilename),
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
    const counterfeitSchemaAliasRun = runOxlint(lintConfig, [consumer], directory);
    expectServiceReports(
      counterfeitSchemaAliasRun,
      'a type-only counterfeit Schema.Struct.Fields root must not prove a schema factory',
    );
  });
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
      const run = runOxlint(lintConfig, [consumer], directory);
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
      expectServiceReports(runOxlint(lintConfig, [consumer], directory), declaration);
    }
  });
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
  });
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
  });
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
  });
});

it('proves closed native set queries without admitting mutation or executable members', () => {
  withTemporaryWorkspace((directory) => {
    const factory = nodePath.join(directory, factoryFilename);
    const consumer = nodePath.join(directory, consumerFilename);
    writeFileSync(consumer, dataFactoryConsumer);
    for (const declaration of [
      'export const makeData = (value: string) => ({ reserved: new Set(["reserved"]).has(value) });',
      'export const makeData = (values: readonly string[], value: string) => { const names = new Set(values); return { found: names.has(value), size: names.size }; };',
      'export const makeData = () => ({ size: new Set().size });',
    ]) {
      writeFileSync(factory, declaration);
      expect(provesDataFactoryImport(consumer, factorySource, 'makeData'), declaration).toBe(true);
    }
    for (const declaration of [
      'export const makeData = (value: string) => new Set([value]);',
      'export const makeData = () => new Set([() => fetch("service")]).has("reserved");',
      'export const makeData = (values: readonly unknown[]) => new Set(values).size;',
      'export const makeData = (values: readonly { readonly id: string }[]) => new Set(values).has("reserved");',
      'export const makeData = () => new Set(["reserved"]).has(() => fetch("service"));',
      'export const makeData = (value: string) => { const names = new Set([value]); names.add("changed"); return { size: names.size }; };',
      'export const makeData = (value: string) => { const names = new Set([value]); names.delete(value); return { size: names.size }; };',
      'export const makeData = (value: string) => { const names = new Set([value]); names.clear(); return { size: names.size }; };',
      'const Set = class { has(value: string) { fetch(value); return true; } }; export const makeData = (value: string) => new Set().has(value);',
      'export const makeData = (Set: { readonly value: string }) => new Set().has("reserved");',
      'export const makeData = (value: string) => new Set([fetch(value)]).has(value);',
    ]) {
      writeFileSync(factory, declaration);
      expect(provesDataFactoryImport(consumer, factorySource, 'makeData'), declaration).toBe(false);
    }
  });
});

it('proves data-only string replacement without admitting replacement callbacks', () => {
  withTemporaryWorkspace((directory) => {
    const factory = nodePath.join(directory, factoryFilename);
    const consumer = nodePath.join(directory, consumerFilename);
    writeFileSync(consumer, dataFactoryConsumer);
    for (const declaration of [
      'export const makeData = (value: string) => ({ label: value.replace("old", "new") });',
      'export const makeData = (value: string) => ({ label: value.replace(/old/gu, "new") });',
      'export const makeData = (value: string) => ({ label: value.replaceAll(/old/gu, "new") });',
    ]) {
      writeFileSync(factory, declaration);
      expect(provesDataFactoryImport(consumer, factorySource, 'makeData'), declaration).toBe(true);
    }
    for (const declaration of [
      'export const makeData = (value: string) => value.replace(/old/gu, () => fetch(value));',
      'export const makeData = (value: string) => value.replaceAll("old", () => fetch(value));',
      'export const makeData = (value: string, replacement: unknown) => value.replace("old", replacement);',
      'export const makeData = (value: string) => value.replace("old", fetch(value));',
      'const source = { replace: (value: string) => fetch(value) }; export const makeData = (value: string) => source.replace(value);',
    ]) {
      writeFileSync(factory, declaration);
      expect(provesDataFactoryImport(consumer, factorySource, 'makeData'), declaration).toBe(false);
    }
  });
});

it('proves closed schema dictionaries without erasing opaque or executable values', () => {
  withTemporaryWorkspace((directory) => {
    const factory = nodePath.join(directory, factoryFilename);
    const consumer = nodePath.join(directory, consumerFilename);
    writeFileSync(consumer, dataFactoryConsumer);
    for (const declaration of [
      'import { Schema } from "effect"; const codec = Schema.Record(Schema.String, Schema.String); const decode = Schema.decodeUnknownSync(codec); export const makeData = (value: string) => ({ labels: decode(value) });',
      'import { Schema } from "effect"; const codec = Schema.Record(Schema.String, Schema.Json); const decode = Schema.decodeUnknownSync(codec); export const makeData = (value: string) => ({ payload: decode(value) });',
      'import { Schema } from "effect"; const codec = Schema.Record(Schema.String, Schema.Struct({ id: Schema.String })); const decode = Schema.decodeUnknownSync(codec); export const makeData = (value: string) => Object.values(decode(value)).map(({ id }) => ({ id }));',
      'import { Schema as S } from "effect"; const codec = S.Record(S.String, S.String); const decode = S.decodeUnknownSync(codec); export const makeData = (value: string) => ({ ...decode(value) });',
      'import { Schema } from "effect"; const codec = Schema.Record(Schema.String, Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))); const decode = Schema.decodeUnknownSync(codec); export const makeData = (value: string) => ({ counts: decode(value) });',
    ]) {
      writeFileSync(factory, declaration);
      expect(provesDataFactoryImport(consumer, factorySource, 'makeData'), declaration).toBe(true);
    }
    for (const declaration of [
      'import { Schema } from "effect"; const decode = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown)); export const makeData = (value: string) => ({ payload: decode(value) });',
      'import { Schema } from "effect"; const decode = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown)); export const makeData = (value: string) => ({ ...decode(value) });',
      'import { Schema } from "effect"; const decode = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown)); export const makeData = (value: string) => Object.values(decode(value));',
      'import { Schema } from "effect"; const codec = Schema.Record(Schema.String, Schema.String.check(Schema.makeFilter((value) => { fetch(value); return undefined; }))); const decode = Schema.decodeUnknownSync(codec); export const makeData = (value: string) => decode(value);',
      'import { Schema } from "effect"; const codec = Schema.Record(Schema.String, Schema.String, { decode: () => fetch("service") }); const decode = Schema.decodeUnknownSync(codec); export const makeData = (value: string) => decode(value);',
      'import { Schema } from "effect"; const codec = Schema.Record(Schema.String, Schema.Int.check(Schema.isGreaterThanOrEqualTo(fetch("service")))); const decode = Schema.decodeUnknownSync(codec); export const makeData = (value: string) => decode(value);',
      'import { Schema } from "effect"; const codec = Schema.Int.check(Schema.isGreaterThanOrEqualTo(() => fetch("service"))); const decode = Schema.decodeUnknownSync(codec); export const makeData = (value: string) => decode(value);',
      'const Schema = { Record: () => fetch("service") }; export const makeData = () => ({ value: Schema.Record() });',
      'import { Schema } from "foreign-runtime"; const decode = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.String)); export const makeData = (value: string) => decode(value);',
    ]) {
      writeFileSync(factory, declaration);
      expect(provesDataFactoryImport(consumer, factorySource, 'makeData'), declaration).toBe(false);
    }
  });
});

it('preserves dictionary element openness through local and parameter destructuring', () => {
  const codec = Schema.Record(Schema.String, Schema.Struct({ id: Schema.String }));
  const run = () => 'executable';
  const value = { item: { id: 'data', run } };
  const local = (input: typeof codec.Type) => {
    const { item } = input;
    return item;
  };
  const parameter = ({ item }: typeof codec.Type) => item;
  expect(local(value)).toBe(value.item);
  expect(parameter(value)).toBe(value.item);
  expect(value.item.run()).toBe('executable');
  let inheritedReads = 0;
  const prototype = Object.defineProperty({}, 'item', {
    get: () => {
      inheritedReads += 1;
      return value.item;
    },
  });
  const inherited = { __proto__: prototype } as unknown as typeof codec.Type;
  expect(local(inherited)).toBe(value.item);
  expect(parameter(inherited)).toBe(value.item);
  expect(inheritedReads).toBe(2);
  withTemporaryWorkspace((directory) => {
    const factory = nodePath.join(directory, factoryFilename);
    const consumer = nodePath.join(directory, consumerFilename);
    writeFileSync(consumer, dataFactoryConsumer);
    const codec = `${schemaImport} const codec = Schema.Record(Schema.String, Schema.Struct({ id: Schema.String }));`;
    const outcomes = [
      'export const makeData = (value: typeof codec.Type) => { const { item } = value; return item; };',
      'export const makeData = ({ item }: typeof codec.Type) => item;',
      'export const makeData = (value: typeof codec.Type) => value.item;',
      'export const makeData = (value: typeof codec.Type) => { const { item } = value; return { id: item.id }; };',
      'export const makeData = ({ item: { id } }: typeof codec.Type) => ({ id });',
    ].map((declaration) => {
      writeFileSync(factory, `${codec} ${declaration}`);
      return provesDataFactoryImport(consumer, factorySource, 'makeData');
    });
    expect(outcomes, 'dictionary keys may be absent or inherited on external prototype graphs').toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
    for (const declaration of [
      'export const makeData = (value: { readonly item: { readonly id: string } }) => { const { item } = value; return { id: item.id }; };',
      'export const makeData = ({ item: { id } }: { readonly item: { readonly id: string } }) => ({ id });',
    ]) {
      writeFileSync(factory, `${codec} ${declaration}`);
      expect(provesDataFactoryImport(consumer, factorySource, 'makeData'), declaration).toBe(true);
    }
  });
});

it('keeps unknown present values unsafe through local, nested, and parameter defaults', () => {
  const codec = Schema.Record(Schema.String, Schema.Struct({ id: Schema.String }));
  const decode = Schema.decodeUnknownSync(Schema.Json);
  let calls = 0;
  const replacement = Object.defineProperty({ id: 'data' }, 'replace', {
    value: () => {
      calls += 1;
      return 'executed';
    },
  });
  const unsafeMakeData = (value: typeof codec.Type) => {
    const { item } = value;
    if ('extra' in item) {
      const { extra = 'safe' } = item;
      return (decode(extra) as unknown as string).replace('old', 'new');
    }
    return 'safe';
  };
  const value = { item: { id: 'data', extra: replacement } };
  expect(unsafeMakeData(value)).toBe('executed');
  expect(calls).toBe(1);

  withTemporaryWorkspace((directory) => {
    const factory = nodePath.join(directory, factoryFilename);
    const consumer = nodePath.join(directory, consumerFilename);
    writeFileSync(consumer, dataFactoryConsumer);
    const prelude = `${schemaImport} const codec = Schema.Record(Schema.String, Schema.Struct({ id: Schema.String })); const decode = Schema.decodeUnknownSync(Schema.Json);`;
    const controls = [
      'export const makeData = (value: typeof codec.Type) => { const { item } = value; if ("extra" in item) { const { extra = "safe" } = item; return (decode(extra) as unknown as string).replace("old", "new"); } return "safe"; };',
      'export const makeData = (value: typeof codec.Type) => { const { item: { extra = "safe" } } = value; return (decode(extra) as unknown as string).replace("old", "new"); };',
      'export const makeData = ({ item: { extra = "safe" } }: typeof codec.Type) => (decode(extra) as unknown as string).replace("old", "new");',
      'export const makeData = (value: typeof codec.Type) => { const { item: { extra: { label = "safe" } = {} } } = value; return (decode(label) as unknown as string).replace("old", "new"); };',
      'export const makeData = ({ item: { extra: { label = "safe" } = {} } }: typeof codec.Type) => (decode(label) as unknown as string).replace("old", "new");',
      'export const makeData = (value: typeof codec.Type) => { const project = ({ extra = "safe" }) => (decode(extra) as unknown as string).replace("old", "new"); return project(value.item); };',
      'export const makeData = (value: typeof codec.Type) => { const { item = { id: "safe" } } = value; return item; };',
      'export const makeData = ({ item = { id: "safe" } }: typeof codec.Type) => item;',
      'export const makeData = ({ item: { id = "safe" } = { id: "fallback" } }: typeof codec.Type) => ({ id });',
      'const optional = Schema.Struct({ item: Schema.optionalKey(Schema.Struct({ id: Schema.String })) }); export const makeData = ({ item = { id: "safe" } }: typeof optional.Type) => item;',
    ];
    expect(
      controls.map((declaration) => {
        writeFileSync(factory, `${prelude} ${declaration}`);
        return provesDataFactoryImport(consumer, factorySource, 'makeData');
      }),
      controls.join('\n'),
    ).toEqual(controls.map(() => false));
    for (const declaration of [
      'export const makeData = (value: { readonly label?: string }) => { const { label = "safe" } = value; return { label: label.replace("old", "new") }; };',
      'export const makeData = ({ item: { id = "safe" } = { id: "fallback" } }: { readonly item: { readonly id: string } }) => ({ id });',
      'export const makeData = () => { const { item: { id = "safe" } = { id: "fallback" } } = {}; return { id }; };',
      'export const makeData = () => { const { label = "safe" } = { label: undefined }; return { label }; };',
      'export const makeData = (label: string = "safe") => ({ label });',
    ]) {
      writeFileSync(factory, `${prelude} ${declaration}`);
      expect(provesDataFactoryImport(consumer, factorySource, 'makeData'), declaration).toBe(true);
    }
  });
});

it('joins every record branch when projecting named fields and dictionary elements', () => {
  const codec = Schema.Record(Schema.String, Schema.Struct({ id: Schema.String }));
  const decode = Schema.decodeUnknownSync(Schema.Json);
  let calls = 0;
  const replacement = Object.defineProperty({ id: 'data' }, 'replace', {
    value: () => {
      calls += 1;
      return 'executed';
    },
  });
  const unsafeMakeData = (value: typeof codec.Type, flag: boolean) => {
    const selected = flag ? value : { item: { id: 'safe' } };
    return (decode(selected.item) as unknown as string).replace('old', 'new');
  };
  expect(unsafeMakeData({ item: replacement }, true)).toBe('executed');
  expect(calls).toBe(1);

  withTemporaryWorkspace((directory) => {
    const factory = nodePath.join(directory, factoryFilename);
    const consumer = nodePath.join(directory, consumerFilename);
    writeFileSync(consumer, dataFactoryConsumer);
    const prelude = `${schemaImport} const codec = Schema.Record(Schema.String, Schema.Struct({ id: Schema.String })); const decode = Schema.decodeUnknownSync(Schema.Json);`;
    const controls = [
      'export const makeData = (value: typeof codec.Type, flag: boolean) => { const selected = flag ? value : { item: { id: "safe" } }; return (decode(selected.item) as unknown as string).replace("old", "new"); };',
      'export const makeData = (value: typeof codec.Type, flag: boolean) => { const selected = flag ? value : { item: { id: "safe" } }; return selected.item; };',
      'export const makeData = (value: typeof codec.Type, flag: boolean) => { const { item } = flag ? value : { item: { id: "safe" } }; return item; };',
      'export const makeData = (value: { readonly id: string }, flag: boolean) => { const selected = flag ? value : { item: { id: "safe" } }; return selected.item; };',
      'export const makeData = (value: { readonly id: string }, flag: boolean) => { const { item = { id: "safe" } } = flag ? value : {}; return item; };',
      'export const makeData = (value: typeof codec.Type, flag: boolean) => { const selected = flag ? { nested: value } : { nested: { item: { id: "safe" } } }; return selected.nested.item; };',
      'export const makeData = (value: typeof codec.Type, flag: boolean) => { const selected = flag ? value : { item: { id: "safe" } }; const { item: { extra = "safe" } } = selected; return (decode(extra) as unknown as string).replace("old", "new"); };',
      'export const makeData = (value: typeof codec.Type, other: { readonly id: string }, flag: boolean) => { const selected = flag ? value : other; return selected.item; };',
      'export const makeData = (value: typeof codec.Type, flag: boolean) => { const selected = flag ? value : {}; const { item = { id: "safe" } } = selected; return item; };',
      'export const makeData = (flag: boolean) => { const selected = flag ? { label: true } : {}; return selected.label === true ? { safe: true } : { run: () => "executable" }; };',
      'const strings = Schema.Record(Schema.String, Schema.String); export const makeData = (value: typeof strings.Type, other: { readonly id: string }, flag: boolean) => { const selected = flag ? value : other; return (decode(selected.item) as unknown as string).replace("old", "new"); };',
      'export const makeData = (value: typeof codec.Type, flag: boolean) => flag ? { id: value.item.id } : { id: "safe" };',
      'const strings = Schema.Record(Schema.String, Schema.String); export const makeData = (value: typeof strings.Type, flag: boolean) => { const selected = flag ? value : { label: "safe" }; return selected.label.replace("old", "new"); };',
      'const strings = Schema.Record(Schema.String, Schema.String); export const makeData = (value: typeof strings.Type, other: typeof strings.Type, flag: boolean) => { const selected = flag ? value : other; return selected.item.replace("old", "new"); };',
    ];
    expect(
      controls.map((declaration) => {
        writeFileSync(factory, `${prelude} ${declaration}`);
        return provesDataFactoryImport(consumer, factorySource, 'makeData');
      }),
      controls.join('\n'),
    ).toEqual(controls.map(() => false));
    for (const declaration of [
      'export const makeData = (flag: boolean) => { const selected = flag ? { item: { id: "first" } } : { item: { id: "second" } }; return selected.item; };',
      'export const makeData = (flag: boolean) => { const { label = "safe" } = flag ? { label: "old" } : {}; return { label: label.replace("old", "new") }; };',
      'export const makeData = (value: { readonly item: { readonly id: string } }, flag: boolean) => flag ? { id: value.item.id } : { id: "safe" };',
      'export const makeData = (value: { readonly label: string }, flag: boolean) => { const selected = flag ? value : { label: "safe" }; return selected.label.replace("old", "new"); };',
      'export const makeData = (value: { readonly item: string }, other: { readonly item: string }, flag: boolean) => { const selected = flag ? value : other; return selected.item.replace("old", "new"); };',
      'export const makeData = (flag: boolean) => { const selected = flag ? { label: true } : {}; return selected.label === true ? { safe: true } : { safe: false }; };',
    ]) {
      writeFileSync(factory, `${prelude} ${declaration}`);
      expect(provesDataFactoryImport(consumer, factorySource, 'makeData'), declaration).toBe(true);
    }
  });
});

it('preserves uncertainty when later object spreads can overwrite closed named fields', () => {
  const codec = Schema.Record(Schema.String, Schema.Struct({ id: Schema.String }));
  const decode = Schema.decodeUnknownSync(Schema.Json);
  let calls = 0;
  const replacement = Object.defineProperty({ id: 'data' }, 'replace', {
    value: () => {
      calls += 1;
      return 'executed';
    },
  });
  const unsafeMakeData = (value: typeof codec.Type) => {
    const selected = { item: { id: 'safe' }, ...value };
    return (decode(selected.item) as unknown as string).replace('old', 'new');
  };
  expect(unsafeMakeData({ item: replacement })).toBe('executed');
  expect(calls).toBe(1);

  withTemporaryWorkspace((directory) => {
    const factory = nodePath.join(directory, factoryFilename);
    const consumer = nodePath.join(directory, consumerFilename);
    writeFileSync(consumer, dataFactoryConsumer);
    const prelude = `${schemaImport} const codec = Schema.Record(Schema.String, Schema.Struct({ id: Schema.String })); const decode = Schema.decodeUnknownSync(Schema.Json);`;
    const controls = [
      'export const makeData = (value: typeof codec.Type) => { const selected = { item: { id: "safe" }, ...value }; return (decode(selected.item) as unknown as string).replace("old", "new"); };',
      'export const makeData = (value: typeof codec.Type) => { const { item } = { item: { id: "safe" }, ...value }; return item; };',
      'export const makeData = (value: { readonly id: string }) => ({ item: { id: "safe" }, ...value }).item;',
      'export const makeData = (value: typeof codec.Type, flag: boolean) => ({ ...value, ...(flag ? { item: { id: "safe" } } : {}) }).item;',
      'export const makeData = (value: typeof codec.Type, flag: boolean) => ({ item: { id: "safe" }, ...(flag ? value : {}) }).item;',
      'export const makeData = (value: typeof codec.Type, other: { readonly id: string }) => ({ item: { id: "safe" }, ...value, ...other }).item;',
      'const strings = Schema.Record(Schema.String, Schema.String); export const makeData = (value: typeof strings.Type, other: { readonly id: string }) => { const selected = { ...value, ...other }; return (decode(selected.item) as unknown as string).replace("old", "new"); };',
    ];
    expect(
      controls.map((declaration) => {
        writeFileSync(factory, `${prelude} ${declaration}`);
        return provesDataFactoryImport(consumer, factorySource, 'makeData');
      }),
      controls.join('\n'),
    ).toEqual(controls.map(() => false));
    for (const declaration of [
      'export const makeData = (value: typeof codec.Type) => ({ ...value, item: { id: "safe" } }).item;',
      'export const makeData = (value: typeof codec.Type) => ({ item: { id: "safe" }, ...value }).item.id;',
      'export const makeData = (flag: boolean) => ({ item: { id: "safe" }, ...(flag ? { item: { id: "other" } } : {}) }).item;',
      'export const makeData = () => ({ ...{ item: { id: "first" } }, ...{ item: { id: "second" } } }).item;',
      'const strings = Schema.Record(Schema.String, Schema.String); export const makeData = (value: typeof strings.Type) => ({ label: "safe", ...value }).label.replace("old", "new");',
    ]) {
      writeFileSync(factory, `${prelude} ${declaration}`);
      expect(provesDataFactoryImport(consumer, factorySource, 'makeData'), declaration).toBe(true);
    }
  });
});

it('does not prove inherited property lookups undefined through defaults, joins, or spreads', () => {
  const decode = Schema.decodeUnknownSync(Schema.Json);
  let calls = 0;
  const replacement = Object.defineProperty({ id: 'data' }, 'replace', {
    value: () => {
      calls += 1;
      return 'executed';
    },
  });
  const execute = (value: { readonly id: string }) => (decode(value) as unknown as string).replace('old', 'new');
  const decodeDictionary = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Literal('safe')));
  expect(decodeDictionary({}).label).toBeUndefined();
  expect(decodeDictionary({ label: 'safe' }).label).toBe('safe');
  expect(Reflect.get(decodeDictionary({ toString: 'safe' }), 'toString')).toBe('safe');
  expect(Reflect.get(decodeDictionary({ constructor: 'safe' }), 'constructor')).toBe('safe');
  expect(Object.getPrototypeOf(decodeDictionary({ __proto__: null }))).toBe(Object.prototype);
  expect(Object.getPrototypeOf(/(?<name>safe)/u.exec('safe')!.groups)).toBeNull();
  const variants = [
    (value: { readonly id: string }) => {
      const dict = decodeDictionary({});
      return (dict.toString as unknown) === 'safe' ? 'safe' : execute(value);
    },
    (value: { readonly id: string }) => {
      const dict = decodeDictionary({});
      const { constructor = 'safe' } = dict;
      return (constructor as unknown) === 'safe' ? 'safe' : execute(value);
    },
    (value: { readonly id: string }) => {
      const dict = decodeDictionary({});
      const selected = replacement.id === 'data' ? dict : { constructor: 'safe' };
      return selected.constructor === 'safe' ? 'safe' : execute(value);
    },
    (value: { readonly id: string }) => {
      const dict = decodeDictionary({});
      return dict.label === 'safe' ? 'safe' : execute(value);
    },
    (value: { readonly id: string }) => {
      const empty = {};
      return empty.toString === undefined ? 'safe' : execute(value);
    },
    (value: { readonly id: string }) => {
      const { toString = undefined } = {};
      return toString === undefined ? 'safe' : execute(value);
    },
    (value: { readonly id: string }) => {
      const selected: { readonly toString?: unknown } = replacement.id === 'data' ? {} : { toString: undefined };
      return selected.toString === undefined ? 'safe' : execute(value);
    },
    (value: { readonly id: string }) => {
      const selected = { ...{} };
      return selected.toString === undefined ? 'safe' : execute(value);
    },
    (value: { readonly id: string }) => {
      const branch: { readonly toString?: unknown } = replacement.id === 'data' ? {} : { toString: undefined };
      const selected = { ...branch };
      const { toString = undefined } = selected;
      return toString === undefined ? 'safe' : execute(value);
    },
  ];
  expect(variants.map((makeData) => makeData(replacement))).toEqual(variants.map(() => 'executed'));
  expect(calls).toBe(variants.length);
  expect({}.constructor).toBe(Object);
  expect(Reflect.get({}, '__proto__')).toBe(Object.prototype);
  let getterCalls = 0;
  const prototype = Object.defineProperty({ id: 'prototype' }, 'extra', {
    get: () => {
      getterCalls += 1;
      return 'inherited';
    },
  });
  const inherited: { readonly extra?: string } = { __proto__: prototype } as { readonly extra?: string };
  expect(inherited.extra === undefined ? 'safe' : execute(replacement)).toBe('executed');
  expect(getterCalls).toBe(1);
  expect(calls).toBe(variants.length + 1);

  withTemporaryWorkspace((directory) => {
    const factory = nodePath.join(directory, factoryFilename);
    const consumer = nodePath.join(directory, consumerFilename);
    writeFileSync(consumer, dataFactoryConsumer);
    const prelude = `${schemaImport} const decode = Schema.decodeUnknownSync(Schema.Json);`;
    const unsafe = '(decode(value) as unknown as string).replace("old", "new")';
    const dictionary = 'Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Literal("safe")))({})';
    const bodies = [
      `const dict = ${dictionary}; return dict.toString === "safe" ? "safe" : ${unsafe};`,
      `const dict = ${dictionary}; const { constructor = "safe" } = dict; return constructor === "safe" ? "safe" : ${unsafe};`,
      `const dict = ${dictionary}; const selected = flag ? dict : { constructor: "safe" }; return selected.constructor === "safe" ? "safe" : ${unsafe};`,
      `const dict = ${dictionary}; return dict.label === "safe" ? "safe" : ${unsafe};`,
      `const dict = ${dictionary}; const selected = flag ? dict : { label: "safe" }; return selected.label === "safe" ? "safe" : ${unsafe};`,
      `const dict = ${dictionary}; const selected = { ...dict }; return selected.constructor === "safe" ? "safe" : ${unsafe};`,
      `const dict = ${dictionary}; const selected = { ...(flag ? dict : { constructor: "safe" }) }; return selected.constructor === "safe" ? "safe" : ${unsafe};`,
      `const dict = ${dictionary}; const selected = { __proto__: null, ...dict }; return selected.constructor === "safe" ? "safe" : ${unsafe};`,
      `const dict = ${dictionary}; const selected = flag ? { __proto__: null, ...dict } : { __proto__: null, constructor: "safe" }; return selected.constructor === "safe" ? "safe" : ${unsafe};`,
      `const selected = flag ? value : { constructor: "safe" }; return selected.constructor === "safe" ? "safe" : ${unsafe};`,
      `const empty = {}; return empty.toString === undefined ? "safe" : ${unsafe};`,
      `const { toString = undefined } = {}; return toString === undefined ? "safe" : ${unsafe};`,
      `const selected = flag ? {} : { toString: undefined }; return selected.toString === undefined ? "safe" : ${unsafe};`,
      `const selected = { ...{} }; return selected.toString === undefined ? "safe" : ${unsafe};`,
      `const selected = { ...(flag ? {} : { toString: undefined }) }; const { toString = undefined } = selected; return toString === undefined ? "safe" : ${unsafe};`,
      `const empty = {}; return empty.constructor === undefined ? "safe" : ${unsafe};`,
      `const { constructor = undefined } = {}; return constructor === undefined ? "safe" : ${unsafe};`,
      `const empty = {}; return empty.__proto__ === undefined ? "safe" : ${unsafe};`,
      `const { __proto__ = undefined } = {}; return __proto__ === undefined ? "safe" : ${unsafe};`,
      `const selected = { ...(flag ? { constructor: undefined } : {}) }; return selected.constructor === undefined ? "safe" : ${unsafe};`,
      `const selected = { __proto__: value }; return selected.extra === undefined ? "safe" : ${unsafe};`,
      `const selected = flag ? { toString: undefined } : {}; return { ...selected }.toString === undefined ? "safe" : ${unsafe};`,
      `const selected = { ...{ __proto__: null } }; return selected.toString === undefined ? "safe" : ${unsafe};`,
      `const selected = flag ? { __proto__: null } : {}; return selected.toString === undefined ? "safe" : ${unsafe};`,
      `const selected = Object.freeze(flag ? {} : { toString: undefined }); return selected.toString === undefined ? "safe" : ${unsafe};`,
      `const selected = { __proto__: value }; const { extra = "safe" } = selected; return extra === "safe" ? "safe" : ${unsafe};`,
      `const selected = { __proto__: { get extra() { return value; } } }; return selected.extra === undefined ? "safe" : ${unsafe};`,
    ];
    expect(
      bodies.map((body, index) => {
        const parameters =
          index === 0 ? 'value: { readonly id: string }' : 'value: { readonly id: string }, flag: boolean';
        writeFileSync(factory, `${prelude} export const makeData = (${parameters}) => { ${body} };`);
        return provesDataFactoryImport(consumer, factorySource, 'makeData');
      }),
      bodies.join('\n'),
    ).toEqual(bodies.map(() => false));
    for (const body of [
      'const groups = /(?<name>safe)/u.exec("safe").groups; return { name: groups.name, missing: groups.missing, constructor: groups.constructor };',
      `const dict = ${dictionary}; return { label: dict.label };`,
      `const dict = ${dictionary}; const { label = "safe" } = dict; return { label };`,
      `const dict = ${dictionary}; return { ...dict };`,
      `const dict = ${dictionary}; const selected = { __proto__: null, ...(flag ? dict : { constructor: "safe" }) }; const { constructor = "safe" } = selected; return { constructor };`,
      `const dict = ${dictionary}; const selected = { constructor: "safe", ...dict }; return selected.constructor === "safe" ? "safe" : ${unsafe};`,
      `const dict = ${dictionary}; const selected = { ...dict, constructor: "safe" }; return selected.constructor === "safe" ? "safe" : ${unsafe};`,
      `const dict = ${dictionary}; const selected = { ...(flag ? dict : { constructor: "safe" }), constructor: "safe" }; return selected.constructor === "safe" ? "safe" : ${unsafe};`,
      `const selected = { toString: undefined }; return selected.toString === undefined ? "safe" : ${unsafe};`,
      `const { toString = "safe" } = { toString: undefined }; return toString === "safe" ? "safe" : ${unsafe};`,
      `const selected = { toString: undefined, ...(flag ? {} : { toString: undefined }) }; return selected.toString === undefined ? "safe" : ${unsafe};`,
      `const selected = { ...(flag ? {} : { toString: undefined }), toString: undefined }; return selected.toString === undefined ? "safe" : ${unsafe};`,
      `const selected = { __proto__: null }; return selected.toString === undefined ? "safe" : ${unsafe};`,
      'return { ...(flag ? {} : { toString: undefined }) };',
      'return flag ? { first: "data" } : { second: "data" };',
      'const { missing = "safe" } = { ...{} }; return { missing };',
      'const selected = { __proto__: null, ...(flag ? {} : { toString: undefined }) }; const { toString = "safe" } = selected; return { toString };',
    ]) {
      writeFileSync(
        factory,
        `${prelude} export const makeData = (value: { readonly id: string }, flag: boolean) => { ${body} };`,
      );
      expect(provesDataFactoryImport(consumer, factorySource, 'makeData'), body).toBe(true);
    }
  });
});

it('does not treat Schema.Json validation as closure of opaque object inputs', () => {
  const run = () => 'executable';
  const hidden = Object.defineProperty({ id: 'data' }, 'run', { value: run });
  const symbol = Symbol('run');
  const symbolValue = Object.defineProperty({ id: 'data' }, symbol, { value: run });
  const decode = Schema.decodeUnknownSync(Schema.Json);
  expect(decode(hidden)).toBe(hidden);
  expect(Object.getOwnPropertyDescriptor(decode(hidden), 'run')?.value).toBe(run);
  expect(Object.getOwnPropertyDescriptor(decode(symbolValue), symbol)?.value).toBe(run);
  const dictionary = { item: hidden };
  expect(Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))(dictionary).item).toBe(hidden);
  let calls = 0;
  const replacement = Object.defineProperty({ id: 'data' }, 'replace', {
    value: () => {
      calls += 1;
      return 'executed';
    },
  });
  const unsafeMakeData = (value: { readonly id: string }) => (decode(value) as unknown as string).replace('old', 'new');
  expect(unsafeMakeData(replacement)).toBe('executed');
  const decodeDictionary = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json));
  const unsafeDictionaryMakeData = (value: { readonly item: { readonly id: string } }) =>
    (decodeDictionary(value).item as unknown as string).replace('old', 'new');
  expect(unsafeDictionaryMakeData({ item: replacement })).toBe('executed');
  expect(calls).toBe(2);

  withTemporaryWorkspace((directory) => {
    const factory = nodePath.join(directory, factoryFilename);
    const consumer = nodePath.join(directory, consumerFilename);
    writeFileSync(consumer, dataFactoryConsumer);
    const controls = [
      'const decode = Schema.decodeUnknownSync(Schema.Json); export const makeData = (value: { readonly id: string }) => decode(value);',
      'const decode = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json)); export const makeData = (value: { readonly item: { readonly id: string } }) => decode(value);',
      'const decode = Schema.decodeUnknownSync(Schema.Json); export const makeData = (value: { readonly id: string }) => decode(value).replace("old", "new");',
      'const decode = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json)); export const makeData = (value: { readonly item: { readonly id: string } }) => decode(value).item.replace("old", "new");',
      'const codec = Schema.Json; export const makeData = (value: typeof codec.Type) => value;',
      'const decode = Schema.decodeUnknownSync(Schema.Struct({ payload: Schema.Json })); export const makeData = (value: { readonly payload: { readonly id: string } }) => decode(value);',
      'const decode = Schema.decodeUnknownSync(Schema.Array(Schema.Json)); export const makeData = (value: readonly { readonly id: string }[]) => decode(value);',
      'const decode = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Struct({ payload: Schema.Json }))); export const makeData = (value: { readonly item: { readonly payload: { readonly id: string } } }) => decode(value);',
      'const encode = Schema.encodeSync(Schema.Json); export const makeData = (value: { readonly id: string }) => encode(value);',
      'const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Json)); export const makeData = (value: { readonly id: string }) => encode(value);',
      'const encode = Schema.encodeSync(Schema.Struct({ payload: Schema.fromJsonString(Schema.Json) })); export const makeData = (value: { readonly payload: { readonly id: string } }) => encode(value);',
      'const decode = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json)); export const makeData = () => decode("true") === "true" ? { safe: true } : { run: () => "executable" };',
    ];
    const outcomes = controls.map((declaration) => {
      writeFileSync(factory, `${schemaImport} ${declaration}`);
      return provesDataFactoryImport(consumer, factorySource, 'makeData');
    });
    expect(outcomes, controls.join('\n')).toEqual(controls.map(() => false));
    for (const declaration of [
      'const decode = Schema.decodeUnknownSync(Schema.Json); export const makeData = () => decode({ id: "data" });',
      'const decode = Schema.decodeUnknownSync(Schema.Json); export const makeData = (value: { readonly id: string }) => decode({ id: value.id });',
      'const decode = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json)); export const makeData = () => decode({ item: { id: "data" } });',
      'const decode = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json)); export const makeData = (value: string) => decode(value);',
      'const decode = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json))); export const makeData = (value: string) => decode(value);',
      'const decode = Schema.decodeUnknownSync(Schema.Struct({ payload: Schema.Json, entry: Schema.Struct({ id: Schema.String }) })); export const makeData = (value: { readonly id: string }) => decode({ payload: { id: value.id }, entry: value });',
      'const decode = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Struct({ payload: Schema.Json, entry: Schema.Struct({ id: Schema.String }) }))); export const makeData = (value: { readonly id: string }) => decode({ item: { payload: { id: value.id }, entry: value } });',
      'const decode = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ payload: Schema.Json, entry: Schema.Struct({ id: Schema.String }) }))); export const makeData = (value: { readonly id: string }) => decode([{ payload: { id: value.id }, entry: value }]);',
    ]) {
      writeFileSync(factory, `${schemaImport} ${declaration}`);
      expect(provesDataFactoryImport(consumer, factorySource, 'makeData'), declaration).toBe(true);
    }
  });
});

it('proves data-only template literal codecs without hiding executable schema parts', () => {
  withTemporaryWorkspace((directory) => {
    const factory = nodePath.join(directory, factoryFilename);
    const consumer = nodePath.join(directory, consumerFilename);
    writeFileSync(consumer, dataFactoryConsumer);
    for (const declaration of [
      'import { Schema } from "effect"; const codec = Schema.TemplateLiteral(["prefix-[", Schema.String, "]"]).check(Schema.isMaxLength(120)); const decode = Schema.decodeUnknownSync(codec); export const makeData = (value: string) => ({ label: decode(value) });',
      'import { Schema as S } from "effect"; const parts = ["prefix-", S.Number]; const codec = S.TemplateLiteral(parts); const decode = S.decodeUnknownSync(codec); export const makeData = (value: string) => ({ label: decode(value) });',
    ]) {
      writeFileSync(factory, declaration);
      expect(provesDataFactoryImport(consumer, factorySource, 'makeData'), declaration).toBe(true);
    }
    for (const declaration of [
      'import { Schema } from "effect"; const codec = Schema.TemplateLiteral(["prefix-", Schema.Unknown]); const decode = Schema.decodeUnknownSync(codec); export const makeData = (value: string) => decode(value);',
      'import { Schema } from "effect"; const codec = Schema.TemplateLiteral(["prefix-", () => fetch("service")]); const decode = Schema.decodeUnknownSync(codec); export const makeData = (value: string) => decode(value);',
      'import { Schema } from "effect"; const codec = Schema.TemplateLiteral(["prefix-", Schema.String.check(Schema.makeFilter((value) => { fetch(value); return undefined; }))]); const decode = Schema.decodeUnknownSync(codec); export const makeData = (value: string) => decode(value);',
      'import { Schema } from "effect"; const codec = Schema.TemplateLiteral(["prefix-", fetch("service")]); const decode = Schema.decodeUnknownSync(codec); export const makeData = (value: string) => decode(value);',
      'const Schema = { TemplateLiteral: () => fetch("service") }; export const makeData = () => ({ value: Schema.TemplateLiteral() });',
    ]) {
      writeFileSync(factory, declaration);
      expect(provesDataFactoryImport(consumer, factorySource, 'makeData'), declaration).toBe(false);
    }
  });
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
  });
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
      expectServiceReports(runOxlint(lintConfig, [consumer], directory), declaration);
    }
  });
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
        runOxlint(lintConfig, [consumer], directory).diagnostics.filter(({ code }) => code === ruleCode),
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
        runOxlint(lintConfig, [consumer], directory).diagnostics.filter(({ code }) => code === ruleCode).length,
        declaration,
      ).toBe(1);
    }
  });
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
  });
});
