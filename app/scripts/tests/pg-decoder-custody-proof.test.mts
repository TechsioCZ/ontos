import { readFile } from 'node:fs/promises';
import { Effect, Path } from 'effect';
import { expect, it } from 'effect-rstest';
import { parseSync, Visitor } from 'oxc-parser';
import type { Expression } from 'oxc-parser';

import { hasClosedNativePgDecoderRegistryCustody } from '../pg-decoder-custody-proof.mts';
import type { PgDecoderImportEdge } from '../pg-decoder-custody-proof.mts';
import { makeScopedContextFactoryResolver } from '../scoped-context-factory-proof.mts';

const fixtureFile = '/fixture/main.ts';
const barrelFile = '/fixture/barrel.ts';
const nativeRootKind = 'native-pg-root';
const otherNativeKind = 'other-native';
const importEdge = (file: string, source: string): PgDecoderImportEdge | undefined => {
  if (source === '@effect/sql-pg') {
    return { kind: nativeRootKind };
  }
  if (source === '@effect/sql-pg/PgTypes') {
    return { kind: 'native-pg-types' };
  }
  if (source === 'effect') {
    return { kind: otherNativeKind };
  }
  return source === './barrel' && file === fixtureFile ? { file: barrelFile, kind: 'module' } : undefined;
};

const probeSuffix = ';export const decoderCustodyProbe=()=>0;decoderCustodyProbe();';
const corpus = (entries: readonly (readonly [string, string])[]) =>
  Effect.gen(function* proofFixture() {
    const path = yield* Path.Path;
    const sources = new Map(entries.map(([file, source]) => [file, `${source}${probeSuffix}`]));
    const resolver = makeScopedContextFactoryResolver(sources, '/fixture', path, new Map());
    for (const [file, source] of sources) {
      const parsed = parseSync(file, source, { sourceType: 'module' });
      expect(parsed.errors, source).toEqual([]);
      let probe: Expression | undefined;
      new Visitor({
        CallExpression: (node) => {
          if (node.callee.type === 'Identifier' && node.callee.name === 'decoderCustodyProbe') {
            probe = node.callee;
          }
        },
      }).visit(parsed.program);
      expect(probe).toBeDefined();
      if (probe !== undefined) {
        resolver.resolveDeclaredFunction({ callee: probe, file });
      }
    }
    const modules = resolver.runtimeProofModules();
    expect(modules).toHaveLength(entries.length);
    return modules;
  }).pipe(Effect.provide(Path.layer));
const prove = (entries: readonly (readonly [string, string])[]) =>
  corpus(entries).pipe(Effect.map((modules) => hasClosedNativePgDecoderRegistryCustody(modules, importEdge)));
const single = (source: string) => prove([[fixtureFile, source]]);

const prefix = "import {PgTypes} from '@effect/sql-pg';";

for (const [name, body, expected] of [
  [
    'actual scoped routine parameter readers',
    'const oid=PgTypes.OID.int8;PgTypes.jsonb(value);PgTypes.array(values,oid);',
    true,
  ],
  ['readonly computed own OID', "const oid=PgTypes['OID']['text'];", true],
  ['erased codec error type', 'type Failure=PgTypes.CodecError;', true],
  ['global registration', 'PgTypes.register(25,codec);', false],
  ['global unregistration', 'PgTypes.unregister(25);', false],
  ['extracted registration', 'const mutate=PgTypes.register;mutate(25,codec);', false],
  ['namespace alias', 'const alias=PgTypes;alias.register(25,codec);', false],
  ['namespace return', 'function expose(){return PgTypes;}', false],
  ['namespace container', 'const box={types:PgTypes};foreign(box);', false],
  ['namespace storage', 'box.types=PgTypes;foreign(box);', false],
  ['namespace argument', 'foreign(PgTypes);', false],
  ['forged encoder borrower', 'foreign.jsonb(PgTypes);', false],
  ['namespace reflection', "Reflect.get(PgTypes,'register')(25,codec);", false],
  ['namespace export', 'export {PgTypes};', false],
  ['OID mutation', 'PgTypes.OID.text=25;', false],
  ['OID argument escape', 'foreign(PgTypes.OID);', false],
  ['OID container escape', 'const values=[PgTypes.OID];foreign(values);', false],
  ['OID inherited field', 'const value=PgTypes.OID.constructor;', false],
  ['parameter function escape', 'const encode=PgTypes.jsonb;foreign(encode);', false],
  ['mutating parameter function', 'PgTypes.jsonb.custom=foreign;', false],
  ['optional parameter call', 'PgTypes.jsonb?.(value);', false],
  ['spread parameter call', 'PgTypes.array(...values);', false],
  [
    'explicit client registry construction',
    'const registry=PgTypes.makeRegistry();registry.register(25,codec);',
    false,
  ],
  ['native dynamic module', "const types=await import('@effect/sql-pg/PgTypes');", false],
  ['unknown dynamic module', 'const types=await import(source);', false],
  ['require module loader', "const types=require('@effect/sql-pg/PgTypes');", false],
  ['Function module loader', "Function('return import(source)')();", false],
  ['Function alias module loader', "const load=Function;load('return import(source)')();", false],
  ['extracted constructor module loader', "const load=(()=>0).constructor;load('return import(source)')();", false],
  [
    'computed constructor alias loader',
    "const key='constructor';const load=(()=>0)[key];load('return import(source)')();",
    false,
  ],
  ['reflected constructor loader', "Reflect.get(()=>0,'constructor')('return import(source)')();", false],
  ['destructured global loader', "const {Function:Compile}=globalThis;Compile('return import(source)')();", false],
  [
    'destructured function constructor loader',
    "const {constructor:Compile}=function(){};Compile('return import(source)')();",
    false,
  ],
  [
    'nested destructured loader',
    "const holder={root:globalThis};const {root:{Function:Compile}}=holder;Compile('return import(source)')();",
    false,
  ],
  [
    'defaulted destructured loader',
    "const {Function:Compile=()=>0}=globalThis;Compile('return import(source)')();",
    false,
  ],
  [
    'computed destructured loader',
    "const key='Function';const {[key]:Compile}=globalThis;Compile('return import(source)')();",
    false,
  ],
  [
    'literal named native import',
    "import {'PgTypes' as Registry}from '@effect/sql-pg';Registry.register(25,codec);",
    false,
  ],
  ['inline type-only known-native export names', "export{type PgTypes}from '@effect/sql-pg';", true],
  [
    'inline type-only known-native import names',
    "import{type CodecError}from '@effect/sql-pg/PgTypes';type Failure=CodecError;",
    true,
  ],
  ['inline type-only foreign import still has runtime edge', "import{type T}from 'foreign';", false],
  ['whole type-only foreign import erased', "import type{T}from 'foreign';", true],
  ['whole type-only foreign export erased', "export type{T}from 'foreign';", true],
  ['constructor module loader', "(()=>0).constructor('return import(source)')();", false],
] as const) {
  it.effect(`proves decoder registry custody: ${name}`, () =>
    single(`${prefix}${body}`).pipe(
      Effect.map((result) => {
        expect(result).toBe(expected);
        return result;
      }),
    ),
  );
}

it.effect('tracks genuine root namespace references and direct scalar imports', () =>
  prove([
    [
      fixtureFile,
      "import * as Native from '@effect/sql-pg';const oid=Native.PgTypes.OID.text;Native.PgTypes.jsonb(value);",
    ],
    [
      '/fixture/scalar.ts',
      "import {OID,jsonb,array} from '@effect/sql-pg/PgTypes';array(values,OID.text);jsonb(value);",
    ],
  ]).pipe(
    Effect.map((result) => {
      expect(result).toBe(true);
      return result;
    }),
  ),
);

it.effect('rejects actual native registry reexports through a corpus barrel', () =>
  prove([
    [fixtureFile, "import {Types} from './barrel';Types.register(25,codec);"],
    [barrelFile, "export {PgTypes as Types} from '@effect/sql-pg';"],
  ]).pipe(
    Effect.map((result) => {
      expect(result).toBe(false);
      return result;
    }),
  ),
);

it.effect('rejects a missing canonical corpus target', () =>
  single("import {Types} from './barrel';Types.register(25,codec);").pipe(
    Effect.map((result) => {
      expect(result).toBe(false);
      return result;
    }),
  ),
);

it.effect('rejects foreign and missing canonical import evidence', () =>
  single("import {PgTypes} from 'fake-pg';PgTypes.jsonb(value);").pipe(
    Effect.map((result) => {
      expect(result).toBe(false);
      return result;
    }),
  ),
);

it.effect('uses the actual lexical binding rather than a shadowed namespace name', () =>
  single(`${prefix}function local(PgTypes){PgTypes.register(25,codec);}const oid=PgTypes.OID.text;`).pipe(
    Effect.map((result) => {
      expect(result).toBe(true);
      return result;
    }),
  ),
);

it('refuses an absent runtime corpus', () => {
  expect(hasClosedNativePgDecoderRegistryCustody([], importEdge)).toBe(false);
});

it.effect('rejects a canonical-edge downgrade of the genuine native registry', () =>
  corpus([[fixtureFile, `${prefix}PgTypes.register(25,codec);`]]).pipe(
    Effect.map((modules) => {
      const result = hasClosedNativePgDecoderRegistryCustody(modules, () => ({ kind: otherNativeKind }));
      expect(result).toBe(false);
      return result;
    }),
  ),
);
it.effect('rejects a forged native edge for a foreign module', () =>
  corpus([[fixtureFile, "import {PgTypes} from 'foreign';PgTypes.jsonb(value);"]]).pipe(
    Effect.map((modules) => {
      const result = hasClosedNativePgDecoderRegistryCustody(modules, () => ({ kind: nativeRootKind }));
      expect(result).toBe(false);
      return result;
    }),
  ),
);
it.effect('requires original parsed binding nodes rather than detached equal spans', () =>
  corpus([[fixtureFile, `${prefix}const oid=PgTypes.OID.text;`]]).pipe(
    Effect.map((modules) => {
      const detached = modules.map((module) => ({
        ...module,
        bindings: module.bindings.map((binding) => ({
          ...binding,
          node: { end: binding.node.end, start: binding.node.start },
        })),
      }));
      const result = hasClosedNativePgDecoderRegistryCustody(detached, importEdge);
      expect(result).toBe(false);
      return result;
    }),
  ),
);

const nodeVariantFile = '/fixture/node.ts';
const workerVariantFile = '/fixture/workerd.ts';
const conditionalSource = "import {port}from './conditional';port();";
const portSource = 'export const port=()=>0;';
const conditionalEdges =
  (targets: readonly string[]) =>
  (file: string, source: string): PgDecoderImportEdge | undefined =>
    source === './conditional' ? { files: targets, kind: 'conditional-modules' } : importEdge(file, source);

it.effect('requires every canonical conditional variant without choosing a default', () =>
  corpus([
    [fixtureFile, conditionalSource],
    [nodeVariantFile, portSource],
    [workerVariantFile, portSource],
  ]).pipe(
    Effect.map((modules) => {
      const result = hasClosedNativePgDecoderRegistryCustody(
        modules,
        conditionalEdges([nodeVariantFile, workerVariantFile]),
      );
      expect(result).toBe(true);
      return result;
    }),
  ),
);
it.effect('rejects a missing canonical conditional target', () =>
  corpus([
    [fixtureFile, conditionalSource],
    [nodeVariantFile, portSource],
  ]).pipe(
    Effect.map((modules) => {
      const result = hasClosedNativePgDecoderRegistryCustody(
        modules,
        conditionalEdges([nodeVariantFile, workerVariantFile]),
      );
      expect(result).toBe(false);
      return result;
    }),
  ),
);
it.effect('rejects an empty conditional target set', () =>
  corpus([[fixtureFile, conditionalSource]]).pipe(
    Effect.map((modules) => {
      const result = hasClosedNativePgDecoderRegistryCustody(modules, conditionalEdges([]));
      expect(result).toBe(false);
      return result;
    }),
  ),
);
it.effect('rejects registry authority exposed by any conditional variant', () =>
  corpus([
    [fixtureFile, conditionalSource],
    [nodeVariantFile, portSource],
    [workerVariantFile, "export{PgTypes as port}from '@effect/sql-pg';"],
  ]).pipe(
    Effect.map((modules) => {
      const result = hasClosedNativePgDecoderRegistryCustody(
        modules,
        conditionalEdges([nodeVariantFile, workerVariantFile]),
      );
      expect(result).toBe(false);
      return result;
    }),
  ),
);
const forgedConditionalEdge = (file: string, source: string): PgDecoderImportEdge | undefined =>
  source === 'foreign-pg'
    ? { kind: nativeRootKind }
    : conditionalEdges([nodeVariantFile, workerVariantFile])(file, source);
it.effect('rejects a forged native origin inside a canonical conditional variant', () =>
  corpus([
    [fixtureFile, conditionalSource],
    [nodeVariantFile, portSource],
    [workerVariantFile, "import{PgTypes}from 'foreign-pg';PgTypes.jsonb(value);export const port=()=>0;"],
  ]).pipe(
    Effect.map((modules) => {
      const result = hasClosedNativePgDecoderRegistryCustody(modules, forgedConditionalEdge);
      expect(result).toBe(false);
      return result;
    }),
  ),
);

const hostPrelude =
  "const {existsSync}=process.getBuiltinModule('node:fs');const path=process.getBuiltinModule('node:path');";
const hostEdges = (file: string, source: string): PgDecoderImportEdge | undefined =>
  source === 'node:fs' || source === 'node:path' ? { kind: otherNativeKind } : importEdge(file, source);
for (const [name, source, expected] of [
  ['the two actual bootstrap fs/path sites', hostPrelude, true],
  ['a dynamic host target', 'process.getBuiltinModule(target);', false],
  ['a module-loader host target', "process.getBuiltinModule('node:module');", false],
  ['a shadowed process origin', `const process={getBuiltinModule:foreign};${hostPrelude}`, false],
  ['a modified process loader', `process.getBuiltinModule=foreign;${hostPrelude}`, false],
] as const) {
  it.effect(`checks exact Node host boundary: ${name}`, () =>
    corpus([[fixtureFile, source]]).pipe(
      Effect.map((modules) => {
        const result = hasClosedNativePgDecoderRegistryCustody(modules, hostEdges);
        expect(result).toBe(expected);
        return result;
      }),
    ),
  );
}

for (const [name, source] of [
  [
    'actual Context.get service lookup',
    "import{Context}from'effect';Context.get(executionContext,CommerceEnrollmentPreparedOwnerExecutionService);",
  ],
  [
    'actual private-symbol descriptor read',
    "const scopeProperty=Symbol('scope');Object.getOwnPropertyDescriptor(transaction,scopeProperty);",
  ],
  [
    'actual principal validator dispatch',
    'const principalContextValidators={HUMAN:()=>true};principalContextValidators[context.authMethod](context);',
  ],
] as const) {
  it.effect(`keeps actual non-loader origin: ${name}`, () =>
    corpus([[fixtureFile, source]]).pipe(
      Effect.map((modules) => {
        const result = hasClosedNativePgDecoderRegistryCustody(modules, hostEdges);
        expect(result).toBe(true);
        return result;
      }),
    ),
  );
}

it.effect('proves the actual workspace environment bootstrap host lookups', () =>
  Effect.promise(() =>
    readFile(
      new URL('../../packages/core-runtime/src/environment/workspace-environment-bootstrap.cjs', import.meta.url),
      'utf-8',
    ),
  ).pipe(
    Effect.flatMap((source) => corpus([[fixtureFile, source]])),
    Effect.map((modules) => {
      const result = hasClosedNativePgDecoderRegistryCustody(modules, hostEdges);
      expect(result).toBe(true);
      return result;
    }),
  ),
);

for (const [name, source] of [
  ['actual process computed module loader', "process['get'+'BuiltinModule']('node:module');"],
  [
    'actual global computed Function loader',
    "globalThis['Fun'+'ction']('return import(\"@effect/sql-pg/PgTypes\")')();",
  ],
] as const) {
  it.effect(`rejects sensitive computed origin: ${name}`, () =>
    corpus([[fixtureFile, source]]).pipe(
      Effect.map((modules) => {
        const result = hasClosedNativePgDecoderRegistryCustody(modules, hostEdges);
        expect(result).toBe(false);
        return result;
      }),
    ),
  );
}

for (const [name, source] of [
  ['possible sensitive global alias branch', "let g=globalThis;if(false)g={};g['Fun'+'ction']('return 7')();"],
  ['actual declared function constructor target', "function f(){};Reflect.get(f,'constructor')('return 7')();"],
] as const) {
  it.effect(`rejects executable current-origin regression: ${name}`, () =>
    corpus([[fixtureFile, source]]).pipe(
      Effect.map((modules) => {
        const result = hasClosedNativePgDecoderRegistryCustody(modules, hostEdges);
        expect(result).toBe(false);
        return result;
      }),
    ),
  );
}

it.effect('keeps the actual rest-array witness map method outside loader origins', () =>
  single('export const mergeWitnessAuthority=(...maps)=>new Map(maps.flatMap(map=>[...map]));').pipe(
    Effect.map((result) => {
      expect(result).toBe(true);
      return result;
    }),
  ),
);

it.effect('borrows Function only for the actual native Schema instance metadata', () =>
  single("import{Schema}from'effect';const metadata=Schema.instanceOf(Function);").pipe(
    Effect.map((result) => {
      expect(result).toBe(true);
      return result;
    }),
  ),
);
it.effect('rejects a fake local instanceOf Function borrower', () =>
  single('const Schema={instanceOf:value=>value};Schema.instanceOf(Function);').pipe(
    Effect.map((result) => {
      expect(result).toBe(false);
      return result;
    }),
  ),
);
it.effect('rejects a canonical foreign module pretending to be native Schema', () =>
  corpus([
    [fixtureFile, "import{Schema}from './barrel';Schema.instanceOf(Function);"],
    [barrelFile, 'export const Schema={instanceOf:value=>value};'],
  ]).pipe(
    Effect.map((modules) => {
      const result = hasClosedNativePgDecoderRegistryCustody(modules, importEdge);
      expect(result).toBe(false);
      return result;
    }),
  ),
);
it.effect('retains opaque rest element loader projection rejection', () =>
  single('export function invoke(...rest){return rest[0]("return 7")();}').pipe(
    Effect.map((result) => {
      expect(result).toBe(false);
      return result;
    }),
  ),
);

const healthEdges = (file: string, source: string): PgDecoderImportEdge | undefined =>
  ['node:http', '@effect/platform-node/NodeHttpServer', 'effect/http', 'effect/net'].includes(source)
    ? { kind: otherNativeKind }
    : hostEdges(file, source);
it.effect('proves the actual health createServer canonical HTTP host lookup', () =>
  Effect.promise(() =>
    readFile(new URL('../../packages/core-runtime/src/outbox/health.ts', import.meta.url), 'utf-8'),
  ).pipe(
    Effect.flatMap((source) => corpus([[fixtureFile, source]])),
    Effect.map((modules) => {
      const result = hasClosedNativePgDecoderRegistryCustody(modules, healthEdges);
      expect(result).toBe(true);
      return result;
    }),
  ),
);
