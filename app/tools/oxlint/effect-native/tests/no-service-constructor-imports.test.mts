import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import nodePath from 'node:path';

import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { appRoot, runOxlint, testsDirectory } from './oxlint.mts';
import type { LintRun } from './oxlint.mts';
import { withTemporaryWorkspace } from './temporary-workspace.mts';
import { provesDataFactoryImport } from '../../anti-slop/effect/rules/data-factory-proof.ts';
import { noServiceConstructorImportsRule } from '../../anti-slop/effect/rules/no-service-constructor-imports.ts';
import {
  proveDictionaryElementOpenness,
  proveInheritedPropertyLookups,
  replaceOpaqueDecodedValue,
} from '../../anti-slop/tests/fixtures/no-service-constructor-imports/runtime-counterexamples.ts';

const bootstrapFilename = 'bootstrap.ts';
const privacyCompletionProcess = 'verticals/privacy/tests/support/privacy-completion-http.ts';
const processImports = "import { NodeRuntime } from '@effect/platform-node'; import { Effect } from 'effect';";
const loaderAcquisition = 'const load = require; void load;';
const bffAssemblyReturn = 'return assembleEffectBffRuntime({ api: Api, handlers });';
const statusComparison = 'if (status === 403)';
const factoryFilename = 'factory.ts';
const supportDirectory = 'tests/support';
const directRunMain = 'NodeRuntime.runMain(Effect.void);';
const consumerFilename = 'consumer.ts';
const factorySource = './factory.ts';
const schemaImport = "import { Schema } from 'effect';";
const dataFactoryConsumer = "import { makeData } from './factory.ts'; void makeData;";
const lintConfig = nodePath.join(appRoot, 'oxlint.config.ts');
const boundSchemaDeclaration = (bound: string) =>
  [
    'import { Schema as S } from "effect";',
    bound,
    'export const BoundSchema = S.Finite.check(S.isInt(), S.isLessThanOrEqualTo(ceiling));',
  ].join('\n');

const fixtureExecutable = () => 'executable';

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

it('proves native Set membership in DTO codecs and rejects executable lookalikes', () => {
  withTemporaryWorkspace((directory) => {
    const factory = nodePath.join(directory, factoryFilename);
    const consumer = nodePath.join(directory, consumerFilename);
    writeFileSync(consumer, dataFactoryConsumer);
    const codec = [
      'const codec = Schema.String.check(Schema.makeFilter((value) => reserved.has(value) ? "reserved" : undefined));',
      'const decode = Schema.decodeUnknownSync(codec);',
      'export const makeData = (value: string) => ({ value: decode(value) });',
    ].join('\n');
    writeFileSync(factory, `${schemaImport}\nconst reserved = new Set(["staff", "shell"]);\n${codec}`);
    expect(provesDataFactoryImport(consumer, factorySource, 'makeData')).toBe(true);
    for (const declaration of [
      'const reserved = { has: (value: string) => { fetch(value); return false; } };',
      'const Set = class { constructor(values: readonly string[]) { fetch(values[0]); } has() { return false; } }; const reserved = new Set(["staff"]);',
      'const reserved = new Set([() => fetch("service")]);',
      'const reserved = new Set([fetch("service")]);',
      'const reserved = new Set(["staff"]); reserved.add("shell");',
    ]) {
      writeFileSync(factory, `${schemaImport}\n${declaration}\n${codec}`);
      expect(provesDataFactoryImport(consumer, factorySource, 'makeData'), declaration).toBe(false);
    }
    writeFileSync(
      factory,
      `${schemaImport}\nconst reserved = new Set(["staff"]);\n${codec.replace('reserved.has(value)', 'reserved.has(fetch(value))')}`,
    );
    expect(provesDataFactoryImport(consumer, factorySource, 'makeData')).toBe(false);
  });
});

it('proves native string replacement in DTO codecs and rejects executable alternatives', () => {
  withTemporaryWorkspace((directory) => {
    const factory = nodePath.join(directory, factoryFilename);
    const consumer = nodePath.join(directory, consumerFilename);
    writeFileSync(consumer, dataFactoryConsumer);
    const codec = [
      'const codec = Schema.String.check(Schema.makeFilter((value) => value.replace(/^__(?:Secure|Host)-/u, "").startsWith("staff.") ? "reserved" : undefined));',
      'const decode = Schema.decodeUnknownSync(codec);',
      'export const makeData = (value: string) => ({ value: decode(value) });',
    ].join('\n');
    writeFileSync(factory, `${schemaImport}\n${codec}`);
    expect(provesDataFactoryImport(consumer, factorySource, 'makeData')).toBe(true);
    for (const expression of [
      'value.replace(/^__/u, () => fetch(value))',
      'value.replace(/^__/u, fetch(value))',
      'value.replace({ [Symbol.replace]: () => fetch(value) }, "")',
      '({ replace: () => fetch(value) }).replace()',
    ]) {
      writeFileSync(
        factory,
        `${schemaImport}\n${codec.replace('value.replace(/^__(?:Secure|Host)-/u, "")', expression)}`,
      );
      expect(provesDataFactoryImport(consumer, factorySource, 'makeData'), expression).toBe(false);
    }
  });
});

it('proves closed record and template schemas and rejects opaque or executable payloads', () => {
  withTemporaryWorkspace((directory) => {
    const factory = nodePath.join(directory, factoryFilename);
    const consumer = nodePath.join(directory, consumerFilename);
    writeFileSync(consumer, dataFactoryConsumer);
    const declaration = (codec: string, input = '{}'): string =>
      `${schemaImport}\nconst decode = Schema.decodeUnknownSync(${codec}); export const makeData = () => ({ value: decode(${input}) });`;
    for (const [codec, input] of [
      ['Schema.Record(Schema.String, Schema.String)', '{ label: "data" }'],
      ['Schema.Record(Schema.String, Schema.Json)', '{ nested: { values: [1, "data", null] } }'],
      ['Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))', '0'],
      ['Schema.TemplateLiteral(["icon-[", Schema.String, "]"])', '"icon-[home]"'],
    ] as const) {
      writeFileSync(factory, declaration(codec, input));
      expect(provesDataFactoryImport(consumer, factorySource, 'makeData'), codec).toBe(true);
    }
    for (const codec of [
      'Schema.Record(Schema.String, Schema.Unknown)',
      'Schema.Record(Schema.Unknown, Schema.String)',
      'Schema.Record(Schema.String, Schema.String.check(Schema.makeFilter((value) => { fetch(value); return undefined; })))',
      'Schema.Record(Schema.String, Schema.String, { transform: () => fetch("service") })',
      'Schema.Int.check(Schema.isGreaterThanOrEqualTo(fetch("service")))',
      'Schema.TemplateLiteral(["icon-[", Schema.Unknown, "]"])',
      'Schema.TemplateLiteral(["icon-[", () => fetch("service"), "]"])',
      'Schema.TemplateLiteral(["icon-[", fetch("service"), "]"])',
      'Schema.TemplateLiteral(["icon-[", Schema.String.check(Schema.makeFilter((value) => { fetch(value); return undefined; })), "]"])',
    ]) {
      writeFileSync(factory, declaration(codec));
      expect(provesDataFactoryImport(consumer, factorySource, 'makeData'), codec).toBe(false);
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
  proveDictionaryElementOpenness(fixtureExecutable);
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
      return replaceOpaqueDecodedValue(decode(extra));
    }
    return 'safe';
  };
  const value = { item: { extra: replacement, id: 'data' } };
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
    return replaceOpaqueDecodedValue(decode(selected.item));
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
    return replaceOpaqueDecodedValue(decode(selected.item));
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
  proveInheritedPropertyLookups();
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
  const hidden = Object.defineProperty({ id: 'data' }, 'run', { value: fixtureExecutable });
  const symbol = Symbol('run');
  const symbolValue = Object.defineProperty({ id: 'data' }, symbol, { value: fixtureExecutable });
  const decode = Schema.decodeUnknownSync(Schema.Json);
  expect(decode(hidden)).toBe(hidden);
  expect(Object.getOwnPropertyDescriptor(decode(hidden), 'run')?.value).toBe(fixtureExecutable);
  expect(Object.getOwnPropertyDescriptor(decode(symbolValue), symbol)?.value).toBe(fixtureExecutable);
  const dictionary = { item: hidden };
  expect(Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))(dictionary).item).toBe(hidden);
  let calls = 0;
  const replacement = Object.defineProperty({ id: 'data' }, 'replace', {
    value: () => {
      calls += 1;
      return 'executed';
    },
  });
  const unsafeMakeData = (value: { readonly id: string }) => replaceOpaqueDecodedValue(decode(value));
  expect(unsafeMakeData(replacement)).toBe('executed');
  const decodeDictionary = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json));
  const unsafeDictionaryMakeData = (value: { readonly item: { readonly id: string } }) =>
    replaceOpaqueDecodedValue(decodeDictionary(value).item);
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

it('proves pure byte hashing in generic data calls and rejects executable or unmodeled hashing', () => {
  withTemporaryWorkspace((directory) => {
    const factory = nodePath.join(directory, factoryFilename);
    const consumer = nodePath.join(directory, consumerFilename);
    writeFileSync(
      factory,
      'export const makePayload = <Value extends object>({ id, entries }: { readonly id: string; readonly entries: readonly Value[] }) => ({ id, entries });',
    );
    const shaImport = "import { sha256 } from '@noble/hashes/sha2.js';";
    const declaration = [
      shaImport,
      "import { utf8ToBytes } from '@noble/hashes/utils.js';",
      "import { Hex } from 'effect/encoding';",
      "import { makePayload } from './factory.ts';",
      'export const makeEnvelope = (id: string) => makePayload({ id: Hex.encode(sha256(utf8ToBytes(id))), entries: [{ label: id }] });',
    ].join('\n');
    writeFileSync(consumer, declaration);
    expect(provesDataFactoryImport(consumer, factorySource, 'makePayload')).toBe(true);
    writeFileSync(consumer, declaration.replace('utf8ToBytes(id)', 'utf8ToBytes(fetch(id))'));
    expect(provesDataFactoryImport(consumer, factorySource, 'makePayload')).toBe(false);
    writeFileSync(
      consumer,
      declaration.replace(shaImport, "import { sha512 as sha256 } from '@noble/hashes/sha2.js';"),
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
      expectServiceReports(runOxlint(lintConfig, [consumer], directory), declaration);
    }
  });
});

it('proves imported native numeric bounds without trusting shadowed or opaque values', () => {
  withTemporaryWorkspace((directory) => {
    const factory = nodePath.join(directory, factoryFilename);
    const consumer = nodePath.join(directory, consumerFilename);
    const boundedSchema = nodePath.join(directory, 'bounded-schema.ts');
    writeFileSync(consumer, dataFactoryConsumer);
    writeFileSync(
      factory,
      [
        'import { Schema as S } from "effect";',
        'import { BoundSchema } from "./bounded-schema.ts";',
        'const decode = S.decodeUnknownSync(BoundSchema);',
        'export const makeData = (value: number) => ({ revision: decode(value) });',
      ].join('\n'),
    );
    for (const bound of [
      'const ceiling = Number.MAX_SAFE_INTEGER;',
      'const Numeric = Number; const ceiling = Numeric.MAX_SAFE_INTEGER;',
      'const Number = { MAX_SAFE_INTEGER: 12 }; const ceiling = Number.MAX_SAFE_INTEGER;',
    ]) {
      writeFileSync(boundedSchema, boundSchemaDeclaration(bound));
      expect(provesDataFactoryImport(consumer, factorySource, 'makeData'), bound).toBe(true);
    }
    for (const bound of [
      'const Number = { MAX_SAFE_INTEGER: () => fetch("runtime") }; const ceiling = Number.MAX_SAFE_INTEGER;',
      'const Number = { get MAX_SAFE_INTEGER() { return fetch("runtime"); } }; const ceiling = Number.MAX_SAFE_INTEGER;',
      'const ceiling = Number.parseInt("42");',
      'const ceiling = Number.MISSING_BOUND;',
      'const ceiling = () => Number.MAX_SAFE_INTEGER;',
    ]) {
      writeFileSync(boundedSchema, boundSchemaDeclaration(bound));
      expect(provesDataFactoryImport(consumer, factorySource, 'makeData'), bound).toBe(false);
    }
  });
});

it('proves omitted optional JSON fields without closing supplied opaque payloads', () => {
  withTemporaryWorkspace((directory) => {
    const factory = nodePath.join(directory, factoryFilename);
    const consumer = nodePath.join(directory, consumerFilename);
    writeFileSync(consumer, dataFactoryConsumer);
    const prefix = [
      'import { Schema } from "effect";',
      'const decode = Schema.decodeUnknownSync(Schema.Struct({',
      '  entry: Schema.Struct({ id: Schema.String }),',
      '  optionalPayload: Schema.optionalKey(Schema.Struct({ query: Schema.Json })),',
      '}));',
    ].join('\n');
    writeFileSync(factory, `${prefix} export const makeData = (entry: { readonly id: string }) => decode({ entry });`);
    expect(provesDataFactoryImport(consumer, factorySource, 'makeData')).toBe(true);
    for (const declaration of [
      'export const makeData = (entry: { readonly id: string }) => decode({ entry, optionalPayload: { query: entry } });',
      'export const makeData = (value: { readonly entry: { readonly id: string } }) => decode(value);',
      'export const makeData = (entry: { readonly id: string }) => decode({ entry, optionalPayload: { query: { run: () => fetch("runtime") } } });',
    ]) {
      writeFileSync(factory, `${prefix} ${declaration}`);
      expect(provesDataFactoryImport(consumer, factorySource, 'makeData'), declaration).toBe(false);
    }
  });
});

it('retains recursive data closure through native Object.values on arrays', () => {
  withTemporaryWorkspace((directory) => {
    const factory = nodePath.join(directory, factoryFilename);
    const consumer = nodePath.join(directory, consumerFilename);
    writeFileSync(consumer, dataFactoryConsumer);
    const declaration = [
      'import { Predicate } from "effect";',
      'const freeze = <Value>(value: Value): Value => {',
      '  if (!Predicate.isObjectKeyword(value) || value === null) return value;',
      '  for (const nested of Object.values(value)) freeze(nested);',
      '  return Object.freeze(value);',
      '};',
      'export const makeData = () => freeze([{ entries: [{ id: "data" }] }]);',
    ].join('\n');
    writeFileSync(factory, declaration);
    expect(provesDataFactoryImport(consumer, factorySource, 'makeData')).toBe(true);
    writeFileSync(factory, declaration.replace('freeze(nested);', 'fetch("runtime");'));
    expect(provesDataFactoryImport(consumer, factorySource, 'makeData')).toBe(false);
    writeFileSync(factory, declaration.replace('{ id: "data" }', '{ run: () => fetch("runtime") }'));
    expect(provesDataFactoryImport(consumer, factorySource, 'makeData')).toBe(false);
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

it('proves validated, freshly linked Drizzle metadata without a factory-name exemption', () => {
  withTemporaryWorkspace((directory) => {
    const factory = nodePath.join(directory, factoryFilename);
    const consumer = nodePath.join(directory, consumerFilename);
    writeFileSync(consumer, dataFactoryConsumer);
    const declaration = [
      'import { sql as statement } from "drizzle-orm";',
      'import { pgPolicy as policy, pgSchema, uuid, text } from "drizzle-orm/pg-core";',
      'import type { PgPolicy, PgTable } from "drizzle-orm/pg-core";',
      'import { Schema } from "effect";',
      'const Invariant = Schema.TaggedError<Error>()("Invariant", { message: Schema.String });',
      'const table = pgSchema("core").table("items", { tenantId: uuid("tenant_id").notNull(), moduleKey: text("module_key") });',
      'const trustedTenant = statement`(select trust.current_tenant_id())`;',
      'const canonical = /^[a-z][a-z0-9_]*$/u;',
      'const literal = (key: string) => {',
      '  if (!canonical.test(key)) throw new Invariant({ message: "invalid module key" });',
      `  return statement.raw(\`'\${key}'\`);`,
      '};',
      'const linked = (target: PgTable, value: PgPolicy, scope: { readonly trustedTenant?: true } = {}) => {',
      '  if (!canonical.test(value.name) || value.name.length > 63) throw new Invariant({ message: "invalid policy name" });',
      '  if (Array.isArray(value.to)) Object.freeze(value.to);',
      '  return Object.freeze({ ...scope, policy: Object.freeze(value.link(target)), table: target });',
      '};',
      'export const makeData = (keys: readonly string[]) => {',
      '  const validated = keys.map((key) => key);',
      '  if (keys.some((key, index) => key !== validated[index])) throw new Invariant({ message: "inconsistent enrollment" });',
      `  const exclusions = validated.map((key) => statement\`\${table.moduleKey} <> \${literal(key)}\`);`,
      `  const predicate = statement\`\${table.tenantId} = \${trustedTenant} and \${statement.join(exclusions, statement\` and \`)}\`;`,
      '  const descriptors = [',
      '    linked(table, policy("items_select", { for: "select", to: ["runtime"], using: keys.length === 0 ? undefined : predicate, withCheck: keys.length === 0 ? predicate : undefined })),',
      `    ...validated.flatMap((key) => [linked(table, policy(\`items_\${key}_select\`, { for: "select", to: [key], using: predicate }), { trustedTenant: true })]),`,
      '  ];',
      '  if (new Set(descriptors.map(({ policy }) => policy.name)).size !== descriptors.length) throw new Invariant({ message: "duplicate names" });',
      '  return Object.freeze(descriptors);',
      '};',
    ].join('\n');
    writeFileSync(factory, declaration);
    expect(provesDataFactoryImport(consumer, factorySource, 'makeData')).toBe(true);
    expect(runOxlint(lintConfig, [consumer], directory).diagnostics.filter(({ code }) => code === ruleCode)).toEqual(
      [],
    );
    writeFileSync(
      factory,
      declaration.replace(`return statement.raw(\`'\${key}'\`);`, 'return statement.raw(fetch(key));'),
    );
    expect(provesDataFactoryImport(consumer, factorySource, 'makeData')).toBe(false);
    expect(
      runOxlint(lintConfig, [consumer], directory).diagnostics.filter(({ code }) => code === ruleCode),
    ).toHaveLength(1);
  });
});

it('proves the actual enrollment, identity-policy and migration-schema graphs', () => {
  const migration = nodePath.join(appRoot, 'database/core-schema.ts');
  expect(
    provesDataFactoryImport(
      migration,
      '../packages/core-runtime/src/db/database-identity-manifest.ts',
      'defineDatabaseIdentityEnrollment',
    ),
  ).toBe(true);
  expect(
    provesDataFactoryImport(
      migration,
      '../packages/core-runtime/src/db/identity-policies.ts',
      'makeCoreIdentityPolicies',
    ),
  ).toBe(true);
  expect(
    provesDataFactoryImport(
      nodePath.join(appRoot, 'database/core-schema.cts'),
      './core-schema.ts',
      'makeCoreMigrationSchema',
    ),
  ).toBe(true);
});

it('proves branded Result and Option construction only through native data-only operations', () => {
  withTemporaryWorkspace((directory) => {
    const factory = nodePath.join(directory, factoryFilename);
    const consumer = nodePath.join(directory, consumerFilename);
    writeFileSync(consumer, dataFactoryConsumer);
    const declaration = [
      'import { Schema as S, Result as R, Option as O } from "effect";',
      'const brand: unique symbol = Symbol("enrollment");',
      'interface Input { readonly id: string; readonly detail: { readonly label: string } | null; }',
      'class Invalid extends S.TaggedError<Invalid>()("Invalid", { cause: S.optionalKey(S.Unknown), reason: S.String }) {}',
      'const decode = S.decodeUnknownResult(S.Struct({ id: S.String, detail: S.OptionFromNullOr(S.Struct({ label: S.String })) }));',
      'export const makeData = (input: Input) => {',
      '  const value = R.getOrThrow(decode(input).pipe(R.mapError((cause) => new Invalid({ cause, reason: "invalid" }))));',
      '  return Object.freeze({ [brand]: true, id: value.id, detail: O.getOrNull(value.detail) });',
      '};',
    ].join('\n');
    writeFileSync(factory, declaration);
    expect(provesDataFactoryImport(consumer, factorySource, 'makeData')).toBe(true);
    const emptyErrorBody = 'reason: S.String }) {}';
    for (const [before, after] of [
      ['from "effect"', 'from "foreign-runtime"'],
      [
        '(cause) => new Invalid({ cause, reason: "invalid" })',
        '(cause) => { fetch(cause); return new Invalid({ cause, reason: "invalid" }); }',
      ],
      ['O.getOrNull(value.detail)', 'O.getOrNull({ run: () => fetch("runtime") })'],
      ['[brand]: true', '[brand]: () => fetch("runtime")'],
      ['[brand]: true', '[fetch("runtime")]: true'],
      [emptyErrorBody, 'reason: S.String }) { constructor(input: unknown) { super(input); fetch("runtime"); } }'],
      [emptyErrorBody, 'reason: S.String }) { run() { return fetch("runtime"); } }'],
      [emptyErrorBody, 'reason: S.String }) { readonly run = fetch("runtime"); }'],
      [
        'const brand: unique symbol = Symbol("enrollment");',
        'const Symbol = () => fetch("runtime"); const brand = Symbol("enrollment");',
      ],
      [
        'id: S.String, detail:',
        'id: S.String.check(S.makeFilter((value) => { fetch(value); return undefined; })), detail:',
      ],
    ]) {
      writeFileSync(factory, declaration.replace(before, after));
      expect(provesDataFactoryImport(consumer, factorySource, 'makeData'), after).toBe(false);
    }
    for (const source of [
      'import { Schema, Result } from "effect"; const decode = Schema.decodeUnknownResult(Schema.Json); export const makeData = (input: { readonly id: string }) => Result.getOrThrow(decode(input));',
      'import { Schema } from "effect"; const decode = Schema.decodeUnknownResult(Schema.Struct({ id: Schema.String })); export const makeData = (input: { readonly id: string }) => decode(input);',
      'import { Result } from "effect"; export const makeData = (input: { readonly id: string }) => Result.getOrThrow(input);',
    ]) {
      writeFileSync(factory, source);
      expect(provesDataFactoryImport(consumer, factorySource, 'makeData'), source).toBe(false);
    }
  });
});

it('proves schema-builder callbacks without admitting runtime defaults or counterfeit metadata', () => {
  withTemporaryWorkspace((directory) => {
    const factory = nodePath.join(directory, factoryFilename);
    const consumer = nodePath.join(directory, consumerFilename);
    writeFileSync(consumer, dataFactoryConsumer);
    const declaration = [
      'import { sql, defineRelations } from "drizzle-orm";',
      'import { pgSchema, uuid, timestamp, check, index, uniqueIndex, foreignKey, primaryKey, pgPolicy } from "drizzle-orm/pg-core";',
      'const schema = pgSchema("data");',
      'const sequence = schema.sequence("ids", { startWith: 1 });',
      'const parent = schema.table("parents", { id: uuid("id").defaultRandom().primaryKey() }).enableRLS();',
      'const items = schema.table.withRLS("items", {',
      '  id: uuid("id").primaryKey(),',
      '  parentId: uuid("parent_id").references(() => parent.id, { onDelete: "restrict" }),',
      '  createdAt: timestamp("created_at").defaultNow().notNull(),',
      '}, (table) => {',
      `  const predicate = sql\`\${table.id} is not null\`;`,
      '  return [primaryKey({ columns: [table.id], name: "items_pk" }),',
      '    check("items_ck", predicate), index("items_idx").on(table.id).where(predicate),',
      '    uniqueIndex("items_uk").on(table.parentId),',
      '    foreignKey({ columns: [table.parentId], foreignColumns: [parent.id] }).onDelete("restrict"),',
      '    pgPolicy("items_select", { using: predicate })];',
      '});',
      'const tables = { parent, items };',
      'const relations = defineRelations(tables);',
      'export const makeData = () => Object.freeze({ ...tables, schema, sequence, relations });',
    ].join('\n');
    writeFileSync(factory, declaration);
    expect(provesDataFactoryImport(consumer, factorySource, 'makeData')).toBe(true);
    for (const [before, after] of [
      ['from "drizzle-orm/pg-core"', 'from "foreign-runtime"'],
      ['(table) => {', '(table) => { fetch("runtime");'],
      ['() => parent.id', '() => { fetch("runtime"); return parent.id; }'],
      ['() => parent.id', '() => ({ run: () => fetch("runtime") })'],
      ['.defaultNow()', '.$defaultFn(() => fetch("runtime"))'],
      ['.defaultRandom()', '.randomRuntimeMethod()'],
      ['.on(table.id).where(predicate)', '.on(table.id).execute()'],
      ['defineRelations(tables)', 'defineRelations(tables, () => { fetch("runtime"); return {}; })'],
      ['columns: [table.id], name:', 'columns: [() => fetch("runtime")], name:'],
      ['const parent = schema.table(', 'const parent = fetch('],
    ]) {
      writeFileSync(factory, declaration.replace(before, after));
      expect(provesDataFactoryImport(consumer, factorySource, 'makeData'), after).toBe(false);
    }
    writeFileSync(factory, `${declaration}\nparent.enableRLS();`);
    expect(provesDataFactoryImport(consumer, factorySource, 'makeData')).toBe(false);
  });
});

it('keeps native metadata provenance through imports and rejects effectful module initialization', () => {
  withTemporaryWorkspace((directory) => {
    const factory = nodePath.join(directory, factoryFilename);
    const helper = nodePath.join(directory, 'metadata.ts');
    const consumer = nodePath.join(directory, consumerFilename);
    writeFileSync(consumer, dataFactoryConsumer);
    const metadata = [
      'import { sql } from "drizzle-orm";',
      'import { pgTable, uuid } from "drizzle-orm/pg-core";',
      'export const table = pgTable("items", { id: uuid("id").primaryKey() });',
      `export const predicate = sql\`\${table.id} is not null\`;`,
    ].join('\n');
    writeFileSync(helper, metadata);
    writeFileSync(
      factory,
      [
        'import { pgPolicy } from "drizzle-orm/pg-core";',
        'import { table, predicate } from "./metadata.ts";',
        'export const makeData = () => Object.freeze({ table, policy: pgPolicy("items_select", { using: predicate }).link(table) });',
      ].join('\n'),
    );
    expect(provesDataFactoryImport(consumer, factorySource, 'makeData')).toBe(true);
    for (const initializer of [
      'fetch("module initializer");',
      'const initialized = fetch("module initializer");',
      'const source = { get predicate() { fetch("module initializer"); return true; } }; const initialized = source.predicate;',
    ]) {
      writeFileSync(helper, `${metadata}\n${initializer}`);
      expect(provesDataFactoryImport(consumer, factorySource, 'makeData'), initializer).toBe(false);
    }
  });
});

it('rejects executable SQL, arbitrary linking, counterfeit imports, and unproved table builders', () => {
  withTemporaryWorkspace((directory) => {
    const factory = nodePath.join(directory, factoryFilename);
    const consumer = nodePath.join(directory, consumerFilename);
    writeFileSync(consumer, dataFactoryConsumer);
    const imports = [
      'import { sql } from "drizzle-orm";',
      'import { pgPolicy, pgTable, uuid } from "drizzle-orm/pg-core";',
      'import type { PgPolicy, PgTable } from "drizzle-orm/pg-core";',
      'import { Effect, Layer } from "effect";',
      'const table = pgTable("items", { id: uuid("id") });',
    ].join('\n');
    const controls = [
      `export const makeData = () => sql\`\${Effect.runSync(Effect.succeed("runtime"))}\`;`,
      `export const makeData = () => sql\`\${Layer.succeed("runtime")}\`;`,
      `export const makeData = () => sql\`\${{ getSQL: () => fetch("runtime") }}\`;`,
      'export const makeData = () => sql.raw(fetch("runtime"));',
      'export const makeData = () => sql.raw(() => fetch("runtime"));',
      'export const makeData = () => sql.join([sql`true`, fetch("runtime")]);',
      'export const makeData = () => sql.join([() => fetch("runtime")]);',
      'export const makeData = () => sql`true`.execute();',
      'export const makeData = () => sql.execute("select 1");',
      'export const makeData = () => pgPolicy("items_select", { using: sql`true`, to: [() => fetch("runtime")] });',
      'export const makeData = () => pgPolicy("items_select", { using: sql`true`, withCheck: Effect.succeed("runtime") });',
      'export const makeData = () => pgPolicy("items_select", { using: sql`true`, ignored: fetch("runtime") });',
      'export const makeData = () => pgPolicy("items_select", { using: sql`true` }).link({ id: "not a native table" });',
      'export const makeData = (policy: PgPolicy) => policy.link(table);',
      'export const makeData = (target: PgTable) => pgPolicy("items_select", { using: sql`true` }).link(target);',
      'const shared = pgPolicy("items_select", { using: sql`true` }); export const makeData = () => shared.link(table);',
      'const shared = { policy: pgPolicy("items_select", { using: sql`true` }) }; export const makeData = () => shared.policy.link(table);',
      'export const makeData = () => { const policy = pgPolicy("items_select", { using: sql`true` }); policy.link = () => fetch("runtime"); return policy.link(table); };',
      `const wrap = (value: string) => { fetch(value); return value; }; export const makeData = () => sql\`\${wrap("runtime")}\`;`,
      'export const makeData = (keys: readonly string[]) => sql.join(keys.map((key) => { fetch(key); return sql`true`; }));',
      'export const makeData = (keys: readonly string[]) => keys.flatMap((key) => { fetch(key); return [pgPolicy("items_select", { using: sql`true` })]; });',
      'export const makeData = (keys: readonly string[]) => { if (keys.some((key, index) => fetch(key) === keys[index])) throw new Error("invalid"); return sql`true`; };',
      'export const makeData = () => pgTable("other", { id: uuid("id") }, () => { fetch("runtime"); return []; });',
      'export const makeData = () => pgTable("other", { id: uuid("id").$defaultFn(() => fetch("runtime")) });',
      'export const makeData = () => pgTable("other", { id: uuid("id").references(() => { fetch("runtime"); return table.id; }) });',
      'export const makeData = () => table.enableRLS();',
      'export const makeData = () => { const sql = { raw: () => fetch("runtime") }; return sql.raw(); };',
      'export const makeData = (Array: { readonly isArray: () => boolean }) => { if (Array.isArray(table)) return sql`true`; return sql`false`; };',
      'sql.raw = () => fetch("runtime"); export const makeData = () => sql.raw("safe");',
      'let create = pgPolicy; create = () => fetch("runtime"); export const makeData = () => create("items_select", {});',
    ];
    for (const declaration of controls) {
      writeFileSync(factory, `${imports}\n${declaration}`);
      expect(provesDataFactoryImport(consumer, factorySource, 'makeData'), declaration).toBe(false);
    }
    writeFileSync(nodePath.join(directory, 'type-only.ts'), 'export type { sql } from "drizzle-orm";');
    for (const declaration of [
      'import { sql } from "foreign-runtime"; export const makeData = () => sql`true`;',
      'import type { sql } from "drizzle-orm"; export const makeData = () => sql`true`;',
      'import { type sql } from "drizzle-orm"; export const makeData = () => sql`true`;',
      'import { sql } from "./type-only.ts"; export const makeData = () => sql`true`;',
      'import { pgPolicy } from "foreign-runtime"; export const makeData = () => pgPolicy("items_select", {});',
      'import type { pgPolicy } from "drizzle-orm/pg-core"; export const makeData = () => pgPolicy("items_select", {});',
      'const sql = (value: unknown) => fetch("runtime"); export const makeData = () => sql`true`;',
      'export const makeData = () => ({ link: () => fetch("runtime") }).link({});',
    ]) {
      writeFileSync(factory, declaration);
      expect(provesDataFactoryImport(consumer, factorySource, 'makeData'), declaration).toBe(false);
    }
  });
});

it('proves checked invariant throws without admitting arbitrary constructors or dropping fallthrough', () => {
  withTemporaryWorkspace((directory) => {
    const factory = nodePath.join(directory, factoryFilename);
    const consumer = nodePath.join(directory, consumerFilename);
    writeFileSync(consumer, dataFactoryConsumer);
    for (const declaration of [
      'export const makeData = (value: string) => { if (value.length > 63) throw new Error("invalid"); return { value }; };',
      'export const makeData = (value: string) => { if (value.length > 63) throw new TypeError(value); return { value }; };',
      'import { Schema as S } from "effect"; const Invariant = S.TaggedError<Error>()("Invariant", { message: S.String }); export const makeData = (value: string) => { if (value.length > 63) throw new Invariant({ message: value }); return { value }; };',
    ]) {
      writeFileSync(factory, declaration);
      expect(provesDataFactoryImport(consumer, factorySource, 'makeData'), declaration).toBe(true);
    }
    for (const declaration of [
      'export const makeData = (value: string) => { if (value.length > 63) throw new Error(fetch(value)); return { value }; };',
      'class Invariant { constructor(value: string) { fetch(value); } } export const makeData = (value: string) => { if (value.length > 63) throw new Invariant(value); return { value }; };',
      'const Error = class { constructor(value: string) { fetch(value); } }; export const makeData = (value: string) => { if (value.length > 63) throw new Error(value); return { value }; };',
      'import { Schema } from "foreign-runtime"; const Invariant = Schema.TaggedError()("Invariant", { message: Schema.String }); export const makeData = (value: string) => { if (value.length > 63) throw new Invariant({ message: value }); return { value }; };',
      'import { Schema } from "effect"; const Invariant = Schema.TaggedError()("Invariant", { message: Schema.String }); export const makeData = (value: string) => { if (value.length > 63) throw new Invariant({ message: fetch(value) }); return { value }; };',
      'import { Schema } from "effect"; const Invariant = Schema.TaggedError()("Invariant", { message: Schema.String }); export const makeData = (value: string) => { if (value.length > 63) throw new Invariant({ message: value, run: () => fetch(value) }); return { value }; };',
      'const choose = (flag: boolean) => { if (flag) return "safe"; }; export const makeData = (flag: boolean) => choose(flag) === "safe" ? "safe" : fetch("runtime");',
      'export const makeData = (values: readonly string[]) => { for (const value of values) { return () => fetch(value); } return "safe"; };',
    ]) {
      writeFileSync(factory, declaration);
      expect(provesDataFactoryImport(consumer, factorySource, 'makeData'), declaration).toBe(false);
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

it('accepts only deployment-bound native Layer composition and preserves constructor controls', () => {
  withTemporaryWorkspace((directory) => {
    const actualRuntime = nodePath.relative(
      directory,
      nodePath.join(appRoot, 'packages/core-runtime/src/actions/runtime.ts'),
    );
    const layerFactorySource = './layer-factory.ts';
    const layerFactory = [
      'import { Effect, Layer, Context } from "effect";',
      'const Tag = Context.Service("Tag");',
      'export const makeRuntime = (deployment) => Layer.effect(Tag, Effect.gen(function* () { return deployment; }));',
    ].join('\n');
    writeFileSync(nodePath.join(directory, 'layer-factory.ts'), layerFactory);
    writeFileSync(
      nodePath.join(directory, 'effect-factory.ts'),
      layerFactory.replace(
        'Layer.effect(Tag, Effect.gen(function* () { return deployment; }))',
        'Effect.succeed(deployment)',
      ),
    );
    writeFileSync(
      nodePath.join(directory, 'eager-factory.ts'),
      layerFactory.replace(
        'Layer.effect(Tag, Effect.gen(function* () { return deployment; }))',
        '{ fetch("runtime"); return Layer.effect(Tag, Effect.gen(function* () { return deployment; })); }',
      ),
    );
    writeFileSync(nodePath.join(directory, 'mutated-factory.ts'), `${layerFactory}\nLayer.effect = counterfeit;`);
    writeFileSync(
      nodePath.join(directory, 'escaped-factory-namespace.ts'),
      `${layerFactory}\nObject.assign(Layer, counterfeit);`,
    );
    const source = [
      'import { Effect as Fx, Layer as Layers } from "effect";',
      'import { ActiveApplicationCompositionService as Composition } from "@app/core-runtime/modules/active-application-composition";',
      'import { makeRuntime as makeBoundRuntime } from "./layer-factory.ts";',
      'const runtime = Layers.unwrap(Fx.gen(function* () {',
      '  const snapshot = yield* (yield* Composition).load;',
      '  return makeBoundRuntime(snapshot.composition.shell.deployment).pipe(Layers.provide(dependencies));',
      '}));',
    ].join('\n');
    const valid = {
      'actual-runtime.ts': source
        .replace('makeRuntime as makeBoundRuntime', 'makeActionRuntimeLive as makeBoundRuntime')
        .replace(layerFactorySource, actualRuntime),
      'native-layer.ts': source,
    };
    const invalid = {
      'eager-factory-consumer.ts': source.replace(layerFactorySource, './eager-factory.ts'),
      'effect-factory-consumer.ts': source.replace(layerFactorySource, './effect-factory.ts'),
      'escaped-factory-namespace-consumer.ts': source.replace(layerFactorySource, './escaped-factory-namespace.ts'),
      'escaped-factory.ts': `${source}\nvoid makeBoundRuntime;`,
      'escaped-layer.ts': `${source}\nObject.assign(Layers, counterfeit);`,
      'fake-snapshot.ts': source.replace(
        'yield* (yield* Composition).load',
        '{ composition: { shell: { deployment: {} } } }',
      ),
      'foreign-composition.ts': source.replace(
        '@app/core-runtime/modules/active-application-composition',
        './foreign-composition.ts',
      ),
      'foreign-effect.ts': source.replace('from "effect"', 'from "foreign-effect"'),
      'hardcoded-deployment.ts': source.replace(
        'snapshot.composition.shell.deployment',
        '{ appId: "shell", buildMarker: "fake" }',
      ),
      'laundered-return.ts': source.replace(
        'return makeBoundRuntime(snapshot.composition.shell.deployment).pipe(Layers.provide(dependencies));',
        'return Fx.succeed(makeBoundRuntime(snapshot.composition.shell.deployment));',
      ),
      'mutated-deployment.ts': source.replace(
        '  return makeBoundRuntime',
        '  snapshot.composition.shell.deployment = replacement;\n  return makeBoundRuntime',
      ),
      'mutated-factory-consumer.ts': source.replace(layerFactorySource, './mutated-factory.ts'),
      'mutated-layer.ts': `${source}\nLayers.unwrap = counterfeit;`,
      'nested-business.ts': source.replace('const runtime =', 'function business() { return').replace('}));', '})); }'),
      'shadowed-composition.ts': source.replace(
        '  const snapshot',
        '  const Composition = fakeService;\n  const snapshot',
      ),
      'shadowed-layer.ts': source
        .replace('const runtime =', 'function business(Layers) { return')
        .replace('}));', '})); }'),
      'wrong-deployment.ts': source.replace(
        'snapshot.composition.shell.deployment',
        'snapshot.composition.other.deployment',
      ),
    };
    const files = Object.entries({ ...valid, ...invalid }).map(([name, candidate]) => {
      const filename = nodePath.join(directory, name);
      writeFileSync(filename, candidate);
      return filename;
    });
    const run = runOxlint(lintConfig, files, directory);
    expect(run.numberOfFiles).toBe(files.length);
    for (const name of Object.keys(valid)) {
      expect(
        run.diagnostics.filter(({ code, filename }) => code === ruleCode && nodePath.basename(filename) === name),
        name,
      ).toEqual([]);
    }
    for (const name of Object.keys(invalid)) {
      expect(
        run.diagnostics.filter(({ code, filename }) => code === ruleCode && nodePath.basename(filename) === name),
        name,
      ).toHaveLength(1);
      expect(
        run.diagnostics.find(({ code, filename }) => code === ruleCode && nodePath.basename(filename) === name)
          ?.message,
        name,
      ).toBe(
        noServiceConstructorImportsRule.meta?.messages?.serviceConstructorImport.replace('{{name}}', 'makeRuntime'),
      );
    }
  });
});

it('recognizes only owner-local executable test process roots for service composition', () => {
  withTemporaryWorkspace((directory) => {
    const workspace = nodePath.join(directory, 'app');
    const runtimeFilename = 'runtime.ts';
    const cases = [
      { names: ['makeAuthDatabase', 'makeAuthenticationService', 'makeApiKeyService'], owner: 'apps/shell-super-app' },
      { names: ['makePrivacyApiRuntime'], owner: 'verticals/privacy' },
    ];
    for (const { names, owner } of cases) {
      const ownerRoot = nodePath.join(workspace, owner);
      const support = nodePath.join(ownerRoot, supportDirectory);
      const api = nodePath.join(ownerRoot, 'api');
      mkdirSync(support, { recursive: true });
      mkdirSync(api, { recursive: true });
      const factory = nodePath.join(api, runtimeFilename);
      writeFileSync(
        factory,
        names
          .map((name) => `export const ${name} = (dependency: { readonly read: () => string }) => dependency;`)
          .join('\n'),
      );
      const consumer = nodePath.join(support, 'privacy-completion.ts');
      const localImport = `import { ${names.join(', ')} } from '../../api/runtime.ts';`;
      const runtimeImport = "import { NodeRuntime } from '@effect/platform-node';";
      const constructors = names.map((name) => `${name}({ read: () => 'fixture' });`).join(' ');
      const run = directRunMain;
      const effectImport = "import { Effect } from 'effect';";
      const count = (path: string, source: string) => {
        writeFileSync(path, source);
        return runOxlint(lintConfig, [path], appRoot).diagnostics.filter(({ code }) => code === ruleCode).length;
      };
      expect(count(consumer, `${runtimeImport} ${effectImport} ${localImport} ${constructors} ${run}`)).toBe(0);
      expect(
        count(
          consumer,
          `import { NodeRuntime as Runtime } from '@effect/platform-node'; ${effectImport} ${localImport} ${constructors} Runtime.runMain(Effect.void);`,
        ),
      ).toBe(0);
      const invalidRoots = [
        `${effectImport} ${localImport} ${constructors}`,
        `${runtimeImport} ${effectImport} ${localImport} ${constructors} const start = () => { ${run} }; void start;`,
        `${effectImport} ${localImport} ${constructors} const NodeRuntime = { runMain: (value: unknown) => value }; ${run}`,
        `import { NodeRuntime } from 'foreign-runtime'; ${effectImport} ${localImport} ${constructors} ${run}`,
        `${runtimeImport} ${effectImport} ${localImport} ${constructors} NodeRuntime['runMain'](Effect.void);`,
        `${runtimeImport} ${effectImport} ${localImport} ${constructors} NodeRuntime.runMain = (value: unknown) => value; ${run}`,
        `${runtimeImport} ${effectImport} ${localImport} ${constructors} const alias = NodeRuntime; alias.runMain(Effect.void);`,
        `${runtimeImport} ${effectImport} ${localImport} ${constructors} export const helper = () => undefined; ${run}`,
        `${runtimeImport} ${effectImport} ${localImport} ${constructors} export default {}; ${run}`,
        `${runtimeImport} ${effectImport} ${localImport} ${constructors} export * from '../../api/runtime.ts'; ${run}`,
        `${effectImport} ${localImport} ${constructors} // NodeRuntime.runMain(Effect.void);`,
      ];
      for (const source of invalidRoots) {
        expect(count(consumer, source), source).toBe(names.length);
      }
      expect(
        count(
          factory,
          `${runtimeImport} ${effectImport} import { ${names.join(', ')} } from './service.ts'; ${constructors} ${run}`,
        ),
      ).toBe(names.length);
      // Restore the owner source after using its runtime path as the negative consumer.
      writeFileSync(
        factory,
        names
          .map((name) => `export const ${name} = (dependency: { readonly read: () => string }) => dependency;`)
          .join('\n'),
      );
      const foreign = nodePath.join(workspace, 'verticals/foreign-owner/api');
      mkdirSync(foreign, { recursive: true });
      writeFileSync(
        nodePath.join(foreign, runtimeFilename),
        names
          .map((name) => `export const ${name} = (dependency: { readonly read: () => string }) => dependency;`)
          .join('\n'),
      );
      const foreignImport = nodePath.relative(support, nodePath.join(foreign, runtimeFilename)).replaceAll('\\', '/');
      expect(
        count(
          consumer,
          `${runtimeImport} ${effectImport} import { ${names.join(', ')} } from '${foreignImport}'; ${constructors} ${run}`,
        ),
      ).toBe(names.length);
      const barrel = nodePath.join(api, 'barrel.ts');
      const foreignFromApi = nodePath.relative(api, nodePath.join(foreign, runtimeFilename)).replaceAll('\\', '/');
      writeFileSync(barrel, `export { ${names.join(', ')} } from '${foreignFromApi}';`);
      expect(
        count(
          consumer,
          `${runtimeImport} ${effectImport} import { ${names.join(', ')} } from '../../api/barrel.ts'; ${constructors} ${run}`,
        ),
      ).toBe(names.length);
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

it('requires a closed stable NodeRuntime import origin across equivalent module aliases', () => {
  withTemporaryWorkspace((directory) => {
    const owner = nodePath.join(directory, 'app/verticals/runtime-owner');
    const api = nodePath.join(owner, 'api');
    const support = nodePath.join(owner, supportDirectory);
    mkdirSync(api, { recursive: true });
    mkdirSync(support, { recursive: true });
    writeFileSync(
      nodePath.join(api, factoryFilename),
      'export const makeService = (dependency: { readonly read: () => string }) => dependency;',
    );
    const consumer = nodePath.join(support, bootstrapFilename);
    const base =
      "import { NodeRuntime } from '@effect/platform-node'; import { Effect } from 'effect'; import { makeService } from '../../api/factory.ts'; void makeService;";
    const main = directRunMain;
    const findings = (extra: string) => {
      writeFileSync(consumer, `${base} ${extra} ${main}`);
      return runOxlint(lintConfig, [consumer], appRoot).diagnostics.filter(({ code }) => code === ruleCode).length;
    };
    expect(findings("import type { NodeRuntime as Other } from '@effect/platform-node';")).toBe(0);
    expect(findings("import type * as Platform from '@effect/platform-node';")).toBe(0);
    for (const extra of [
      "import { NodeRuntime as Other } from '@effect/platform-node'; Other.runMain = replacement;",
      "import { NodeRuntime as Other } from '@effect/platform-node'; void Other;",
      "import * as Platform from '@effect/platform-node'; Platform.NodeRuntime.runMain = replacement;",
      "import * as Platform from '@effect/platform-node'; const Other = Platform.NodeRuntime; void Other;",
      "import * as Other from '@effect/platform-node/NodeRuntime'; Other.runMain = replacement;",
      "import { runMain as other } from '@effect/platform-node/NodeRuntime'; void other;",
      "import Other from '@effect/platform-node/NodeRuntime'; void Other;",
      "const Other = await import('@effect/platform-node/NodeRuntime'); void Other;",
      "const Other = require('@effect/platform-node'); void Other;",
    ]) {
      expect(findings(extra), extra).toBe(1);
    }
  }, testsDirectory);
});

interface ProcessCapabilityCase {
  readonly after?: string;
  readonly before?: string;
  readonly constructorName?: string;
  readonly declaration?: string;
  readonly expected: number;
  readonly name: string;
}
const inspectProcessCapabilityCases = (cases: readonly ProcessCapabilityCase[]): void => {
  withTemporaryWorkspace((directory) => {
    const files = cases.map((scenario, index) => {
      const constructorName = scenario.constructorName ?? 'makeService';
      const owner = nodePath.join(directory, 'app/verticals', `capability-${index}`);
      const api = nodePath.join(owner, 'api');
      const support = nodePath.join(owner, supportDirectory);
      mkdirSync(api, { recursive: true });
      mkdirSync(support, { recursive: true });
      writeFileSync(
        nodePath.join(api, factoryFilename),
        scenario.declaration ??
          "import { Effect } from 'effect'; export const makeService = Effect.fn('service')(function* (dependency: { readonly read: () => string }) { return dependency; });",
      );
      const file = nodePath.join(support, `${scenario.name}.ts`);
      writeFileSync(
        file,
        [
          processImports,
          `import { ${constructorName} } from '../../api/factory.ts'; void ${constructorName};`,
          scenario.before ?? '',
          directRunMain,
          scenario.after ?? '',
        ].join('\n'),
      );
      return file;
    });
    const diagnostics = runOxlint(lintConfig, files, appRoot).diagnostics.filter(({ code }) => code === ruleCode);
    for (const scenario of cases) {
      expect(
        diagnostics.filter(({ filename }) => filename.endsWith(`/${scenario.name}.ts`)).length,
        scenario.name,
      ).toBe(scenario.expected);
    }
  }, testsDirectory);
};

it('recognizes canonical Effect.result observation without permitting capability escape', () => {
  inspectProcessCapabilityCases([
    {
      before: "const outcome = Effect.fail('typed').pipe(Effect.result); void outcome;",
      expected: 0,
      name: 'result-pipe-direct',
    },
    {
      before: "import { Effect as E } from 'effect'; const outcome = E.fail('typed').pipe(E.result); void outcome;",
      expected: 0,
      name: 'result-pipe-renamed-import',
    },
    { before: 'consume(Effect.result);', expected: 1, name: 'result-argument-escape' },
    { before: 'program.pipe?.(Effect.result);', expected: 1, name: 'result-optional-pipe' },
    { before: "program['pipe'](Effect.result);", expected: 1, name: 'result-computed-pipe' },
    { before: 'program.pipe(...[Effect.result]);', expected: 1, name: 'result-spread-pipe' },
    { before: 'const observe = Effect.result; void observe;', expected: 1, name: 'result-extraction' },
    { before: "program.pipe(Effect['result']);", expected: 1, name: 'result-computed' },
    { before: 'program.pipe(Effect?.result);', expected: 1, name: 'result-optional' },
    { before: 'Effect.result = replacement;', expected: 1, name: 'result-write-before' },
    { after: 'Effect.result = replacement;', expected: 1, name: 'result-write-after' },
    { before: 'const alias = Effect; program.pipe(alias.result);', expected: 1, name: 'result-object-alias' },
  ]);
});

it('recognizes canonical optional service lookup without permitting capability escape', () => {
  inspectProcessCapabilityCases([
    { before: 'Effect.serviceOption(Service);', expected: 0, name: 'optional-service-direct' },
    {
      before: "import { Effect as E } from 'effect'; E.serviceOption(Service);",
      expected: 0,
      name: 'optional-service-renamed-import',
    },
    { before: 'const lookup = Effect.serviceOption; void lookup;', expected: 1, name: 'optional-service-extraction' },
    { before: "Effect['serviceOption'](Service);", expected: 1, name: 'optional-service-computed' },
    { before: 'Effect?.serviceOption(Service);', expected: 1, name: 'optional-service-optional' },
    { before: 'Effect.serviceOption(...services);', expected: 1, name: 'optional-service-spread' },
    { before: 'Effect.serviceOption();', expected: 1, name: 'optional-service-missing-tag' },
    { before: 'Effect.serviceOption(Service, other);', expected: 1, name: 'optional-service-extra-argument' },
    { before: 'Effect.serviceOption = replacement;', expected: 1, name: 'optional-service-write-before' },
    { after: 'Effect.serviceOption = replacement;', expected: 1, name: 'optional-service-write-after' },
    {
      before: 'const alias = Effect; alias.serviceOption(Service);',
      expected: 1,
      name: 'optional-service-object-alias',
    },
  ]);
});

it('closes real executable HTTP observations without admitting evaluator or capability escape', () => {
  const fetchSource = "const fetch = globalThis.fetch; fetch('https://example.test');";
  const mapSource =
    "const choices = new Map([['/read', 'read']]); const operation = choices.get(path); const observed = { read: 'NONE' }; observed[operation] = 'SUCCESS';";
  inspectProcessCapabilityCases([
    {
      before:
        "Effect.all([Effect.void]); Effect.forEach([], () => Effect.void); Effect.tapErrorTag('Failure', () => Effect.void);",
      expected: 0,
      name: 'owner-effect-observers',
    },
    { before: 'const all = Effect.all; consume(all);', expected: 1, name: 'owner-effect-all-escape' },
    { before: 'Effect.tapErrorTag = replacement;', expected: 1, name: 'owner-effect-observer-mutation' },
    { before: fetchSource, expected: 0, name: 'owner-native-fetch' },
    ...[
      'consume(fetch);',
      'const alias = fetch; alias(url);',
      'fetch?.(url);',
      'fetch.constructor;',
      'globalThis.fetch = replacement;',
      'const global = globalThis; consume(global);',
      'globalThis[key](code);',
    ].map((after, index) => ({ after, before: fetchSource, expected: 1, name: `owner-fetch-unsafe-${index}` })),
    { before: 'const observed = input[key] !== other.value;', expected: 0, name: 'owner-strict-observation' },
    ...['input[key]();', 'consume(input[key]);', 'const observed = input[key] == other.value;'].map(
      (before, index) => ({ before, expected: 1, name: `owner-computed-unsafe-${index}` }),
    ),
    { before: mapSource, expected: 0, name: 'owner-finite-map-observation' },
    ...[
      "choices.set('/other', 'constructor');",
      'consume(choices);',
      'const alias = choices; alias.get(path);',
      'Map = replacement;',
    ].map((after, index) => ({ after, before: mapSource, expected: 1, name: `owner-map-unsafe-${index}` })),
    {
      before: mapSource.replace("'/read', 'read'", "'/read', 'constructor'"),
      expected: 1,
      name: 'owner-map-reflective-value',
    },
    {
      before: mapSource.replace("'/read', 'read'", "'/read', dynamicKey"),
      expected: 1,
      name: 'owner-map-dynamic-value',
    },
    { before: mapSource.replace('new Map(', 'new OtherMap('), expected: 1, name: 'owner-map-foreign-constructor' },
    {
      before: mapSource.replace('choices.get(path)', 'choices.get?.(path)'),
      expected: 1,
      name: 'owner-map-optional-lookup',
    },
    {
      before: mapSource.replace('choices.get(path)', "choices['get'](path)"),
      expected: 1,
      name: 'owner-map-computed-lookup',
    },
  ]);
});

it('permits only data-only native module-relative path metadata', () => {
  const pathSource = "const cwd = new URL('../../', import.meta.url).pathname;";
  inspectProcessCapabilityCases([
    { before: `${pathSource} URL.canParse(candidate);`, expected: 0, name: 'owner-module-path' },
    ...[
      'const meta = import.meta;',
      'const url = import.meta.url;',
      "import.meta.resolve('code');",
      pathSource.replace('import.meta.url', "import.meta['url']"),
      pathSource.replace("'../../'", 'dynamicPath'),
      pathSource.replace('new URL', 'new OtherURL'),
      pathSource.replace('.pathname', '.constructor'),
      `${pathSource} URL = replacement;`,
      `${pathSource} URL.canParse = replacement;`,
      `${pathSource} const parse = URL.canParse; parse(candidate);`,
      `const URL = replacement; ${pathSource}`,
      `${pathSource} const factory = URL; consume(factory);`,
    ].map((before, index) => ({ before, expected: 1, name: `owner-module-path-unsafe-${index}` })),
  ]);
});

it('classifies fixed non-enumerable local error causes without allowing reflection mutation', () => {
  const causeDescriptor = 'configurable: true, value: cause';
  const causeSource =
    "import { Failure } from './failure.ts'; export const makeService = (cause: unknown) => { const failure = new Failure({ reason: 'safe' }); Object.defineProperty(failure, 'cause', { configurable: true, value: cause }); return failure; };";
  inspectProcessCapabilityCases([
    { declaration: causeSource, expected: 0, name: 'owner-error-cause' },
    ...[
      ["'cause'", "'prototype'"],
      ["'cause'", "'constructor'"],
      ["'cause'", 'unknownKey'],
      [causeDescriptor, 'enumerable: true, value: cause'],
      [causeDescriptor, 'get: () => cause'],
      [causeDescriptor, '...descriptor'],
      ['const failure =', 'let failure ='],
      ['Object.defineProperty(failure,', 'Object.defineProperty(globalThis,'],
    ].map(([from, to], index) => ({
      declaration: causeSource.replace(from, to),
      expected: 1,
      name: `owner-error-cause-unsafe-${index}`,
    })),
  ]);
});

it('recognizes the real owner Party resolver constructor without executing its dependency', () => {
  inspectProcessCapabilityCases([
    {
      constructorName: 'makePartyRegistryRetailPartyResolver',
      declaration: readFileSync(
        nodePath.join(
          appRoot,
          'verticals/commerce-customer-context/src/integrations/party-registry-retail-party-resolver.ts',
        ),
        'utf-8',
      ),
      expected: 0,
      name: 'actual-owner-party-resolver',
    },
  ]);
});

it('closes canonical runtime object aliases and every unsupported reference before root eligibility', () => {
  inspectProcessCapabilityCases([
    { expected: 0, name: 'positive-floor' },
    {
      before:
        "import type * as P from '@effect/platform-node'; import type { NodeRuntime as R } from '@effect/platform-node/NodeRuntime';",
      expected: 0,
      name: 'type-only-equivalents',
    },
    {
      before: "import { NodeRuntime as Other } from '@effect/platform-node'; Other.runMain = replacement;",
      expected: 1,
      name: 'named-alias-mutation',
    },
    {
      before: "import * as P from '@effect/platform-node'; P['NodeRuntime'].runMain = replacement;",
      expected: 1,
      name: 'namespace-computed-slot',
    },
    {
      before: "import P from '@effect/platform-node'; P.NodeRuntime.runMain = replacement;",
      expected: 1,
      name: 'default-equivalent',
    },
    {
      before: "import { default as P } from '@effect/platform-node'; P.NodeRuntime.runMain = replacement;",
      expected: 1,
      name: 'named-default-equivalent',
    },
    {
      before: "import * as R from '@effect/platform-node/NodeRuntime'; R.runMain = replacement;",
      expected: 1,
      name: 'subpath-equivalent',
    },
    { before: 'const box = { runtime: NodeRuntime }; void box;', expected: 1, name: 'object-storage' },
    { before: 'const box = [NodeRuntime]; void box;', expected: 1, name: 'array-storage' },
    { before: 'const box = { ...NodeRuntime }; void box;', expected: 1, name: 'spread-storage' },
    { before: 'const box = flag ? NodeRuntime : {}; void box;', expected: 1, name: 'conditional-storage' },
    { before: 'const box = NodeRuntime || {}; void box;', expected: 1, name: 'logical-storage' },
    { before: 'const box = (0, NodeRuntime); void box;', expected: 1, name: 'sequence-storage' },
    { before: 'const load = () => NodeRuntime; void load;', expected: 1, name: 'closure-storage' },
    { before: 'mutate(NodeRuntime);', expected: 1, name: 'unknown-call' },
    { before: 'const start = NodeRuntime.runMain; void start;', expected: 1, name: 'method-extraction' },
    { before: 'NodeRuntime.runMain.call(null, Effect.void);', expected: 1, name: 'call-operation' },
    { before: 'const start = NodeRuntime.runMain.bind(null); void start;', expected: 1, name: 'bind-operation' },
    { before: 'NodeRuntime?.runMain(Effect.void);', expected: 1, name: 'optional-operation' },
    { after: 'NodeRuntime.runMain = replacement;', expected: 1, name: 'after-main-assignment' },
    { after: 'NodeRuntime.runMain++;', expected: 1, name: 'after-main-update' },
    { after: 'delete NodeRuntime.runMain;', expected: 1, name: 'after-main-delete' },
    { after: 'const box = (NodeRuntime as unknown); void box;', expected: 1, name: 'typescript-wrapper-escape' },
    {
      before: 'function local(NodeRuntime: { runMain: () => void }) { NodeRuntime.runMain(); } void local;',
      expected: 0,
      name: 'lexical-shadow-parameter',
    },
    {
      before: '{ const NodeRuntime = { runMain() {} }; NodeRuntime.runMain(); }',
      expected: 0,
      name: 'lexical-shadow-block',
    },
    { before: 'try {} catch (NodeRuntime) { void NodeRuntime; }', expected: 0, name: 'lexical-shadow-catch' },
    {
      before: 'function local({ NodeRuntime }: { NodeRuntime: unknown }) { void NodeRuntime; } void local;',
      expected: 0,
      name: 'lexical-shadow-destructure',
    },
  ]);
});

it('rejects loader and evaluator acquisition itself across import and free-reference forms', () => {
  inspectProcessCapabilityCases([
    { expected: 0, name: 'ordinary-positive' },
    {
      before: 'function local(input = require) { var require = () => undefined; return input; } void local;',
      expected: 1,
      name: 'unsupported-body-var-parameter-loader',
    },
    { before: 'var ordinary = 1; void ordinary;', expected: 1, name: 'unsupported-var-floor' },
    {
      before: 'function require(value: string) { return value; } require("ordinary");',
      expected: 0,
      name: 'local-require',
    },
    { before: 'const module = { name: "local" }; void module.name;', expected: 0, name: 'local-module' },
    {
      before: 'function local(globalThis: { name: string }) { return globalThis.name; } void local;',
      expected: 0,
      name: 'local-global-name',
    },
    {
      before:
        'import type { Module } from "node:module"; type Names = "require" | "eval"; const text = "globalThis.Function"; void text; // require module eval Function',
      expected: 0,
      name: 'type-comment-string',
    },
    {
      before:
        "const load = require; const Other = load('@effect/platform-node')['NodeRuntime']; Other.runMain = replacement;",
      expected: 1,
      name: 'global-require-alias',
    },
    {
      before:
        "import { createRequire as acquire } from 'node:module'; const load = acquire(import.meta.url); const Other = load('@effect/platform-node')['NodeRuntime']; Other.runMain = replacement;",
      expected: 1,
      name: 'renamed-loader-factory',
    },
    { before: loaderAcquisition, expected: 1, name: 'loader-unused-alias' },
    { after: loaderAcquisition, expected: 1, name: 'loader-acquired-after-main' },
    { before: 'const box = { load: require }; void box;', expected: 1, name: 'loader-container' },
    { before: 'const load = module?.require; void load;', expected: 1, name: 'loader-optional' },
    { before: "import modules from 'node:module'; void modules;", expected: 1, name: 'loader-default' },
    { before: "import { default as modules } from 'module'; void modules;", expected: 1, name: 'loader-named-default' },
    { before: "import * as modules from 'module'; void modules;", expected: 1, name: 'loader-namespace' },
    {
      before: "import { syncBuiltinESMExports as sync } from 'node:module'; void sync;",
      expected: 1,
      name: 'loader-sync-import',
    },
    { before: "import { runInThisContext as execute } from 'vm'; void execute;", expected: 1, name: 'vm-named' },
    { before: "import * as evaluator from 'node:vm'; void evaluator;", expected: 1, name: 'vm-namespace' },
    { before: "import evaluator from 'vm'; void evaluator;", expected: 1, name: 'vm-default' },
    { before: "const load = import('ordinary'); void load;", expected: 1, name: 'dynamic-import' },
    { before: "import load = require('ordinary'); void load;", expected: 1, name: 'import-equals' },
    { before: 'const load = import.meta.resolve; void load;', expected: 1, name: 'import-meta' },
    { before: 'const execute = (0, eval); void execute;', expected: 1, name: 'indirect-eval' },
    { before: 'const execute = Function; void execute;', expected: 1, name: 'function-alias' },
    { before: 'const execute = (eval as unknown); void execute;', expected: 1, name: 'typescript-evaluator-wrapper' },
    ...['globalThis', 'global', 'window', 'self', 'Reflect'].map((name) => ({
      before: `const box = { root: ${name} }; void box;`,
      expected: 1,
      name: `global-root-${name}`,
    })),
    { before: 'const execute = (() => {}).constructor; void execute;', expected: 1, name: 'constructor-acquisition' },
    { before: 'const execute = (() => {})?.constructor; void execute;', expected: 1, name: 'optional-constructor' },
    { before: 'const prototype = (() => {}).prototype; void prototype;', expected: 1, name: 'prototype-acquisition' },
    {
      before: 'const execute = (() => {})["con" + "structor"]; void execute;',
      expected: 1,
      name: 'computed-constructor',
    },
    { before: 'const acquire = Object.getPrototypeOf; void acquire;', expected: 1, name: 'reflective-intrinsic' },
    { before: 'const object = Object; void object;', expected: 1, name: 'intrinsic-object-escape' },
  ]);
});

it('limits canonical process capabilities to ordinary data and direct IO operations', () => {
  inspectProcessCapabilityCases([
    {
      before:
        'process.stdout.write("ready"); process.stderr.write("diagnostic"); const pid = process.pid; const environment = process.env.MODE; void pid; void environment; process.argv.includes("--describe");',
      expected: 0,
      name: 'global-process-ordinary',
    },
    { before: "import proc from 'node:process'; proc.stdout.write('ready');", expected: 0, name: 'process-default' },
    {
      before: "import { default as proc } from 'process'; proc.argv.includes('--describe');",
      expected: 0,
      name: 'process-default-as',
    },
    {
      before: "import * as proc from 'node:process'; const pid = proc.pid; void pid;",
      expected: 0,
      name: 'process-namespace',
    },
    { before: 'const proc = process; void proc;', expected: 1, name: 'raw-process-alias' },
    { before: 'const load = process.mainModule; void load;', expected: 1, name: 'process-main-module' },
    { before: 'const load = process.getBuiltinModule; void load;', expected: 1, name: 'process-builtin-loader' },
    {
      before: "import proc from 'node:process'; const load = proc.getBuiltinModule; void load;",
      expected: 1,
      name: 'process-default-loader',
    },
    {
      before: "import { default as proc } from 'process'; const load = proc.mainModule; void load;",
      expected: 1,
      name: 'process-default-as-loader',
    },
    {
      before: "import * as proc from 'process'; const load = proc.default; void load;",
      expected: 1,
      name: 'process-namespace-default',
    },
    {
      before: "import { getBuiltinModule as load } from 'node:process'; void load;",
      expected: 1,
      name: 'process-named-loader',
    },
    { before: 'const value = process.unknown; void value;', expected: 1, name: 'unknown-process-slot' },
    { before: 'const value = process[slot]; void value;', expected: 1, name: 'computed-process-slot' },
    { before: 'const write = process.stdout.write; void write;', expected: 1, name: 'process-method-extraction' },
    { before: 'const environment = process.env; void environment;', expected: 1, name: 'process-environment-escape' },
    { before: 'process.stdout.write = replacement;', expected: 1, name: 'process-io-mutation' },
  ]);
});

it('closes the full owner definition before proving direct or genuine Effect fn constructors', () => {
  const genuine =
    "import { Effect } from 'effect'; export const makeService = Effect.fn('service')(function* (dependency: { readonly read: () => string }) { return dependency; });";
  inspectProcessCapabilityCases([
    { declaration: genuine, expected: 0, name: 'genuine-definition' },
    {
      declaration: `${genuine} function local(input = require) { var require = () => undefined; return input; } void local;`,
      expected: 1,
      name: 'owner-body-var-parameter-loader',
    },
    {
      declaration: `${genuine} import { default as Other } from 'effect'; Other['Effect'].fn = replacement;`,
      expected: 1,
      name: 'owner-effect-named-default-mutation',
    },
    {
      declaration: `${genuine} export { type Module } from 'node:module';`,
      expected: 0,
      name: 'owner-type-only-loader-export',
    },
    {
      declaration: `${genuine} function local(Effect: { fn: unknown }) { return Effect.fn; } void local;`,
      expected: 0,
      name: 'owner-local-shadow',
    },
    {
      declaration: `${genuine} function require(value: string) { return value; } require('ordinary');`,
      expected: 0,
      name: 'owner-local-require',
    },
    { declaration: `${genuine} const load = require; void load;`, expected: 1, name: 'owner-loader-after-definition' },
    {
      declaration: `import { createRequire as load } from 'node:module'; ${genuine} void load;`,
      expected: 1,
      name: 'owner-loader-import',
    },
    {
      declaration: `${genuine} export { createRequire as load } from 'module';`,
      expected: 1,
      name: 'owner-loader-reexport',
    },
    {
      declaration: `${genuine} const module = import('ordinary'); void module;`,
      expected: 1,
      name: 'owner-dynamic-import',
    },
    {
      declaration:
        'const load = require; export const makeService = (dependency: { readonly read: () => string }) => dependency; void load;',
      expected: 1,
      name: 'owner-direct-arrow-loader',
    },
    {
      declaration: `${genuine} const box = { effect: Effect }; void box;`,
      expected: 1,
      name: 'owner-effect-object-container',
    },
    { declaration: `${genuine} const fn = Effect.fn; void fn;`, expected: 1, name: 'owner-effect-fn-extraction' },
    { declaration: `${genuine} Effect.unknown();`, expected: 1, name: 'owner-effect-unknown-member' },
    {
      declaration: `${genuine} Effect['fn']('other')(function* () {});`,
      expected: 1,
      name: 'owner-effect-computed-member',
    },
    {
      declaration: `${genuine} import { Effect as Other } from 'effect'; Other.fn = replacement;`,
      expected: 1,
      name: 'owner-effect-second-alias-mutation',
    },
    {
      declaration: `${genuine} import * as Library from 'effect'; Library['Effect'].fn = replacement;`,
      expected: 1,
      name: 'owner-effect-namespace-mutation',
    },
    {
      declaration: `${genuine} import * as Other from 'effect/Effect'; void Other;`,
      expected: 1,
      name: 'owner-effect-subpath',
    },
    { declaration: `${genuine} Effect.fn++;`, expected: 1, name: 'owner-effect-update-after-definition' },
    { declaration: `${genuine} delete Effect.fn;`, expected: 1, name: 'owner-effect-delete-after-definition' },
    {
      declaration: `${genuine} const root = (() => {}).constructor; void root;`,
      expected: 1,
      name: 'owner-prototype-acquisition',
    },
    {
      declaration:
        "import { makeService as foreign } from '../../../foreign/api/service.ts'; export const makeService = foreign;",
      expected: 1,
      name: 'owner-foreign-initializer',
    },
  ]);
});

it('keeps all three actual completion process children clear without source or filename exceptions', () => {
  const files = [
    'apps/shell-super-app/tests/support/privacy-completion-shell.ts',
    privacyCompletionProcess,
    'verticals/party-registry/tests/support/privacy-completion-worker.ts',
  ].map((file) => nodePath.join(appRoot, file));
  expect(runOxlint(lintConfig, files, appRoot).diagnostics.filter(({ code }) => code === ruleCode)).toEqual([]);
});

it('keeps direct pinned Effect try and catch operations inside the canonical closed-use grammar', () => {
  const syncProgram =
    "import { writeSync } from 'node:fs'; const program = Effect.try({ try: () => writeSync(3, 'private'), catch: () => new Error('unavailable') }).pipe(Effect.catch(() => Effect.void)); void program;";
  inspectProcessCapabilityCases([
    { before: syncProgram, expected: 0, name: 'direct-sync-fd-try-recovery-catch' },
    {
      before:
        "import { Effect as E } from 'effect'; const program = E.try({ try: () => 1, catch: () => new Error('unavailable') }).pipe(E.catch(() => E.void)); void program;",
      expected: 0,
      name: 'renamed-try-catch',
    },
    { before: 'const capture = Effect.try; void capture;', expected: 1, name: 'try-extraction' },
    { before: 'const recover = Effect.catch; void recover;', expected: 1, name: 'catch-extraction' },
    {
      before: "Effect['try']({ try: () => 1, catch: () => new Error('unavailable') });",
      expected: 1,
      name: 'computed-try',
    },
    { before: 'Effect.catch?.(() => Effect.void);', expected: 1, name: 'optional-catch' },
    { before: 'Effect.try.call(null, {});', expected: 1, name: 'try-call-indirection' },
    { after: 'Effect.try = replacement;', expected: 1, name: 'try-assignment-after-main' },
    { after: 'Effect.catch++;', expected: 1, name: 'catch-update-after-main' },
    { after: 'delete Effect.try;', expected: 1, name: 'try-delete-after-main' },
    {
      before: "import { Effect as E } from 'effect'; E.catch = replacement;",
      expected: 1,
      name: 'renamed-catch-mutation',
    },
    { before: 'const box = { effect: Effect }; void box;', expected: 1, name: 'try-catch-object-escape' },
    { before: 'Effect.unknownOperation();', expected: 1, name: 'unknown-operation-still-rejected' },
    {
      before: syncProgram,
      declaration:
        "import { Effect } from 'effect'; export const makeService = Effect.fn('service')(function* (dependency: { readonly read: () => string }) { return yield* Effect.try({ try: () => dependency, catch: () => new Error('unavailable') }).pipe(Effect.catch(() => Effect.succeed(dependency))); });",
      expected: 0,
      name: 'owner-definition-try-catch',
    },
  ]);
});

it('keeps direct canonical tapError and tapCause observation inside the closed process grammar', () => {
  const observe = 'const program = Effect.fail("typed").pipe(Effect.tapError(() => Effect.void)); void program;';
  const cases: readonly ProcessCapabilityCase[] = [
    { before: observe, expected: 0, name: 'tap-error-direct' },
    {
      before:
        "import { Effect as E } from 'effect'; const program = E.fail('typed').pipe(E.tapError(() => E.void)); void program;",
      expected: 0,
      name: 'tap-error-renamed-canonical',
    },
    {
      before: [
        "import { Context, Layer } from 'effect';",
        'const decorate = (actual: { readonly runAction: <A>(input: A) => A }, context: Context.Context<never>) => {',
        'const runAction: typeof actual.runAction = (input) => actual.runAction(input).pipe(Effect.tapError(() => Effect.void));',
        'return Layer.succeedContext(Context.add(context, Runtime, { ...actual, runAction })); }; void decorate;',
      ].join('\n'),
      expected: 0,
      name: 'tap-error-public-runtime-delegation',
    },
    { before: 'const observe = Effect.tapError; void observe;', expected: 1, name: 'tap-error-extraction' },
    { before: "Effect['tapError'](() => Effect.void);", expected: 1, name: 'tap-error-computed' },
    { before: 'Effect.tapError?.(() => Effect.void);', expected: 1, name: 'tap-error-optional-call' },
    { before: 'Effect?.tapError(() => Effect.void);', expected: 1, name: 'tap-error-optional-member' },
    { before: 'Effect.tapError.call(null, () => Effect.void);', expected: 1, name: 'tap-error-call-indirection' },
    { before: 'Effect.tapError.apply(null, []);', expected: 1, name: 'tap-error-apply-indirection' },
    { before: 'const alias = Effect; alias.tapError(() => Effect.void);', expected: 1, name: 'tap-error-object-alias' },
    { before: 'const box = { effect: Effect }; void box;', expected: 1, name: 'tap-error-object-escape' },
    { before: 'Effect.tapError = replacement;', expected: 1, name: 'tap-error-write-before' },
    { after: 'Effect.tapError = replacement;', expected: 1, name: 'tap-error-write-after' },
    { after: 'Effect.tapError++;', expected: 1, name: 'tap-error-update-after' },
    { after: 'delete Effect.tapError;', expected: 1, name: 'tap-error-delete-after' },
    {
      before: "import { Effect as E } from 'effect'; E.tapError = replacement;",
      expected: 1,
      name: 'tap-error-renamed-mutation',
    },
    { before: 'Effect.unknownOperation();', expected: 1, name: 'tap-error-unknown-operation' },
    {
      before: observe,
      declaration:
        "import { Effect } from 'foreign-effect'; export const makeService = Effect.fn('service')(function* (dependency: unknown) { return dependency; });",
      expected: 1,
      name: 'tap-error-foreign-effect-constructor',
    },
    {
      before: "import * as E from 'effect'; E.Effect.tapError(() => Effect.void);",
      expected: 1,
      name: 'tap-error-module-namespace',
    },
    {
      before: 'Effect.tapError(() => { const leaked = Effect; return leaked; });',
      expected: 1,
      name: 'tap-error-callback-capability-escape',
    },
    {
      before: "Effect.tapError(() => import('foreign-effect'));",
      expected: 1,
      name: 'tap-error-callback-dynamic-loader',
    },
    {
      before: "Effect.tapError(() => require('foreign-effect'));",
      expected: 1,
      name: 'tap-error-callback-require',
    },
    {
      before: "Effect.tapError(() => eval('unsafe'));",
      expected: 1,
      name: 'tap-error-callback-eval',
    },
    {
      before: 'Effect.tapError(() => Object.getPrototypeOf(Effect));',
      expected: 1,
      name: 'tap-error-callback-reflection',
    },
    {
      before: observe,
      declaration:
        "import { makeForeign } from '../../foreign-owner/api/factory.ts'; export { makeForeign as makeService };",
      expected: 1,
      name: 'tap-error-foreign-owner-reexport',
    },
    {
      before: 'Effect.tapError(() => Effect.unknownOperation());',
      expected: 1,
      name: 'tap-error-opaque-callback',
    },
    {
      before: 'Effect.tapErrorCause(() => Effect.void);',
      expected: 1,
      name: 'tap-error-cause-nonexistent-operation',
    },
  ];
  inspectProcessCapabilityCases(
    cases.flatMap((scenario) => {
      const paired = { ...scenario, name: scenario.name.replace('tap-error', 'tap-cause') };
      if (scenario.after !== undefined) {
        paired.after = scenario.after.replaceAll('tapError', 'tapCause');
      }
      if (scenario.before !== undefined) {
        paired.before = scenario.before.replaceAll('tapError', 'tapCause');
      }
      if (scenario.declaration !== undefined) {
        paired.declaration = scenario.declaration.replaceAll('tapError', 'tapCause');
      }
      return [scenario, paired];
    }),
  );
});

it('keeps the actual typed-error Privacy process floor clear without source exceptions', () => {
  const file = nodePath.join(appRoot, privacyCompletionProcess);
  expect(runOxlint(lintConfig, [file], appRoot).diagnostics.filter(({ code }) => code === ruleCode)).toEqual([]);
});

interface BffCase {
  readonly consumer?: string;
  readonly expected: number;
  readonly extra?: string;
  readonly name: string;
  readonly replace?: readonly [string, string];
  readonly source?: string;
}
const bffFactorySource = [
  "import { assembleEffectBffRuntime } from '@modern-js/bff-effect/assembly';",
  "import { Layer } from '@modern-js/bff-effect/effect-edge';",
  "import type { EffectBffDefinition, EffectBffRuntime } from '@modern-js/bff-effect/effect-edge';",
  "import { Api } from '../shared/api.ts';",
  "const header = (headers: unknown, key: string) => headers[key]; header({}, 'x-correlation-id'); header({}, 'idempotency-key');",
  'const group = Layer.mergeAll();',
  'export const makeRuntime = (): EffectBffDefinition<typeof Api> & EffectBffRuntime<typeof Api> => {',
  'const handlers = Layer.mergeAll(group).pipe(Layer.provide(group), Layer.orDie);',
  bffAssemblyReturn,
  '};',
  'const runtime = makeRuntime(); void runtime;',
].join('\n');
const inspectBffCases = (cases: readonly BffCase[]): void => {
  withTemporaryWorkspace((directory) => {
    const files = cases.map((scenario) => {
      const owner = nodePath.join(directory, 'app/verticals', scenario.name);
      mkdirSync(nodePath.join(owner, 'api'), { recursive: true });
      mkdirSync(nodePath.join(owner, 'shared'), { recursive: true });
      mkdirSync(nodePath.join(owner, supportDirectory), { recursive: true });
      writeFileSync(nodePath.join(owner, 'shared/api.ts'), 'export const Api = {};');
      const baseline = scenario.source ?? bffFactorySource;
      const original = scenario.replace === undefined ? baseline : baseline.replace(...scenario.replace);
      writeFileSync(nodePath.join(owner, 'api/index.ts'), `${original}\n${scenario.extra ?? ''}`);
      const consumer = nodePath.join(owner, supportDirectory, bootstrapFilename);
      writeFileSync(
        consumer,
        scenario.consumer ??
          [processImports, "import { makeRuntime } from '../../api/index.ts'; void makeRuntime;", directRunMain].join(
            '\n',
          ),
      );
      return consumer;
    });
    const diagnostics = runOxlint(lintConfig, files, appRoot).diagnostics.filter(({ code }) => code === ruleCode);
    for (const scenario of cases) {
      expect(diagnostics.filter(({ filename }) => filename.includes(`/${scenario.name}/`)).length, scenario.name).toBe(
        scenario.expected,
      );
    }
  }, testsDirectory);
};

it('classifies only genuine immutable same-owner canonical BFF assembly factories', () => {
  inspectBffCases([
    { expected: 0, name: 'bff-canonical' },
    { expected: 1, extra: 'export const empty = Layer.empty; Layer.provide(empty);', name: 'bff-empty-layer-export' },
    {
      expected: 1,
      extra: "import * as Other from 'effect/Layer'; Other.mergeAll = replacement;",
      name: 'bff-layer-subpath-alias',
    },
    {
      expected: 1,
      extra: "import { Layer as Other } from '@modern-js/bff-effect/effect-server'; Other.mergeAll = replacement;",
      name: 'bff-layer-barrel-alias',
    },
    {
      consumer:
        "import { NodeRuntime } from '@effect/platform-node'; import { Effect } from 'effect'; import { makeRuntime, makeRawService } from '../../api/index.ts'; void makeRuntime; void makeRawService; NodeRuntime.runMain(Effect.void);",
      expected: 1,
      extra: 'export const makeRawService = () => group;',
      name: 'bff-raw-service-isolated',
    },

    {
      expected: 0,
      name: 'bff-empty-layer-value',
      replace: [
        'const group = Layer.mergeAll();',
        'const group = Layer.mergeAll(); const optionalLayer = enabled ? group : Layer.empty; Layer.provide(optionalLayer);',
      ],
    },
    { expected: 1, extra: 'Layer.empty();', name: 'bff-empty-layer-call' },
    { expected: 1, extra: 'const empty = Layer.empty; empty();', name: 'bff-empty-layer-alias-call' },
    { expected: 1, extra: 'Layer.empty = replacement;', name: 'bff-empty-layer-mutation' },
    {
      expected: 1,
      extra: "import { Api as Other } from '../shared/api.ts'; Other.changed = replacement;",
      name: 'bff-api-second-alias-mutation',
    },
    {
      expected: 1,
      extra: "import * as Other from '../shared/api.ts'; const api = Other.Api; void api;",
      name: 'bff-api-namespace-escape',
    },
    { expected: 1, extra: 'type EffectBffRuntime<T> = T;', name: 'bff-type-shadow' },
    { expected: 1, extra: 'consume(Api);', name: 'bff-api-escaped' },
    {
      expected: 1,
      name: 'bff-assembler-call-indirection',
      replace: ['return assembleEffectBffRuntime({', 'return assembleEffectBffRuntime.call(null, {'],
    },

    {
      expected: 0,
      name: 'bff-renamed-assembler',
      source: bffFactorySource
        .replace('{ assembleEffectBffRuntime }', '{ assembleEffectBffRuntime as assemble }')
        .replace('return assembleEffectBffRuntime(', 'return assemble('),
    },
    {
      expected: 1,
      name: 'bff-wrong-assembler-origin',
      replace: ["from '@modern-js/bff-effect/assembly'", "from 'foreign-assembly'"],
    },
    {
      expected: 1,
      name: 'bff-fake-type-origin',
      replace: [
        "import type { EffectBffDefinition, EffectBffRuntime } from '@modern-js/bff-effect/effect-edge'",
        "import type { EffectBffDefinition, EffectBffRuntime } from 'foreign-types'",
      ],
    },
    { expected: 1, name: 'bff-fake-api', replace: ["import { Api } from '../shared/api.ts';", 'const Api = {};'] },
    { expected: 1, extra: 'const box = { assembleEffectBffRuntime }; void box;', name: 'bff-assembler-escape' },
    {
      expected: 1,
      extra:
        "import { assembleEffectBffRuntime as other } from '@modern-js/bff-effect/assembly'; other.value = replacement;",
      name: 'bff-second-assembler-mutation',
    },
    {
      expected: 1,
      extra: "import { default as other } from '@modern-js/bff-effect/assembly'; void other;",
      name: 'bff-second-assembler-default',
    },
    { expected: 1, extra: 'Layer.mergeAll = replacement;', name: 'bff-layer-mutated' },
    {
      expected: 1,
      name: 'bff-return-wrapped',
      replace: [bffAssemblyReturn, 'return wrap(assembleEffectBffRuntime({ api: Api, handlers }));'],
    },
    {
      expected: 1,
      name: 'bff-early-return',
      replace: [
        'const handlers = Layer.mergeAll(group)',
        'if (flag) return {}; const handlers = Layer.mergeAll(group)',
      ],
    },
    { expected: 1, name: 'bff-wrong-handler', replace: ['handlers });', 'handlers: {} });'] },
    {
      expected: 1,
      name: 'bff-dummy-call',
      replace: [bffAssemblyReturn, 'assembleEffectBffRuntime({ api: Api, handlers }); return group;'],
    },
    {
      consumer: "import { makeRuntime } from '../../api/index.ts'; void makeRuntime;",
      expected: 1,
      name: 'bff-runtime-consumer',
    },
    {
      consumer:
        "import { NodeRuntime } from '@effect/platform-node'; import { Effect } from 'effect'; import { makeRuntime } from '../../api/index.ts'; export const helper = makeRuntime; NodeRuntime.runMain(Effect.void);",
      expected: 1,
      name: 'bff-exported-support',
    },
    { expected: 1, extra: loaderAcquisition, name: 'bff-loader-after' },
    { expected: 1, extra: "const load = import('ordinary'); void load;", name: 'bff-import-after' },
    { expected: 1, name: 'bff-unknown-handler-pipe', replace: ['Layer.orDie);', 'Layer.unknown);'] },
  ]);
});

it('closes finite data keys over all immutable local helper callers before BFF classification', () => {
  inspectBffCases([
    { expected: 0, name: 'bff-key-positive' },
    { expected: 1, extra: 'export { header };', name: 'bff-key-export' },

    {
      expected: 0,
      extra: "const key1 = 'x-safe'; const key2 = key1; header({}, key2);",
      name: 'bff-key-literal-alias',
    },
    {
      expected: 1,
      extra: 'const later = () => header({}, unknownKey); void later;',
      name: 'bff-key-hidden-late-caller',
    },

    { expected: 1, extra: 'header({}, unknownKey);', name: 'bff-key-late-unknown-caller' },
    { expected: 1, extra: "header({}, 'constructor');", name: 'bff-key-reflective-caller' },
    { expected: 1, extra: 'const callback = header; void callback;', name: 'bff-key-callback-escape' },
    { expected: 1, extra: 'header(...arguments_);', name: 'bff-key-spread' },
    { expected: 1, extra: 'header({});', name: 'bff-key-omitted' },
    {
      expected: 1,
      name: 'bff-key-recursion',
      replace: ['=> headers[key]', "=> header(headers, 'safe') || headers[key]"],
    },
    { expected: 1, name: 'bff-key-default', replace: ['key: string)', "key: string = 'safe')"] },
    { expected: 1, extra: "header?.({}, 'safe');", name: 'bff-key-optional-caller' },
    { expected: 1, extra: "header.call(null, {}, 'safe');", name: 'bff-key-call-indirection' },
  ]);
});

it('closes strict scalar observations and rejects computed evaluator capabilities or result escapes', () => {
  const observe =
    'const policy = (map: unknown, key: string) => { const status = map[key]; if (status === 403) return 1; if (status === 409) return 2; if (status !== 422) return 3; return 4; };';
  const carrier =
    "const key = ['con', 'structor'].join(''); const carrier = () => {}; const evaluate = carrier[key]; evaluate('return globalThis')();";
  inspectBffCases([
    { expected: 0, extra: observe, name: 'bff-observation-positive' },
    {
      expected: 0,
      extra: observe.replace('const status = map[key];', 'const value = map[key]; const status = value;'),
      name: 'bff-observation-alias-positive',
    },
    {
      expected: 1,
      extra: observe.replace(statusComparison, 'new status(); if (status === 403)'),
      name: 'bff-observation-new',
    },
    {
      expected: 1,
      extra: observe.replace(statusComparison, 'const { value } = status; void value; if (status === 403)'),
      name: 'bff-observation-destructure',
    },
    {
      expected: 1,
      extra: observe.replace(statusComparison, 'const result = status ?? 0; void result; if (status === 403)'),
      name: 'bff-observation-nullish',
    },
    {
      expected: 1,
      extra: 'const status = input[key]; if (status === 403) consume(1); export { status };',
      name: 'bff-observation-export',
    },
    {
      expected: 1,
      extra: `const key = { toString() { ${carrier} } }; const status = input[key]; if (status === 403) consume(1);`,
      name: 'bff-key-coercion-hidden',
    },

    {
      expected: 1,
      extra: observe.replace(statusComparison, 'status(); if (status === 403)'),
      name: 'bff-observation-call',
    },
    {
      expected: 1,
      extra: observe.replace(statusComparison, 'const alias = status; alias(); if (status === 403)'),
      name: 'bff-observation-alias-call',
    },
    {
      expected: 1,
      extra: observe.replace(statusComparison, 'consume(status); if (status === 403)'),
      name: 'bff-observation-argument',
    },
    {
      expected: 1,
      extra: observe.replace(statusComparison, 'const box = { status }; void box; if (status === 403)'),
      name: 'bff-observation-container',
    },
    { expected: 1, extra: observe.replace('return 4;', 'return status;'), name: 'bff-observation-return' },
    { expected: 1, extra: observe.replace('status === 403', 'status == 403'), name: 'bff-observation-coercion' },
    {
      expected: 1,
      extra: observe.replace(statusComparison, 'status?.(); if (status === 403)'),
      name: 'bff-observation-optional-call',
    },
    {
      expected: 1,
      extra: observe.replace(statusComparison, 'status.value; if (status === 403)'),
      name: 'bff-observation-member',
    },
    {
      expected: 1,
      extra: observe.replace(statusComparison, 'status`code`; if (status === 403)'),
      name: 'bff-observation-template',
    },
    { expected: 1, extra: carrier, name: 'bff-computed-constructor' },
    { expected: 1, extra: `const hidden = () => { ${carrier} }; void hidden;`, name: 'bff-computed-callback' },
    {
      expected: 1,
      extra: "const key = ['con', 'structor'].join(''); const { [key]: evaluate } = () => {}; evaluate('code');",
      name: 'bff-computed-destructure',
    },
    {
      expected: 1,
      extra: 'const { constructor: evaluate } = () => {}; evaluate("code");',
      name: 'bff-static-destructure',
    },
    { expected: 1, extra: 'const value = input?.[key]; value();', name: 'bff-optional-computed' },
    { expected: 1, extra: `const object = { get value() { ${carrier} } }; void object;`, name: 'bff-getter-hidden' },
    {
      expected: 1,
      extra: `const object = new Proxy({}, { get() { ${carrier} } }); void object;`,
      name: 'bff-proxy-hidden',
    },
  ]);
});

it('proves the actual Shell API composition factory from current owner source without executing it', () => {
  withTemporaryWorkspace((directory) => {
    const owner = nodePath.join(directory, 'app/apps/shell-super-app');
    for (const file of ['api/index.ts', 'api/shell-transport.ts', 'shared/api.ts', 'src/module-api/transport.ts']) {
      const target = nodePath.join(owner, file);
      mkdirSync(nodePath.dirname(target), { recursive: true });
      writeFileSync(target, readFileSync(nodePath.join(appRoot, 'apps/shell-super-app', file), 'utf-8'));
    }
    const consumer = nodePath.join(owner, supportDirectory, bootstrapFilename);
    mkdirSync(nodePath.dirname(consumer), { recursive: true });
    writeFileSync(
      consumer,
      [
        processImports,
        "import { makeShellAuthenticationApiRuntime } from '../../api/index.ts'; void makeShellAuthenticationApiRuntime;",
        directRunMain,
      ].join('\n'),
    );
    expect(runOxlint(lintConfig, [consumer], appRoot).diagnostics.filter(({ code }) => code === ruleCode)).toEqual([]);
  }, testsDirectory);
});

const finiteKeyParameterProbe = (body: string): string =>
  `const read = (object: unknown, key: string) => { ${body} }; const evaluate = read(() => {}, 'safe'); evaluate('return 1')();`;

it('requires closed immutable finite-key parameter references rather than literal callers alone', () => {
  inspectBffCases([
    {
      expected: 1,
      extra: finiteKeyParameterProbe('const { ...alias } = key; consume(alias); return object[key];'),
      name: 'bff-key-parameter-destructure-escape',
    },
    {
      expected: 1,
      extra: finiteKeyParameterProbe('const alias = { ...key }; consume(alias); return object[key];'),
      name: 'bff-key-parameter-spread-escape',
    },
    {
      expected: 1,
      extra: finiteKeyParameterProbe('const [alias] = [key]; consume(alias); return object[key];'),
      name: 'bff-key-parameter-array-escape',
    },
    {
      expected: 1,
      extra: finiteKeyParameterProbe('const alias = () => key; consume(alias); return object[key];'),
      name: 'bff-key-parameter-closure-escape',
    },
    {
      expected: 0,
      extra: finiteKeyParameterProbe('const alias = key; return object[alias];'),
      name: 'bff-key-parameter-alias-positive',
    },
    {
      expected: 0,
      extra: finiteKeyParameterProbe(
        "const local = (key: string) => { key = 'constructor'; }; local('other'); return object[key];",
      ),
      name: 'bff-key-parameter-shadow-positive',
    },
    {
      expected: 1,
      extra: finiteKeyParameterProbe("key = 'constructor'; return object[key];"),
      name: 'bff-key-parameter-assigned',
    },
    {
      expected: 1,
      extra: finiteKeyParameterProbe("({ key } = { key: 'constructor' }); return object[key];"),
      name: 'bff-key-parameter-destructure-assigned',
    },
    {
      expected: 1,
      extra: finiteKeyParameterProbe("key += 'constructor'; return object[key];"),
      name: 'bff-key-parameter-compound-assigned',
    },
    {
      expected: 1,
      extra: finiteKeyParameterProbe("const mutate = () => { key = 'constructor'; }; mutate(); return object[key];"),
      name: 'bff-key-parameter-callback-assigned',
    },
    { expected: 1, extra: finiteKeyParameterProbe('key++; return object[key];'), name: 'bff-key-parameter-updated' },
    {
      expected: 1,
      extra: finiteKeyParameterProbe('for (key in { constructor: 1 }) {} return object[key];'),
      name: 'bff-key-parameter-for-in',
    },
    {
      expected: 1,
      extra: finiteKeyParameterProbe("for (key of ['constructor']) {} return object[key];"),
      name: 'bff-key-parameter-for-of',
    },
    {
      expected: 1,
      extra: finiteKeyParameterProbe("([...key] = ['constructor']); return object[key];"),
      name: 'bff-key-parameter-rest-assigned',
    },
    {
      expected: 1,
      extra: finiteKeyParameterProbe('consume(key); return object[key];'),
      name: 'bff-key-parameter-argument-escape',
    },
    {
      expected: 1,
      extra: finiteKeyParameterProbe('const box = { key }; consume(box); return object[key];'),
      name: 'bff-key-parameter-container-escape',
    },
    {
      expected: 1,
      extra: finiteKeyParameterProbe('const alias = key; consume(alias); return object[key];'),
      name: 'bff-key-parameter-alias-escape',
    },
    {
      expected: 1,
      extra: finiteKeyParameterProbe("const alias = key; ([alias] = ['constructor']); return object[alias];"),
      name: 'bff-key-parameter-alias-destructure',
    },
  ]);
});

it('recognizes the real legacy receiver process protocol without weakening owner provenance', () => {
  const consumer = (body: string) =>
    [
      processImports,
      "import { createInterface } from 'node:readline';",
      "import { makeRuntime } from '../../api/index.ts';",
      body,
      'makeRuntime();',
      directRunMain,
    ].join('\n');
  inspectBffCases([
    {
      consumer: consumer(
        "const input = createInterface({ input: process.stdin }); process.stdin.on('data', () => {}); process.stdin.destroy(new Error('bounded')); void input;",
      ),
      expected: 0,
      name: 'legacy-stdin-protocol',
    },
    {
      consumer: consumer('const input = channel; input[Symbol.asyncIterator]();'),
      expected: 0,
      name: 'legacy-async-iterator',
    },
    { consumer: consumer('Effect.catchCause(() => Effect.void);'), expected: 0, name: 'legacy-cause-recovery' },
    {
      consumer: consumer('const Symbol = source; channel[Symbol.asyncIterator]();'),
      expected: 1,
      name: 'legacy-symbol-shadow',
    },
    {
      consumer: consumer('Symbol.asyncIterator = replacement; channel[Symbol.asyncIterator]();'),
      expected: 1,
      name: 'legacy-symbol-mutation',
    },
    { consumer: consumer('channel[key]();'), expected: 1, name: 'legacy-unknown-protocol-key' },

    {
      consumer: consumer("Symbol = { asyncIterator: 'constructor' }; channel[Symbol.asyncIterator]();"),
      expected: 1,
      name: 'legacy-symbol-global-assignment',
    },
    {
      consumer: consumer('({ Symbol } = replacement); channel[Symbol.asyncIterator]();'),
      expected: 1,
      name: 'legacy-symbol-destructured-assignment',
    },
    {
      consumer: consumer('[Symbol] = replacement; channel[Symbol.asyncIterator]();'),
      expected: 1,
      name: 'legacy-symbol-array-assignment',
    },
    {
      consumer: consumer('for (Symbol of values) {} channel[Symbol.asyncIterator]();'),
      expected: 1,
      name: 'legacy-symbol-loop-assignment',
    },
    {
      consumer: consumer('const alias = Symbol; mutate(alias); channel[Symbol.asyncIterator]();'),
      expected: 1,
      name: 'legacy-symbol-alias-escape',
    },

    {
      consumer: consumer('const input = process.stdin; consume(input);'),
      expected: 1,
      name: 'legacy-stdin-alias-escape',
    },
    { consumer: consumer('process.stdin.constructor;'), expected: 1, name: 'legacy-stdin-reflection' },
    {
      consumer: consumer('const recover = Effect.catchCause; recover(program);'),
      expected: 1,
      name: 'legacy-cause-extraction',
    },
    { consumer: consumer('Effect.catchCause = replacement;'), expected: 1, name: 'legacy-cause-mutation' },
    {
      consumer: consumer(
        "import { createRequire } from 'node:module'; const input = createInterface({ input: process.stdin }); void input; void createRequire;",
      ),
      expected: 1,
      name: 'legacy-loader-with-protocol',
    },
    {
      consumer: consumer('const NodeRuntime = fake;').replace(
        'import { NodeRuntime }',
        'import { NodeRuntime as ActualRuntime }',
      ),
      expected: 1,
      name: 'legacy-fake-main',
    },
    {
      consumer: consumer('').replace('../../api/index.ts', '../../../foreign/api/index.ts'),
      expected: 1,
      name: 'legacy-foreign-owner',
    },
  ]);
});

it('proves supported subpath test roots and closed exported controls without admitting runtime capabilities', () => {
  const actualFilename = nodePath.join(appRoot, privacyCompletionProcess);
  const actualSource = readFileSync(actualFilename, 'utf-8');
  const control = actualSource.slice(
    actualSource.indexOf('export const makeReportResponseLossControl'),
    actualSource.indexOf('// Immutable historical TEST producer'),
  );
  expect(control.startsWith('export const makeReportResponseLossControl')).toBe(true);
  expect(runOxlint(lintConfig, [actualFilename], appRoot).diagnostics.filter(({ code }) => code === ruleCode)).toEqual(
    [],
  );
  withTemporaryWorkspace((directory) => {
    const owner = nodePath.join(directory, 'app/verticals/privacy');
    const support = nodePath.join(owner, 'tests/support');
    const api = nodePath.join(owner, 'api');
    mkdirSync(support, { recursive: true });
    mkdirSync(api, { recursive: true });
    writeFileSync(
      nodePath.join(api, 'closed-runtime.ts'),
      'export const makePrivacyApiRuntime = (dependency: {readonly read:()=>string}) => dependency;',
    );
    const filename = nodePath.join(support, 'completion.ts');
    const imports =
      "import {runMain as main} from '@effect/platform-node/NodeRuntime'; import {Effect} from 'effect'; import {makePrivacyApiRuntime} from '../../api/closed-runtime.ts';";
    const assemblyCall = "makePrivacyApiRuntime({read:()=> 'fixture'});";
    const root = 'main(Effect.void);';
    const count = (source: string) => {
      writeFileSync(filename, source);
      return runOxlint(lintConfig, [filename], appRoot).diagnostics.filter(({ code }) => code === ruleCode).length;
    };
    const valid = `${imports} ${control} ${assemblyCall} ${root}`;
    expect(count(valid)).toBe(0);
    expect(
      count(
        `${valid} const startupFlag = '--legacy'; process.argv.includes(startupFlag); void process.ppid; void process.execPath; const legacy = import.meta.fixtureBuild === true;`,
      ),
    ).toBe(0);
    for (const invalid of [
      valid.replace("'@effect/platform-node/NodeRuntime'", "'foreign-runtime'"),
      valid
        .replace('runMain as main', 'runMain as acquired')
        .replace(root, 'const main = acquired; main(Effect.void);'),
      valid.replace(root, 'const launch = () => { main(Effect.void); }; launch();'),
      valid.replace(root, 'main = () => undefined; main(Effect.void);'),
      valid.replace(root, 'void main; main(Effect.void);'),
      valid.replace(control, 'export const unrelated = {};'),
      valid.replace(control, 'export default {};'),
      valid.replace(control, "export * from '../../api/closed-runtime.ts';"),
      valid.replace('let armed = false;', 'let armed = process.pid;'),
      valid.replace('let armed = false;', "let armed = makePrivacyApiRuntime({read:()=> 'bad'});"),
      valid.replace('close();', 'process.exit();'),
      valid.replace('close();', 'const callback = close; callback();'),
      valid.replace('close();', 'return close;'),
      valid.replace('close();', 'close.constructor();'),
      valid.replace(
        'observe: () => ({ armed, committedResponseStatus, discardedResponses })',
        'observe: () => process.env',
      ),
      `${valid} process.ppid = 1;`,
      `${valid} process.execPath = 'foreign';`,
      `${valid} let flag = '--legacy'; process.argv.includes(flag);`,
      `${valid} const flag = process.env.FLAG; process.argv.includes(flag);`,
      `${valid} import.meta.fixtureBuild();`,
      `${valid} const metadata = import.meta;`,
      `${valid} import.meta.fixtureBuild = true;`,
    ]) {
      expect(count(invalid), invalid).toBe(1);
    }
    const runtimeFile = nodePath.join(owner, 'src/runtime.ts');
    mkdirSync(nodePath.dirname(runtimeFile), { recursive: true });
    writeFileSync(runtimeFile, valid);
    expect(
      runOxlint(lintConfig, [runtimeFile], appRoot).diagnostics.filter(({ code }) => code === ruleCode),
    ).toHaveLength(1);
    const foreignImport = valid.replace("'../../api/closed-runtime.ts'", "'../../../other/api/closed-runtime.ts'");
    const other = nodePath.join(directory, 'app/verticals/other/api');
    mkdirSync(other, { recursive: true });
    writeFileSync(
      nodePath.join(other, 'closed-runtime.ts'),
      'export const makePrivacyApiRuntime = (dependency: {readonly read:()=>string}) => dependency;',
    );
    expect(count(foreignImport)).toBe(1);
  }, testsDirectory);
});

it('closes NodeRuntime subpath capabilities in governed BFF origins', () => {
  inspectBffCases([
    { expected: 0, name: 'bff-subpath-unchanged-positive' },
    {
      expected: 1,
      extra:
        "import { runMain as launch } from '@effect/platform-node/NodeRuntime'; export const escapedRuntime = launch;",
      name: 'bff-subpath-runtime-escape',
    },
    {
      expected: 1,
      extra: "import { runMain as launch } from '@effect/platform-node/NodeRuntime'; const alias = launch; void alias;",
      name: 'bff-subpath-runtime-alias',
    },
    {
      expected: 1,
      extra: "import { runMain as launch } from '@effect/platform-node/NodeRuntime'; launch(Effect.void);",
      name: 'bff-subpath-runtime-call',
    },
  ]);
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
