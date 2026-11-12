import { readFile, readdir } from 'node:fs/promises';
import nodePath from 'node:path';

import { Effect, Path } from 'effect';
import { expect, it } from 'effect-rstest';

import { provedShellGatewayDatabaseSources } from '../shell-gateway-database-proof.mts';

const nativeRuntimeEntry = 'apps/shell-super-app/api/index.ts';
const nativeTransportEntry = 'apps/shell-super-app/api/symmy/transport.ts';
const fixtureRoot = '/issuer-proof';
const rootFile = `${fixtureRoot}/apps/shell-super-app/api/index.ts`;
const helperFile = `${fixtureRoot}/apps/shell-super-app/api/auth/evidence.ts`;
const sharedFile = `${fixtureRoot}/packages/shared-contracts/src/index.ts`;
const coreFile = `${fixtureRoot}/packages/core-runtime/src/db/client.ts`;
const helperSource = `import { CoreDatabase } from '@app/core-runtime/db/client';
import { Effect } from 'effect';
import { sql } from 'drizzle-orm';
export const evidence = Effect.fn('evidence')(function* () {
 const database = yield* CoreDatabase;
 return yield* database.executor.transaction(Effect.fn('facts')(function* (transaction) {
  return yield* transaction.execute(sql\`select tenant_id from core.api_key_principals\`);
 }));
});`;
const publishedGroupMount = 'Layer.mergeAll(group)';
const registeredRoot = `import { Layer } from 'effect';
import { HttpApi, HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { assembleEffectBffRuntime } from '@modern-js/bff-effect/assembly';
import { GatewayContextApiGroup } from '@app/shared-contracts';
import { evidence } from './auth/evidence.ts';
const api = HttpApi.make('shell').add(GatewayContextApiGroup);
export const makeRuntime = () => {
 const group = HttpApiBuilder.group(api, 'gatewayContext', handlers => handlers
  .handle('issueGatewayContext', () => evidence())
  .handle('issueApiKeyGatewayContext', () => evidence())
  .handle('issueDelegatedGatewayContext', () => evidence()));
 const handlers = Layer.mergeAll(group);
 return assembleEffectBffRuntime({ api, handlers });
};
export const argumentsTuple = Object.freeze([] as const);
const runtime = makeRuntime(...argumentsTuple);
export default runtime;`;
const fixtureSources = (): Map<string, string> =>
  new Map([
    [rootFile, registeredRoot],
    [helperFile, helperSource],
    [
      sharedFile,
      `import { HttpApiGroup } from '@modern-js/bff-effect/effect-client';
export const GatewayContextApiGroup = HttpApiGroup.make('gatewayContext');
export const shellGatewayContextContract = { ownerId: 'shell-super-app' } as const;`,
    ],
    [coreFile, 'export class CoreDatabase {}'],
  ]);
const fixtureExports = new Map([
  ['@app/shared-contracts', sharedFile],
  ['@app/core-runtime/db/client', coreFile],
]);
const proveFixture = (sources: ReadonlyMap<string, string>) =>
  Effect.gen(function* fixtureProof() {
    const path = yield* Path.Path;
    return [...provedShellGatewayDatabaseSources(sources, fixtureRoot, path, fixtureExports)];
  }).pipe(Effect.provide(Path.layer));

it.effect('proves the actual registered issuer role rather than an auth directory', () =>
  proveFixture(fixtureSources()).pipe(Effect.map((result) => expect(result).toEqual([helperFile]))),
);

it.effect.each([
  'Layer.empty.pipe(Layer.provideMerge(group))',
  'Layer.provideMerge(Layer.empty, group)',
  'Layer.mergeAll(group).pipe(Layer.provide(Layer.empty))',
])('preserves actual published Layer outputs: %s', (mount) => {
  const sources = fixtureSources();
  sources.set(rootFile, registeredRoot.replace(publishedGroupMount, mount));
  return proveFixture(sources).pipe(Effect.map((result) => expect(result).toEqual([helperFile])));
});

it.effect.each([
  ['unmounted group', registeredRoot.replace(publishedGroupMount, 'Layer.mergeAll(unrelated)')],
  ['dependency-only group', registeredRoot.replace(publishedGroupMount, 'Layer.empty.pipe(Layer.provide(group))')],
  ['uncurried dependency-only group', registeredRoot.replace(publishedGroupMount, 'Layer.provide(Layer.empty, group)')],
  ['unregistered runtime', registeredRoot.replace('export default runtime', 'export default unrelated')],
  [
    'conditional assembly return',
    registeredRoot.replace('return assembleEffectBffRuntime', 'if (false) return assembleEffectBffRuntime'),
  ],
  ['forged builder', registeredRoot.replace("from '@modern-js/bff-effect/effect-edge'", "from 'fake-framework'")],
  ['mutated namespace', `${registeredRoot}\nLayer.mergeAll = replacement;`],
  ['deleted native method', `${registeredRoot}\ndelete Layer.mergeAll;`],
  [
    'duplicate assembly handlers',
    registeredRoot.replace('{ api, handlers }', '{ api, handlers, "handlers": unrelated }'),
  ],
  ['mutable root factory', registeredRoot.replace('export const makeRuntime', 'export let makeRuntime')],
])('rejects %s', ([_name, source]) => {
  const sources = fixtureSources();
  sources.set(rootFile, source);
  return proveFixture(sources).pipe(Effect.map((result) => expect(result).toEqual([])));
});

it.effect.each([
  [
    'returned database',
    helperSource.replace(
      'return yield* database.executor.transaction',
      'return database;\n yield* database.executor.transaction',
    ),
  ],
  [
    'returned executor',
    `${helperSource}\nexport const executor = Effect.gen(function* () { const database = yield* CoreDatabase; return database.executor; });`,
  ],
  [
    'returned transaction',
    helperSource.replace('return yield* transaction.execute', 'return transaction;\n yield* transaction.execute'),
  ],
  [
    'transaction closure',
    helperSource.replace('return yield* transaction.execute', 'return () => transaction.execute'),
  ],
  ['second driver', `${helperSource}\nimport { Pool } from 'pg';`],
  ['raw tag export', `${helperSource}\nexport { CoreDatabase };`],
  ['local function alias escape', `${helperSource}\nexport const leaked = evidence;`],
  ['local business function consumer', `${helperSource}\nexport const directBusiness = () => evidence();`],
])('rejects capability escape through %s', ([_name, source]) => {
  const sources = fixtureSources();
  sources.set(helperFile, source);
  return proveFixture(sources).pipe(Effect.map((result) => expect(result).toEqual([])));
});

it.effect.each([
  ['business Action', "import { evidence } from '../api/auth/evidence.ts'; export const action = () => evidence();"],
  ['function alias escape', "import { evidence } from '../api/auth/evidence.ts'; export const leaked = evidence;"],
  ['reexport', "export { evidence } from '../api/auth/evidence.ts';"],
  ['star reexport', "export * from '../api/auth/evidence.ts';"],
  ['dynamic import', "export const imported = import('../api/auth/evidence.ts');"],
  ['template import', 'export const imported = import(`../api/auth/evidence.ts`);'],
  ['concat import', "export const imported = import('../api/auth/' + 'evidence.ts');"],
  ['const alias import', "const target = '../api/auth/evidence.ts'; export const imported = import(target);"],
  [
    'template substitution import',
    `const directory = '../api/auth/'; export const imported = import(\`\${directory}evidence.ts\`);`,
  ],
])('rejects an additional %s consumer', ([_name, source]) => {
  const sources = fixtureSources();
  sources.set(`${fixtureRoot}/apps/shell-super-app/business/action.ts`, source);
  return proveFixture(sources).pipe(Effect.map((result) => expect(result).toEqual([])));
});

it.live('proves exactly the six current Shell issuer bootstrap sources', () =>
  Effect.gen(function* actualShellIssuerProof() {
    const purePath = yield* Path.Path;
    const root = nodePath.resolve(import.meta.dirname, '../..');
    const sources = new Map<string, string>();
    const directories = [
      'apps/shell-super-app/api',
      'apps/shell-super-app/shared',
      'packages/shared-contracts/src',
      'packages/core-runtime/src/db',
    ];
    for (const directory of directories) {
      const absolute = nodePath.join(root, directory);
      const entries = yield* Effect.tryPromise(() => readdir(absolute, { recursive: true }));
      yield* Effect.forEach(
        entries.filter((entry) => /\.[cm]?tsx?$/u.test(entry)),
        (entry) =>
          Effect.gen(function* sourceSnapshot() {
            const file = nodePath.join(absolute, entry);
            sources.set(file, yield* Effect.tryPromise(() => readFile(file, 'utf-8')));
          }),
      );
    }
    const exports = new Map([
      ['@app/shared-contracts', nodePath.join(root, 'packages/shared-contracts/src/index.ts')],
      ['@app/shared-contracts/symmy', nodePath.join(root, 'packages/shared-contracts/src/symmy/index.ts')],
      ['@app/core-runtime/db/client', nodePath.join(root, 'packages/core-runtime/src/db/client.ts')],
    ]);
    expect(
      new Set(
        [...provedShellGatewayDatabaseSources(sources, root, purePath, exports)].map((file) => nodePath.basename(file)),
      ),
    ).toEqual(
      new Set([
        'gateway-organization-governance-evidence.ts',
        'gateway-privacy-dispatch-evidence.ts',
        'gateway-recovery-evidence.ts',
        'gateway-registered-assertion.ts',
        'gateway-symmy-route-scope.ts',
        'gateway-workload-evidence.ts',
      ]),
    );
    const symmyMutations = [
      {
        file: nodePath.join(root, nativeRuntimeEntry),
        from: '      return {\n        admit:',
        to: '      if (false) return {\n        admit:',
      },
      {
        file: nodePath.join(root, nativeRuntimeEntry),
        from: 'SymmyIngressHandlersLive.pipe(\n      Layer.provide(\n        Layer.mergeAll(\n          symmyIngressLive,',
        to: 'symmyIngressLive, SymmyIngressHandlersLive.pipe(\n      Layer.provide(\n        Layer.mergeAll(\n          Layer.empty,',
      },
      {
        file: nodePath.join(root, nativeRuntimeEntry),
        from: 'SymmyIngressHandlersLive.pipe(',
        to: 'unregisteredHandlers.pipe(',
      },
      {
        file: nodePath.join(root, nativeTransportEntry),
        from: 'Context.Service<',
        to: 'forgedContext.Service<',
      },
      {
        file: nodePath.join(root, nativeTransportEntry),
        from: '.admit(rawKey, httpRequest)',
        to: '.foreignAdmit(rawKey, httpRequest)',
      },
      {
        file: nodePath.join(root, 'apps/shell-super-app/shared/api.ts'),
        from: "from '@app/shared-contracts/symmy'",
        to: "from '@app/foreign-contracts/symmy'",
      },
      {
        file: nodePath.join(root, nativeRuntimeEntry),
        from: 'const symmyIngressLive = Layer.effect(\n    SymmyIngress,',
        to: 'const symmyIngressLive = Layer.effect(\n    foreignService,',
      },
    ];
    for (const mutation of symmyMutations) {
      const original = sources.get(mutation.file) ?? '';
      expect(original).toContain(mutation.from);
      const mutated = new Map([...sources, [mutation.file, original.replace(mutation.from, mutation.to)]]);
      const proved = provedShellGatewayDatabaseSources(mutated, root, purePath, exports);
      expect(proved.size).toBe(5);
      expect(proved.has(nodePath.join(root, 'apps/shell-super-app/api/auth/gateway-symmy-route-scope.ts'))).toBe(false);
    }
  }).pipe(Effect.provide(Path.layer)),
);
