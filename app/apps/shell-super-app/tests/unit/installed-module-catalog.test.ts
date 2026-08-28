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

test.each([
  [
    'unavailable',
    async () => {
      throw new Error('secret host failure');
    },
    'InstalledModuleCatalogUnavailableError',
  ],
  ['redirect', async () => response({}, { status: 302 }), 'InstalledModuleCatalogUnavailableError'],
  [
    'non-JSON',
    async () => response('{}', { headers: { 'content-type': 'text/html' } }),
    'InstalledModuleCatalogInvalidError',
  ],
  ['malformed JSON', async () => response('{broken'), 'InstalledModuleCatalogInvalidError'],
  [
    'invalid schema',
    async () => response({ schemaVersion: '0' }),
    'InstalledModuleCatalogInvalidError',
  ],
  [
    'mismatched app',
    async () => response(contract('documents-center', 'property.registry')),
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
  const one: DeploymentAllowlist['entries'][number] = {
    appId: 'property-registry',
    contractUrl: 'https://property.example.test/.well-known/ontos-module-manifest.json',
  };
  const oversized = makeInstalledModuleCatalogLoader(
    allowlist([one]),
    async () => response('x'.repeat(64)),
    { maxBytes: 32 },
  );
  await expect(Effect.runPromise(oversized)).rejects.toMatchObject({
    _tag: 'InstalledModuleCatalogUnavailableError',
  });

  const timedOut = makeInstalledModuleCatalogLoader(
    allowlist([one]),
    async (_url, init) =>
      await new Promise((_resolve, reject) => {
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
    async (url) => {
      attempts += 1;
      return new Request(url).url.includes('property')
        ? response(contract('property-registry', 'shared.module'))
        : response(contract('documents-center', 'shared.module'));
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
