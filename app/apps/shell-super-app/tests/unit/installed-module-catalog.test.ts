/* eslint-disable promise/avoid-new -- The timeout fixture must wait for the injected AbortSignal. */
// @effect-diagnostics asyncFunction:off preferSchemaOverJson:off
import { expect, test } from '@rstest/core';
import { Effect } from 'effect';
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
    },
  },
  runtime: { outboxSubscriptions: [] },
  schemaVersion: '1',
});

const allowlist = (entries: DeploymentAllowlist['entries']): DeploymentAllowlist =>
  Object.freeze({ entries: Object.freeze([...entries]), revision: JSON.stringify(entries) });

const response = (value: unknown, init: ResponseInit = {}): Response =>
  new Response(typeof value === 'string' ? value : JSON.stringify(value), {
    headers: { 'content-type': 'application/json', ...init.headers },
    status: init.status,
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
    (url, init) => {
      const normalized = String(url);
      requests.push(normalized);
      expect(init?.redirect).toBe('manual');
      return Promise.resolve(response(documents.get(normalized)));
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

test.each([
  [
    'unavailable',
    () => Promise.reject(new Error('secret host failure')),
    'InstalledModuleCatalogUnavailableError',
  ],
  [
    'redirect',
    () => Promise.resolve(response({}, { status: 302 })),
    'InstalledModuleCatalogUnavailableError',
  ],
  [
    'non-JSON',
    () => Promise.resolve(response('{}', { headers: { 'content-type': 'text/html' } })),
    'InstalledModuleCatalogInvalidError',
  ],
  [
    'malformed JSON',
    () => Promise.resolve(response('{broken')),
    'InstalledModuleCatalogInvalidError',
  ],
  [
    'invalid schema',
    () => Promise.resolve(response({ schemaVersion: '0' })),
    'InstalledModuleCatalogInvalidError',
  ],
  [
    'mismatched app',
    () => Promise.resolve(response(contract('documents-center', 'property.registry'))),
    'InstalledModuleCatalogInvalidError',
  ],
])('fails the whole snapshot for %s responses', async (_label, fetcher, expectedTag) => {
  const loader = makeInstalledModuleCatalogLoader(
    allowlist([
      {
        appId: 'property-registry',
        contractUrl: 'https://property.example.test/.well-known/ontos-module-manifest.json',
      },
    ]),
    fetcher,
  );
  await expect(Effect.runPromise(loader)).rejects.toMatchObject({ _tag: expectedTag });
});

test('rejects oversized, timed-out, and duplicate-module snapshots without caching failures', async () => {
  let attempts = 0;
  const one = {
    appId: 'property-registry',
    contractUrl: 'https://property.example.test/.well-known/ontos-module-manifest.json',
  } as const;
  const oversized = makeInstalledModuleCatalogLoader(
    allowlist([one]),
    () => Promise.resolve(response('x'.repeat(64))),
    { maxBytes: 32 },
  );
  await expect(Effect.runPromise(oversized)).rejects.toMatchObject({
    _tag: 'InstalledModuleCatalogUnavailableError',
  });

  const timedOut = makeInstalledModuleCatalogLoader(
    allowlist([one]),
    (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }),
    { timeoutMs: 10 },
  );
  await expect(Effect.runPromise(timedOut)).rejects.toMatchObject({
    _tag: 'InstalledModuleCatalogUnavailableError',
  });

  const duplicate = makeInstalledModuleCatalogLoader(
    allowlist([
      one,
      {
        appId: 'documents-center',
        contractUrl: 'https://documents.example.test/.well-known/ontos-module-manifest.json',
      },
    ]),
    (url) => {
      attempts += 1;
      return Promise.resolve(
        String(url).includes('property')
          ? response(contract('property-registry', 'shared.module'))
          : response(contract('documents-center', 'shared.module')),
      );
    },
  );
  await expect(Effect.runPromise(duplicate)).rejects.toMatchObject({
    _tag: 'InstalledModuleCatalogInvalidError',
  });
  await expect(Effect.runPromise(duplicate)).rejects.toMatchObject({
    _tag: 'InstalledModuleCatalogInvalidError',
  });
  expect(attempts).toBe(4);
});

test('recreates the complete cache by constructing a new deployment-revision Layer', async () => {
  let requests = 0;
  const fetcher = () => {
    requests += 1;
    return Promise.resolve(response(contract('property-registry', 'property.registry')));
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
