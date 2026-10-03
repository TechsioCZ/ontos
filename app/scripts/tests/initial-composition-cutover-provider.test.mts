import { createHash } from 'node:crypto';

import { ConfigProvider, Effect, Fiber, Layer, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { expect, it } from 'effect-rstest';
import { HttpClient, HttpClientResponse } from 'effect/unstable/http';

import {
  InitialCutoverProviderError,
  quiesceInitialCutoverProviderInventory,
  verifyInitialCutoverProviderInventory,
} from '../initial-composition-cutover-provider.mts';
import { ONTOS_APPLICATION_COMPOSITION_MAX_BYTES } from '../../packages/core-runtime/src/modules/application-composition-limits.ts';

import { ZeropsPublicApiLive } from '../zerops-public-api.mts';

const accountId = 'a'.repeat(32);
const namespaceId = 'c'.repeat(32);
const obsoletePointer = '\uFEFFobsolete pointer bytes\n';
const compositionPointer = { namespaceId, sha256: createHash('sha256').update(obsoletePointer).digest('hex') };
const namespacePath = `/client/v4/accounts/${accountId}/storage/kv/namespaces/${namespaceId}`;
const pointerPath = `${namespacePath}/values/active`;
const nativeNamespace = () => Response.json({ errors: [], result: { id: namespaceId }, success: true });
const legacyServiceId = 'legacy-node';
const deletionProcessId = 'delete-process';
const deletionProcessPath = `/api/rest/public/process/${deletionProcessId}`;
const cloudflareToken = 'secret-cloudflare-token';
const cloudflarePath = `/client/v4/accounts/${accountId}/workers/scripts/legacy-worker`;
const zeropsPath = '/api/rest/public/service-stack/legacy-node';
const inventory = {
  cloudflare: { accountId, compositionPointer, workerNames: ['legacy-worker'] },
  zeropsServiceIds: [legacyServiceId],
};
const absentWorker = () => Response.json({ errors: [{ code: 10_007 }], success: false }, { status: 404 });
const absentService = () => Response.json({ error: { code: 'serviceStackNotFound' } }, { status: 400 });
const service = (status: string) =>
  Response.json({ base: 'alpine/nodejs@24', isSystem: false, name: legacyServiceId, status, subdomainAccess: false });

const provider = (
  answer: (method: string, url: URL) => Effect.Effect<Response>,
  pointerAnswer: (method: string, url: URL) => Effect.Effect<Response> = (_method, url) =>
    Effect.succeed(url.pathname === namespacePath ? nativeNamespace() : new Response(null, { status: 404 })),
) => {
  const requests: string[] = [];
  const client = HttpClient.make((request, url) => {
    requests.push(`${request.method} ${url.origin}${url.pathname}`);
    const response = url.pathname.startsWith(namespacePath)
      ? pointerAnswer(request.method, url)
      : answer(request.method, url);
    return response.pipe(Effect.map((value) => HttpClientResponse.fromWeb(request, value)));
  });
  const http = Layer.succeed(HttpClient.HttpClient, client);
  return {
    layer: Layer.mergeAll(
      http,
      ZeropsPublicApiLive.pipe(Layer.provide(http)),
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          CLOUDFLARE_API_TOKEN: cloudflareToken,
          ZEROPS_TOKEN: 'secret-zerops-token',
        }),
      ),
    ),
    requests,
  };
};

it.effect('accepts only provider-confirmed absence of the exact retired inventory', () =>
  Effect.gen(function* verifiesExplicitInventory() {
    const native = provider((_method, url) =>
      Effect.succeed(url.pathname === zeropsPath ? absentService() : absentWorker()),
    );
    yield* verifyInitialCutoverProviderInventory(inventory).pipe(Effect.provide(native.layer));
    expect(native.requests).toHaveLength(4);
    expect(native.requests).toEqual(
      expect.arrayContaining([
        `GET https://api.app-prg1.zerops.io${zeropsPath}`,
        `GET https://api.cloudflare.com${cloudflarePath}`,
      ]),
    );
  }),
);

it.effect('rejects active, transitional, and unknown Zerops states without carrying provider payloads', () =>
  Effect.gen(function* rejectsRunningServices() {
    for (const status of ['ACTIVE', 'STOPPED', 'DELETED', 'STOPPING', 'STARTING', cloudflareToken]) {
      const native = provider((_method, url) =>
        Effect.succeed(url.pathname === zeropsPath ? service(status) : absentWorker()),
      );
      const error = yield* verifyInitialCutoverProviderInventory(inventory).pipe(
        Effect.provide(native.layer),
        Effect.flip,
      );
      expect(Schema.is(InitialCutoverProviderError)(error)).toBe(true);
      expect(error.provider).toBe('zerops');
      expect(JSON.stringify(error)).not.toContain('secret-');
    }
  }),
);

it.effect('rejects existing scripts, redirects, forbidden reads, generic/mixed absence, and malformed envelopes', () =>
  Effect.gen(function* rejectsUnprovedWorkerAbsence() {
    const answers = [
      () => new Response('private executable bytes', { status: 200 }),
      () => new Response(null, { headers: { location: 'https://attacker.example/' }, status: 302 }),
      () => Response.json({ errors: [{ code: 10_007 }], success: false }, { status: 403 }),
      () => Response.json({ errors: [], success: false }, { status: 404 }),
      () => Response.json({ errors: [{ code: 10_007 }, { code: 10_000 }], success: false }, { status: 404 }),
      () => Response.json({ errors: [{ code: 10_007 }], success: true }, { status: 404 }),
      () => new Response(cloudflareToken, { status: 404 }),
      () => new Response('x'.repeat(65_537), { status: 404 }),
    ];
    for (const answer of answers) {
      const native = provider((_method, url) =>
        Effect.succeed(url.pathname === zeropsPath ? absentService() : answer()),
      );
      const error = yield* verifyInitialCutoverProviderInventory(inventory).pipe(
        Effect.provide(native.layer),
        Effect.flip,
      );
      expect(Schema.is(InitialCutoverProviderError)(error)).toBe(true);
      expect(error.provider).toBe('cloudflare');
      expect(JSON.stringify(error)).not.toContain('secret-');
      expect(native.requests.every((request) => !request.includes('attacker'))).toBe(true);
    }
  }),
);

it.effect('permanently retires the explicit inventory, then independently rechecks both providers', () =>
  Effect.gen(function* quiescesAndRechecks() {
    let nodeDeleted = false;
    let workerDeleted = false;
    const native = provider((method, url) => {
      if (url.pathname === zeropsPath && method === 'DELETE') {
        nodeDeleted = true;
        return Effect.succeed(Response.json({ id: deletionProcessId, status: 'PENDING' }));
      }
      if (url.pathname === deletionProcessPath) {
        return Effect.succeed(Response.json({ id: deletionProcessId, status: 'FINISHED' }));
      }
      if (url.pathname === zeropsPath) {
        return Effect.succeed(nodeDeleted ? absentService() : service('ACTIVE'));
      }
      if (method === 'DELETE') {
        workerDeleted = true;
        return Effect.succeed(Response.json({ errors: [], success: true }));
      }
      return Effect.succeed(workerDeleted ? absentWorker() : new Response('script'));
    });
    yield* quiesceInitialCutoverProviderInventory(inventory).pipe(Effect.provide(native.layer));
    expect(native.requests.filter((request) => request.endsWith(zeropsPath) && request.startsWith('GET'))).toHaveLength(
      2,
    );
    expect(
      native.requests.filter((request) => request.endsWith(cloudflarePath) && request.startsWith('GET')),
    ).toHaveLength(2);
    expect(native.requests).toContain(`DELETE https://api.app-prg1.zerops.io${zeropsPath}`);
    expect(native.requests).toContain(`DELETE https://api.cloudflare.com${cloudflarePath}`);
  }),
);

it.effect('does not mistake a successful delete response for verified absence or drop mutated caller targets', () =>
  Effect.gen(function* rechecksTheOriginalTargets() {
    const mutable = {
      cloudflare: { accountId, compositionPointer, workerNames: ['legacy-worker'] },
      zeropsServiceIds: [],
    };
    const native = provider((method) => {
      if (method === 'DELETE') {
        mutable.cloudflare.workerNames.length = 0;
        return Effect.succeed(Response.json({ errors: [], success: true }));
      }
      return Effect.succeed(new Response('still deployed'));
    });
    const error = yield* quiesceInitialCutoverProviderInventory(mutable).pipe(
      Effect.provide(native.layer),
      Effect.flip,
    );
    expect(error.provider).toBe('cloudflare');
    expect(native.requests).toHaveLength(3);
  }),
);

it.effect('bounds provider reads and stalled response decoding to ten seconds', () =>
  Effect.gen(function* timesOutStalledRead() {
    for (const answer of [Effect.never, Effect.sync(() => new Response(new ReadableStream(), { status: 404 }))]) {
      const native = provider((_method, url) =>
        url.pathname === zeropsPath ? Effect.succeed(absentService()) : answer,
      );
      const fiber = yield* verifyInitialCutoverProviderInventory(inventory).pipe(
        Effect.provide(native.layer),
        Effect.flip,
        Effect.forkChild,
      );
      yield* TestClock.adjust('10 seconds');
      const error = yield* Fiber.join(fiber);
      expect(error.reason).toBe('provider operation timed out');
    }
  }),
);

it.effect('shares one concurrency limit across both providers', () =>
  Effect.gen(function* boundsAllProviderRequests() {
    let active = 0;
    let maximum = 0;
    const native = provider((_method, url) =>
      Effect.gen(function* overlapProviderReads() {
        active += 1;
        maximum = Math.max(maximum, active);
        yield* Effect.yieldNow;
        active -= 1;
        return url.hostname === 'api.cloudflare.com' ? absentWorker() : absentService();
      }),
    );
    yield* verifyInitialCutoverProviderInventory({
      cloudflare: {
        accountId,
        compositionPointer,
        workerNames: Array.from({ length: 6 }, (_, index) => `worker-${String(index)}`),
      },
      zeropsServiceIds: Array.from({ length: 6 }, (_, index) => `node-${String(index)}`),
    }).pipe(Effect.provide(native.layer));
    expect(native.requests).toHaveLength(14);
    expect(maximum).toBeGreaterThan(1);
    expect(maximum).toBeLessThanOrEqual(4);
  }),
);

it.effect('keeps traversal identifiers in one encoded service path segment and rejects standalone dots', () =>
  Effect.gen(function* confinesServiceIdentityPaths() {
    const serviceId = '../project/target?secret=value#fragment';
    const encodedId = encodeURIComponent(serviceId);
    const exactPath = `/api/rest/public/service-stack/${encodedId}`;
    let nodeDeleted = false;
    const native = provider((method, url) => {
      expect(url.search).toBe('');
      expect(url.hash).toBe('');
      if (url.pathname === exactPath && method === 'DELETE') {
        nodeDeleted = true;
        return Effect.succeed(Response.json({ id: deletionProcessId, status: 'PENDING' }));
      }
      if (url.pathname === deletionProcessPath) {
        return Effect.succeed(Response.json({ id: deletionProcessId, status: 'FINISHED' }));
      }
      expect(url.pathname).toBe(exactPath);
      return Effect.succeed(nodeDeleted ? absentService() : service('ACTIVE'));
    });
    yield* quiesceInitialCutoverProviderInventory({
      cloudflare: { accountId, compositionPointer, workerNames: [] },
      zeropsServiceIds: [serviceId],
    }).pipe(Effect.provide(native.layer));
    expect(native.requests).toEqual([
      `GET https://api.app-prg1.zerops.io${exactPath}`,
      `DELETE https://api.app-prg1.zerops.io${exactPath}`,
      'GET https://api.app-prg1.zerops.io/api/rest/public/process/delete-process',
      `GET https://api.app-prg1.zerops.io${exactPath}`,
      `GET https://api.cloudflare.com${namespacePath}`,
      `GET https://api.cloudflare.com${pointerPath}`,
      `GET https://api.cloudflare.com${namespacePath}`,
      `GET https://api.cloudflare.com${pointerPath}`,
    ]);
    for (const dot of ['.', '..']) {
      const forbidden = provider(() => Effect.succeed(absentService()));
      const input = { cloudflare: { accountId, compositionPointer, workerNames: [] }, zeropsServiceIds: [dot] };
      yield* verifyInitialCutoverProviderInventory(input).pipe(Effect.provide(forbidden.layer), Effect.flip);
      yield* quiesceInitialCutoverProviderInventory(input).pipe(Effect.provide(forbidden.layer), Effect.flip);
      expect(forbidden.requests).toHaveLength(0);
    }
  }),
);

it.effect('rejects database, storage, system, missing, and unknown service identities before deletion', () =>
  Effect.gen(function* excludesNonRuntimeRetirement() {
    const metadata = [
      { base: 'postgresql@16', isSystem: false },
      { base: 'object-storage@1', isSystem: false },
      { base: 'local-storage@1', isSystem: false },
      { base: 'unknown@1', isSystem: false },
      { base: 'nodejs@24', isSystem: true },
      { isSystem: false },
      { base: 'nodejs@24' },
    ];
    for (const identity of metadata) {
      const native = provider(() =>
        Effect.succeed(
          Response.json({ ...identity, name: legacyServiceId, status: 'STOPPED', subdomainAccess: false }),
        ),
      );
      const error = yield* quiesceInitialCutoverProviderInventory({
        cloudflare: { accountId, compositionPointer, workerNames: [] },
        zeropsServiceIds: [legacyServiceId],
      }).pipe(Effect.provide(native.layer), Effect.flip);
      expect(Schema.is(InitialCutoverProviderError)(error)).toBe(true);
      expect(native.requests).toEqual([`GET https://api.app-prg1.zerops.io${zeropsPath}`]);
    }
  }),
);

it.effect('rejects a finished native deletion process while the old service remains present', () =>
  Effect.gen(function* requiresIndependentNativeAbsence() {
    const native = provider((method, url) => {
      if (method === 'DELETE' || url.pathname === deletionProcessPath) {
        return Effect.succeed(Response.json({ id: deletionProcessId, status: 'FINISHED' }));
      }
      return Effect.succeed(service('STOPPED'));
    });
    const error = yield* quiesceInitialCutoverProviderInventory({
      cloudflare: { accountId, compositionPointer, workerNames: [] },
      zeropsServiceIds: [legacyServiceId],
    }).pipe(Effect.provide(native.layer), Effect.flip);
    expect(error.provider).toBe('zerops');
    expect(native.requests).toHaveLength(4);
  }),
);

it.effect('bounds an unfinished native deletion process without claiming retirement', () =>
  Effect.gen(function* boundsNativeRetirementProcess() {
    const native = provider((method, url) =>
      Effect.succeed(
        method === 'GET' && url.pathname === zeropsPath
          ? service('ACTIVE')
          : Response.json({ id: deletionProcessId, status: 'PENDING' }),
      ),
    );
    const fiber = yield* quiesceInitialCutoverProviderInventory({
      cloudflare: { accountId, compositionPointer, workerNames: [] },
      zeropsServiceIds: [legacyServiceId],
    }).pipe(Effect.provide(native.layer), Effect.flip, Effect.forkChild);
    yield* TestClock.adjust('15 minutes');
    const error = yield* Fiber.join(fiber);
    expect(Schema.is(InitialCutoverProviderError)(error)).toBe(true);
    expect(error.provider).toBe('zerops');
    expect(
      native.requests.filter((request) => request === `GET https://api.app-prg1.zerops.io${zeropsPath}`),
    ).toHaveLength(1);
  }),
);

it.effect(
  'retires only the reviewed raw pointer after all executable absence checks and independently verifies deletion',
  () =>
    Effect.gen(function* retiresReviewedPointerAfterExecutables() {
      let pointerPresent = true;
      const native = provider(
        (_method, url) => Effect.succeed(url.pathname === zeropsPath ? absentService() : absentWorker()),
        (method, url) => {
          if (url.pathname === namespacePath) {
            return Effect.succeed(nativeNamespace());
          }
          if (method === 'DELETE') {
            expect(native.requests).toContain(`GET https://api.app-prg1.zerops.io${zeropsPath}`);
            expect(native.requests).toContain(`GET https://api.cloudflare.com${cloudflarePath}`);
            pointerPresent = false;
            return Effect.succeed(Response.json({ errors: [], success: true }));
          }
          return Effect.succeed(pointerPresent ? new Response(obsoletePointer) : new Response(null, { status: 404 }));
        },
      );
      yield* quiesceInitialCutoverProviderInventory(inventory).pipe(Effect.provide(native.layer));
      const firstPointerRead = native.requests.indexOf(`GET https://api.cloudflare.com${namespacePath}`);
      expect(firstPointerRead).toBe(4);
      expect(native.requests.slice(firstPointerRead)).toEqual([
        `GET https://api.cloudflare.com${namespacePath}`,
        `GET https://api.cloudflare.com${pointerPath}`,
        `DELETE https://api.cloudflare.com${pointerPath}`,
        `GET https://api.cloudflare.com${namespacePath}`,
        `GET https://api.cloudflare.com${pointerPath}`,
      ]);
    }),
);

it.effect('rejects changed obsolete bytes and a replacement pointer before any key deletion', () =>
  Effect.gen(function* protectsUnreviewedPointerBytes() {
    for (const body of [
      obsoletePointer.slice(1),
      `${obsoletePointer}\n`,
      JSON.stringify({ composition: { schemaVersion: '2' } }),
    ]) {
      const native = provider(
        (_method, url) => Effect.succeed(url.pathname === zeropsPath ? absentService() : absentWorker()),
        (_method, url) => Effect.succeed(url.pathname === namespacePath ? nativeNamespace() : new Response(body)),
      );
      const error = yield* quiesceInitialCutoverProviderInventory(inventory).pipe(
        Effect.provide(native.layer),
        Effect.flip,
      );
      expect(Schema.is(InitialCutoverProviderError)(error)).toBe(true);
      expect(native.requests.filter((request) => request.startsWith('DELETE '))).toEqual([]);
    }
  }),
);

it.effect('requires authenticated exact namespace identity before trusting raw-value absence', () =>
  Effect.gen(function* rejectsUnprovedNamespace() {
    const answers = [
      () => new Response(null, { status: 404 }),
      () => new Response(null, { status: 403 }),
      () => new Response(null, { headers: { location: 'https://untrusted.example/' }, status: 302 }),
      () => Response.json({ errors: [], result: { id: 'd'.repeat(32) }, success: true }),
      () => Response.json({ errors: [], result: { id: namespaceId }, success: false }),
      () => Response.json({ errors: [{ code: 10_000 }], result: { id: namespaceId }, success: true }),
      () => Response.json({ errors: [], success: true }),
      () => new Response(cloudflareToken),
    ];
    for (const answer of answers) {
      const native = provider(
        (_method, url) => Effect.succeed(url.pathname === zeropsPath ? absentService() : absentWorker()),
        () => Effect.succeed(answer()),
      );
      const error = yield* quiesceInitialCutoverProviderInventory(inventory).pipe(
        Effect.provide(native.layer),
        Effect.flip,
      );
      expect(Schema.is(InitialCutoverProviderError)(error)).toBe(true);
      expect(JSON.stringify(error)).not.toContain(cloudflareToken);
      expect(native.requests.some((request) => request.endsWith(pointerPath))).toBe(false);
    }
  }),
);

it.effect('does not accept deletion acknowledgement without native pointer absence', () =>
  Effect.gen(function* rejectsFailedOrUnobservedPointerDeletion() {
    const answers = [
      () => new Response(null, { status: 403 }),
      () => new Response(null, { headers: { location: 'https://untrusted.example/' }, status: 302 }),
      () => Response.json({ errors: [], success: false }),
      () => Response.json({ errors: [{ code: 10_000 }], success: true }),
      () => new Response(cloudflareToken),
      () => Response.json({ errors: [], success: true }),
    ];
    for (const answer of answers) {
      const native = provider(
        (_method, url) => Effect.succeed(url.pathname === zeropsPath ? absentService() : absentWorker()),
        (method, url) => {
          if (url.pathname === namespacePath) {
            return Effect.succeed(nativeNamespace());
          }
          return Effect.succeed(method === 'DELETE' ? answer() : new Response(obsoletePointer));
        },
      );
      const error = yield* quiesceInitialCutoverProviderInventory(inventory).pipe(
        Effect.provide(native.layer),
        Effect.flip,
      );
      expect(Schema.is(InitialCutoverProviderError)(error)).toBe(true);
      expect(JSON.stringify(error)).not.toContain(cloudflareToken);
      expect(native.requests.filter((request) => request.startsWith('DELETE '))).toEqual([
        `DELETE https://api.cloudflare.com${pointerPath}`,
      ]);
    }
  }),
);

it.effect('does not delete an already absent pointer and rejects any pointer before first publication', () =>
  Effect.gen(function* requiresFreshPointerAbsence() {
    const absent = provider((_method, url) =>
      Effect.succeed(url.pathname === zeropsPath ? absentService() : absentWorker()),
    );
    yield* quiesceInitialCutoverProviderInventory(inventory).pipe(Effect.provide(absent.layer));
    expect(absent.requests.some((request) => request.startsWith('DELETE '))).toBe(false);
    for (const status of [200, 302, 401, 403, 500]) {
      const native = provider(
        (_method, url) => Effect.succeed(url.pathname === zeropsPath ? absentService() : absentWorker()),
        (_method, url) =>
          Effect.succeed(url.pathname === namespacePath ? nativeNamespace() : new Response(null, { status })),
      );
      const error = yield* verifyInitialCutoverProviderInventory(inventory).pipe(
        Effect.provide(native.layer),
        Effect.flip,
      );
      expect(Schema.is(InitialCutoverProviderError)(error)).toBe(true);
      expect(native.requests.some((request) => request.startsWith('DELETE '))).toBe(false);
    }
  }),
);

it.effect('bounds streamed raw pointer bytes before hashing even when the reviewed digest matches', () =>
  Effect.gen(function* limitsRawPointerBytesBeforeDelete() {
    const bytes = new Uint8Array(ONTOS_APPLICATION_COMPOSITION_MAX_BYTES + 1).fill(32);
    const input = {
      ...inventory,
      cloudflare: {
        ...inventory.cloudflare,
        compositionPointer: { namespaceId, sha256: createHash('sha256').update(bytes).digest('hex') },
      },
    };
    let deleted = false;
    const native = provider(
      (_method, url) => Effect.succeed(url.pathname === zeropsPath ? absentService() : absentWorker()),
      (method, url) => {
        if (url.pathname === namespacePath) {
          return Effect.succeed(nativeNamespace());
        }
        if (method === 'DELETE') {
          deleted = true;
          return Effect.succeed(Response.json({ errors: [], success: true }));
        }
        return Effect.succeed(
          deleted
            ? new Response(null, { status: 404 })
            : new Response(
                new ReadableStream({
                  start(controller) {
                    controller.enqueue(bytes);
                    controller.close();
                  },
                }),
              ),
        );
      },
    );
    const error = yield* quiesceInitialCutoverProviderInventory(input).pipe(Effect.provide(native.layer), Effect.flip);
    expect(Schema.is(InitialCutoverProviderError)(error)).toBe(true);
    expect(deleted).toBe(false);
  }),
);

it.effect('bounds a stalled obsolete pointer stream without deleting the key', () =>
  Effect.gen(function* timesOutPointerStream() {
    const native = provider(
      (_method, url) => Effect.succeed(url.pathname === zeropsPath ? absentService() : absentWorker()),
      (_method, url) =>
        Effect.succeed(url.pathname === namespacePath ? nativeNamespace() : new Response(new ReadableStream())),
    );
    const fiber = yield* quiesceInitialCutoverProviderInventory(inventory).pipe(
      Effect.provide(native.layer),
      Effect.flip,
      Effect.forkChild,
    );
    yield* TestClock.adjust('10 seconds');
    const error = yield* Fiber.join(fiber);
    expect(error.reason).toBe('provider operation timed out');
    expect(native.requests.some((request) => request.startsWith('DELETE '))).toBe(false);
  }),
);
