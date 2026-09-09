import { Effect, Predicate } from 'effect';
import { expect, it } from 'effect-rstest';

import { makeModuleContractFixture } from '../../../../packages/core-runtime/src/testing/module-contract.ts';
import type { DeploymentAllowlist } from '../../api/modules/deployment-allowlist.ts';
import {
  installedModuleCatalog,
  makeInstalledModuleCatalogLayer,
  makeInstalledModuleCatalogLoader,
} from '../../api/modules/installed-module-catalog.ts';

const contract = (appId: string, moduleId: string) =>
  makeModuleContractFixture({
    appId,
    moduleId,
    supportedStates: ['inactive', 'active', 'read_only', 'suspended', 'quarantined', 'deprecated', 'archived'],
  });

const allowlist = (entries: DeploymentAllowlist['entries']): DeploymentAllowlist =>
  Object.freeze({
    entries: Object.freeze([...entries]),
    revision: JSON.stringify(entries),
  });

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

it.effect('loads two independent deployment contracts once and preserves both identities', () =>
  Effect.gen(function* verifyCase1() {
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
        {
          appId: 'property-registry',
          contractUrl: [...documents.keys()][0] ?? '',
        },
        {
          appId: 'documents-center',
          contractUrl: [...documents.keys()][1] ?? '',
        },
      ]),
      (url, init) => {
        const normalized = new Request(url).url;
        requests.push(normalized);
        expect(init?.redirect).toBe('manual');
        return Promise.resolve(response(documents.get(normalized)));
      },
    );
    const [first, concurrent, cached] = yield* Effect.all([loader, loader, loader], {
      concurrency: 'unbounded',
    });
    expect(first).toBe(concurrent);
    expect(first).toBe(cached);
    expect(requests).toHaveLength(2);
    expect(first.moduleIds).toEqual(['documents.center', 'property.registry']);
    expect(first.getByDeploymentAppId('property-registry')?.manifest.module.id).toBe('property.registry');
    expect(first.getByModuleId('property.registry')?.deployment.appId).toBe('property-registry');
  }),
);

it.effect('keeps a healthy deployment available on cold start when another is unreachable', () =>
  Effect.gen(function* verifyCase2() {
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
      (url) => {
        const appId = new Request(url).url.includes('property') ? 'property-registry' : 'documents-center';
        if (appId === 'property-registry') {
          return Promise.reject(new Error('deployment unreachable'));
        }
        return Promise.resolve(response(contract(appId, 'documents.center')));
      },
    );

    const catalog = yield* loader;

    expect(catalog.moduleIds).toEqual(['documents.center']);
    expect(catalog.deploymentStatuses).toEqual([
      {
        appId: 'documents-center',
        moduleId: 'documents.center',
        status: 'available',
      },
      {
        appId: 'property-registry',
        reason: 'unavailable',
        status: 'unavailable',
      },
    ]);
  }),
);

const unavailableResponses = [
  ['unavailable', () => Promise.reject(new Error('secret host failure')), 'unavailable'],
  ['redirect', () => Promise.resolve(response({}, { status: 302 })), 'unavailable'],
  ['non-JSON', () => Promise.resolve(response('{}', { headers: { 'content-type': 'text/html' } })), 'incompatible'],
  ['malformed JSON', () => Promise.resolve(response('{broken')), 'incompatible'],
  ['invalid schema', () => Promise.resolve(response({ schemaVersion: '0' })), 'incompatible'],
  [
    'mismatched app',
    () => Promise.resolve(response(contract('documents-center', 'property.registry'))),
    'incompatible',
  ],
] as const;
for (const [label, fetcher, expectedReason] of unavailableResponses) {
  it.effect(`reports a typed deployment status for ${label} responses`, () =>
    Effect.gen(function* verifyCase3() {
      const loader = makeInstalledModuleCatalogLoader(
        allowlist([
          {
            appId: 'property-registry',
            contractUrl: 'https://property.example.test/.well-known/ontos-module-manifest.json',
          },
        ]),
        fetcher,
      );
      const catalog = yield* loader;
      expect(catalog.moduleIds).toEqual([]);
      expect(catalog.deploymentStatuses).toEqual([
        {
          appId: 'property-registry',
          reason: expectedReason,
          status: 'unavailable',
        },
      ]);
    }),
  );
}

it.live('classifies oversized, timed-out, and duplicate-module deployments without caching failures', () =>
  Effect.gen(function* verifyCase4() {
    let attempts = 0;
    const one: DeploymentAllowlist['entries'][number] = {
      appId: 'property-registry',
      contractUrl: 'https://property.example.test/.well-known/ontos-module-manifest.json',
    };
    const oversized = makeInstalledModuleCatalogLoader(
      allowlist([one]),
      () => Promise.resolve(response('x'.repeat(64))),
      { maxBytes: 32 },
    );
    expect(yield* oversized).toMatchObject({
      deploymentStatuses: [
        {
          appId: 'property-registry',
          reason: 'unavailable',
          status: 'unavailable',
        },
      ],
    });

    const timedOut = makeInstalledModuleCatalogLoader(
      allowlist([one]),
      (_url, init) => {
        const pending = Promise.withResolvers<Response>();
        init?.signal?.addEventListener('abort', () => pending.reject(new Error('aborted')), {
          once: true,
        });
        return Promise.resolve(pending.promise);
      },
      { timeoutMs: 10 },
    );
    expect(yield* timedOut).toMatchObject({
      deploymentStatuses: [
        {
          appId: 'property-registry',
          reason: 'timeout',
          status: 'unavailable',
        },
      ],
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
          new Request(url).url.includes('property')
            ? response(contract('property-registry', 'shared.module'))
            : response(contract('documents-center', 'shared.module')),
        );
      },
    );
    expect(yield* duplicate).toMatchObject({
      deploymentStatuses: [
        {
          appId: 'documents-center',
          reason: 'incompatible',
          status: 'unavailable',
        },
        {
          appId: 'property-registry',
          reason: 'incompatible',
          status: 'unavailable',
        },
      ],
    });
    yield* duplicate;
    expect(attempts).toBe(4);
  }),
);

it.effect('recovers a deployment on a later read and caches only the fully healthy result', () =>
  Effect.gen(function* verifyCase5() {
    let requests = 0;
    const loader = makeInstalledModuleCatalogLoader(
      allowlist([
        {
          appId: 'property-registry',
          contractUrl: 'https://property.example.test/.well-known/ontos-module-manifest.json',
        },
      ]),
      () => {
        requests += 1;
        if (requests === 1) {
          return Promise.reject(new Error('temporarily unreachable'));
        }
        return Promise.resolve(response(contract('property-registry', 'property.registry')));
      },
    );

    const degraded = yield* loader;
    const recovered = yield* loader;
    const cached = yield* loader;

    expect(degraded.deploymentStatuses).toEqual([
      {
        appId: 'property-registry',
        reason: 'unavailable',
        status: 'unavailable',
      },
    ]);
    expect(recovered.deploymentStatuses).toEqual([
      {
        appId: 'property-registry',
        moduleId: 'property.registry',
        status: 'available',
      },
    ]);
    expect(cached).toBe(recovered);
    expect(requests).toBe(2);
  }),
);

it.effect('recreates the complete cache by constructing a new deployment-revision Layer', () =>
  Effect.gen(function* verifyCase6() {
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

    yield* installedModuleCatalog.pipe(Effect.provide(firstRevision));
    yield* installedModuleCatalog.pipe(Effect.provide(firstRevision));
    yield* installedModuleCatalog.pipe(Effect.provide(secondRevision));
    expect(requests).toBe(2);
  }),
);
