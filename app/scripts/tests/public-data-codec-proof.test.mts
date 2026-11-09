import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { Schema as NativeSchema, SchemaAST as NativeSchemaAST } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import { parseSync } from 'oxc-parser';

import {
  nativeColumnInitializationEvidence,
  hasClosedNativeArrayIteratorCustody,
  hasClosedNativeObjectIntrinsicCustody,
  hasClosedNativeStringConstructorCustody,
  hasClosedNativeObjectPrototypeKeyCustody,
  provesDataFactoryImport,
  provesServiceFreeSchemaExport,
  provesDefaultStructEquivalenceSchemaExport,
  provesPublicDataCodecExport,
  provesPublicDataCodecTypeExport,
} from '../../tools/oxlint/anti-slop/effect/rules/data-factory-proof.ts';

import { withTemporaryWorkspace } from '../../tools/oxlint/effect-native/tests/temporary-workspace.mts';

const actual = readFileSync(
  path.resolve(import.meta.dirname, '../../verticals/symmy-integration/shared/domain/symmy-source-selector.ts'),
  'utf-8',
);
const names = ['encodeSymmySourceSelector', 'decodeSymmySourceSelector', 'verifySymmySourceSelector'];
const trace = "Effect.fn('SymmySourceSelector.decode')";
const nativeHashImport = "from '@noble/hashes/sha2.js'";
const nativeBytesImport = "from '@noble/hashes/utils.js'";
const foreignHashModule = './foreign-hash.ts';
const foreignBytesModule = './foreign-bytes.ts';
const sourceHash = 'sha256(utf8ToBytes(value))';
const nativeImports = "import { Effect, Schema } from 'effect';";
const legacyBranch = "  if (!code.startsWith('~c14s1.'))";

it('proves every actual public source-selector wire codec through its closed data dependencies', () => {
  for (const name of names) {
    expect(provesPublicDataCodecExport(actual, name), name).toBe(true);
  }
  const renamed = actual
    .replace('import { sha256 }', 'import { sha256 as digest }')
    .replace(sourceHash, 'digest(utf8ToBytes(value))')
    .replace('import { Effect, Match, Schema }', 'import { Effect as CodecEffect, Match, Schema }')
    .replaceAll('Effect.', 'CodecEffect.')
    .replaceAll('encodeSymmySourceSelector', 'wireEncode');
  expect(provesPublicDataCodecExport(renamed, 'wireEncode')).toBe(true);
  expect(provesPublicDataCodecExport(renamed, 'decodeSymmySourceSelector')).toBe(true);
  expect(provesPublicDataCodecExport(renamed, 'verifySymmySourceSelector')).toBe(true);
});

for (const [name, source] of [
  [
    'native generator codec',
    `${nativeImports} export const parse=(input:string)=>Effect.gen(function*(){return yield* Schema.decodeUnknownEffect(Schema.String)(input);});`,
  ],
  [
    'native mapped codec',
    `${nativeImports} export const parse=(input:string)=>Schema.decodeUnknownEffect(Schema.String)(input).pipe(Effect.map(value=>({value})));`,
  ],
  ['closed textual data', 'export const parse=(input:string)=>input.trim().toLowerCase();'],
] as const) {
  it(`accepts ${name}`, () => expect(provesPublicDataCodecExport(source, 'parse')).toBe(true));
}

const invalid = [
  ['foreign hash import', actual.replace(nativeHashImport, `from '${foreignHashModule}'`)],
  ['foreign byte encoding', actual.replace(nativeBytesImport, `from '${foreignBytesModule}'`)],
  ['foreign effect namespace', actual.replace("from 'effect'", "from './foreign-effect.ts'")],
  ['unused runtime authority', `import { Context } from 'effect';\n${actual}`],
  ['side-effect import', `import './ambient.ts';\n${actual}`],
  ['ambient source key', actual.replace('utf8ToBytes(value)', 'utf8ToBytes(process.env.SOURCE_KEY)')],
  [
    'ambient source object',
    actual.replace('const route = scope.sourceRouteId ?? scope.routeId;', 'const route = globalThis.route;'),
  ],
  ['random source key', actual.replace('utf8ToBytes(value)', 'utf8ToBytes(String(Math.random()))')],
  ['unmodeled hash member', actual.replace(sourceHash, 'sha256.random(utf8ToBytes(value))')],
  ['unmodeled byte member', actual.replace(sourceHash, 'sha256(utf8ToBytes.unsafe(value))')],
  ['mutated hash binding', `${actual}\nsha256 = foreignHash;`],
  ['mutated hash member', `${actual}\nsha256.create = foreignHash;`],
  ['eager codec invocation', `${actual}\nconst eager = decodeSymmySourceSelector('~c14s1.code');`],
  [
    'eager factory invocation',
    actual.replace(
      '});\n\nexport const verifySymmySourceSelector',
      "})('input');\n\nexport const verifySymmySourceSelector",
    ),
  ],
  ['dynamic trace', actual.replace(trace, 'Effect.fn(process.env.TRACE)')],
  ['effectful trace', actual.replace(trace, 'Effect.fn(readTrace())')],
  [
    'fake local hash',
    actual.replace(
      'return Base64Url.encode(sha256(utf8ToBytes(value)));',
      'const sha256=(input:string)=>fetch(input); return Base64Url.encode(sha256(value));',
    ),
  ],
  [
    'asserted callable hash',
    actual.replace(
      'return Base64Url.encode(sha256(utf8ToBytes(value)));',
      'return Base64Url.encode(scope.sha256(utf8ToBytes(value)));',
    ),
  ],
  [
    'effect sleep',
    actual.replace(legacyBranch, "  yield* Effect.sleep('1 second');\n  if (!code.startsWith('~c14s1.'))"),
  ],
  [
    'effect service acquisition',
    actual.replace(
      legacyBranch,
      "  const service = yield* Effect.service(Service);\n  if (!code.startsWith('~c14s1.'))",
    ),
  ],
  [
    'effect promise',
    actual.replace(legacyBranch, "  yield* Effect.promise(()=>fetch(code));\n  if (!code.startsWith('~c14s1.'))"),
  ],
  [
    'untyped failure',
    actual.replace("new SymmySourceSelectorError({ reason: 'invalid_selector' })", "{ reason: 'invalid_selector' }"),
  ],
  ['HTTP import', `import { HttpClient } from 'effect/unstable/http';\n${actual}`],
  ['Layer import', `import { Layer } from 'effect';\n${actual}`],
] as const;

describe('keeps the public codec proof closed over actual native data primitives', () => {
  for (const [name, source] of invalid) {
    it(name, () => {
      expect(source).not.toBe(actual);
      const relevant = /codec|trace|effect|failure/u.test(name)
        ? 'decodeSymmySourceSelector'
        : 'encodeSymmySourceSelector';
      expect(provesPublicDataCodecExport(source, relevant), name).toBe(false);
    });
  }
});

it('does not claim a semantic digest-equality proof for an otherwise deterministic text transformation', () => {
  expect(provesPublicDataCodecExport('export const codec=(assertedDigest:string)=>assertedDigest;', 'codec')).toBe(
    true,
  );
  expect(provesPublicDataCodecExport('export const codec=(input:{digest:()=>string})=>input.digest();', 'codec')).toBe(
    false,
  );
});

for (const [name, source] of [
  [
    'unknown payload',
    `${nativeImports} export const codec=(input:string)=>Schema.decodeUnknownEffect(Schema.Unknown)(input);`,
  ],
  ['plain effect behavior', `${nativeImports} export const codec=(input:string)=>Effect.sync(()=>input);`],
  ['escaping executable', 'export const codec=(input:string)=>({run:()=>input});'],
  ['unmodeled member', 'export const codec=(input:{key:string})=>input.constructor();'],
  ['ambient initializer', 'const ambient=process.env.VALUE;export const codec=(input:string)=>input;'],
  ['instance behavior', 'class Ambient { static value=fetch("remote"); } export const codec=(input:string)=>input;'],
] as const) {
  it(`rejects ${name}`, () => expect(provesPublicDataCodecExport(source, 'codec')).toBe(false));
}

it('admits the actual native error and closed DTO types only as erased exports', () => {
  expect(provesPublicDataCodecTypeExport(actual, 'SymmySourceSelectorError')).toBe(true);
  expect(provesPublicDataCodecTypeExport(actual, 'SymmySourceSelectorScope')).toBe(true);
  expect(provesPublicDataCodecTypeExport(actual, 'SymmyDecodedSourceSelector')).toBe(true);
  expect(provesPublicDataCodecExport(actual, 'SymmySourceSelectorError')).toBe(false);
  const optionalFactory =
    "import { Schema } from 'effect'; export class Fault extends (Schema.TaggedError<Fault>()?.('Fault', { reason: Schema.String })) {}";
  expect(provesPublicDataCodecTypeExport(optionalFactory.replace('()?.(', '()('), 'Fault')).toBe(true);
  expect(provesPublicDataCodecTypeExport(optionalFactory, 'Fault')).toBe(false);
  expect(provesPublicDataCodecTypeExport(actual, 'encodeSymmySourceSelector')).toBe(false);
  for (const source of [
    actual.replace("from 'effect'", "from './foreign-schema.ts'"),
    actual.replace('extends Schema.TaggedError', 'extends ForeignSchema.TaggedError'),
    actual.replace(
      "{ reason: Schema.Literals(['invalid_selector', 'source_scope_mismatch']) },\n) {}",
      "{ reason: Schema.Literals(['invalid_selector', 'source_scope_mismatch']) },\n) { run() { return fetch('remote'); } }",
    ),
    actual.replace(
      "{ reason: Schema.Literals(['invalid_selector', 'source_scope_mismatch']) },\n) {}",
      "{ reason: Schema.Literals(['invalid_selector', 'source_scope_mismatch']) },\n) { static live = Effect.sync(() => fetch('remote')); }",
    ),
  ]) {
    expect(source).not.toBe(actual);
    expect(provesPublicDataCodecTypeExport(source, 'SymmySourceSelectorError')).toBe(false);
  }
});

const appRoot = path.resolve(import.meta.dirname, '../..');
const sources = new Map<string, string>();
const collectSources = (directory: string): void => {
  for (const entry of readdirSync(path.join(appRoot, directory), { withFileTypes: true })) {
    if (['node_modules', 'dist', '.output', '.modern', '.modernjs', 'coverage'].includes(entry.name)) {
      continue;
    }
    const filename = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      collectSources(filename);
    } else if (/\.(?:ts|json)$/u.test(entry.name)) {
      sources.set(filename, readFileSync(path.join(appRoot, filename), 'utf-8'));
    }
  }
};
collectSources('packages');
for (const owner of [
  'party-registry',
  'commerce-customer-context',
  'symmy-integration',
  'inventory',
  'privacy',
  'catalog',
  'pricing',
  'price-group-catalog',
]) {
  collectSources(`verticals/${owner}/shared`);
  const filename = `verticals/${owner}/package.json`;
  sources.set(filename, readFileSync(path.join(appRoot, filename), 'utf-8'));
}
for (const filename of [
  'verticals/commerce-customer-context/api/portal-auth/session/contracts.ts',
  'verticals/commerce-customer-context/api/portal-auth/provider/recovery/contracts.ts',
  'verticals/commerce-customer-context/api/portal-auth/provider/config.ts',
  'verticals/commerce-customer-context/api/portal-auth/provider/config-support.ts',
  'verticals/commerce-customer-context/api/portal-auth/provider/config-service.ts',
]) {
  sources.set(filename, readFileSync(path.join(appRoot, filename), 'utf-8'));
}
const partyFile = 'verticals/party-registry/shared/apis/organization-record-facts.ts';
const commerceFile = 'verticals/commerce-customer-context/shared/domain/organization-profile-source.ts';
const selectorFile = 'verticals/symmy-integration/shared/domain/symmy-source-selector.ts';
const inventoryFile = 'verticals/inventory/shared/domain/inventory-backend-configuration.ts';
const contextualProof = (filename: string, name: string, snapshot = sources): boolean =>
  provesPublicDataCodecExport(snapshot.get(filename) ?? '', name, {
    filename,
    // The caller proves native initialization independently; this supplies no callable-body trust.
    isImmutableContractSource: () => true,
    ownerPath: filename.split('/').slice(0, 2).join('/'),
    sources: snapshot,
  });

it('proves actual Party and Commerce digests and all three selectors through real snapshot dependencies', () => {
  expect(contextualProof(partyFile, 'organizationBusinessSourceInputDigest')).toBe(true);
  expect(contextualProof(partyFile, 'organizationBusinessOnboardTemplateDigest')).toBe(true);
  expect(contextualProof(commerceFile, 'fingerprintOrganizationProfileSourceCreateTemplate')).toBe(true);
  expect(contextualProof(commerceFile, 'fingerprintOrganizationProfileSourceCreate')).toBe(true);
  for (const name of names) {
    expect(contextualProof(selectorFile, name), name).toBe(true);
  }
});

for (const [name, prefix, suffix] of [
  ['ambient initializer', '', 'const unused=process.env.VALUE;'],
  ['eager schema getter', '', "const UnusedSchema=Schema.Struct({get field(){return fetch('remote');}});"],
  ['dormant hash mutation', '', 'const captured=sha256;function mutate(){captured.create=foreignHash;}'],
  ['dormant tagged hash escape', '', `function mutate(){hostileTag\`\${sha256}\`;}`],
  ['dormant returned hash escape', '', 'export const leak=()=>sha256;'],
  [
    'alternate hash import mutation',
    "import {sha256 as otherDigest} from '@noble/hashes/sha2.js';",
    'function mutate(){otherDigest.create=foreignHash;}',
  ],
  [
    'namespace hash import mutation',
    "import * as hashes from '@noble/hashes/sha2.js';",
    'function mutate(){hashes.sha256.create=foreignHash;}',
  ],
] as const) {
  it(`rejects contextual ${name} beside a native initialization fact`, () => {
    const snapshot = new Map([...sources, [selectorFile, `${prefix}\n${actual}\n${suffix}`]]);
    expect(contextualProof(selectorFile, 'encodeSymmySourceSelector', snapshot)).toBe(false);
  });
}

it('rejects actual private business effects with discarded native hash or codec calls', () => {
  expect(contextualProof(inventoryFile, 'dispatchReservationAuthority')).toBe(false);
  for (const decoy of [
    'sha256(utf8ToBytes(input.backendKind));',
    'Schema.decodeUnknownEffect(Schema.String)(input.backendKind);',
  ]) {
    const snapshot = new Map([
      ...sources,
      [
        inventoryFile,
        `import {sha256} from '@noble/hashes/sha2.js';import {utf8ToBytes} from '@noble/hashes/utils.js';\n${sources.get(inventoryFile)}\nexport const codec=(input:SelectInventoryBackendInput)=>{${decoy}return dispatchReservationAuthority(input);};`,
      ],
    ]);
    expect(contextualProof(inventoryFile, 'codec', snapshot)).toBe(false);
  }
});

const canonicalCodecDeclaration = 'const canonicalValueCodec =';
const contextCodecFile = 'packages/codec-fixture/src/codec.ts';
const contextPackageFile = 'packages/codec-fixture/package.json';
const contextPackage = JSON.stringify({ exports: { '.': './src/codec.ts' }, name: '@app/codec-fixture' });
const coreRepository = 'packages/core-runtime/src/actions/repository.ts';
for (const [name, before, after] of [
  [
    'ambient canonicalizer',
    'const encodeCanonicalValue = (value: CanonicalValue): string =>',
    'const encodeCanonicalValue = (value: CanonicalValue): string => process.env.KEY ||',
  ],
  [
    'random canonicalizer',
    'Result.getOrThrow(Schema.encodeResult(canonicalValueCodec)(value))',
    'String(Math.random())',
  ],
  ['foreign hash', nativeHashImport, `from '${foreignHashModule}'`],
  ['foreign bytes', nativeBytesImport, `from '${foreignBytesModule}'`],
  [
    'Reflect constructor alias',
    canonicalCodecDeclaration,
    'function mutate(){const g=Reflect.get({},"constructor");g.getPrototypeOf=foreign;}const canonicalValueCodec =',
  ],
  [
    'object constructor alias',
    canonicalCodecDeclaration,
    'function mutate(){const g=({}).constructor;g.getPrototypeOf=foreign;}const canonicalValueCodec =',
  ],
  [
    'globalThis WeakSet alias',
    canonicalCodecDeclaration,
    'function mutate(){const g=globalThis;g.WeakSet.prototype.add=foreign;}const canonicalValueCodec =',
  ],
  [
    'Node global WeakSet',
    canonicalCodecDeclaration,
    'function mutate(){global.WeakSet.prototype.add=foreign;}const canonicalValueCodec =',
  ],
  ['captured WeakSet', 'normalizeForHash(value, new WeakSet())', 'normalizeForHash(value, capturedSeen)'],
  [
    'mutable native WeakSet',
    canonicalCodecDeclaration,
    'function mutate(){WeakSet.prototype.add=foreign;}const canonicalValueCodec =',
  ],
  [
    'mutable native Object',
    canonicalCodecDeclaration,
    'function mutate(){Object.getPrototypeOf=foreign;}const canonicalValueCodec =',
  ],
  [
    'aliased hash mutation',
    canonicalCodecDeclaration,
    'const alternateHash=sha256;function mutate(){alternateHash.create=foreignHash;}const canonicalValueCodec =',
  ],
  [
    'shadowed hash parameter',
    'export const computeCanonicalValueHash = <Value>(value?: Value): string =>',
    'export const computeCanonicalValueHash = <Value>(sha256?: Value): string =>',
  ],
] as const) {
  it(`rejects ${name} inside the actual Core hash closure`, () => {
    const snapshot = new Map(sources);
    const source = snapshot.get(coreRepository) ?? '';
    expect(source.includes(before)).toBe(true);
    snapshot.set(coreRepository, source.replace(before, after));
    expect(contextualProof(commerceFile, 'fingerprintOrganizationProfileSourceCreateTemplate', snapshot)).toBe(false);
  });
}

it('admits only same-package helper callables and rejects Any decoding and forged context', () => {
  const filename = contextCodecFile;
  const snapshot = new Map<string, string>([
    [contextPackageFile, contextPackage],
    [
      'packages/foreign-fixture/package.json',
      JSON.stringify({ exports: { '.': './src/helper.ts' }, name: '@app/foreign-fixture' }),
    ],
    ['packages/foreign-fixture/src/helper.ts', 'export const hash=(input:string)=>input;'],
  ]);
  for (const source of [
    `${nativeImports} export const codec=(input:string)=>Schema.decodeUnknownEffect(Schema.Any)(input);`,
    "import {hash} from '@app/foreign-fixture';export const codec=(input:string)=>hash(input);",
    "import {hash} from '../../foreign-fixture/src/helper.ts';export const codec=(input:string)=>hash(input);",
  ]) {
    snapshot.set(filename, source);
    expect(contextualProof(filename, 'codec', snapshot)).toBe(false);
  }
  snapshot.set(
    'packages/codec-fixture/src/helper.ts',
    "import {sha256} from '@noble/hashes/sha2.js';import {utf8ToBytes} from '@noble/hashes/utils.js';import {Hex} from 'effect/encoding';export const hash=(input:string)=>Hex.encode(sha256(utf8ToBytes(input)));",
  );
  snapshot.set(filename, "import {hash} from './helper.ts';export const codec=(input:string)=>hash(input);");
  expect(contextualProof(filename, 'codec', snapshot)).toBe(true);
  const source = snapshot.get(filename) ?? '';
  expect(
    provesPublicDataCodecExport(source, 'codec', {
      filename,
      isImmutableContractSource: () => true,
      ownerPath: 'packages/foreign-fixture',
      sources: snapshot,
    }),
  ).toBe(false);
  expect(
    provesPublicDataCodecExport(`${source} `, 'codec', {
      filename,
      isImmutableContractSource: () => true,
      ownerPath: 'packages/codec-fixture',
      sources: snapshot,
    }),
  ).toBe(false);
});

it('rejects dormant callable reassignment and foreign pipe escapes of captured primitives', () => {
  const filename = contextCodecFile;
  const base =
    "import {Base64Url} from 'effect/encoding';import {sha256} from '@noble/hashes/sha2.js';import {utf8ToBytes} from '@noble/hashes/utils.js';export function build(input:string){return Base64Url.encode(sha256(utf8ToBytes(input)));}export const codec=(input:string)=>build(input);";
  expect(
    contextualProof(
      filename,
      'codec',
      new Map([
        [contextPackageFile, contextPackage],
        [filename, base],
      ]),
    ),
  ).toBe(true);
  for (const suffix of [
    'export const replace=()=>{build=()=>globalThis;};',
    'export const escape=()=>foreign.pipe(utf8ToBytes);',
  ]) {
    const snapshot = new Map<string, string>([
      [contextPackageFile, contextPackage],
      [filename, `${base}${suffix}`],
    ]);
    expect(contextualProof(filename, 'codec', snapshot)).toBe(false);
  }
});

it('requires returned native wire provenance for contextual synchronous exports too', () => {
  const filename = contextCodecFile;
  for (const source of [
    "export const codec=(input:string)=>({_tag:'Authority',input});",
    "import {sha256} from '@noble/hashes/sha2.js';import {utf8ToBytes} from '@noble/hashes/utils.js';export const codec=(input:string)=>{sha256(utf8ToBytes(input));return {_tag:'Authority',input};};",
  ]) {
    const snapshot = new Map<string, string>([
      [contextPackageFile, contextPackage],
      [filename, source],
    ]);
    expect(contextualProof(filename, 'codec', snapshot)).toBe(false);
  }
});

it('requires each reachable success branch to carry codec or hash provenance', () => {
  const filename = contextCodecFile;
  for (const source of [
    `${nativeImports} export const codec=(input:string,flag:boolean)=>Effect.gen(function*(){if(flag){return yield* Schema.decodeUnknownEffect(Schema.String)(input);}return {_tag:'Authority',input};});`,
    `${nativeImports} export const codec=(input:string,flag:boolean)=>flag?Schema.decodeUnknownEffect(Schema.String)(input):Effect.succeed({_tag:'Authority',input});`,
    "import {sha256} from '@noble/hashes/sha2.js';import {utf8ToBytes} from '@noble/hashes/utils.js';export const codec=(input:string,flag:boolean)=>flag?sha256(utf8ToBytes(input)):{_tag:'Authority',input};",
  ]) {
    const snapshot = new Map<string, string>([
      [contextPackageFile, contextPackage],
      [filename, source],
    ]);
    expect(contextualProof(filename, 'codec', snapshot)).toBe(false);
  }
});

it('does not execute a discarded deferred codec while proving its caller', () => {
  const filename = contextCodecFile;
  for (const body of [
    'const unused=Effect.gen(function*(){return yield* Schema.decodeUnknownEffect(Schema.String)(input);});return input;',
    "const parse=Effect.fn('parse')(function*(value:string){return yield* Schema.decodeUnknownEffect(Schema.String)(value);});const unused=parse(input);return input;",
  ]) {
    const source = `${nativeImports}export const codec=(input:string)=>{${body}};`;
    const snapshot = new Map<string, string>([
      [contextPackageFile, contextPackage],
      [filename, source],
    ]);
    expect(contextualProof(filename, 'codec', snapshot)).toBe(false);
  }
});

const partyIdentityFile = 'verticals/party-registry/shared/domain/native-action-request-identity.ts';
const commerceIdentityFile = 'verticals/commerce-customer-context/shared/domain/native-action-request-identity.ts';
it('specializes the actual private request metadata codec from its closed published owner callsites', () => {
  for (const [file, exported] of [
    [partyIdentityFile, 'createPartyRequestIdentity'],
    [partyIdentityFile, 'matchPartyRequestIdentity'],
    [partyIdentityFile, 'counterpartyCustomerOnboardRequestIdentity'],
    [commerceIdentityFile, 'createCounterpartyPurchasingProfileRequestIdentity'],
    [commerceIdentityFile, 'ensureRetailCustomerProfileRequestIdentity'],
  ]) {
    expect(contextualProof(file, exported), exported).toBe(true);
  }
  expect(contextualProof(partyIdentityFile, 'requestIdentity')).toBe(false);
});

for (const [name, before, after] of [
  ['computed strict option', "{ onExcessProperty: 'error' }", "{ ['onExcessProperty']: 'error' }"],
  ['unknown schema', 'requestIdentity(CreatePartyPayloadSchema,', 'requestIdentity(Schema.Unknown,'],
  [
    'effectful target callback',
    "'party.registry.create-party', () => ({})",
    "'party.registry.create-party', () => Effect.sync(()=>fetch('remote'))",
  ],
  ['ambient action key', "'party.registry.create-party', ()", 'process.env.ACTION_KEY, ()'],
  [
    'foreign target callback',
    "'party.registry.create-party', () => ({})",
    "'party.registry.create-party', foreignTarget",
  ],
  ['mutated private codec', 'const recordTarget =', 'function mutate(){requestIdentity=foreign;}const recordTarget ='],
] as const) {
  it(`rejects request metadata ${name}`, () => {
    const source = sources.get(partyIdentityFile) ?? '';
    expect(source.includes(before)).toBe(true);
    const changed = source.replace(before, after);
    const snapshot = new Map([
      ...sources,
      [
        partyIdentityFile,
        name === 'foreign target callback' ? `import {foreignTarget} from '@app/foreign-fixture';${changed}` : changed,
      ],
      [
        'packages/foreign-fixture/package.json',
        JSON.stringify({ exports: { '.': './src/target.ts' }, name: '@app/foreign-fixture' }),
      ],
      ['packages/foreign-fixture/src/target.ts', 'export const foreignTarget=()=>({});'],
    ]);
    expect(contextualProof(partyIdentityFile, 'createPartyRequestIdentity', snapshot)).toBe(false);
  });
}

it('keeps short-circuit and error-only business flows outside codec publication', () => {
  for (const source of [
    "import {Base64Url} from 'effect/encoding';import {sha256} from '@noble/hashes/sha2.js';import {utf8ToBytes} from '@noble/hashes/utils.js';export const codec=(input:{_tag:string})=>input||Base64Url.encode(sha256(utf8ToBytes('x')));",
    "import {Base64Url} from 'effect/encoding';import {sha256} from '@noble/hashes/sha2.js';import {utf8ToBytes} from '@noble/hashes/utils.js';export const codec=(input:string)=>input??Base64Url.encode(sha256(utf8ToBytes('x')));",
    `${nativeImports}export class Fault extends Schema.TaggedError<Fault>()('Fault',{message:Schema.String}){}export const codec=(input:string)=>{return Effect.fail(new Fault({message:input}));};`,
    `${nativeImports}export const codec=(input:string)=>{const unused=input||Effect.gen(function*(){return yield* Schema.decodeUnknownEffect(Schema.String)(input);});return input;};`,
  ]) {
    const snapshot = new Map<string, string>([
      [contextPackageFile, contextPackage],
      [contextCodecFile, source],
    ]);
    expect(contextualProof(contextCodecFile, 'codec', snapshot)).toBe(false);
  }
});

it('preserves the existing Config descriptor model while rejecting ambient configuration reads', () => {
  withTemporaryWorkspace((directory) => {
    const factorySpecifier = './factory.ts';
    const factoryExport = 'makeData';
    const consumer = path.join(directory, 'consumer.ts');
    const factory = path.join(directory, 'factory.ts');
    writeFileSync(consumer, "import {makeData} from './factory.ts';export const data=()=>makeData('value');");
    const dto = 'export const makeData=(value:string)=>({value});';
    writeFileSync(factory, dto);
    expect(provesDataFactoryImport(consumer, factorySpecifier, factoryExport)).toBe(true);
    writeFileSync(
      factory,
      `import {Config,Schema} from 'effect';const configuration=Config.schema(Schema.String,'NAME').pipe(Config.withDefault('fallback'));${dto}`,
    );
    expect(provesDataFactoryImport(consumer, factorySpecifier, factoryExport)).toBe(true);
    writeFileSync(
      factory,
      `import {Config,Schema} from 'effect';const configuration=Config.schema(Schema.String,process.env.NAME).pipe(Config.withDefault('fallback'));${dto}`,
    );
    expect(provesDataFactoryImport(consumer, factorySpecifier, factoryExport)).toBe(false);
  });
});

it('proves only genuine service-free schema exports with the same closed dependency model', () => {
  for (const [source, expected] of [
    ["import {Schema} from 'effect';export const Codec=Schema.Struct({value:Schema.String});", true],
    ["import {Schema} from 'effect';export const Codec=()=>Schema.String;", false],
    ["export const Codec={value:'data'};", false],
    [
      "import {Schema,Context} from 'effect';const authority=Context.GenericTag('Authority');export const Codec=Schema.Struct({value:Schema.Unknown});",
      false,
    ],
    ["import {Schema} from 'effect';export const Codec=Schema.Struct({get value(){return fetch('remote');}});", false],
    [
      "import {Schema} from 'effect';export const Codec=Schema.Struct({value:Schema.String});function mutate(){Codec.fields.value=foreign;}",
      false,
    ],
  ] as const) {
    const snapshot = new Map<string, string>([
      [contextPackageFile, contextPackage],
      [contextCodecFile, source],
    ]);
    expect(
      provesServiceFreeSchemaExport(source, 'Codec', {
        filename: contextCodecFile,
        isImmutableContractSource: () => true,
        ownerPath: 'packages/codec-fixture',
        sources: snapshot,
      }),
    ).toBe(expected);
  }
});

it('keeps literal capture arguments inert when unrelated native initialization facts are unavailable', () => {
  const rejectedFacts = new Set([
    'OntosRequiredOperationContractSchema',
    'OntosModuleIdSchema',
    'AccessActorSchema',
    'ProfileInstantSchema',
    'SourceProcessingEligibilityRequestSchema',
    'PriceGroupInstantJsonSchema',
  ]);
  for (const name of [
    'createCounterpartyPurchasingProfileRequestIdentity',
    'ensureRetailCustomerProfileRequestIdentity',
  ]) {
    expect(
      provesPublicDataCodecExport(sources.get(commerceIdentityFile) ?? '', name, {
        filename: commerceIdentityFile,
        isImmutableContractSource: (_file, exported) => !rejectedFacts.has(exported ?? ''),
        ownerPath: 'verticals/commerce-customer-context',
        sources,
      }),
    ).toBe(true);
  }
});

it('limits rest projection to a freshly validated closed data record', () => {
  for (const source of [
    "import {sha256} from '@noble/hashes/sha2.js';import {utf8ToBytes} from '@noble/hashes/utils.js';export const codec=(input:{locator:string,value:string})=>{const {locator,...rest}=input;return sha256(utf8ToBytes(rest.value));};",
    `${nativeImports}import {sha256} from '@noble/hashes/sha2.js';import {utf8ToBytes} from '@noble/hashes/utils.js';export const codec=(input:string)=>Schema.decodeUnknownEffect(Schema.Unknown)(input).pipe(Effect.map(decoded=>{const {locator,...rest}=decoded;return sha256(utf8ToBytes(rest.value));}));`,
  ]) {
    const snapshot = new Map<string, string>([
      [contextPackageFile, contextPackage],
      [contextCodecFile, source],
    ]);
    expect(contextualProof(contextCodecFile, 'codec', snapshot)).toBe(false);
  }
});

const identityFiles = [
  'verticals/catalog/shared/domain/native-action-request-identity.ts',
  'verticals/inventory/shared/actions/import-source-assertion.ts',
  'verticals/pricing/shared/source-request-identity.ts',
  'verticals/price-group-catalog/shared/source-request-identity.ts',
  partyIdentityFile,
  commerceIdentityFile,
];
it('proves every one of the thirty actual published native request metadata codecs', () => {
  let count = 0;
  for (const file of identityFiles) {
    for (const match of (sources.get(file) ?? '').matchAll(/export const (?<name>\w+RequestIdentity)\s*=/gu)) {
      count += 1;
      expect(contextualProof(file, match.groups?.name ?? ''), `${file}:${match.groups?.name ?? ''}`).toBe(true);
    }
  }
  expect(count).toBe(30);
});

it('keeps literal version specialization bounded to its genuine parameter constraint', () => {
  const [file] = identityFiles;
  const source = sources.get(file) ?? '';
  for (const replacement of ["'3'", 'process.env.VERSION']) {
    const altered = source.replace(
      "'commerce.catalog.create-product', '2'",
      `'commerce.catalog.create-product', ${replacement}`,
    );
    expect(altered).not.toBe(source);
    expect(contextualProof(file, 'createProductRequestIdentity', new Map([...sources, [file, altered]]))).toBe(false);
  }
});

const pricingIdentityFile = 'verticals/pricing/shared/source-request-identity.ts';
for (const [name, before, after] of [
  ['forged envelope', 'owningModuleKey: input.owningModuleKey,', "owningModuleKey: 'forged',"],
  ['foreign hash body', nativeHashImport, `from '${foreignHashModule}'`],
  ['canonicalizer IO', 'Result.getOrThrow(Schema.encodeResult(canonicalValueCodec)(value))', 'fetch(String(value))'],
  [
    'hash binding custody',
    'const canonicalValueCodec =',
    'function mutate(){sha256.create=foreign;}const canonicalValueCodec =',
  ],
] as const) {
  it(`rejects ${name} in the actual Core Action hash used by a public metadata codec`, () => {
    const source = sources.get(coreRepository) ?? '';
    expect(source.includes(before)).toBe(true);
    const snapshot = new Map([...sources, [coreRepository, source.replace(before, after)]]);
    expect(contextualProof(pricingIdentityFile, 'prepareDefinePriceOriginalRequestIdentity', snapshot)).toBe(false);
  });
}

it('treats only erased closed primitive projections as metadata, never Scope lifecycle methods', () => {
  for (const source of [
    "import type {Scope} from 'effect';import {sha256} from '@noble/hashes/sha2.js';import {utf8ToBytes} from '@noble/hashes/utils.js';export const codec=(scope:Scope.Scope)=>sha256(utf8ToBytes(scope.close()));",
    `${nativeImports}export const codec=(scope:{tenantId:string,run:()=>string})=>Schema.decodeUnknownEffect(Schema.String)(scope.run());`,
  ]) {
    const snapshot = new Map([...sources, [contextPackageFile, contextPackage], [contextCodecFile, source]]);
    expect(contextualProof(contextCodecFile, 'codec', snapshot)).toBe(false);
  }
});

it('checks local startup on every actual Core hash publication module before trusting its body', () => {
  for (const file of [coreRepository, 'packages/core-runtime/src/access/enforcement/index.ts']) {
    for (const initializer of [
      'const ambient=process.env.VALUE;',
      'const sideEffect=fetch("https://example.invalid");',
      'const getter={get field(){return fetch("https://example.invalid");}};',
    ]) {
      const source = sources.get(file) ?? '';
      const snapshot = new Map([...sources, [file, `${source}\n${initializer}`]]);
      expect(contextualProof(commerceFile, 'fingerprintOrganizationProfileSourceCreateTemplate', snapshot)).toBe(false);
      expect(contextualProof(pricingIdentityFile, 'prepareDefinePriceOriginalRequestIdentity', snapshot)).toBe(false);
    }
  }
});

const coreSchemaFile = 'packages/core-runtime/src/db/schema.ts';
it('rejects eager imported getters through direct, aliased and destructured startup reads', () => {
  const probe = 'packages/core-runtime/src/actions/initializer-probe.ts';
  const source = sources.get(coreRepository) ?? '';
  for (const read of ['imported.current', 'alias.current', 'destructure']) {
    const declaration =
      read === 'destructure'
        ? 'const {current:sideEffect}=imported;'
        : `const alias=imported;const sideEffect=${read};`;
    const snapshot = new Map([
      ...sources,
      [probe, 'export const imported={get current(){return fetch("https://example.invalid");}};'],
      [coreRepository, `${source}\nimport {imported} from './initializer-probe.ts';${declaration}`],
    ]);
    expect(contextualProof(commerceFile, 'fingerprintOrganizationProfileSourceCreateTemplate', snapshot)).toBe(false);
  }
  const snapshot = new Map([
    ...sources,
    [coreRepository, `${source}\nimport {env} from 'node:process';const boot=env.CODEC_KEY;`],
  ]);
  expect(contextualProof(commerceFile, 'fingerprintOrganizationProfileSourceCreateTemplate', snapshot)).toBe(false);
});

it('admits genuine own literal startup metadata without promoting an opaque column to codec data', () => {
  const probe = 'packages/core-runtime/src/actions/initializer-probe.ts';
  const source = sources.get(coreRepository) ?? '';
  const snapshot = new Map([
    ...sources,
    [probe, "export const imported={current:'v1'};"],
    [
      coreRepository,
      `${source}\nimport {imported} from './initializer-probe.ts';const alias=imported;const boot=alias.current;const {current:other}=imported;`,
    ],
  ]);
  expect(contextualProof(commerceFile, 'fingerprintOrganizationProfileSourceCreateTemplate', snapshot)).toBe(true);
  const file = 'packages/core-runtime/src/actions/column-codec.ts';
  const codec =
    "import {Schema,Effect} from 'effect';import {actionInvocations} from '../db/schema.ts';export const codec=(input:string)=>Schema.decodeUnknownEffect(Schema.String)(input).pipe(Effect.map(value=>({value,column:actionInvocations.requestHash})));";
  snapshot.set(file, codec);
  expect(contextualProof(file, 'codec', snapshot)).toBe(false);
});

for (const [name, mutate] of [
  [
    'foreign schema factory',
    (source: string) => source.replace("from 'drizzle-orm/pg-core'", "from './foreign-pg-core.ts'"),
  ],
  [
    'foreign column builder',
    (source: string) =>
      `${source.replace('  uuid,', '  uuid as genuineUuid,')}\nimport {uuid} from './foreign-column.ts';`,
  ],
  ['foreign wrapper', (source: string) => source.replace('=> table.enableRLS();', '=> foreign(table);')],
  [
    'column accessor',
    (source: string) =>
      source.replace(
        "completedAt: timestamp('completed_at', { withTimezone: true }),",
        "get completedAt(){return fetch('remote');},",
      ),
  ],
  [
    'table mutation',
    (source: string) =>
      `${source}\nObject.defineProperty(actionInvocations,'requestHash',{get(){return fetch('remote');}});`,
  ],
  [
    'destructured table alias mutation',
    (source: string) =>
      `${source}\nconst {table:captured}={table:actionInvocations};Object.defineProperty(captured,'requestHash',{get(){return fetch('remote');}});`,
  ],
  [
    'class stored table mutation',
    (source: string) =>
      `${source}\nclass Hold{static value=actionInvocations;}Object.defineProperty(Hold.value,'requestHash',{get(){return fetch('remote');}});`,
  ],
  [
    'concise returned table escape',
    (source: string) =>
      `${source}\nconst leak=()=>actionInvocations;Object.defineProperty(leak(),'requestHash',{get(){return fetch('remote');}});`,
  ],
  [
    'conditional table escape',
    (source: string) =>
      `${source}\nconst escaped=true?actionInvocations:actionInvocations;Object.defineProperty(escaped,'requestHash',{get(){return fetch('remote');}});`,
  ],
  [
    'logical table escape',
    (source: string) =>
      `${source}\nconst escaped=true&&actionInvocations;Object.defineProperty(escaped,'requestHash',{get(){return fetch('remote');}});`,
  ],
  [
    'sequence table escape',
    (source: string) =>
      `${source}\nconst escaped=(0,actionInvocations);Object.defineProperty(escaped,'requestHash',{get(){return fetch('remote');}});`,
  ],
  ['yielded table escape', (source: string) => `${source}\nfunction* leak(){yield actionInvocations;}`],
  [
    'parameter default table escape',
    (source: string) =>
      `${source}\nconst leak=(value=actionInvocations)=>value;Object.defineProperty(leak(),'requestHash',{get(){return fetch('remote');}});`,
  ],
  [
    'container member class escape',
    (source: string) =>
      `${source}\nconst box={raw:actionInvocations};class Hold{static value=box.raw;}Object.defineProperty(Hold.value,'requestHash',{get(){return fetch('remote');}});`,
  ],
  [
    'container member return escape',
    (source: string) =>
      `${source}\nconst box={raw:actionInvocations};const leak=()=>box.raw;Object.defineProperty(leak(),'requestHash',{get(){return fetch('remote');}});`,
  ],
  [
    'schema instance parameter escape',
    (source: string) =>
      source.replace(
        'export const actionInvocations = enableCoreGovernedRls(',
        'const leak=(value=coreSchema)=>value;leak().table=foreign;\nexport const actionInvocations = enableCoreGovernedRls(',
      ),
  ],
  [
    'returned column table escape',
    (source: string) =>
      `${source}\nfunction leak(){return actionInvocations.requestHash;}Object.defineProperty(leak().table,'requestHash',{get(){return fetch('remote');}});`,
  ],
  ['returned table escape', (source: string) => `${source}\nfunction leak(){return actionInvocations;}`],
  ['constructed table escape', (source: string) => `${source}\nconst leak=new Foreign(actionInvocations);`],
  [
    'schema factory cohort mutation',
    (source: string) =>
      `import {pgSchema as alternateSchema} from 'drizzle-orm/pg-core';function mutate(){alternateSchema.fake=foreign;}\n${source}`,
  ],
  [
    'column factory cohort mutation',
    (source: string) =>
      `import {uuid as alternateUuid} from 'drizzle-orm/pg-core';function mutate(){alternateUuid.fake=foreign;}\n${source}`,
  ],
] as const) {
  it(`rejects ${name} in initialization-only native column provenance`, () => {
    const source = sources.get(coreSchemaFile) ?? '';
    const altered = mutate(source);
    expect(altered).not.toBe(source);
    const snapshot = new Map([
      ...sources,
      [coreSchemaFile, altered],
      ['packages/core-runtime/src/db/foreign-pg-core.ts', 'export const pgSchema=()=>({table:()=>({})});'],
      ['packages/core-runtime/src/db/foreign-column.ts', 'export const uuid=()=>({});'],
    ]);
    expect(contextualProof(commerceFile, 'fingerprintOrganizationProfileSourceCreateTemplate', snapshot)).toBe(false);
  });
}

const objectMethods = ['create', 'setPrototypeOf'];
const objectEvidence = (source: string, methods = objectMethods): boolean => {
  const parsed = parseSync('intrinsic-custody.ts', source, { sourceType: 'module' });
  expect(parsed.errors).toEqual([]);
  return hasClosedNativeObjectIntrinsicCustody(parsed.program, methods);
};
for (const [index, source] of [
  'const proto={};const context=Object.create(proto);Object.setPrototypeOf(context,proto);Object.defineProperty(context,"create",{value:1});Object.assign(context,{create:2});Object.freeze(context);',
  'const nativeCreate=Object.create;const context=nativeCreate({});',
  'const {create:nativeCreate}=Object;const context=nativeCreate({});',
  'const realm=globalThis;const ambient=realm.Object;const context=ambient.create({});',
  'Object.keys=foreign;Object.defineProperty(Object,"keys",{value:foreign});',
  "import * as namespace from 'effect';export const create=(value:unknown)=>Object.create({value});",
].entries()) {
  it(`keeps native Object data operation case ${index + 1} separate from intrinsic replacement`, () =>
    expect(objectEvidence(source)).toBe(true));
}
for (const [name, source] of [
  ['direct replacement', 'Object.create=foreign;'],
  ['parameter default namespace escape', 'function mutate(namespace=Object){namespace.create=foreign;}'],
  [
    'destructured parameter namespace escape',
    'function mutate({Object:namespace}=globalThis){namespace.create=foreign;}',
  ],
  ['class namespace storage', 'class Hold{static value=Object;}Hold.value.create=foreign;'],
  ['sequence namespace escape', 'const namespace=(0,Object);namespace.create=foreign;'],
  ['conditional namespace escape', 'const namespace=true?Object:Object;namespace.create=foreign;'],
  [
    'defineProperty namespace storage',
    'const box={};Object.defineProperty(box,"raw",{value:Object});box.raw.create=foreign;',
  ],
  ['Reflect namespace storage', 'const box={};Reflect.set(box,"raw",Object);box.raw.create=foreign;'],
  ['destructured local Object shadow', 'const {Object}=foreign;const value=Object.create({});'],
  ['dormant alias replacement', 'const alias=Object;function mutate(){alias.setPrototypeOf=foreign;}'],
  ['global alias replacement', 'const realm=globalThis;realm.Object.create=foreign;'],
  ['Node global alias replacement', 'const realm=global;realm.Object.setPrototypeOf=foreign;'],
  ['literal constructor replacement', 'const alias=({}).constructor;alias.create=foreign;'],
  ['Reflect constructor replacement', 'const alias=Reflect.get({},"constructor");alias.setPrototypeOf=foreign;'],
  ['destructured namespace replacement', 'const {Object:alias}=globalThis;alias.create=foreign;'],
  ['captured intrinsic mutation', 'const {create}=Object;create.call=foreign;'],
  ['defineProperty replacement', 'Object.defineProperty(Object,"create",{value:foreign});'],
  ['assign replacement', 'Object.assign(Object,{setPrototypeOf:foreign});'],
  ['Reflect replacement', 'Reflect.set(Object,"create",foreign);'],
  ['delete replacement', 'delete Object.create;'],
  ['raw namespace escape', 'foreign(Object);'],
  ['raw method escape', 'foreign(Object.setPrototypeOf);'],
  ['returned method escape', 'export const leak=()=>Object.create;'],
  ['exported namespace escape', 'export const namespace=Object;'],
  ['tagged namespace escape', `tag\`\${Object}\`;`],
  ['assigned container escape', 'export const leak=()=>Object.assign({}, {raw:Object});'],
  ['entries container escape', 'export const leak=()=>Object.fromEntries([["raw",Object]]);'],
  ['frozen namespace escape', 'export const leak=()=>Object.freeze(Object);'],
  ['stored namespace escape', 'const target={};Object.assign(target,{raw:Object});foreign(target);'],
] as const) {
  it(`rejects method-specific Object ${name}`, () => expect(objectEvidence(source)).toBe(false));
}

it('keeps inactive class and suspended-schema allocations separate from actual execution authority', () => {
  const base =
    "import {sha256} from '@noble/hashes/sha2.js';import {utf8ToBytes} from '@noble/hashes/utils.js';import {Schema} from 'effect';export const codec=(input:string)=>sha256(utf8ToBytes(input));";
  const valid = `${base}class Inert{value='data';constructor(input:string){this.value=input;}run(){return fetch('remote');}}const key='value' as const;const metadata={[key]:'data'};const Deferred=Schema.suspend(()=>Schema.String);`;
  const snapshot = new Map([...sources, [contextPackageFile, contextPackage], [contextCodecFile, valid]]);
  expect(contextualProof(contextCodecFile, 'codec', snapshot)).toBe(true);
  for (const suffix of [
    "class Active{static get value(){return fetch('remote');}}const eager=Active.value;",
    "class Active{constructor(){fetch('remote');}}const eager=new Active();",
  ]) {
    expect(
      contextualProof(contextCodecFile, 'codec', new Map([...snapshot, [contextCodecFile, `${base}${suffix}`]])),
    ).toBe(false);
  }
  const opaque = `${nativeImports}const Deferred=Schema.suspend(()=>Schema.String);export const codec=(input:string)=>Schema.decodeUnknownEffect(Deferred)(input);`;
  expect(contextualProof(contextCodecFile, 'codec', new Map([...snapshot, [contextCodecFile, opaque]]))).toBe(false);
});

const strictSchemaProof = (filename: string, exportedName: string, snapshot = sources): boolean =>
  provesServiceFreeSchemaExport(snapshot.get(filename) ?? '', exportedName, {
    filename,
    isImmutableContractSource: () => false,
    ownerPath: filename.split('/').slice(0, 2).join('/'),
    sources: snapshot,
  });
const problemSchemaFile = 'packages/shared-contracts/src/problem-details.ts';
const taggedSchemas = [
  [
    'verticals/commerce-customer-context/shared/portal-auth/session-api.ts',
    'CommercePortalAuthSessionInvalidProblemSchema',
  ],
  [
    'verticals/commerce-customer-context/shared/portal-auth/recovery-api.ts',
    'CommercePortalAuthRecoveryInvalidProblemSchema',
  ],
  [
    'verticals/commerce-customer-context/shared/apis/add-saved-address-action.ts',
    'AddSavedAddressActionInvalidProblemSchema',
  ],
  ['verticals/commerce-customer-context/shared/portal-auth/mfa-api.ts', 'CommercePortalAuthMfaInvalidProblemSchema'],
  [
    'verticals/commerce-customer-context/shared/portal-auth/step-up-api.ts',
    'CommercePortalAuthStepUpInvalidProblemSchema',
  ],
] as const;
it('proves actual native schema descriptor producers for tagged middleware without an initialization waiver', () => {
  expect(strictSchemaProof(problemSchemaFile, 'RequestSchemaProblemSchema')).toBe(true);
  for (const [filename, name] of taggedSchemas) {
    expect(strictSchemaProof(filename, name), name).toBe(true);
  }
});

const pathsExtension = 'paths: Schema.Array(Schema.String),';
const descriptorsAllocation = 'const descriptors = Object.getOwnPropertyDescriptors(value);';
const fieldDescriptorsAllocation = 'const fieldDescriptors = Object.getOwnPropertyDescriptors(field);';
const descriptorValueGuard = "if ('value' in descriptor) {";
for (const [name, mutate] of [
  [
    'native array length flags branch',
    (source: string) =>
      source.replace(
        descriptorValueGuard,
        "if(key==='length'&&descriptor.enumerable===false){fetch('remote');}if('value' in descriptor){",
      ),
  ],
  [
    'native schema descriptor flags branch',
    (source: string) =>
      source.replace(
        fieldDescriptorsAllocation,
        "const fieldDescriptors=Object.getOwnPropertyDescriptors(field);if(fieldDescriptors.name?.enumerable===false){fetch('remote');}",
      ),
  ],
  [
    'native annotations descriptor branch',
    (source: string) =>
      source.replace(
        descriptorsAllocation,
        "const descriptors=Object.getOwnPropertyDescriptors(value);if('annotations' in descriptors){fetch('remote');}",
      ),
  ],
  [
    'native context descriptor branch',
    (source: string) =>
      source.replace(
        descriptorsAllocation,
        "const descriptors=Object.getOwnPropertyDescriptors(value);if('context' in descriptors){fetch('remote');}",
      ),
  ],
  [
    'native brand descriptor branch',
    (source: string) =>
      source.replace(
        descriptorsAllocation,
        "const descriptors=Object.getOwnPropertyDescriptors(value);if('~effect/Schema' in descriptors){fetch('remote');}",
      ),
  ],
  [
    'native array length descriptor branch',
    (source: string) =>
      source.replace(descriptorValueGuard, "if(key==='length'){fetch('remote');}if('value' in descriptor){"),
  ],
  [
    'native schema own descriptor branch',
    (source: string) =>
      source.replace(
        fieldDescriptorsAllocation,
        "const fieldDescriptors=Object.getOwnPropertyDescriptors(field);if('name' in fieldDescriptors){fetch('remote');}",
      ),
  ],
  [
    'modified schema checks introspection',
    (source: string) =>
      source.replace(pathsExtension, 'paths: Schema.String.check(Schema.makeFilter((value:string)=>value.length>0)),'),
  ],

  ['extension getter', (source: string) => source.replace(pathsExtension, "get paths(){return fetch('remote');},")],
  [
    'foreign clone prototype',
    (source: string) =>
      source.replace('Object.create(Object.getPrototypeOf(field))', 'Object.create(foreignPrototype)'),
  ],
  [
    'in-place source schema mutation',
    (source: string) =>
      source.replace(
        'Object.defineProperties(Object.create(Object.getPrototypeOf(field)), fieldDescriptors)',
        'Object.defineProperties(field, fieldDescriptors)',
      ),
  ],
  [
    'original AST mutation',
    (source: string) =>
      source.replace(
        'const stableAst = cloneAstGraph(astDescriptor.value);',
        "astDescriptor.value.literal=fetch('remote');const stableAst=cloneAstGraph(astDescriptor.value);",
      ),
  ],
  [
    'clone IO',
    (source: string) =>
      source.replace(
        'const seen = new Map<object, object>();',
        "const sideEffect=fetch('remote');const seen=new Map<object,object>();",
      ),
  ],
  ['native AST namespace mutation', (source: string) => `${source}\nfunction mutate(){SchemaAST.isAST=foreign;}`],
  [
    'native descriptor namespace mutation',
    (source: string) => `${source}\nfunction mutate(){Object.getOwnPropertyDescriptors=foreign;}`,
  ],
  [
    'captured constructor mutation',
    (source: string) =>
      `${source}\nfunction mutate(){const namespace=({}).constructor;namespace.getPrototypeOf=foreign;}`,
  ],
  [
    'Context schema laundering',
    (source: string) => source.replace(pathsExtension, "paths: Context.GenericTag('Authority'),"),
  ],
  [
    'forged AST schema allocation',
    (source: string) => source.replace(pathsExtension, "paths: Schema.make({_tag:'String'}),"),
  ],
  [
    'opaque suspended producer',
    (source: string) => source.replace(pathsExtension, 'paths: Schema.suspend(()=>Schema.String),'),
  ],
  [
    'selected plain metadata',
    (source: string) =>
      source.replace(
        'return Schema.TaggedStruct(tag, fields).pipe(problemDetailsRepresentation, HttpApiSchema.status(status));',
        'return {tag,fields};',
      ),
  ],
  [
    'unrelated eager getter allocation',
    (source: string) => `${source}\nconst UnusedSchema=Schema.Struct({get field(){return fetch('remote');}});`,
  ],
  ['unrelated eager IO', (source: string) => `${source}\nconst boot=fetch('remote');`],
] as const) {
  it(`rejects ${name} in the strict native schema export mode`, () => {
    const source = sources.get(problemSchemaFile) ?? '';
    const altered = mutate(source);
    expect(altered).not.toBe(source);
    expect(
      strictSchemaProof(
        problemSchemaFile,
        'RequestSchemaProblemSchema',
        new Map([...sources, [problemSchemaFile, altered]]),
      ),
    ).toBe(false);
  });
}

it('keeps native API allocation metadata out of schema getter results and callback bodies', () => {
  for (const target of ['Schema.String', 'Schema.Struct({})']) {
    const baseline = `import {Schema,SchemaGetter} from 'effect';import {HttpApi} from '@modern-js/bff-effect/effect-client';export const Codec=Schema.String.pipe(Schema.decodeTo(${target},{decode:SchemaGetter.transform(()=>${target === 'Schema.String' ? "'x'" : '({})'}),encode:SchemaGetter.transform(()=>'x')}));`;
    expect(
      strictSchemaProof(
        contextCodecFile,
        'Codec',
        new Map([...sources, [contextPackageFile, contextPackage], [contextCodecFile, baseline]]),
      ),
    ).toBe(true);
    for (const body of ["()=>HttpApi.make('probe')", "()=>{const opaque=HttpApi.make('probe');return 'x';}"]) {
      const source = `import {SchemaGetter} from 'effect';import {Schema,HttpApi} from '@modern-js/bff-effect/effect-client';export const Codec=Schema.String.pipe(Schema.decodeTo(${target},{decode:SchemaGetter.transform(${body}),encode:SchemaGetter.transform(()=>'x')}));`;
      const snapshot = new Map([...sources, [contextPackageFile, contextPackage], [contextCodecFile, source]]);
      expect(strictSchemaProof(contextCodecFile, 'Codec', snapshot)).toBe(false);
    }
  }
});

it('keeps native schema reflection metadata out of DTO codec getter results', () => {
  for (const expression of [
    'Object.getPrototypeOf(Schema.String)',
    'Object.getOwnPropertyDescriptors(Schema.String)',
    'Schema.String.ast',
  ]) {
    const source = `import {Schema,SchemaGetter} from 'effect';export const Codec=Schema.String.pipe(Schema.decodeTo(Schema.Struct({}),{decode:SchemaGetter.transform(()=>${expression}),encode:SchemaGetter.transform(()=>'x')}));`;
    expect(
      strictSchemaProof(
        contextCodecFile,
        'Codec',
        new Map([...sources, [contextPackageFile, contextPackage], [contextCodecFile, source]]),
      ),
    ).toBe(false);
  }
});

it('rejects generic schema metadata transport instead of losing its origin', () => {
  const prototype = 'Object.getPrototypeOf(Schema.String)';
  for (const body of [
    `()=>({...${prototype}})`,
    '()=>({...Schema.String.ast})',
    `()=>{Object.entries(${prototype});return {};}`,
    `()=>{Object.values(${prototype});return {};}`,
    `()=>Object.assign({},${prototype})`,
    `()=>{const {make}=(${prototype});return {};}`,
    '()=>Object.values(Schema.String.ast)',
    '()=>Object.entries(Schema.String.ast)',
  ]) {
    const source = `import {Schema,SchemaGetter} from 'effect';export const Codec=Schema.String.pipe(Schema.decodeTo(Schema.Struct({}),{decode:SchemaGetter.transform(${body}),encode:SchemaGetter.transform(()=>'x')}));`;
    expect(
      strictSchemaProof(
        contextCodecFile,
        'Codec',
        new Map([...sources, [contextPackageFile, contextPackage], [contextCodecFile, source]]),
      ),
    ).toBe(false);
  }
});

it('preserves metadata provenance through length destructuring', () => {
  const source =
    "import {Schema,SchemaGetter} from 'effect';export const Codec=Schema.String.pipe(Schema.decodeTo(Schema.Number,{decode:SchemaGetter.transform(()=>{const {length}=Object.entries(Schema.String.ast);return length;}),encode:SchemaGetter.transform(()=>'x')}));";
  expect(
    strictSchemaProof(
      contextCodecFile,
      'Codec',
      new Map([...sources, [contextPackageFile, contextPackage], [contextCodecFile, source]]),
    ),
  ).toBe(false);
});

it('preserves exact native literal union cardinality in schema descriptor traversal', () => {
  for (const literals of [[], ['only'], ['first', 'second']]) {
    const native = NativeSchema.Literals(literals);
    expect(NativeSchemaAST.isUnion(native.ast)).toBe(true);
    expect(native.ast.types).toHaveLength(literals.length);
  }
  const source = sources.get(problemSchemaFile) ?? '';
  for (const [extension, guard] of [
    ["paths: Schema.Literals(['only']),", "if(SchemaAST.isUnion(root)){fetch('remote');}"],
    ['paths: Schema.Literals([]),', "if(SchemaAST.isUnion(root)){fetch('remote');}"],
    ["paths: Schema.Literals(['first','second']),", "if(key==='1'){fetch('remote');}"],
  ]) {
    const mutated = source
      .replace(pathsExtension, extension)
      .replace(
        'const isConcreteExtensionAst = (root: SchemaAST.AST): boolean => {',
        `const isConcreteExtensionAst=(root:SchemaAST.AST):boolean=>{${guard}`,
      );
    // The member index guard belongs to the descriptor loop so its real index is exercised.
    const traversalSource = extension.includes('second')
      ? source.replace(pathsExtension, extension).replace(descriptorValueGuard, `${guard}if('value' in descriptor){`)
      : mutated;
    expect(
      strictSchemaProof(
        problemSchemaFile,
        'RequestSchemaProblemSchema',
        new Map([...sources, [problemSchemaFile, traversalSource]]),
      ),
    ).toBe(false);
  }
});

it('keeps inherited native descriptor presence unknown instead of proving absence', () => {
  const source = sources.get(problemSchemaFile) ?? '';
  for (const property of ['toString', 'constructor', 'hasOwnProperty']) {
    const mutated = source.replace(
      descriptorsAllocation,
      `${descriptorsAllocation}if('${property}' in descriptors){fetch('remote');}`,
    );
    expect(mutated).not.toBe(source);
    expect(
      strictSchemaProof(
        problemSchemaFile,
        'RequestSchemaProblemSchema',
        new Map([...sources, [problemSchemaFile, mutated]]),
      ),
    ).toBe(false);
  }
});

it('keeps native kind predicates unknown for opaque schema own values', () => {
  const source = sources.get(problemSchemaFile) ?? '';
  const fieldsAllocation = fieldDescriptorsAllocation;
  for (const [extension, field, predicate] of [
    ["paths: Schema.Literals(['first','second']),", 'members', 'Array.isArray'],
    [pathsExtension, 'value', 'Schema.isSchema'],
  ]) {
    const mutated = source
      .replace(pathsExtension, extension)
      .replace(
        fieldsAllocation,
        `${fieldsAllocation}if(fieldDescriptors.${field}!==undefined&&${predicate}(fieldDescriptors.${field}.value)){fetch('remote');}`,
      );
    expect(mutated).not.toBe(source);
    expect(
      strictSchemaProof(
        problemSchemaFile,
        'RequestSchemaProblemSchema',
        new Map([...sources, [problemSchemaFile, mutated]]),
      ),
    ).toBe(false);
  }
  const nativeArray = NativeSchema.Array(NativeSchema.String);
  const nativeLiterals = NativeSchema.Literals(['first', 'second']);
  expect(Array.isArray(Object.getOwnPropertyDescriptor(nativeLiterals, 'members')?.value)).toBe(true);
  expect(NativeSchema.isSchema(Object.getOwnPropertyDescriptor(nativeArray, 'value')?.value)).toBe(true);
});

it('keeps unknown native own descriptor presence uncertain through equality and aliases', () => {
  const source = sources.get(problemSchemaFile) ?? '';
  for (const branch of [
    "if(fieldDescriptors.missingDefinitelyNotNative===undefined){fetch('remote');}",
    "const missing=fieldDescriptors.missingDefinitelyNotNative;if(missing===undefined){fetch('remote');}",
  ]) {
    const mutated = source.replace(fieldDescriptorsAllocation, `${fieldDescriptorsAllocation}${branch}`);
    expect(
      strictSchemaProof(
        problemSchemaFile,
        'RequestSchemaProblemSchema',
        new Map([...sources, [problemSchemaFile, mutated]]),
      ),
    ).toBe(false);
  }
  expect(Object.getOwnPropertyDescriptor(NativeSchema.String, 'missingDefinitelyNotNative')).toBeUndefined();
});

for (const method of ['create', 'setPrototypeOf', 'defineProperty']) {
  it(`rejects shadowed namespace and computed-key collisions for native Object.${method}`, () => {
    const protectedMethods = [method];
    for (const source of [
      `const alias=Object;function harmless(){const alias=globalThis;}alias.${method}=foreign;`,
      `const alias=globalThis;function harmless(){const alias=Object;}alias.Object.${method}=foreign;`,
      `const key='${method}';function harmless(){const key='keys';}Object[key]=foreign;`,
      `function harmless(){const key='keys';}const key='${method}';Object[key]=foreign;`,
    ]) {
      expect(objectEvidence(source, protectedMethods)).toBe(false);
    }
    expect(
      objectEvidence(
        `const alias=Object;function harmless(){const alias=Object;}const value=alias.${method};`,
        protectedMethods,
      ),
    ).toBe(true);
    expect(
      objectEvidence(
        `const key='${method}';function harmless(){const key='${method}';}const value=Object[key];`,
        protectedMethods,
      ),
    ).toBe(true);
  });
}
it('rejects counterfeit or replaced native borrowers without freezing unrelated methods', () => {
  const protectedMethods = ['create'];
  expect(objectEvidence("import Reflect from 'foreign';Reflect.set(Object,'keys',foreign);", protectedMethods)).toBe(
    false,
  );
  expect(
    objectEvidence('Object.assign=(target)=>{target.create=foreign};Object.assign(Object,{keys:1});', protectedMethods),
  ).toBe(false);
  expect(
    objectEvidence(
      "Object.defineProperty=(target)=>{target.create=foreign};Object.defineProperty(Object,'keys',{value:1});",
      protectedMethods,
    ),
  ).toBe(false);
  expect(
    objectEvidence("Reflect.set=(target)=>{target.create=foreign};Reflect.set(Object,'keys',1);", protectedMethods),
  ).toBe(false);
  expect(
    objectEvidence(
      'Object.getPrototypeOf=foreign;const alias=Object.getPrototypeOf({});alias.create=foreign;',
      protectedMethods,
    ),
  ).toBe(false);
  expect(objectEvidence('Object.keys=foreign;', protectedMethods)).toBe(true);
  expect(objectEvidence('Object.assign(Object,{keys:1});', protectedMethods)).toBe(true);
});

it('invalidates replaced Reflect namespaces before treating their calls as native borrowers', () => {
  const protectedMethods = ['create'];
  for (const source of [
    "globalThis.Reflect={set(target){target.create=foreign}};Reflect.set(Object,'keys',1);",
    "const realm=global;realm.Reflect={set(target){target.create=foreign}};Reflect.set(Object,'keys',1);",
    "Object.defineProperty(globalThis,'Reflect',{value:{set(target){target.create=foreign}}});Reflect.set(Object,'keys',1);",
    "globalThis.Reflect.set=foreign;Reflect.set(Object,'keys',1);",
  ]) {
    expect(objectEvidence(source, protectedMethods)).toBe(false);
  }
  expect(objectEvidence("const reflect=globalThis.Reflect;reflect.set(Object,'keys',1);", protectedMethods)).toBe(true);
  expect(objectEvidence('globalThis.Reflect={};', protectedMethods)).toBe(true);
});

it('rejects native namespace spelling shadowed by named expression self bindings', () => {
  const protectedMethods = ['create'];
  for (const source of [
    "const fn=function Reflect(){Reflect.set(Object,'keys',1)};fn.set=(target)=>{target.create=foreign};fn();",
    "const Klass=class Reflect{static run(){Reflect.set(Object,'keys',1)}};Klass.set=(target)=>{target.create=foreign};Klass.run();",
    'const fn=function Object(){Object.create=foreign};fn();',
    'const Klass=class Object{static run(){Object.create=foreign}};Klass.run();',
  ]) {
    expect(objectEvidence(source, protectedMethods)).toBe(false);
  }
});

it('joins unknown shadow bindings instead of retaining a native namespace borrower', () => {
  for (const source of [
    'const alias=Object;{const alias={assign(target){target.create=foreign}};alias.assign(Object,{keys:1});}',
    'const alias=Object;function run(alias){alias.assign(Object,{keys:1});}run({assign(target){target.create=foreign}});',
    'const alias=Object;function run({alias}){alias.assign(Object,{keys:1});}run({alias:{assign(target){target.create=foreign}}});',
    'const alias=Object;const fn=function alias(){alias.assign(Object,{keys:1})};fn.assign=(target)=>{target.create=foreign};fn();',
    'const alias=Object;const Klass=class alias{static assign(target){target.create=foreign}static run(){alias.assign(Object,{keys:1})}};Klass.run();',
    'const alias=Object;try{throw {assign(target){target.create=foreign}};}catch(alias){alias.assign(Object,{keys:1});}',
    "const key='keys';function run({key}){Object[key]=foreign;}run({key:'create'});",
  ]) {
    expect(objectEvidence(source, ['create'])).toBe(false);
  }
  expect(objectEvidence('const data={};function run(data){Object.assign(data,{key:1});}run(data);', ['create'])).toBe(
    true,
  );
});

it('keeps unproven Symbol computed keys unknown', () => {
  for (const source of [
    "const Symbol=()=> 'create';Object[Symbol()]=foreign;",
    "const Symbol={for:()=> 'create'};Object[Symbol.for('key')]=foreign;",
  ]) {
    expect(objectEvidence(source, ['create'])).toBe(false);
  }
});

it('resolves deeply nested unrelated call chains without repeated origin expansion', () => {
  const chain = `source${'.pipe()'.repeat(28)}`;
  expect(objectEvidence(`const value=${chain};Object.create({value});`, ['create'])).toBe(true);
});

it('keeps later alias and native helper identity facts in fluent origin analysis', () => {
  expect(
    objectEvidence('function run(){const holder=alias;holder.create=foreign;}const alias=Object;run();', ['create']),
  ).toBe(false);
  expect(
    objectEvidence('const holder=Object.assign({},{});Object.assign=foreign;holder.create=foreign;', ['create']),
  ).toBe(false);
  expect(objectEvidence('const key=first;const first=key;Object[key]=foreign;', ['create'])).toBe(false);
});

const arrayIteratorEvidence = (source: string): boolean => {
  const parsed = parseSync('array-iterator-custody.ts', source, { sourceType: 'module' });
  expect(parsed.errors).toEqual([]);
  return hasClosedNativeArrayIteratorCustody(parsed.program);
};

for (const [name, source] of [
  ['ordinary rest forwarding', 'export const forward=(...args:unknown[])=>callback(...args);'],
  ['ordinary arrays', 'export const items=[1,2];const copy=items.map(x=>x+1);callback(copy);'],
  ['ordinary mutable array entries', 'const entries=[];const index=foreignIndex();entries[index]=1;callback(entries);'],
  [
    'ordinary array element and rest destructuring',
    'const [head,...tail]=[1,2];callback(head,tail);export const output={head,tail};',
  ],
  ['ordinary object rest over an array', 'const array=[1,2];const {length,...rest}=array;callback(length,rest);'],
  ['ordinary entry reconstruction', "const fields=[['field',1]];export const result=Object.fromEntries(fields);"],

  [
    'native array allocations',
    'const first=Array(2);const second=new Array();const third=Array.of(1);const fourth=Array.from(first);callback(second,third,fourth);',
  ],
  ['ordinary symbol allocation', "const key=Symbol('local');const object={[key]:1};callback(object);"],
  [
    'ordinary native Object allocation',
    'const object=Object.create({});Object.assign(object,{value:1});Object.freeze(object);',
  ],
  ['unrelated Array prototype method replacement', 'Array.prototype.map=foreign;'],
  ['unrelated native Object method replacement', 'Object.keys=foreign;'],
  ['local iterator consumption', 'const iterator=[1,2].values();iterator.next();'],
  [
    'Reflect iterator prototype observation',
    'const proto=Reflect.getPrototypeOf([].values());const same=proto===Object.getPrototypeOf([].values());',
  ],
  [
    'literal iterator and direct prototype observation',
    'const iterator=[][Symbol.iterator]();const prototype=Object.getPrototypeOf(iterator);const same=prototype===Object.getPrototypeOf([].values());',
  ],
  ['Symbol iterator local alias', 'const key=Symbol.iterator;const iterator=[][key]();iterator.next();'],
  ['Symbol iterator destructured alias', 'const {iterator:key}=Symbol;const iterator=[][key]();iterator.next();'],
  ['genuine iterator factory alias', 'const values=Array.prototype.values;const iterator=[].values();iterator.next();'],
] as const) {
  it(`proves array iteration identity beside ${name}`, () => expect(arrayIteratorEvidence(source)).toBe(true));
}
for (const [name, source] of [
  ['native iteration replacement', 'Array.prototype[Symbol.iterator]=foreign;'],
  ['native iterator deletion', 'delete Array.prototype[Symbol.iterator];'],
  ['global Array replacement', 'globalThis.Array=foreign;'],
  ['global Symbol replacement', 'const realm=global;realm.Symbol=foreign;'],
  ['well-known symbol replacement', 'Symbol.iterator=foreign;'],
  ['unknown native prototype write', 'Array.prototype[key]=foreign;'],
  ['literal prototype replacement', 'Object.getPrototypeOf([])[Symbol.iterator]=foreign;'],
  [
    'aliased prototype borrower unsupported',
    'const protoOf=Object.getPrototypeOf;protoOf([])[Symbol.iterator]=foreign;',
  ],
  [
    'destructured prototype borrower unsupported',
    'const {getPrototypeOf:protoOf}=Object;protoOf([].values()).next=foreign;',
  ],

  ['Array.of prototype replacement', 'Object.getPrototypeOf(Array.of())[Symbol.iterator]=foreign;'],
  ['Array.from iterator next replacement', 'Object.getPrototypeOf(Array.from([]).values()).next=foreign;'],
  ['Array constructor prototype replacement', 'Object.getPrototypeOf(Array())[Symbol.iterator]=foreign;'],
  ['new Array prototype replacement', 'Object.getPrototypeOf(new Array())[Symbol.iterator]=foreign;'],
  ['mapped array iterator prototype replacement', 'Object.getPrototypeOf([].map(x=>x).values()).next=foreign;'],
  ['unknown produced array proto-member write', 'Array.of().__proto__[Symbol.iterator]=foreign;'],
  [
    'constructor prototype provenance replacement',
    'const p=Object.getPrototypeOf([].values());Array.prototype.constructor={prototype:p};Array.prototype.constructor.prototype.next=foreign;',
  ],
  ['assigned prototype container escape', 'const box={};box.proto=Array.prototype;foreign(box);'],

  ['literal prototype alias', 'const prototype=[].__proto__;prototype[Symbol.iterator]=foreign;'],
  ['destructured native prototype', 'const {prototype}=Array;prototype[Symbol.iterator]=foreign;'],
  ['iteration key alias', 'const key=Symbol.iterator;Array.prototype[key]=foreign;'],
  [
    'computed key shadow',
    "const key=Symbol.iterator;function dormant(){const key='map';}Array.prototype[key]=foreign;",
  ],
  ['native namespace shadow', 'const Array=foreign;Array.prototype[Symbol.iterator]=foreign;'],
  ['native Symbol shadow', "const Symbol={iterator:'map'};Array.prototype[Symbol.iterator]=foreign;"],
  [
    'native namespace alias shadow',
    'const alias=Array;function dormant(alias){alias.prototype[Symbol.iterator]=foreign;}',
  ],
  ['Object mutator', 'Object.defineProperty(Array.prototype,Symbol.iterator,{value:foreign});'],
  ['Object descriptor map mutator', 'Object.defineProperties(Array.prototype,{[Symbol.iterator]:{value:foreign}});'],
  ['Object assign mutator', 'Object.assign(Array.prototype,{[Symbol.iterator]:foreign});'],
  ['Reflect mutator', 'Reflect.set(Array.prototype,Symbol.iterator,foreign);'],
  [
    'Reflect descriptor native prototype mutation',
    "const descriptor=Reflect.getOwnPropertyDescriptor(Array,'prototype');descriptor.value[Symbol.iterator]=foreign;",
  ],
  [
    'Reflect descriptor next escape',
    "const descriptor=Reflect.getOwnPropertyDescriptor(Object.getPrototypeOf([].values()),'next');foreign(descriptor.value);",
  ],
  ['Reflect namespace shadow', "import Reflect from 'foreign';Reflect.set(Array.prototype,'map',1);"],
  ['changed mutator borrower', 'Object.assign=foreign;Object.assign(Array.prototype,{map:1});'],
  ['raw native prototype escape', 'foreign(Array.prototype);'],
  ['raw factory escape', 'foreign(Array.prototype.values);'],
  ['destructured iterator key escape', 'const {iterator:key}=Symbol;foreign([][key]());'],
  [
    'ambiguous iterator key call unsupported',
    "const key=Symbol.iterator;function dormant(){const key='map';}foreign([][key]());",
  ],
  ['returned prototype escape', 'export const leak=()=>Array.prototype;'],
  ['native prototype class storage', 'class Hold{static value=Array.prototype;}'],
  ['acquired values iterator next replacement', 'const iterator=[].values();iterator.next=foreign;'],
  [
    'acquired keys iterator next replacement',
    'const iterator=[].keys();Object.defineProperty(iterator,"next",{value:foreign});',
  ],
  ['acquired entries iterator next replacement', 'const iterator=[].entries();Reflect.set(iterator,"next",foreign);'],
  ['native iterator prototype next replacement', 'Object.getPrototypeOf([][Symbol.iterator]()).next=foreign;'],
  ['native iterator prototype through Reflect', 'Reflect.getPrototypeOf([].values()).next=foreign;'],
  [
    'descriptor-derived factory transport unsupported',
    'const factory=Object.getOwnPropertyDescriptor(Array.prototype,Symbol.iterator).value;const iterator=factory.call([]);Object.getPrototypeOf(iterator).next=foreign;',
  ],
  ['native iterator prototype through proto member', '[].values().__proto__.next=foreign;'],
  ['iterator prototype alias escape', 'const proto=Object.getPrototypeOf([].values());foreign(proto);'],
  ['iterator next alias escape', 'const {next}=[].values();foreign(next);'],
  ['iterator returned escape', 'export const leak=()=>[].values();'],
  ['iterator prototype replacement', 'Object.setPrototypeOf([].values(),foreign);'],
  ['unknown iterator prototype member write', 'Object.getPrototypeOf([].values())[key]=foreign;'],
  [
    'iterator factory call transport unsupported',
    'const values=Array.prototype.values;const iterator=values.call([]);foreign(iterator);',
  ],
] as const) {
  it(`rejects array iteration ${name}`, () => expect(arrayIteratorEvidence(source)).toBe(false));
}

it('keeps array iteration origin walks bounded on unrelated fluent spines', () => {
  expect(arrayIteratorEvidence(`const value=source${'.pipe()'.repeat(28)};callback(value);`)).toBe(true);
});

it('rejects assigning a protected Object namespace into an unknown container', () => {
  expect(objectEvidence('const box={};box.raw=Object;foreign(box);')).toBe(false);
  expect(objectEvidence('const box={};box.raw={value:1};foreign(box);')).toBe(true);
});

it('proves actual participating data modules and rejects native iteration tampering beside them', () => {
  for (const file of [
    'packages/core-runtime/src/reads/definition.ts',
    'packages/core-runtime/src/db/scoped-routine.ts',
    'packages/core-runtime/src/database/postgres-failure.ts',
    'packages/core-runtime/src/access/decision/engine.ts',
    'packages/shared-contracts/src/problem-details.ts',
    'verticals/commerce-customer-context/shared/domain/payment-terms.ts',
    'packages/pricing-contracts/src/domain/commercial-total.ts',
    'packages/core-runtime/src/access/compiler/spicedb-relationship.ts',
  ]) {
    const source = sources.get(file);
    expect(source, file).toBeDefined();
    expect(arrayIteratorEvidence(source ?? ''), file).toBe(true);
    expect(arrayIteratorEvidence(`${source}\nObject.getPrototypeOf([].values()).next=foreign;`), file).toBe(false);
  }
});

const columnFile = 'packages/column-proof/src/schema.ts';
const columnEnable = 'const enable=';
const columnProperty = "outcomeCode:text('outcome_code').notNull()";
const columnExport = 'export const audit=';
const columnSource =
  "import {pgSchema,text} from 'drizzle-orm/pg-core';const schema=pgSchema('core');const enable=(table)=>table.enableRLS();export const audit=enable(schema.table('audit_events',{outcomeCode:text('outcome_code').notNull()}));";
const columnEvidence = (source = columnSource, field = 'outcomeCode') =>
  nativeColumnInitializationEvidence(source, 'audit', field, {
    filename: columnFile,
    ownerPath: 'packages/column-proof',
    sources: new Map([
      [columnFile, source],
      [
        'packages/column-proof/package.json',
        JSON.stringify({ exports: { './schema': './src/schema.ts' }, name: '@app/column-proof' }),
      ],
    ]),
  });
it('extracts exact native column initialization AST and count facts without decoder authority', () => {
  const evidence = columnEvidence();
  expect(evidence).not.toBeNull();
  expect(evidence?.scope).toBe('initialization-only');
  expect(evidence?.tableLocalName).toBe('audit');
  expect(evidence?.nativeRoot.kind).toBe('text');
  expect(evidence?.nativeRoot.argumentCount).toBe(1);
  expect(evidence?.builderMethods.map((method) => [method.name, method.argumentCount])).toEqual([['notNull', 0]]);
  expect(evidence?.factoryCalls).toEqual([]);
  expect(evidence?.source).toBe(columnSource);
  expect(evidence?.program.type).toBe('Program');
  expect(evidence?.tableCall.type).toBe('CallExpression');
  const arrayColumn = columnEvidence(
    columnSource.replace("text('outcome_code').notNull()", "text('outcome_code').array().notNull()"),
  );
  expect(arrayColumn?.nativeRoot.kind).toBe('text');
  expect(arrayColumn?.builderMethods.map((method) => method.name)).toEqual(['array', 'notNull']);
});
it('extracts actual auditEvents text columns from the genuine wrapped Core schema', () => {
  const filename = 'packages/core-runtime/src/db/schema.ts';
  const source = sources.get(filename) ?? '';
  for (const field of ['outcomeCode', 'outcomeStage']) {
    const evidence = nativeColumnInitializationEvidence(source, 'auditEvents', field, {
      filename,
      ownerPath: 'packages/core-runtime',
      sources,
    });
    expect(evidence, field).not.toBeNull();
    expect(evidence?.nativeRoot.kind, field).toBe('text');
    expect(evidence?.tableLocalName).toBe('auditEvents');
    expect(evidence?.builderMethods.map((method) => [method.name, method.argumentCount])).toEqual([['notNull', 0]]);
  }
});
it('retains actual specialization captures when a closed native column factory is used', () => {
  const source = columnSource
    .replace(columnEnable, 'const named=(name)=>text(name).notNull();const enable=')
    .replace(columnProperty, "outcomeCode:named('outcome_code')");
  const evidence = columnEvidence(source);
  expect(evidence).not.toBeNull();
  expect(evidence?.nativeRoot.kind).toBe('text');
  expect(evidence?.nativeRoot.captures.get('name')?.value).toBe('outcome_code');
  expect(evidence?.factoryCalls.length).toBe(1);
});
for (const [name, source] of [
  ['foreign native root', columnSource.replace("from 'drizzle-orm/pg-core'", "from 'foreign'")],
  ['wrong field', columnSource.replace('outcomeCode:', 'other:')],
  ['computed field', columnSource.replace('outcomeCode:', "['outcomeCode']:")],
  ['field accessor', columnSource.replace(columnProperty, "get outcomeCode(){return text('outcome_code').notNull()}")],
  ['duplicate field', columnSource.replace('{outcomeCode:', "{outcomeCode:text('decoy'),outcomeCode:")],
  ['custom native root', columnSource.replace("text('outcome_code')", "customType('outcome_code')")],
  ['custom builder method', columnSource.replace('.notNull()', '.mapWith(foreign)')],
  ['foreign RLS wrapper', columnSource.replace('table.enableRLS()', 'foreign(table)')],
  [
    'destructured foreign RLS wrapper',
    columnSource.replace('(table)=>table.enableRLS()', '({...rest})=>foreignObject().enableRLS()'),
  ],
  [
    'default-parameter foreign RLS wrapper',
    columnSource.replace('(table)=>table.enableRLS()', '(table={})=>foreignObject().enableRLS()'),
  ],
  ['preallocation constructor mutation', columnSource.replace(columnExport, 'text=foreign;export const audit=')],
  ['selected column driver mutation', `${columnSource}audit.outcomeCode.mapFromDriverValue=foreign;`],
  [
    'selected column native assign mutation',
    `${columnSource}Object.assign(audit.outcomeCode,{mapFromDriverValue:foreign});`,
  ],
  ['selected column escape', `${columnSource}foreign(audit.outcomeCode);`],
  ['selected column default escape', `${columnSource}const leak=(value=audit.outcomeCode)=>value;foreign(leak());`],
] as const) {
  it(`rejects column initialization evidence for ${name}`, () => expect(columnEvidence(source)).toBeNull());
}

it('records the actual zero-argument field-map factory frame', () => {
  const source = columnSource
    .replace(columnEnable, "const fields=()=>({outcomeCode:text('outcome_code').notNull()});const enable=")
    .replace("{outcomeCode:text('outcome_code').notNull()}));", '{...fields()}));');
  const evidence = columnEvidence(source);
  expect(evidence).not.toBeNull();
  expect(evidence?.factoryCalls.length).toBe(1);
});
it('admits only genuine cold SQL literal metadata in initialization extraction', () => {
  const source = columnSource
    .replace('import {pgSchema,text}', "import {sql} from 'drizzle-orm';import {pgSchema,text}")
    .replace(columnProperty, "outcomeCode:text('outcome_code').notNull().default(sql`'value'`)");
  expect(columnEvidence(source)).not.toBeNull();
  expect(columnEvidence(source.replace("from 'drizzle-orm'", "from 'foreign'"))).toBeNull();
  expect(columnEvidence(source.replace("sql`'value'`", `sql\`\${foreign()}\``))).toBeNull();
  expect(columnEvidence(source.replace(columnExport, 'sql.raw=foreign;export const audit='))).toBeNull();
});
it('rejects mutated or escaped closed column factory bindings before allocation', () => {
  const source = columnSource
    .replace(columnEnable, 'const named=(name)=>text(name).notNull();const enable=')
    .replace(columnProperty, "outcomeCode:named('outcome_code')");
  expect(columnEvidence(source.replace(columnExport, 'named=foreign;export const audit='))).toBeNull();
  expect(columnEvidence(source.replace(columnExport, 'foreign(named);export const audit='))).toBeNull();
});

it('keeps actual Privacy fresh array materialization separate from iterator identity escape', () => {
  const filename = 'verticals/privacy/shared/domain/privacy-applicability.ts';
  const source = sources.get(filename) ?? '';
  expect(source).toContain('[...dimensions.entries()].filter');
  expect(arrayIteratorEvidence(source)).toBe(true);
  for (const suffix of [
    'Array.prototype.entries=foreign;',
    'Object.getPrototypeOf([].values()).next=foreign;',
    'const opaque={raw:Array.prototype};opaque.filter(callback);',
  ]) {
    expect(arrayIteratorEvidence(`${source}\n${suffix}`)).toBe(false);
  }
});
it('consumes a native iterator only in a fresh array spread and retains other container guards', () => {
  expect(
    arrayIteratorEvidence(
      'const dimensions=[];const selected=[...dimensions.entries()].filter(([,values])=>new Set(values).size>1);callback(selected);',
    ),
  ).toBe(true);
  for (const source of [
    'const dimensions=[];const selected=[dimensions.entries()];selected.filter(callback);',
    'const selected=[Array.prototype];selected.filter(callback);',
    'const selected=[...[Array.prototype]];selected.filter(callback);',
    'const iterator=[].entries();foreign(iterator);',
    'const Array=foreign;const selected=[...[].entries()].filter(callback);',
  ]) {
    expect(arrayIteratorEvidence(source)).toBe(false);
  }
});

const stringConstructorEvidence = (source: string): boolean => {
  const parsed = parseSync('string-custody.ts', source, { sourceType: 'module' });
  expect(parsed.errors).toEqual([]);
  return hasClosedNativeStringConstructorCustody(parsed.program);
};
for (const [name, source] of [
  ['native one argument', 'export const value=String(input);'],
  ['aliased constructor member mutation', 'const alias=String;alias.call=foreign;'],
  ['raw constructor escape', 'foreign(String);'],
  ['constructor return escape', 'export const leak=()=>String;'],
  ['constructor property storage', 'const holder={};holder.native=String;'],
  ['prototype constructor replacement', 'String.prototype.constructor=foreign;'],

  ['native alias', 'const native=String;export const value=native(input);'],
  ['global alias', 'const realm=globalThis;export const value=realm.String(input);'],
  ['destructured native alias', 'const {String:native}=globalThis;const value=native(input);'],
  ['ordinary Object metadata', 'Object.defineProperty({},"String",{value:foreign});'],
  ['unrelated native method mutation', 'Object.getOwnPropertyNames=foreign;'],
] as const) {
  it(`proves String constructor identity for ${name}`, () => expect(stringConstructorEvidence(source)).toBe(true));
}
for (const [name, source] of [
  ['direct shadow', 'const String=foreign;String(input);'],
  ['parameter shadow', 'function run(String){return String(input);}'],
  ['import shadow', "import String from 'foreign';String(input);"],
  ['named self shadow', 'const fn=function String(){return String(input);};'],
  ['global replacement', 'globalThis.String=foreign;'],
  ['Node global replacement', 'const realm=global;realm.String=foreign;'],
  ['direct replacement', 'String=foreign;'],
  ['native descriptor replacement', 'Object.defineProperty(globalThis,"String",{value:foreign});'],
  ['native assign replacement', 'Object.assign(globalThis,{String:foreign});'],
  ['native Reflect replacement', 'Reflect.set(globalThis,"String",foreign);'],
  [
    'Reflect descriptor escape',
    'const descriptor=Reflect.getOwnPropertyDescriptor(globalThis,"String");foreign(descriptor.value);',
  ],
  [
    'Object descriptor escape',
    'const descriptor=Object.getOwnPropertyDescriptor(globalThis,"String");foreign(descriptor.value);',
  ],
  ['unknown alias collision', 'const alias=String;function run(alias){foreign(alias);}'],
  ['changed mutation borrower', 'Object.assign=foreign;Object.assign(globalThis,{other:1});'],
] as const) {
  it(`rejects String constructor identity for ${name}`, () => expect(stringConstructorEvidence(source)).toBe(false));
}

it('keeps actual String callback transport separate from global constructor rebinding', () => {
  for (const filename of [
    'packages/shared-contracts/src/http-error-seam.ts',
    'verticals/commerce-customer-context/src/integrations/customer-commerce-payment-terms-policy.ts',
  ]) {
    const source = readFileSync(path.join(appRoot, filename), 'utf-8');
    expect(source).toContain('String');
    expect(stringConstructorEvidence(source), filename).toBe(true);
    expect(
      stringConstructorEvidence(`${source}\nconst realm=globalThis;const alias=realm;alias.String=foreign;`),
      filename,
    ).toBe(false);
  }
  expect(stringConstructorEvidence('const {String:native}=globalThis;native=foreign;native(input);')).toBe(false);
});

const authenticationContractFile = 'verticals/commerce-customer-context/shared/portal-auth-contracts.ts';
const equivalenceDerivation = (source = sources.get(authenticationContractFile) ?? '', snapshot = sources) =>
  provesDefaultStructEquivalenceSchemaExport(source, 'VerifyExternalAuthenticationRequestSchema', {
    filename: authenticationContractFile,
    isImmutableContractSource: () => false,
    ownerPath: 'verticals/commerce-customer-context',
    sources: new Map([...snapshot, [authenticationContractFile, source]]),
  });
it('derives only the actual default native Struct comparator shape', () => {
  expect(equivalenceDerivation()).toBe(true);
});
it('rejects root and nested comparator overrides and captured AST escape in derivation evidence', () => {
  const source = sources.get(authenticationContractFile) ?? '';
  expect(
    equivalenceDerivation(source.replace('nonce: uuid,', 'nonce: uuid.annotate({toEquivalence:()=>()=>true}),')),
  ).toBe(false);
  expect(
    equivalenceDerivation(
      `${source}\nVerifyExternalAuthenticationRequestSchema.ast.annotations={toEquivalence:()=>()=>true};`,
    ),
  ).toBe(false);
  expect(equivalenceDerivation(`${source}\nforeign(VerifyExternalAuthenticationRequestSchema.ast);`)).toBe(false);
});

const derivationFixture = (initializer: string) =>
  provesDefaultStructEquivalenceSchemaExport(
    `import {Schema} from 'effect';export const Result=${initializer};`,
    'Result',
  );
it('keeps comparator derivation restricted to nonempty scalar Struct metadata', () => {
  expect(derivationFixture("Schema.Struct({value:Schema.String,tag:Schema.Literal('tag')})")).toBe(true);
  for (const initializer of [
    'Schema.Struct({})',
    '(Schema.String)',
    'Schema.Struct({value:Schema.Number})',
    'Schema.Struct({value:Schema.Struct({nested:Schema.String})})',
    'Schema.Struct({value:Schema.Array(Schema.String)})',
    'Schema.Union([Schema.Struct({value:Schema.String})])',
    'Schema.suspend(()=>Schema.Struct({value:Schema.String}))',
    'Schema.optionalKey(Schema.Struct({value:Schema.String}))',
    'Schema.String.pipe(Schema.decodeTo(Schema.Struct({value:Schema.String})))',
    'Schema.Struct({value:Schema.String.check(Schema.makeFilter(()=>true))})',
    "Schema.Struct({value:Schema.String.annotate({title:'opaque'})})",
  ]) {
    expect(derivationFixture(initializer), initializer).toBe(false);
  }
});
it('rejects root, spread-child and final-check equivalence overrides', () => {
  const source = sources.get(authenticationContractFile) ?? '';
  const tail = '  tenantId: TenantIdSchema,\n});';
  expect(source).toContain(tail);
  expect(
    equivalenceDerivation(
      source.replace(tail, '  tenantId: TenantIdSchema,\n}).annotate({toEquivalence:()=>()=>true});'),
    ),
  ).toBe(false);
  expect(
    equivalenceDerivation(
      source.replace(
        'providerSubjectId: ProviderSubjectIdSchema,',
        'providerSubjectId: ProviderSubjectIdSchema.annotate({toEquivalence:()=>()=>true}),',
      ),
    ),
  ).toBe(false);
  expect(
    equivalenceDerivation(source.replace('Schema.isUUID()', 'Schema.isUUID(undefined,{toEquivalence:()=>()=>true})')),
  ).toBe(false);
  const external = 'packages/core-runtime/src/auth/external-identity-contracts.ts';
  const producer = sources.get(external) ?? '';
  expect(
    equivalenceDerivation(
      source,
      new Map([
        ...sources,
        [external, producer.replace('Schema.isMaxLength(500)', 'Schema.isMaxLength(500,{toEquivalence:()=>()=>true})')],
      ]),
    ),
  ).toBe(false);
});
it('rejects dormant AST mutation and SchemaCompiler decoder registration escapes', () => {
  const source = sources.get(authenticationContractFile) ?? '';
  for (const suffix of [
    'function mutate(){VerifyExternalAuthenticationRequestSchema.ast.annotations={toEquivalence:()=>()=>true};}',
    'function mutate(){foreign(VerifyExternalAuthenticationRequestSchema.ast);}',
    'function mutate(){foreign(VerifyExternalAuthenticationRequestSchema.fields.nonce.ast);}',
    'function mutate(){SchemaCompiler.set(VerifyExternalAuthenticationRequestSchema.ast,foreign);}',
    'const nonceAlias=VerifyExternalAuthenticationRequestSchema.fields.nonce;function mutate(){SchemaCompiler.set(nonceAlias.ast,foreign);}',
  ]) {
    expect(equivalenceDerivation(`import {SchemaCompiler} from 'effect/schema';\n${source}\n${suffix}`), suffix).toBe(
      false,
    );
  }
});

it('keeps source-only derivation capture custody closed', () => {
  const source = "import {Schema} from 'effect';export const Result=Schema.Struct({value:Schema.String});";
  expect(provesDefaultStructEquivalenceSchemaExport(source, 'Result')).toBe(true);
  expect(provesDefaultStructEquivalenceSchemaExport(`${source}function mutate(){foreign(Result.ast);}`, 'Result')).toBe(
    false,
  );
});

it('does not recover comparator provenance through opaque or unsupported fields projections', () => {
  expect(derivationFixture('Schema.Struct({...Schema.Union([Schema.Struct({value:Schema.String})]).fields})')).toBe(
    false,
  );
  expect(
    derivationFixture("Schema.Struct({...Schema.Struct({value:Schema.String}).annotate({title:'opaque'}).fields})"),
  ).toBe(false);
});

const authenticationDtoKeys = [
  'authenticationNamespaceId',
  'providerSubjectId',
  'subjectType',
  'enrollmentAttemptId',
  'nonce',
  'sessionRef',
  'tenantId',
];
const prototypeKeyEvidence = (source: string): boolean => {
  const parsed = parseSync('prototype-key-custody.ts', source, { sourceType: 'module' });
  expect(parsed.errors).toEqual([]);
  return hasClosedNativeObjectPrototypeKeyCustody(parsed.program, authenticationDtoKeys);
};
it('preserves initially absent native prototype DTO keys for ordinary own-data records', () => {
  expect(
    prototypeKeyEvidence('const input={nonce:"nonce"};const optional=input.enrollmentAttemptId;Object.freeze(input);'),
  ).toBe(true);
});
it('rejects prototype getters setters aliases and unknown writes for actual DTO keys', () => {
  for (const source of [
    'Object.prototype.enrollmentAttemptId=foreign;',
    'Object.defineProperty(Object.prototype,"enrollmentAttemptId",{get(){return foreign();}});',
    'Reflect.defineProperty(Object.prototype,"tenantId",{set(value){foreign(value);}});',
    'const proto=Object.prototype;proto.nonce=foreign;',
    'Object.prototype[key]=foreign;',
    'Object.setPrototypeOf(Object.prototype,foreign);',
    'foreign(Object.prototype);',
  ]) {
    expect(prototypeKeyEvidence(source), source).toBe(false);
  }
});

for (const [name, source] of [
  ['unrelated own getter definition', 'Object.defineProperty(Object.prototype,"other",{get(){return value;}});'],
  ['frozen native prototype', 'Object.freeze(Object.prototype);'],
  ['ordinary own data construction', 'const value=Object.assign({},{nonce:"data"});Object.freeze(value);'],
  ['ordinary local getter not global custody', 'const value={get nonce(){return foreign();}};'],
  ['known absent prototype key read', 'const value=Object.prototype.enrollmentAttemptId;'],
] as const) {
  it(`keeps prototype key custody separate from ${name}`, () => expect(prototypeKeyEvidence(source)).toBe(true));
}
for (const [name, source] of [
  ['legacy getter', 'Object.prototype.__defineGetter__("nonce",foreign);'],
  ['legacy setter', 'Object.prototype.__defineSetter__("tenantId",foreign);'],
  [
    'unknown method receiver escape',
    'Object.prototype.mutate=function(){this.nonce=foreign;};Object.prototype.mutate();',
  ],
  [
    'unknown getter receiver escape',
    'Object.defineProperty(Object.prototype,"other",{get(){this.nonce=foreign;}});const value=Object.prototype.other;',
  ],
  ['destructured alias', 'const {prototype:proto}=Object;proto.sessionRef=foreign;'],
  ['holder alias', 'const holder={proto:Object.prototype};Object.defineProperty(holder.proto,"nonce",{get:foreign});'],
  ['constructor derived prototype', '({}).constructor.prototype.nonce=foreign;'],
  ['literal derived prototype', 'Object.getPrototypeOf({}).nonce=foreign;'],
  ['literal proto property', '({}).__proto__.nonce=foreign;'],
  ['Reflect derived prototype', 'Reflect.getPrototypeOf({}).nonce=foreign;'],
  ['borrower alias unsupported', 'const protoOf=Object.getPrototypeOf;protoOf({}).nonce=foreign;'],
  ['Reflect descriptor alias', 'Reflect.getOwnPropertyDescriptor(Object,"prototype").value.nonce=foreign;'],
  ['prototype descriptor assign', 'Object.defineProperties(Object.prototype,{nonce:{get:foreign}});'],
  ['prototype assign', 'Object.assign(Object.prototype,{tenantId:foreign});'],
  ['computed unknown assign', 'Object.assign(Object.prototype,{[key]:foreign});'],
  ['global constructor replacement', 'globalThis.Object=foreign;'],
  ['prototype replacement', 'Object.prototype=foreign;'],
  ['prototype chain replacement', 'Object.prototype.__proto__=foreign;'],
  ['changed native borrower', 'Object.defineProperty=foreign;Object.defineProperty(Object.prototype,"other",{});'],
  [
    'shadowed native constructor',
    "import Object from 'foreign';Object.defineProperty(Object.prototype,'nonce',{get:foreign});",
  ],
] as const) {
  it(`rejects prototype key custody ${name}`, () => expect(prototypeKeyEvidence(source)).toBe(false));
}
it('does not claim initial absence for builtin prototype properties', () => {
  const parsed = parseSync('prototype-key-custody.ts', '', { sourceType: 'module' });
  expect(hasClosedNativeObjectPrototypeKeyCustody(parsed.program, ['constructor'])).toBe(false);
  expect(hasClosedNativeObjectPrototypeKeyCustody(parsed.program, [])).toBe(false);
});

const prototypeGetterPrefix =
  'Object.defineProperty(Object.prototype,"other",{configurable:true,enumerable:true,get(){this.nonce="injected";}});';
for (const [name, read] of [
  ['object destructure', 'const {other}=Object.prototype;'],
  ['object rest', 'const {...rest}=Object.prototype;'],
  ['object spread', 'const copy={...Object.prototype};'],
  ['native entries', 'Object.entries(Object.prototype);'],
  ['native values', 'Object.values(Object.prototype);'],
  ['native assign values', 'Object.assign({},Object.prototype);'],
  ['Reflect getter', 'Reflect.get(Object.prototype,"other");'],
] as const) {
  it(`rejects implicit prototype getter execution through ${name}`, () =>
    expect(prototypeKeyEvidence(`${prototypeGetterPrefix}${read}`)).toBe(false));
}
for (const [name, write] of [
  ['ordinary assignment', 'Object.prototype.other="injected";'],
  ['Reflect assignment', 'Reflect.set(Object.prototype,"other","injected");'],
  ['native assign setter', 'Object.assign(Object.prototype,{other:"injected"});'],
] as const) {
  it(`rejects implicit prototype setter execution through ${name}`, () =>
    expect(
      prototypeKeyEvidence(
        `Object.defineProperty(Object.prototype,"other",{configurable:true,set(value){this.nonce=value;}});${write}`,
      ),
    ).toBe(false));
}

const runPrototypeFixture = (source: string): string | undefined =>
  withTemporaryWorkspace((directory) => {
    const filename = path.join(directory, 'native-prototype.cjs');
    writeFileSync(
      filename,
      `"use strict";\n${source}\nconst result=Object.prototype.nonce;if(result!==undefined)process.stdout.write(String(result));`,
    );
    const result = execFileSync(process.execPath, [filename], { encoding: 'utf-8', timeout: 2000 });
    return result.length === 0 ? undefined : result;
  });

it('backs implicit prototype accessor counterexamples with isolated native runtime execution', () => {
  const reads = [
    'const {other}=Object.prototype;',
    'const {...rest}=Object.prototype;',
    'const copy={...Object.prototype};',
    'Object.entries(Object.prototype);',
    'Object.values(Object.prototype);',
    'Object.assign({},Object.prototype);',
    'Reflect.get(Object.prototype,"other");',
  ];
  for (const read of reads) {
    const source = `${prototypeGetterPrefix}${read}`;
    expect(runPrototypeFixture(`${prototypeGetterPrefix}try{${read}}catch{}`)).toBe('injected');
    expect(prototypeKeyEvidence(source)).toBe(false);
  }
  for (const write of [
    'Object.prototype.other="injected";',
    'Reflect.set(Object.prototype,"other","injected");',
    'Object.assign(Object.prototype,{other:"injected"});',
  ]) {
    const source = `Object.defineProperty(Object.prototype,"other",{configurable:true,set(value){this.nonce=value;}});${write}`;
    expect(runPrototypeFixture(source)).toBe('injected');
    expect(prototypeKeyEvidence(source)).toBe(false);
  }
});
it('keeps native prototype key and own-descriptor reads separate from value enumeration', () => {
  expect(
    prototypeKeyEvidence(
      `${prototypeGetterPrefix}Object.keys(Object.prototype);Object.getOwnPropertyDescriptors(Object.prototype);Reflect.ownKeys(Object.prototype);`,
    ),
  ).toBe(true);
  expect(
    runPrototypeFixture(
      `${prototypeGetterPrefix}Object.keys(Object.prototype);Object.getOwnPropertyDescriptors(Object.prototype);`,
    ),
  ).toBeUndefined();
});

it('keeps a protected prototype out of implicit computed-key coercion', () => {
  const source =
    'const key={proto:Object.prototype,[Symbol.toPrimitive](){this.proto.nonce="injected";return "other";}};const {[key]:value}={};';
  expect(runPrototypeFixture(source)).toBe('injected');
  expect(prototypeKeyEvidence(source)).toBe(false);
});

for (const [name, use] of [
  ['member key', 'const value={}[key];'],
  ['Object property key', 'Object.defineProperty({},key,{value:1});'],
  ['Reflect property key', 'Reflect.get({},key);'],
  ['native own check key', 'Object.hasOwn({},key);'],
  ['entry construction key', 'Object.fromEntries([[key,1]]);'],
] as const) {
  it(`rejects protected prototype in native key coercion ${name}`, () => {
    const source = `const key={proto:Object.prototype,[Symbol.toPrimitive](){this.proto.nonce="injected";return "other";}};${use}`;
    expect(runPrototypeFixture(source)).toBe('injected');
    expect(prototypeKeyEvidence(source)).toBe(false);
  });
}
