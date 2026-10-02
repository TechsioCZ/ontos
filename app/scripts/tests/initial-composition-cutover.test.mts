import { createHash } from 'node:crypto';
import nodePath from 'node:path';

import { NodeServices } from '@effect/platform-node';
import { ConfigProvider, Effect, FileSystem, Layer, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { expect, it } from 'effect-rstest';
import { HttpClient, HttpClientResponse } from 'effect/unstable/http';

import {
  InitialCompositionCutoverReceiptSchema,
  InitialCompositionExecutionInventorySchema,
  quiesceInitialCompositionCutover,
  validateConfiguredInitialCompositionInventory,
  validateInitialCompositionExecutionInventory,
  verifyInitialCompositionCutover,
} from '../initial-composition-cutover.mts';
import { InitialCutoverProviderError } from '../initial-composition-cutover-provider.mts';
import { ZeropsPublicApiLive } from '../zerops-public-api.mts';

const ACCOUNT_ID = 'a'.repeat(32);
const SOURCE_URL = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/storage/kv/namespaces/${'c'.repeat(32)}/values/active`;
const SHELL_APPLICATION_ID = 'shell-super-app';
const COMMERCE_APPLICATION_ID = 'commerce-customer-context';
const PROVIDER_CREDENTIAL = 'test-provider-credential';
const NODE_RUNTIME_KIND = 'node-runtime';
const NODE_SERVICE_BASE = 'alpine/nodejs@24';
const NODE_SERVICE_METADATA = { base: NODE_SERVICE_BASE, isSystem: false };
const APPLICATION_IDS = [SHELL_APPLICATION_ID, COMMERCE_APPLICATION_ID];
const inventory = () => ({
  applicationIds: APPLICATION_IDS,
  cloudflare: {
    accountId: ACCOUNT_ID,
    workers: [{ appId: COMMERCE_APPLICATION_ID, name: 'cccccccccccccccccccccc-worker', roles: ['worker'] }],
  },
  environment: 'stage',
  schemaVersion: '2',
  sourceRevision: 'b'.repeat(40),
  zerops: [
    {
      appId: SHELL_APPLICATION_ID,
      kind: NODE_RUNTIME_KIND,
      roles: ['ingress', 'producer', 'matcher'],
      serviceId: 'ssssssssssssssssssssss',
    },
    {
      appId: COMMERCE_APPLICATION_ID,
      kind: NODE_RUNTIME_KIND,
      roles: ['hosted_job'],
      serviceId: 'cccccccccccccccccccccc',
    },
  ],
});

const provider = (
  initiallyAbsent = true,
  refuseDelete = false,
  serviceMetadata: { readonly base?: string; readonly isSystem?: boolean } = NODE_SERVICE_METADATA,
  workerInitiallyAbsent = initiallyAbsent,
) => {
  const requests: string[] = [];
  let nodeAbsent = initiallyAbsent;
  let workerDeleted = workerInitiallyAbsent;
  const client = HttpClient.make((request, url) => {
    requests.push(`${request.method} ${url.pathname}`);
    const response = (() => {
      if (url.hostname === 'api.cloudflare.com') {
        if (request.method === 'DELETE') {
          workerDeleted = true;
          return Response.json({ errors: [], success: true });
        }
        return workerDeleted
          ? Response.json({ errors: [{ code: 10_007 }], success: false }, { status: 404 })
          : new Response('old executable');
      }
      if (request.method === 'DELETE') {
        if (refuseDelete) {
          return Response.json({ private: PROVIDER_CREDENTIAL }, { status: 403 });
        }
        nodeAbsent = true;
        return Response.json({ id: 'delete-process', status: 'PENDING' });
      }
      if (url.pathname.includes('/process/')) {
        return Response.json({ id: 'delete-process', status: 'FINISHED' });
      }
      return nodeAbsent
        ? Response.json({ error: { code: 'serviceStackNotFound' } }, { status: 400 })
        : Response.json({ ...serviceMetadata, name: 'old-service', status: 'ACTIVE', subdomainAccess: false });
    })();
    return Effect.succeed(HttpClientResponse.fromWeb(request, response));
  });
  const http = Layer.succeed(HttpClient.HttpClient, client);
  return {
    layer: Layer.mergeAll(
      http,
      ZeropsPublicApiLive.pipe(Layer.provide(http)),
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          CLOUDFLARE_API_TOKEN: PROVIDER_CREDENTIAL,
          ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL: SOURCE_URL,
          ZEROPS_TOKEN: PROVIDER_CREDENTIAL,
        }),
      ),
    ),
    requests,
    restart: () => {
      nodeAbsent = false;
    },
  };
};

const files = Effect.gen(function* ownedTopologyFixture() {
  const filesystem = yield* FileSystem.FileSystem;
  const directory = yield* filesystem.makeTempDirectoryScoped({
    directory: nodePath.resolve(import.meta.dirname, '..', '..', 'topology'),
    prefix: 'initial-cutover-test-',
  });
  const input = {
    environment: 'stage',
    inventoryFile: nodePath.join(directory, 'inventory.json'),
    receiptFile: nodePath.join(directory, 'receipt.json'),
  };
  const raw = `${JSON.stringify(inventory(), null, 2)}\n`;
  yield* filesystem.writeFileString(input.inventoryFile, raw);
  return { filesystem, input, raw };
});

const receiptCodec = Schema.fromJsonString(InitialCompositionCutoverReceiptSchema);

it.effect('rejects malformed native service identities before provider operations', () =>
  Effect.gen(function* rejectsAmbiguousServicePaths() {
    const fixture = yield* files;
    const native = provider();
    yield* fixture.filesystem.writeFileString(
      fixture.input.inventoryFile,
      JSON.stringify({
        ...inventory(),
        zerops: [
          {
            appId: SHELL_APPLICATION_ID,
            kind: NODE_RUNTIME_KIND,
            roles: ['ingress', 'producer', 'matcher'],
            serviceId: '../other-service',
          },
          ...inventory().zerops.slice(1),
        ],
      }),
    );
    const error = yield* quiesceInitialCompositionCutover(fixture.input).pipe(
      Effect.provide(native.layer),
      Effect.flip,
    );
    expect(Schema.is(InitialCutoverProviderError)(error)).toBe(true);
    expect(native.requests).toEqual([]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('requires exact declared application coverage including Shell and the hosted commerce jobs', () =>
  Effect.gen(function* validatesCompleteExecutionInventory() {
    const complete = yield* Schema.decodeUnknownEffect(InitialCompositionExecutionInventorySchema)(inventory());
    expect(yield* validateInitialCompositionExecutionInventory(complete)).toEqual(complete);
    const invalidInventories = [
      { ...inventory(), applicationIds: [] },
      { ...inventory(), applicationIds: [...APPLICATION_IDS, SHELL_APPLICATION_ID] },
      { ...inventory(), applicationIds: [COMMERCE_APPLICATION_ID] },
      { ...inventory(), applicationIds: [SHELL_APPLICATION_ID] },
      { ...inventory(), applicationIds: [...APPLICATION_IDS, 'uncovered-app'] },
      {
        ...inventory(),
        zerops: [
          ...inventory().zerops,
          {
            appId: 'undeclared-app',
            kind: NODE_RUNTIME_KIND,
            roles: ['producer'],
            serviceId: 'eeeeeeeeeeeeeeeeeeeeee',
          },
        ],
      },
    ];
    for (const value of invalidInventories) {
      const decoded = yield* Schema.decodeUnknownEffect(InitialCompositionExecutionInventorySchema)(value);
      const error = yield* validateInitialCompositionExecutionInventory(decoded).pipe(Effect.flip);
      expect(Schema.is(InitialCutoverProviderError)(error)).toBe(true);
    }
  }),
);

it.effect('rejects missing execution roles, misplaced hosted jobs, and ambiguous provider identities', () =>
  Effect.gen(function* rejectsIncompleteExecutionRoles() {
    const invalidInventories = [
      { ...inventory(), cloudflare: { accountId: ACCOUNT_ID, workers: [] } },
      {
        ...inventory(),
        zerops: [
          {
            appId: SHELL_APPLICATION_ID,
            kind: NODE_RUNTIME_KIND,
            roles: ['ingress', 'producer', 'matcher', 'hosted_job'],
            serviceId: 'ssssssssssssssssssssss',
          },
          {
            appId: COMMERCE_APPLICATION_ID,
            kind: NODE_RUNTIME_KIND,
            roles: ['producer'],
            serviceId: 'cccccccccccccccccccccc',
          },
        ],
      },
      {
        ...inventory(),
        zerops: [
          ...inventory().zerops,
          { appId: SHELL_APPLICATION_ID, kind: NODE_RUNTIME_KIND, roles: [], serviceId: 'rrrrrrrrrrrrrrrrrrrrrr' },
        ],
      },
      {
        ...inventory(),
        zerops: [
          ...inventory().zerops,
          {
            appId: SHELL_APPLICATION_ID,
            kind: NODE_RUNTIME_KIND,
            roles: ['producer', 'producer'],
            serviceId: 'dddddddddddddddddddddd',
          },
        ],
      },
      {
        ...inventory(),
        zerops: [
          ...inventory().zerops,
          {
            appId: SHELL_APPLICATION_ID,
            kind: NODE_RUNTIME_KIND,
            roles: ['producer'],
            serviceId: 'ssssssssssssssssssssss',
          },
        ],
      },
      {
        ...inventory(),
        cloudflare: {
          accountId: ACCOUNT_ID,
          workers: [...inventory().cloudflare.workers, ...inventory().cloudflare.workers],
        },
      },
    ];
    for (const value of invalidInventories) {
      const decoded = yield* Schema.decodeUnknownEffect(InitialCompositionExecutionInventorySchema)(value);
      expect(
        Schema.is(InitialCutoverProviderError)(
          yield* validateInitialCompositionExecutionInventory(decoded).pipe(Effect.flip),
        ),
      ).toBe(true);
    }
  }),
);

it.effect('writes a receipt binding the exact reviewed bytes only after deleting and rechecking providers', () =>
  Effect.gen(function* provesQuiescenceBeforeReceipt() {
    const { filesystem, input, raw } = yield* files;
    const native = provider(false);
    yield* quiesceInitialCompositionCutover(input).pipe(Effect.provide(native.layer));
    const receipt = yield* Schema.decodeEffect(receiptCodec)(yield* filesystem.readFileString(input.receiptFile));
    expect(receipt.inventorySha256).toBe(createHash('sha256').update(raw).digest('hex'));
    expect(receipt.environment).toBe('stage');
    expect(native.requests).toContain('DELETE /api/rest/public/service-stack/ssssssssssssssssssssss');
    expect(native.requests).toContain(
      `DELETE /client/v4/accounts/${ACCOUNT_ID}/workers/scripts/cccccccccccccccccccccc-worker`,
    );
    yield* verifyInitialCompositionCutover(input).pipe(Effect.provide(native.layer));
    expect(
      native.requests.filter((request) => request === 'GET /api/rest/public/service-stack/ssssssssssssssssssssss'),
    ).toHaveLength(3);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect('does not write a receipt when native retirement fails', () =>
  Effect.gen(function* doesNotAttestFailedDeletes() {
    const { filesystem, input } = yield* files;
    const native = provider(false, true);
    const error = yield* quiesceInitialCompositionCutover(input).pipe(Effect.provide(native.layer), Effect.flip);
    expect(Schema.is(InitialCutoverProviderError)(error)).toBe(true);
    expect(JSON.stringify(error)).not.toContain(PROVIDER_CREDENTIAL);
    expect(yield* filesystem.exists(input.receiptFile)).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect('refuses database, storage, system, and unclassified services before deletion or receipt creation', () =>
  Effect.gen(function* protectsPersistentAndUnidentifiedServices() {
    const metadata = [
      { base: 'alpine/postgresql@16', isSystem: false },
      { base: 'alpine/object-storage@1', isSystem: false },
      { base: NODE_SERVICE_BASE, isSystem: true },
      { base: NODE_SERVICE_BASE },
      {},
    ];
    for (const identity of metadata) {
      const { filesystem, input } = yield* files;
      const native = provider(false, false, identity, true);
      const error = yield* quiesceInitialCompositionCutover(input).pipe(Effect.provide(native.layer), Effect.flip);
      expect(Schema.is(InitialCutoverProviderError)(error)).toBe(true);
      expect(native.requests.some((request) => request.startsWith('DELETE '))).toBe(false);
      expect(yield* filesystem.exists(input.receiptFile)).toBe(false);
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect('rejects changed raw inventory bytes before rechecking providers', () =>
  Effect.gen(function* preservesRawInventoryBinding() {
    const { filesystem, input, raw } = yield* files;
    const native = provider();
    yield* quiesceInitialCompositionCutover(input).pipe(Effect.provide(native.layer));
    const requestsBeforeVerification = native.requests.length;
    yield* filesystem.writeFileString(input.inventoryFile, `${raw}\n`);
    const error = yield* verifyInitialCompositionCutover(input).pipe(Effect.provide(native.layer), Effect.flip);
    expect(Schema.is(InitialCutoverProviderError)(error)).toBe(true);
    expect(native.requests).toHaveLength(requestsBeforeVerification);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect('rejects missing receipts, future timestamps, and receipts from another environment', () =>
  Effect.gen(function* rejectsInvalidQuiescenceReceipts() {
    yield* TestClock.setTime(0);
    const { filesystem, input } = yield* files;
    const native = provider();
    expect(
      Schema.is(InitialCutoverProviderError)(
        yield* verifyInitialCompositionCutover(input).pipe(Effect.provide(native.layer), Effect.flip),
      ),
    ).toBe(true);
    expect(native.requests).toEqual([]);
    yield* quiesceInitialCompositionCutover(input).pipe(Effect.provide(native.layer));
    const original = yield* filesystem.readFileString(input.receiptFile);
    const receiptFields = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)))(
      original,
    );
    for (const receipt of [
      { ...receiptFields, verifiedAt: '1970-01-01T00:00:00.001Z' },
      { ...receiptFields, environment: 'production' },
      { ...receiptFields, unexpected: 'unreviewed' },
    ]) {
      const before = native.requests.length;
      yield* filesystem.writeFileString(input.receiptFile, JSON.stringify(receipt));
      expect(
        Schema.is(InitialCutoverProviderError)(
          yield* verifyInitialCompositionCutover(input).pipe(Effect.provide(native.layer), Effect.flip),
        ),
      ).toBe(true);
      expect(native.requests).toHaveLength(before);
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect('binds Cloudflare absence checks to the protected publication account', () =>
  Effect.gen(function* rejectsWrongProviderAccount() {
    const complete = yield* Schema.decodeUnknownEffect(InitialCompositionExecutionInventorySchema)(inventory());
    yield* validateConfiguredInitialCompositionInventory(complete).pipe(
      Effect.provide(
        ConfigProvider.layer(ConfigProvider.fromUnknown({ ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL: SOURCE_URL })),
      ),
    );
    for (const sourceUrl of [
      SOURCE_URL.replace(ACCOUNT_ID, 'd'.repeat(32)),
      SOURCE_URL.replace('api.cloudflare.com', 'untrusted.example'),
    ]) {
      const error = yield* validateConfiguredInitialCompositionInventory(complete).pipe(
        Effect.provide(
          ConfigProvider.layer(ConfigProvider.fromUnknown({ ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL: sourceUrl })),
        ),
        Effect.flip,
      );
      expect(Schema.is(InitialCutoverProviderError)(error)).toBe(true);
    }
  }),
);

it.effect('rechecks old executables and rejects a restart even with a valid receipt', () =>
  Effect.gen(function* doesNotTrustHistoricalProviderObservation() {
    const { input } = yield* files;
    const native = provider();
    yield* quiesceInitialCompositionCutover(input).pipe(Effect.provide(native.layer));
    native.restart();
    const before = native.requests.length;
    const error = yield* verifyInitialCompositionCutover(input).pipe(Effect.provide(native.layer), Effect.flip);
    expect(Schema.is(InitialCutoverProviderError)(error)).toBe(true);
    expect(native.requests.length).toBeGreaterThan(before);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect('rejects another environment and non-topology inventory paths before provider operations', () =>
  Effect.gen(function* rejectsForeignInventorySources() {
    const { filesystem, input } = yield* files;
    const native = provider();
    for (const rejected of [
      { ...input, environment: 'production' },
      { ...input, inventoryFile: nodePath.resolve(import.meta.dirname, 'outside-topology.json') },
      { ...input, inventoryFile: nodePath.join(nodePath.dirname(input.inventoryFile), '.env-inventory.json') },
    ]) {
      const error = yield* quiesceInitialCompositionCutover(rejected).pipe(Effect.provide(native.layer), Effect.flip);
      expect(Schema.is(InitialCutoverProviderError)(error)).toBe(true);
      expect(yield* filesystem.exists(input.receiptFile)).toBe(false);
    }
    expect(native.requests).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
