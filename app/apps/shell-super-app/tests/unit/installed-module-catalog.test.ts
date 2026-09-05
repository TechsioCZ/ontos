/* eslint-disable promise/avoid-new -- The timeout fixture must wait for the injected AbortSignal. */
// @effect-diagnostics asyncFunction:off preferSchemaOverJson:off
import { expect, test } from '@rstest/core';
import { Effect, Predicate } from 'effect';
import type { DeploymentAllowlist } from '../../api/modules/deployment-allowlist.ts';
import {
  installedModuleCatalog,
  makeInstalledModuleCatalogLayer,
  makeInstalledModuleCatalogLoader,
} from '../../api/modules/installed-module-catalog.ts';

const contract = (appId: string, moduleId: string) => ({
  deployment: { appId, buildMarker: `${appId}-build` },
  manifest: {
    activation: {
      defaultState: 'inactive',
      preservesHistoryWhenInactive: true,
      scope: 'tenant',
      supportedStates: [
        'inactive',
        'active',
        'read_only',
        'suspended',
        'quarantined',
        'deprecated',
        'archived',
      ],
    },
    module: {
      description: `${moduleId} module`,
      displayName: moduleId,
      id: moduleId,
      implementedAs: 'ultramodern_microvertical',
      kind: 'business_module',
    },
    publicSurface: {
      actions: [],
      api: [],
      components: [],
      events: [],
      reports: [],
      resourceTypes: [],
      search: [],
      shellContributions: {
        mediaAttachments: [],
        navigation: [],
        pages: [],
        publicComponents: [],
        reports: [],
        resourceDetails: [],
        search: [],
        timelines: [],
      },
    },
  },
  runtime: { outboxSubscriptions: [] },
  schemaVersion: '2',
});

const allowlist = (entries: DeploymentAllowlist['entries']): DeploymentAllowlist =>
  Object.freeze({ entries: Object.freeze([...entries]), revision: JSON.stringify(entries) });

const response = <Value>(value: Value, init: ResponseInit = {}): Response => {
  const headers = {
    'content-type': 'application/json',
    ...Object.fromEntries(new Headers(init.headers)),
  };
  return new Response(Predicate.isString(value) ? value : JSON.stringify(value), {
    ...init,
    headers,
  });
};

test('bounds independent deployment fetches to four concurrent requests', async () => {
  const release = Promise.withResolvers<void>();
  const filled = Promise.withResolvers<void>();
  const entries = Array.from({ length: 6 }, (_, index) => ({
    appId: `deployment-${index}`,
    contractUrl: `https://deployment-${index}.example.test/.well-known/ontos-module-manifest.json`,
  }));
  let active = 0;
  let peak = 0;
  const loader = makeInstalledModuleCatalogLoader(allowlist(entries), async (url) => {
    active += 1;
    peak = Math.max(peak, active);
    if (active === 4) {
      filled.resolve();
    }
    try {
      await release.promise;
      const appId = new URL(String(url)).hostname.split('.')[0] ?? '';
      return response(contract(appId, appId.replace('-', '.')));
    } finally {
      active -= 1;
    }
  });
  const result = Effect.runPromise(loader);
  try {
    await filled.promise;
    expect(peak).toBe(4);
    release.resolve();
    expect((await result).deploymentStatuses).toHaveLength(6);
    expect(peak).toBe(4);
    expect(active).toBe(0);
  } finally {
    release.resolve();
    await result;
  }
});

test('loads two independent deployment contracts once and preserves both identities', async () => {
  const requests: string[] = [];
  const documents = new Map([
    [
      'https://property.example.test/.well-known/ontos-module-manifest.json',
      contract('property-registry', 'property.registry'),
    ],
    [
      'https://documents.example.test/.well-known/ontos-module-manifest.json',
      contract('documents-center', 'documents.center'),
    ],
  ]);
  const loader = makeInstalledModuleCatalogLoader(
    allowlist([
      { appId: 'property-registry', contractUrl: [...documents.keys()][0] ?? '' },
      { appId: 'documents-center', contractUrl: [...documents.keys()][1] ?? '' },
    ]),
    async (url, init) => {
      const normalized = new Request(url).url;
      requests.push(normalized);
      expect(init?.redirect).toBe('manual');
      return response(documents.get(normalized));
    },
  );
  const [first, concurrent, cached] = await Promise.all([
    Effect.runPromise(loader),
    Effect.runPromise(loader),
    Effect.runPromise(loader),
  ]);
  expect(first).toBe(concurrent);
  expect(first).toBe(cached);
  expect(requests).toHaveLength(2);
  expect(first.moduleIds).toEqual(['documents.center', 'property.registry']);
  expect(first.getByDeploymentAppId('property-registry')?.manifest.module.id).toBe(
    'property.registry',
  );
  expect(first.getByModuleId('property.registry')?.deployment.appId).toBe('property-registry');
});

test('keeps a healthy deployment available on cold start when another is unreachable', async () => {
  const loader = makeInstalledModuleCatalogLoader(
    allowlist([
      {
        appId: 'property-registry',
        contractUrl: 'https://property.example.test/.well-known/ontos-module-manifest.json',
      },
      {
        appId: 'documents-center',
        contractUrl: 'https://documents.example.test/.well-known/ontos-module-manifest.json',
      },
    ]),
    async (url) => {
      const appId = new Request(url).url.includes('property')
        ? 'property-registry'
        : 'documents-center';
      if (appId === 'property-registry') {
        throw new Error('deployment unreachable');
      }
      return response(contract(appId, 'documents.center'));
    },
  );

  const catalog = await Effect.runPromise(loader);

  expect(catalog.moduleIds).toEqual(['documents.center']);
  expect(catalog.deploymentStatuses).toEqual([
    { appId: 'documents-center', moduleId: 'documents.center', status: 'available' },
    { appId: 'property-registry', reason: 'unavailable', status: 'unavailable' },
  ]);
});

test.each([
  [
    'unavailable',
    async () => {
      throw new Error('secret host failure');
    },
    'unavailable',
  ],
  ['redirect', async () => response({}, { status: 302 }), 'unavailable'],
  [
    'non-JSON',
    async () => response('{}', { headers: { 'content-type': 'text/html' } }),
    'incompatible',
  ],
  ['malformed JSON', async () => response('{broken'), 'incompatible'],
  ['invalid schema', async () => response({ schemaVersion: '0' }), 'incompatible'],
  [
    'mismatched app',
    async () => response(contract('documents-center', 'property.registry')),
    'incompatible',
  ],
])(
  'reports a typed deployment status for %s responses',
  async (_label, fetcher, expectedReason) => {
    const loader = makeInstalledModuleCatalogLoader(
      allowlist([
        {
          appId: 'property-registry',
          contractUrl: 'https://property.example.test/.well-known/ontos-module-manifest.json',
        },
      ]),
      fetcher,
    );
    const catalog = await Effect.runPromise(loader);
    expect(catalog.moduleIds).toEqual([]);
    expect(catalog.deploymentStatuses).toEqual([
      { appId: 'property-registry', reason: expectedReason, status: 'unavailable' },
    ]);
  },
);

test('classifies oversized, timed-out, and duplicate-module deployments without caching failures', async () => {
  let attempts = 0;
  const one: DeploymentAllowlist['entries'][number] = {
    appId: 'property-registry',
    contractUrl: 'https://property.example.test/.well-known/ontos-module-manifest.json',
  };
  const oversized = makeInstalledModuleCatalogLoader(
    allowlist([one]),
    async () => response('x'.repeat(64)),
    { maxBytes: 32 },
  );
  await expect(Effect.runPromise(oversized)).resolves.toMatchObject({
    deploymentStatuses: [
      { appId: 'property-registry', reason: 'unavailable', status: 'unavailable' },
    ],
  });

  const timedOut = makeInstalledModuleCatalogLoader(
    allowlist([one]),
    async (_url, init) =>
      await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }),
    { timeoutMs: 10 },
  );
  await expect(Effect.runPromise(timedOut)).resolves.toMatchObject({
    deploymentStatuses: [{ appId: 'property-registry', reason: 'timeout', status: 'unavailable' }],
  });

  const duplicate = makeInstalledModuleCatalogLoader(
    allowlist([
      one,
      {
        appId: 'documents-center',
        contractUrl: 'https://documents.example.test/.well-known/ontos-module-manifest.json',
      },
    ]),
    async (url) => {
      attempts += 1;
      return new Request(url).url.includes('property')
        ? response(contract('property-registry', 'shared.module'))
        : response(contract('documents-center', 'shared.module'));
    },
  );
  await expect(Effect.runPromise(duplicate)).resolves.toMatchObject({
    deploymentStatuses: [
      { appId: 'documents-center', reason: 'incompatible', status: 'unavailable' },
      { appId: 'property-registry', reason: 'incompatible', status: 'unavailable' },
    ],
  });
  await Effect.runPromise(duplicate);
  expect(attempts).toBe(4);
});

test('does not adopt a late response after the loading owner times out', async () => {
  let attempts = 0;
  let firstSignalAborted = false;
  // The late body reports its own fate instead of the test guessing at an event-loop turn:
  // `cancel` is the abandoned fetch discarding it, `pull` is the interrupted owner reading it
  // as catalog content. Exactly one of the two runs, so the wait always completes.
  const lateBodyFate = Promise.withResolvers<'cancelled' | 'read'>();
  const lateResponse = new Response(
    new ReadableStream<Uint8Array>(
      {
        cancel: () => {
          lateBodyFate.resolve('cancelled');
        },
        pull: (controller) => {
          lateBodyFate.resolve('read');
          controller.enqueue(
            new TextEncoder().encode(
              JSON.stringify(contract('property-registry', 'late.property.registry')),
            ),
          );
          controller.close();
        },
      },
      { highWaterMark: 0 },
    ),
    { headers: { 'content-type': 'application/json' } },
  );
  let releaseFirst: ((value: Response) => void) | undefined;
  const loader = makeInstalledModuleCatalogLoader(
    allowlist([
      {
        appId: 'property-registry',
        contractUrl: 'https://property.example.test/.well-known/ontos-module-manifest.json',
      },
    ]),
    async (_url, init) => {
      attempts += 1;
      if (attempts === 1) {
        init?.signal?.addEventListener('abort', () => {
          firstSignalAborted = true;
        });
        return await new Promise<Response>((resolve) => {
          releaseFirst = resolve;
        });
      }
      return response(contract('property-registry', 'property.registry'));
    },
    { timeoutMs: 10 },
  );

  const timedOut = await Effect.runPromise(loader);
  expect(timedOut.deploymentStatuses).toEqual([
    { appId: 'property-registry', reason: 'timeout', status: 'unavailable' },
  ]);
  expect(firstSignalAborted).toBe(true);
  expect(releaseFirst).toBeDefined();
  releaseFirst?.(lateResponse);
  await expect(lateBodyFate.promise).resolves.toBe('cancelled');

  const recovered = await Effect.runPromise(loader);
  expect(recovered.moduleIds).toEqual(['property.registry']);
  expect(attempts).toBe(2);
});

test('recovers a deployment on a later read and caches only the fully healthy result', async () => {
  let requests = 0;
  const loader = makeInstalledModuleCatalogLoader(
    allowlist([
      {
        appId: 'property-registry',
        contractUrl: 'https://property.example.test/.well-known/ontos-module-manifest.json',
      },
    ]),
    async () => {
      requests += 1;
      if (requests === 1) {
        throw new Error('temporarily unreachable');
      }
      return response(contract('property-registry', 'property.registry'));
    },
  );

  const degraded = await Effect.runPromise(loader);
  const recovered = await Effect.runPromise(loader);
  const cached = await Effect.runPromise(loader);

  expect(degraded.deploymentStatuses).toEqual([
    { appId: 'property-registry', reason: 'unavailable', status: 'unavailable' },
  ]);
  expect(recovered.deploymentStatuses).toEqual([
    { appId: 'property-registry', moduleId: 'property.registry', status: 'available' },
  ]);
  expect(cached).toBe(recovered);
  expect(requests).toBe(2);
});

test('recreates the complete cache by constructing a new deployment-revision Layer', async () => {
  let requests = 0;
  const fetcher = async () => {
    requests += 1;
    return response(contract('property-registry', 'property.registry'));
  };
  const firstRevision = makeInstalledModuleCatalogLayer(
    allowlist([
      {
        appId: 'property-registry',
        contractUrl: 'https://property.example.test/.well-known/ontos-module-manifest.json',
      },
    ]),
    fetcher,
  );
  const secondRevision = makeInstalledModuleCatalogLayer(
    Object.freeze({
      ...allowlist([
        {
          appId: 'property-registry',
          contractUrl: 'https://property.example.test/.well-known/ontos-module-manifest.json',
        },
      ]),
      revision: 'revision-2',
    }),
    fetcher,
  );

  await Effect.runPromise(installedModuleCatalog.pipe(Effect.provide(firstRevision)));
  await Effect.runPromise(installedModuleCatalog.pipe(Effect.provide(firstRevision)));
  await Effect.runPromise(installedModuleCatalog.pipe(Effect.provide(secondRevision)));
  expect(requests).toBe(2);
});
