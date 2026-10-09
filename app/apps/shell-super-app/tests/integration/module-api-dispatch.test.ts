import {
  ApplicationCompositionBackendSchema,
  ApplicationCompositionModuleSchema,
  makeActiveApplicationCompositionLayer,
  validateActiveApplicationCompositionSnapshot,
} from '@app/core-runtime';
import {
  moduleReleaseApiBaseUrl,
  moduleReleaseAssetWorkerName,
  moduleReleaseFetch,
  moduleReleaseWorkerName,
} from '@app/core-runtime/unit-service-fetch';
import { Effect, Predicate, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { dispatchModuleApiRequest } from '../../src/module-api/transport.ts';
import { admitModuleApiRequest, MODULE_API_REVISION_HEADER } from '../../src/module-api/admission.ts';
import { makeCompositionSnapshot, sealComposition } from '../fixtures/application-composition.ts';

const appId = 'party-registry';
const buildMarker = '0123456789abcdef';
const contract = {
  deployment: { appId, buildMarker },
  manifest: {
    activation: {
      defaultState: 'inactive',
      preservesHistoryWhenInactive: true,
      scope: 'tenant',
      supportedStates: ['inactive', 'active', 'read_only', 'suspended', 'quarantined', 'deprecated', 'archived'],
    },
    module: {
      description: 'Test owner',
      displayName: 'Test owner',
      id: 'party.registry',
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
};

const requestFor = (revision: string, path = `${appId}/${buildMarker}/${appId}-api/items`) =>
  new Request(`https://shell.example/module-api/${path}?limit=5`, {
    headers: { [MODULE_API_REVISION_HEADER]: revision },
  });

it.effect('admits only the exact approved owner and its relative endpoint with query', () =>
  Effect.gen(function* exactReleaseDispatch() {
    const snapshot = yield* makeCompositionSnapshot([contract]);
    const request = new Request(`https://shell.example/module-api/${appId}/${buildMarker}/${appId}-api/items?limit=5`, {
      body: 'write payload',
      headers: { authorization: 'Bearer owner-assertion', [MODULE_API_REVISION_HEADER]: snapshot.composition.revision },
      method: 'POST',
    });
    const target = yield* admitModuleApiRequest(request, snapshot.composition);
    expect(target.module.deployment).toEqual({ appId, buildMarker });
    expect(target.forwardedUrl.href).toBe('https://module.invalid/party-registry-api/items?limit=5');
    expect(moduleReleaseApiBaseUrl(appId, buildMarker)).toBe(
      `/shell-super-app-api/module-api/${appId}/${buildMarker}/${appId}-api`,
    );
  }),
);

it.effect('removes Shell secrets and connection-specific headers while retaining governed owner headers', () =>
  Effect.gen(function* ownerHeaderBoundary() {
    const snapshot = yield* makeCompositionSnapshot([contract]);
    const request = new Request(requestFor(snapshot.composition.revision), {
      headers: {
        authorization: 'Bearer approved-owner-assertion',
        connection: 'keep-alive, x-owner-hop',
        cookie: 'shell-secret=must-stay-in-shell',
        host: 'shell.example',
        'idempotency-key': 'write-123',
        [MODULE_API_REVISION_HEADER]: snapshot.composition.revision,
        'proxy-authorization': 'private-proxy-secret',
        'x-correlation-id': 'owner-correlation',
        'x-owner-hop': 'private-hop-value',
      },
    });
    const { forwardedRequest } = yield* admitModuleApiRequest(request, snapshot.composition);
    expect(forwardedRequest.headers.get('cookie')).toBeNull();
    expect(forwardedRequest.headers.get('host')).toBeNull();
    expect(forwardedRequest.headers.get('connection')).toBeNull();
    expect(forwardedRequest.headers.get('proxy-authorization')).toBeNull();
    expect(forwardedRequest.headers.get('x-owner-hop')).toBeNull();
    expect(forwardedRequest.headers.get('authorization')).toBe('Bearer approved-owner-assertion');
    expect(forwardedRequest.headers.get(MODULE_API_REVISION_HEADER)).toBe(snapshot.composition.revision);
    expect(forwardedRequest.headers.get('idempotency-key')).toBe('write-123');
    expect(forwardedRequest.headers.get('x-correlation-id')).toBe('owner-correlation');
  }),
);

it.effect.each(['x-invalid token', 'keep-alive,,x-owner-hop', 'authorization', MODULE_API_REVISION_HEADER])(
  'rejects invalid or authority-removing Connection option %s',
  (connection) =>
    Effect.gen(function* invalidConnectionOption() {
      const snapshot = yield* makeCompositionSnapshot([contract]);
      const request = new Request(requestFor(snapshot.composition.revision), {
        headers: { connection, [MODULE_API_REVISION_HEADER]: snapshot.composition.revision },
      });
      const error = yield* admitModuleApiRequest(request, snapshot.composition).pipe(Effect.flip);
      expect(Predicate.isTagged(error, 'ModuleApiDispatchError')).toBe(true);
      expect(error.status).toBe(400);
    }),
);

it.effect('dispatches an encoded opaque approved build marker without treating it as an owner path', () =>
  Effect.gen(function* opaqueReleaseMarker() {
    const marker = 'release.1 / build 1%2f';
    const snapshot = yield* makeCompositionSnapshot([{ ...contract, deployment: { appId, buildMarker: marker } }]);
    const target = yield* admitModuleApiRequest(
      requestFor(snapshot.composition.revision, `${appId}/${encodeURIComponent(marker)}/${appId}-api/items`),
      snapshot.composition,
    );
    expect(target.module.deployment.buildMarker).toBe(marker);
    expect(target.forwardedUrl.pathname).toBe(`/${appId}-api/items`);
  }),
);

it.effect.each([
  ['stale-revision', `${appId}/${buildMarker}/${appId}-api/items`, 409],
  ['current', `${appId}/other-build/${appId}-api/items`, 409],
  ['current', `unknown/${buildMarker}/unknown-api/items`, 404],
  ['current', `${appId}/${buildMarker}/other-api/items`, 400],
  ['current', `${appId}/${buildMarker}/${appId}-api/items%2foutside`, 400],
  ['current', `${appId}/${buildMarker}/${appId}-api/%252e%252e/outside`, 400],
  ['current', `${appId}/%/${appId}-api/items`, 400],
] as const)('rejects %s / %s before provider selection', ([revision, path, status]) =>
  Effect.gen(function* rejectsBeforeDispatch() {
    const snapshot = yield* makeCompositionSnapshot([contract]);
    const error = yield* admitModuleApiRequest(
      requestFor(revision === 'current' ? snapshot.composition.revision : revision, path),
      snapshot.composition,
    ).pipe(Effect.flip);
    expect(Predicate.isTagged(error, 'ModuleApiDispatchError')).toBe(true);
    if (Predicate.isTagged(error, 'ModuleApiDispatchError')) {
      expect(error.status).toBe(status);
    }
  }),
);

it.effect('requires fresh complete authority and never dispatches from an expired bundle', () =>
  Effect.gen(function* rejectsExpiredAuthority() {
    const snapshot = yield* makeCompositionSnapshot([contract], -1);
    const error = yield* dispatchModuleApiRequest(requestFor(snapshot.composition.revision)).pipe(
      Effect.provide(makeActiveApplicationCompositionLayer(Effect.succeed(snapshot))),
      Effect.flip,
    );
    expect(Predicate.isTagged(error, 'ActiveApplicationCompositionUnavailableError')).toBe(true);
  }),
);

it.effect('admits an ordinary Worker only at the exact approved release origin', () =>
  Effect.gen(function* admitsOrdinaryWorker() {
    const original = yield* makeCompositionSnapshot([contract]);
    const workerName = yield* moduleReleaseWorkerName(appId, buildMarker);
    const backend = yield* Schema.decodeUnknownEffect(ApplicationCompositionBackendSchema)({
      baseUrl: `https://${workerName}.fixture.workers.dev/`,
      transport: 'cloudflare-worker',
      versionId: '00000000-0000-4000-8000-000000000001',
      workerName,
    });
    const snapshot = {
      ...original,
      composition: sealComposition({
        ...original.composition,
        modules: original.composition.modules.map((module) => ({ ...module, backend })),
      }),
    };
    yield* validateActiveApplicationCompositionSnapshot(snapshot);
    const target = yield* admitModuleApiRequest(requestFor(snapshot.composition.revision), snapshot.composition);
    expect(target.module.backend).toEqual(backend);
    expect(target.module.deployment).toEqual({ appId, buildMarker });
  }),
);

it.effect('rejects a Worker from another build before native Node transport can contact it', () =>
  Effect.gen(function* rejectsWrongWorkerIdentity() {
    const snapshot = yield* makeCompositionSnapshot([contract]);
    const module = yield* Schema.decodeUnknownEffect(ApplicationCompositionModuleSchema)(
      snapshot.composition.modules[0],
    );
    const workerName = yield* moduleReleaseWorkerName(appId, 'another-release');
    const backend = yield* Schema.decodeUnknownEffect(ApplicationCompositionBackendSchema)({
      baseUrl: `https://${workerName}.fixture.workers.dev/`,
      transport: 'cloudflare-worker',
      versionId: '00000000-0000-4000-8000-000000000001',
      workerName,
    });
    const error = yield* moduleReleaseFetch(new Request('https://module.invalid/party-registry-api/items'), {
      ...module,
      backend,
    }).pipe(Effect.flip);
    expect(Predicate.isTagged(error, 'ModuleReleaseTransportError')).toBe(true);
    expect(error).toMatchObject({ reason: 'The approved native executable identity is invalid' });
  }),
);

it.effect.each([
  'http://127.0.0.1/',
  'https://foreign.example/',
  'https://release.fixture.workers.dev/path',
  'https://release.fixture.workers.dev/?redirect=foreign',
])('rejects an unsafe ordinary Worker origin before native Node dispatch: %s', (baseUrl) =>
  Effect.gen(function* rejectsUnsafeWorkerOrigin() {
    const snapshot = yield* makeCompositionSnapshot([contract]);
    const module = yield* Schema.decodeUnknownEffect(ApplicationCompositionModuleSchema)(
      snapshot.composition.modules[0],
    );
    const workerName = yield* moduleReleaseWorkerName(appId, buildMarker);
    const backend = yield* Schema.decodeUnknownEffect(ApplicationCompositionBackendSchema)({
      baseUrl: `https://${workerName}.fixture.workers.dev/`,
      transport: 'cloudflare-worker',
      versionId: '00000000-0000-4000-8000-000000000001',
      workerName,
    });
    const error = yield* moduleReleaseFetch(new Request('https://module.invalid/party-registry-api/items'), {
      ...module,
      backend: { ...backend, baseUrl },
    }).pipe(Effect.flip);
    expect(Predicate.isTagged(error, 'ModuleReleaseTransportError')).toBe(true);
    expect(error).toMatchObject({ reason: 'The approved owner placement is invalid' });
  }),
);

it.effect('uses stable bounded distinct provider names even for the longest release identity', () =>
  Effect.gen(function* providerIdentity() {
    const first = yield* moduleReleaseWorkerName('commerce-customer-context', 'a'.repeat(64));
    const again = yield* moduleReleaseWorkerName('commerce-customer-context', 'a'.repeat(64));
    const other = yield* moduleReleaseWorkerName('commerce-customer-context', 'b'.repeat(64));
    const assets = yield* moduleReleaseAssetWorkerName('commerce-customer-context', 'a'.repeat(64));
    expect(first).toBe(again);
    expect(first).not.toBe(other);
    expect(first).toMatch(/^ontos-[a-f\d]{56}$/u);
    expect(assets).toBe(`assets-${first.slice('ontos-'.length)}`);
    expect(assets.length).toBe(63);
  }),
);
