import { readFile, readdir } from 'node:fs/promises';
import nodePath from 'node:path';

import { Effect, Path } from 'effect';
import { expect, it } from 'effect-rstest';

import { provedShellGatewayDatabaseSources } from '../shell-gateway-database-proof.mts';

const nativeRuntimeEntry = 'apps/shell-super-app/api/index.ts';
const nativeTransportEntry = 'apps/shell-super-app/api/symmy/transport.ts';
const paymentTransportEntry = 'apps/shell-super-app/api/payment-gateway/transport.ts';
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

it.live('proves exactly the seven current Shell issuer bootstrap sources', () =>
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
        'gateway-payment-route-scope.ts',
        'gateway-privacy-dispatch-evidence.ts',
        'gateway-recovery-evidence.ts',
        'gateway-registered-assertion.ts',
        'gateway-symmy-route-scope.ts',
        'gateway-workload-evidence.ts',
      ]),
    );
    const runtime = nodePath.join(root, nativeRuntimeEntry);
    const transport = nodePath.join(root, nativeTransportEntry);
    const shellApi = nodePath.join(root, 'apps/shell-super-app/shared/api.ts');
    const unmountedAuthentication = { file: shellApi, from: '  .middleware(SymmyAuthentication)\n', to: '' };
    const symmyMutations = [
      // The SymmyIngress Layer configures no admit.
      [{ file: runtime, from: '      return {\n        admit:', to: '      if (false) return {\n        admit:' }],
      // The SymmyIngress Layer is merged beside the Symmy handlers instead of provided to them.
      [
        {
          file: runtime,
          from: '      Layer.provide(symmyIngressLive),\n    ),\n',
          to: '    ),\n    symmyIngressLive,\n',
        },
      ],
      // The Symmy handlers are not mounted.
      [{ file: runtime, from: 'SymmyIngressHandlersLive.pipe(', to: 'unregisteredHandlers.pipe(' }],
      // SymmyIngress is not a Context.Service.
      [{ file: transport, from: 'Context.Service<', to: 'forgedContext.Service<' }],
      // The Symmy group is not built on the public route inventory.
      [{ file: shellApi, from: "from '@app/shared-contracts/symmy'", to: "from '@app/foreign-contracts/symmy'" }],
      // The root Layer configures another service than SymmyIngress.
      [
        {
          file: runtime,
          from: 'const symmyIngressLive = Layer.effect(\n    SymmyIngress,',
          to: 'const symmyIngressLive = Layer.effect(\n    foreignService,',
        },
      ],
      // The authentication middleware is declared but not mounted on the Symmy group.
      [unmountedAuthentication],
      // An endpoint is added after the authentication middleware, so it runs without it.
      [
        {
          file: shellApi,
          from: '    sellerVatDeclarationsFixtureBatchEndpoint,\n  )\n  .middleware(SymmySchemaError)\n  .middleware(SymmyAuthentication)\n',
          to: '  )\n  .middleware(SymmySchemaError)\n  .middleware(SymmyAuthentication)\n  .add(sellerVatDeclarationsFixtureBatchEndpoint)\n',
        },
      ],
      // Only the job endpoint carries the authentication middleware.
      [
        unmountedAuthentication,
        { file: shellApi, from: 'symmyJobOptions);', to: 'symmyJobOptions).middleware(SymmyAuthentication);' },
      ],
      // The authentication middleware wraps the defect boundary instead of running inside it.
      [
        {
          file: shellApi,
          from: '  .middleware(SymmyAuthentication)\n  .middleware(SymmyDefectBoundary);',
          to: '  .middleware(SymmyDefectBoundary)\n  .middleware(SymmyAuthentication);',
        },
      ],
      // The authentication Layer admits through a forged service.
      [
        {
          file: runtime,
          from: '    const ingress = yield* SymmyIngress;\n',
          to: '    const ingress = yield* forgedIngress;\n',
        },
      ],
      // The admission calls a renamed method.
      [
        {
          file: transport,
          from: '.admit(rawKey, yield* HttpServerRequest.HttpServerRequest, route)',
          to: '.foreignAdmit(rawKey, yield* HttpServerRequest.HttpServerRequest, route)',
        },
      ],
      // The admitting function is not the handler of the middleware's security scheme.
      [
        {
          file: runtime,
          from: '    return {\n      apiKey: (httpEffect',
          to: '    return {\n      bearer: (httpEffect',
        },
      ],
      // A second Layer implements the authentication middleware without admitting.
      [
        {
          file: runtime,
          from: '          SymmyIngressAuthenticationLive,\n',
          to: '          SymmyIngressAuthenticationLive,\n          Layer.succeed(SymmyAuthentication, { apiKey: (httpEffect) => httpEffect }),\n',
        },
      ],
      // The admitting Layer is provided to the payment handlers instead of the Symmy handlers.
      [
        { file: runtime, from: '          SymmyIngressAuthenticationLive,\n', to: '' },
        {
          file: runtime,
          from: '          paymentGatewayRelayLive,\n',
          to: '          paymentGatewayRelayLive,\n          SymmyIngressAuthenticationLive,\n',
        },
      ],
      // The authentication middleware is declared on another group.
      [
        unmountedAuthentication,
        {
          file: shellApi,
          from: '.add(PaymentNotificationsGroup.middleware(PaymentNotificationBoundary))',
          to: '.add(PaymentNotificationsGroup.middleware(SymmyAuthentication).middleware(PaymentNotificationBoundary))',
        },
      ],
      // A handler of another group admits through SymmyIngress.
      [
        unmountedAuthentication,
        {
          file: nodePath.join(root, paymentTransportEntry),
          from: "import { ShellAuthenticationApi } from '../../shared/api.ts';\n",
          to: "import { ShellAuthenticationApi } from '../../shared/api.ts';\nimport { SymmyIngress } from '../symmy/transport.ts';\n",
        },
        {
          file: nodePath.join(root, paymentTransportEntry),
          from: '  const relayService = yield* PaymentGatewayRelay;\n',
          to: '  const symmyIngress = yield* SymmyIngress;\n  yield* symmyIngress.admit(apiKey.value, yield* HttpServerRequest.HttpServerRequest, notification.routeKey);\n  const relayService = yield* PaymentGatewayRelay;\n',
        },
      ],
      // A Symmy handler admits after the request is decoded instead of the middleware.
      [
        unmountedAuthentication,
        {
          file: transport,
          from: '    const ingress = yield* SymmyIngress;\n',
          to: "    const ingress = yield* SymmyIngress;\n    yield* ingress.admit(Redacted.value(credential), yield* HttpServerRequest.HttpServerRequest, 'job');\n",
        },
      ],
      // A Symmy handler imports a route-scope database function directly.
      [
        {
          file: transport,
          from: "import { SymmyAdmittedCaller } from './admitted-caller.ts';\n",
          to: "import { SymmyAdmittedCaller } from './admitted-caller.ts';\nimport { requireSymmyRouteWorkload } from '../auth/gateway-symmy-route-scope.ts';\n",
        },
        {
          file: transport,
          from: ".handle('job', ({ params }) => handlePoll({ id: params.id, route: 'job' }))",
          to: ".handle('job', ({ params }) => requireSymmyRouteWorkload(params.id, 'job'))",
        },
      ],
      // The security handler calls a route-scope database function outside the admission.
      [
        {
          file: runtime,
          from: '        httpEffect.pipe(\n          Effect.provideServiceEffect(SymmyAdmittedCaller',
          to: '        httpEffect.pipe(\n          Effect.tap(() => requireSymmyRouteWorkload(credential, endpoint.identifier)),\n          Effect.provideServiceEffect(SymmyAdmittedCaller',
        },
      ],
    ];
    for (const mutation of symmyMutations) {
      const mutated = new Map(sources);
      for (const change of mutation) {
        const original = mutated.get(change.file) ?? '';
        expect(original).toContain(change.from);
        mutated.set(change.file, original.replace(change.from, change.to));
      }
      const proved = provedShellGatewayDatabaseSources(mutated, root, purePath, exports);
      expect(proved.size).toBe(6);
      expect(proved.has(nodePath.join(root, 'apps/shell-super-app/api/auth/gateway-symmy-route-scope.ts'))).toBe(false);
    }
    const paymentRouteScope = nodePath.join(root, 'apps/shell-super-app/api/auth/gateway-payment-route-scope.ts');
    const paymentMutations = [
      {
        file: nodePath.join(root, nativeRuntimeEntry),
        from: '      return {\n        authorize:',
        to: '      if (false) return {\n        authorize:',
      },
      {
        file: nodePath.join(root, nativeRuntimeEntry),
        from: '    paymentGatewayHandlersLive.pipe(',
        to: '    unregisteredHandlers.pipe(',
      },
      {
        file: nodePath.join(root, paymentTransportEntry),
        from: 'Context.Service<',
        to: 'forgedContext.Service<',
      },
      {
        all: true,
        file: nodePath.join(root, paymentTransportEntry),
        from: '.authorize({',
        to: '.foreignAuthorize({',
      },
      {
        file: nodePath.join(root, nativeRuntimeEntry),
        from: 'const paymentGatewayRelayLive = Layer.effect(\n    PaymentGatewayRelay,',
        to: 'const paymentGatewayRelayLive = Layer.effect(\n    foreignService,',
      },
    ];
    for (const mutation of paymentMutations) {
      const original = sources.get(mutation.file) ?? '';
      expect(original).toContain(mutation.from);
      const replaced =
        mutation.all === true
          ? original.replaceAll(mutation.from, mutation.to)
          : original.replace(mutation.from, mutation.to);
      const proved = provedShellGatewayDatabaseSources(
        new Map([...sources, [mutation.file, replaced]]),
        root,
        purePath,
        exports,
      );
      expect(proved.size).toBe(6);
      expect(proved.has(paymentRouteScope)).toBe(false);
    }
  }).pipe(Effect.provide(Path.layer)),
);
