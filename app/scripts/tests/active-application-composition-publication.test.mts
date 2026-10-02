import { NodeServices } from '@effect/platform-node';
import { ConfigProvider, DateTime, Effect, Layer, Match, Option, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { expect, it } from 'effect-rstest';
import { HttpClient, HttpClientResponse } from 'effect/unstable/http';

import { governedSharedSingletonPackages } from '../../module-federation.shared.ts';
import { CoreDatabase } from '../../packages/core-runtime/src/db/client.ts';
import {
  moduleReleaseAssetWorkerName,
  moduleReleaseWorkerName,
} from '../../packages/core-runtime/src/http/module-release-identity.ts';
import {
  ONTOS_MODULE_CONTRACT_MAX_BYTES,
  validateActiveApplicationCompositionSnapshot,
} from '../../packages/core-runtime/src/index.ts';
import { ApplicationCompositionAuthorityError } from '../../packages/core-runtime/src/modules/application-composition-authority.ts';
import { ApplicationCompositionCloudflareWorkerBackendSchema } from '../../packages/core-runtime/src/modules/application-composition.ts';
import { makeTestDatabase } from '../../packages/core-runtime/tests/support/database.ts';
import {
  ACTIVE_APPLICATION_COMPOSITION_POLICY,
  ActiveApplicationCompositionPublicationError,
  applicationCompositionRevision,
  deriveActiveApplicationCompositionSnapshot,
  encodeActiveApplicationCompositionSnapshot,
} from '../active-application-composition.mts';
import { createShellRuntimeContract } from '../generate-ontos-shell-runtime-contract.mts';
import {
  InitialCutoverProviderError,
  verifyInitialCutoverProviderInventory,
} from '../initial-composition-cutover-provider.mts';
import {
  ActiveApplicationCompositionObservationError,
  ApplicationCompositionPublicationCandidateSchema,
  fetchArtifact,
  observeCandidate,
  publicationUrl,
  publishSnapshot,
  readPublishedSnapshot,
} from '../publish-active-application-composition.mts';
import { ZeropsPublicApiLive } from '../zerops-public-api.mts';

const KV_URL = `https://api.cloudflare.com/client/v4/accounts/${'a'.repeat(32)}/storage/kv/namespaces/${'b'.repeat(32)}/values/active`;
const PUBLICATION_LOCK_SQL =
  "select pg_advisory_lock(hashtextextended('ontos.application-composition-publication', 0))";
const PUBLICATION_UNLOCK_SQL =
  "select pg_advisory_unlock(hashtextextended('ontos.application-composition-publication', 0))";
const TOKEN = 'publication-test-token';
const LEGACY_NODE_SERVICE_ID = 'legacy-node-service';
const LEGACY_WORKER_NAME = 'legacy-worker';
const CUTOVER_ACCOUNT_ID = 'c'.repeat(32);
const NODE_ACTIVE_STATE = 'node-active';
const NODE_STOPPED_STATE = 'node-stopped';
const WORKER_ACTIVE_STATE = 'worker-active';
const SHELL_BUILD_MARKER = 'shell-immutable-build';
const WORKER_VERSION_ID = 'c302ec41-290b-4d31-8105-5c3467008799';
const WORKER_ACCOUNT_SUBDOMAIN = 'test-account';
const CATALOG_MODULE_ID = 'catalog.products';
const initialCutoverProof = verifyInitialCutoverProviderInventory({
  cloudflare: { accountId: CUTOVER_ACCOUNT_ID, workerNames: [LEGACY_WORKER_NAME] },
  zeropsServiceIds: [LEGACY_NODE_SERVICE_ID],
});
const OBSERVED_AT = '2026-10-02T16:00:00.000Z';
const JsonText = Schema.fromJsonString(Schema.Unknown);
const artifact = (url: string, document: typeof JsonText.Type) => ({
  bytes: new TextEncoder().encode(Schema.encodeSync(JsonText)(document)),
  url,
});

const emptyContributions = {
  mediaAttachments: [],
  navigation: [],
  pages: [],
  publicComponents: [],
  reports: [],
  resourceDetails: [],
  search: [],
  timelines: [],
};

const deployedModule = (appId: string, moduleId: string) =>
  Effect.gen(function* deployedTestModule() {
    const worker = yield* moduleReleaseAssetWorkerName(appId, `${appId}-immutable-build`);
    const workerName = yield* moduleReleaseWorkerName(appId, `${appId}-immutable-build`);
    return {
      appId,
      backend: yield* Schema.decodeUnknownEffect(ApplicationCompositionCloudflareWorkerBackendSchema)({
        baseUrl: `https://${workerName}.${WORKER_ACCOUNT_SUBDOMAIN}.workers.dev/`,
        transport: 'cloudflare-worker',
        versionId: WORKER_VERSION_ID,
        workerName,
      }),
      contract: artifact(`https://${worker}.test-account.workers.dev/.well-known/ontos-module-manifest.json`, {
        deployment: { appId, buildMarker: `${appId}-immutable-build` },
        manifest: {
          activation: {
            defaultState: 'inactive',
            preservesHistoryWhenInactive: true,
            scope: 'tenant',
            supportedStates: ['inactive', 'active'],
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
            businessPermissions: [],
            components: [],
            events: [],
            reports: [],
            resourceTypes: [],
            search: [],
            shellContributions: emptyContributions,
          },
        },
        runtime: { outboxSubscriptions: [] },
        schemaVersion: '2',
      }),
    };
  });

const shellArtifacts = (buildMarker: string) =>
  Effect.gen(function* retainedShellArtifacts() {
    const shellAssets = yield* moduleReleaseAssetWorkerName('shell-super-app', buildMarker);
    return {
      federationManifest: artifact(`https://${shellAssets}.test-account.workers.dev/mf-manifest.json`, {
        exposes: [],
        name: 'shellSuperApp',
        shared: governedSharedSingletonPackages.map((name) => ({ name, requiredVersion: '1.0.0', singleton: true })),
      }),
      runtimeContract: artifact(
        `https://${shellAssets}.test-account.workers.dev/.well-known/ontos-shell-runtime.json`,
        createShellRuntimeContract(buildMarker),
      ),
    };
  });

const snapshotAt = (observedAt: string) =>
  Effect.gen(function* deriveTestSnapshot() {
    yield* TestClock.setTime(Date.parse('2026-10-02T16:02:00.000Z'));
    return yield* deriveActiveApplicationCompositionSnapshot({
      environment: 'stage',
      modules: yield* Effect.all([
        deployedModule('catalog', CATALOG_MODULE_ID),
        deployedModule('inventory', 'inventory.stock'),
      ]),
      observedAt: DateTime.makeUnsafe(observedAt),
      shell: yield* shellArtifacts(SHELL_BUILD_MARKER),
      validity: ACTIVE_APPLICATION_COMPOSITION_POLICY.validity,
    });
  });

interface RecordedRequest {
  readonly authorization: string | undefined;
  readonly body: string;
  readonly cacheControl: string | undefined;
  readonly contentType: string | undefined;
  readonly method: string;
  readonly url: string;
}

const provider = (
  answer: (request: RecordedRequest, index: number) => Response,
  url = KV_URL,
  authorityUnexpired = true,
  oldRuntime: 'retired' | typeof NODE_ACTIVE_STATE | typeof NODE_STOPPED_STATE | typeof WORKER_ACTIVE_STATE = 'retired',
) => {
  const requests: RecordedRequest[] = [];
  const proofRequests: RecordedRequest[] = [];
  const statements: string[] = [];
  const transactionStatements: string[] = [];
  const events: string[] = [];
  const client = HttpClient.make((request, destination) => {
    const recorded = {
      authorization: request.headers.authorization,
      body: Match.value(request.body).pipe(
        Match.tag('Uint8Array', (bytes) => new TextDecoder().decode(bytes.body)),
        Match.orElse(() => ''),
      ),
      cacheControl: request.headers['cache-control'],
      contentType: request.headers['content-type'],
      method: request.method,
      url: destination.href,
    };
    events.push(`${recorded.method} ${recorded.url}`);
    if (destination.pathname === `/api/rest/public/service-stack/${LEGACY_NODE_SERVICE_ID}`) {
      proofRequests.push(recorded);
      const proofAnswer =
        oldRuntime === NODE_ACTIVE_STATE || oldRuntime === NODE_STOPPED_STATE
          ? Response.json({
              name: LEGACY_NODE_SERVICE_ID,
              status: oldRuntime === NODE_ACTIVE_STATE ? 'ACTIVE' : 'STOPPED',
              subdomainAccess: false,
            })
          : Response.json({ error: { code: 'serviceStackNotFound' } }, { status: 400 });
      return Effect.succeed(HttpClientResponse.fromWeb(request, proofAnswer));
    }
    if (destination.pathname === `/client/v4/accounts/${CUTOVER_ACCOUNT_ID}/workers/scripts/${LEGACY_WORKER_NAME}`) {
      proofRequests.push(recorded);
      const proofAnswer =
        oldRuntime === WORKER_ACTIVE_STATE
          ? Response.json({ success: true })
          : Response.json({ errors: [{ code: 10_007 }], success: false }, { status: 404 });
      return Effect.succeed(HttpClientResponse.fromWeb(request, proofAnswer));
    }
    requests.push(recorded);
    return Effect.succeed(HttpClientResponse.fromWeb(request, answer(recorded, requests.length - 1)));
  });
  const layer = Layer.mergeAll(
    NodeServices.layer,
    Layer.succeed(HttpClient.HttpClient, client),
    ZeropsPublicApiLive.pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, client))),
    Layer.effect(
      CoreDatabase,
      makeTestDatabase((sql) =>
        Effect.sync(() => {
          statements.push(sql);
          if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
            transactionStatements.push(sql);
          }
          events.push(sql);
          if (sql === PUBLICATION_UNLOCK_SQL) {
            return [{ unlocked: true }];
          }
          if (sql.includes('as isolation')) {
            return [{ isolation: 'read committed' }];
          }
          if (sql.includes('as blocked')) {
            return [{ blocked: false }];
          }
          return sql.includes('as unexpired') ? [{ unexpired: authorityUnexpired }] : [];
        }),
      ).pipe(Effect.map((executor) => ({ executor }))),
    ),
    ConfigProvider.layer(
      ConfigProvider.fromUnknown({
        [ACTIVE_APPLICATION_COMPOSITION_POLICY.sourceUrlVariable]: url,
        CLOUDFLARE_API_TOKEN: TOKEN,
        ZEROPS_TOKEN: 'zerops-test-token',
      }),
    ),
  );
  return { events, layer, proofRequests, requests, statements, transactionStatements };
};

const candidateObservation = Effect.gen(function* nativeCandidateObservationFixture() {
  yield* TestClock.setTime(Date.parse('2026-10-02T16:02:00.000Z'));
  const module = yield* deployedModule('catalog', CATALOG_MODULE_ID);
  const shell = yield* shellArtifacts(SHELL_BUILD_MARKER);
  const snapshot = yield* deriveActiveApplicationCompositionSnapshot({
    environment: 'stage',
    modules: [module],
    observedAt: yield* DateTime.now,
    shell,
    validity: ACTIVE_APPLICATION_COMPOSITION_POLICY.validity,
  });
  const candidate = {
    modules: [{ appId: module.appId, backend: module.backend, contractUrl: module.contract.url }],
    shell: {
      deployment: snapshot.composition.shell.deployment,
      federationManifest: snapshot.composition.shell.federationManifest,
      runtimeContract: snapshot.composition.shell.runtimeContract,
    },
  };
  const workersApi = `https://api.cloudflare.com/client/v4/accounts/${'a'.repeat(32)}/workers`;
  const scriptApi = `${workersApi}/scripts/${module.backend.workerName}`;
  const backendDocuments = new Map<string, unknown>([
    [`${workersApi}/subdomain`, { result: { subdomain: WORKER_ACCOUNT_SUBDOMAIN }, success: true }],
    [`${scriptApi}/subdomain`, { result: { enabled: true }, success: true }],
    [
      `${scriptApi}/deployments`,
      {
        result: { deployments: [{ versions: [{ percentage: 100, version_id: module.backend.versionId }] }] },
        success: true,
      },
    ],
    [`${scriptApi}/versions/${module.backend.versionId}`, { result: { id: module.backend.versionId }, success: true }],
  ]);
  return {
    backendUrls: [...backendDocuments.keys()],
    candidate,
    makeProvider: (unmatched?: (request: RecordedRequest) => Response) =>
      provider((request) => {
        if (backendDocuments.has(request.url)) {
          return Response.json(backendDocuments.get(request.url));
        }
        const observedArtifact = [module.contract, shell.runtimeContract, shell.federationManifest].find(
          ({ url }) => url === request.url,
        );
        return observedArtifact === undefined
          ? (unmatched?.(request) ?? new Response(null, { status: 404 }))
          : new Response(observedArtifact.bytes);
      }),
    snapshot,
  };
});

it.effect('observes the declared retained Shell pins with complete module artifacts and its native backend', () =>
  Effect.gen(function* observesPinnedCandidate() {
    const fixture = yield* candidateObservation;
    const candidate = yield* Schema.decodeUnknownEffect(ApplicationCompositionPublicationCandidateSchema, {
      onExcessProperty: 'error',
    })(fixture.candidate);
    const { layer, proofRequests, requests, statements } = fixture.makeProvider();

    const observed = yield* observeCandidate('stage', candidate).pipe(Effect.provide(layer));

    expect(observed).toEqual(fixture.snapshot);
    expect(observed.composition.modules.map(({ moduleId }) => moduleId)).toEqual([CATALOG_MODULE_ID]);
    expect(requests).toHaveLength(7);
    expect(new Set(requests.map(({ url }) => url))).toEqual(
      new Set([
        ...fixture.backendUrls,
        candidate.modules[0]?.contractUrl,
        candidate.shell.federationManifest.url,
        candidate.shell.runtimeContract.url,
      ]),
    );
    expect(requests.every(({ cacheControl, method }) => method === 'GET' && cacheControl === 'no-cache')).toBe(true);
    expect(
      requests
        .filter(({ url }) => fixture.backendUrls.includes(url))
        .every(({ authorization }) => authorization === `Bearer ${TOKEN}`),
    ).toBe(true);
    expect(
      requests
        .filter(({ url }) => !fixture.backendUrls.includes(url))
        .every(({ authorization }) => authorization === undefined),
    ).toBe(true);
    expect(proofRequests).toEqual([]);
    expect(statements).toEqual([]);
  }),
);

it.effect(
  'observes all four native Worker receipt endpoints and pinned artifacts before publishing the exact bundle',
  () =>
    Effect.gen(function* observesBeforePublication() {
      const fixture = yield* candidateObservation;
      const candidate = yield* Schema.decodeUnknownEffect(ApplicationCompositionPublicationCandidateSchema, {
        onExcessProperty: 'error',
      })(fixture.candidate);
      const encoded = yield* encodeActiveApplicationCompositionSnapshot(fixture.snapshot);
      let uploaded = false;
      const { events, layer, requests } = fixture.makeProvider((request) => {
        if (request.url !== KV_URL) {
          return new Response(null, { status: 404 });
        }
        if (request.method === 'PUT') {
          uploaded = true;
          return Response.json({ success: true });
        }
        return uploaded ? new Response(encoded) : new Response(null, { status: 404 });
      });
      const observed = yield* observeCandidate('stage', candidate).pipe(Effect.provide(layer));
      expect(yield* publishSnapshot(observed, Option.none(), initialCutoverProof).pipe(Effect.provide(layer))).toEqual(
        fixture.snapshot,
      );
      const write = events.indexOf(`PUT ${KV_URL}`);
      expect(write).toBeGreaterThan(0);
      for (const url of [
        ...fixture.backendUrls,
        candidate.modules[0]?.contractUrl,
        candidate.shell.federationManifest.url,
        candidate.shell.runtimeContract.url,
      ]) {
        const read = events.indexOf(`GET ${url ?? ''}`);
        expect(read).toBeGreaterThanOrEqual(0);
        expect(read).toBeLessThan(write);
      }
      expect(requests.filter(({ url }) => url === KV_URL).map(({ method }) => method)).toEqual(['GET', 'PUT', 'GET']);
    }),
);

it.effect('rejects changed approved Shell digests or identity after independently observing valid artifacts', () =>
  Effect.gen(function* rejectsChangedCandidatePins() {
    const fixture = yield* candidateObservation;
    const { shell } = fixture.candidate;
    const changedShells = [
      { ...shell, runtimeContract: { ...shell.runtimeContract, sha256: '0'.repeat(64) } },
      { ...shell, federationManifest: { ...shell.federationManifest, sha256: '0'.repeat(64) } },
      { ...shell, deployment: { ...shell.deployment, buildMarker: 'other-shell-immutable-build' } },
    ];
    for (const changedShell of changedShells) {
      const candidate = yield* Schema.decodeUnknownEffect(ApplicationCompositionPublicationCandidateSchema, {
        onExcessProperty: 'error',
      })({ ...fixture.candidate, shell: changedShell });
      const { layer, proofRequests, requests, statements } = fixture.makeProvider();
      const failure = yield* observeCandidate('stage', candidate).pipe(Effect.provide(layer), Effect.flip);

      expect(Schema.is(ActiveApplicationCompositionPublicationError)(failure)).toBe(true);
      expect(failure).toMatchObject({
        message: 'observed Shell artifacts differ from the exact approved candidate deployment or digests',
        reason: 'invalid_observation',
      });
      expect(requests).toHaveLength(7);
      expect(requests.every(({ method }) => method === 'GET')).toBe(true);
      expect(proofRequests).toEqual([]);
      expect(statements).toEqual([]);
    }
  }),
);

it.effect(
  'requires an explicit Shell deployment and both exact artifact digests in a strict publication candidate',
  () =>
    Effect.gen(function* rejectsUrlOnlyCandidate() {
      const { candidate } = yield* candidateObservation;
      const { shell } = candidate;
      const invalidShells = [
        { federationManifestUrl: shell.federationManifest.url, runtimeContractUrl: shell.runtimeContract.url },
        { federationManifest: shell.federationManifest, runtimeContract: shell.runtimeContract },
        { ...shell, runtimeContract: { url: shell.runtimeContract.url } },
        { ...shell, federationManifest: { url: shell.federationManifest.url } },
        { ...shell, deployment: { ...shell.deployment, appId: 'catalog' } },
        { ...shell, runtimeContractUrl: shell.runtimeContract.url },
      ];
      for (const invalidShell of invalidShells) {
        yield* Schema.decodeUnknownEffect(ApplicationCompositionPublicationCandidateSchema, {
          onExcessProperty: 'error',
        })({ ...candidate, shell: invalidShell }).pipe(Effect.flip);
      }
    }),
);

it.effect('retains the exact approved Shell while publishing a changed complete module inventory', () =>
  Effect.gen(function* publishesRetainedShell() {
    const previous = yield* snapshotAt(OBSERVED_AT);
    const { candidate: observedCandidate, snapshot } = yield* candidateObservation;
    const candidate = yield* Schema.decodeUnknownEffect(ApplicationCompositionPublicationCandidateSchema, {
      onExcessProperty: 'error',
    })({ ...observedCandidate, retainedShellRevision: previous.composition.revision });
    const previousEncoded = yield* encodeActiveApplicationCompositionSnapshot(previous);
    const encoded = yield* encodeActiveApplicationCompositionSnapshot(snapshot);
    const { layer, requests } = provider((request, index) =>
      request.method === 'PUT'
        ? Response.json({ success: true })
        : new Response(index === 0 ? previousEncoded : encoded),
    );

    const published = yield* publishSnapshot(
      snapshot,
      Option.none(),
      initialCutoverProof,
      candidate.retainedShellRevision,
    ).pipe(Effect.provide(layer));

    expect(candidate.retainedShellRevision).toBe(previous.composition.revision);
    expect(snapshot.composition.revision).not.toBe(previous.composition.revision);
    expect(published.composition.shell).toEqual(previous.composition.shell);
    expect(published).toEqual(snapshot);
    expect(requests.map(({ method }) => method)).toEqual(['GET', 'PUT', 'GET']);
    expect(requests[1]?.body).toBe(encoded);
  }),
);

it.effect('refuses a retained Shell publication when its approved release disappeared or changed', () =>
  Effect.gen(function* rejectsChangedRetainedShell() {
    const previous = yield* snapshotAt(OBSERVED_AT);
    const { snapshot } = yield* candidateObservation;
    const changedShellSnapshot = yield* deriveActiveApplicationCompositionSnapshot({
      environment: 'stage',
      modules: [yield* deployedModule('catalog', CATALOG_MODULE_ID)],
      observedAt: yield* DateTime.now,
      shell: yield* shellArtifacts('other-shell-immutable-build'),
      validity: ACTIVE_APPLICATION_COMPOSITION_POLICY.validity,
    });
    const previousEncoded = yield* encodeActiveApplicationCompositionSnapshot(previous);
    const cases = [
      { current: null, retainedRevision: previous.composition.revision, snapshot },
      { current: previousEncoded, retainedRevision: 'other-approved-revision', snapshot },
      { current: previousEncoded, retainedRevision: previous.composition.revision, snapshot: changedShellSnapshot },
    ];
    for (const scenario of cases) {
      const { layer, requests, transactionStatements } = provider(() =>
        scenario.current === null ? new Response(null, { status: 404 }) : new Response(scenario.current),
      );
      const failure = yield* publishSnapshot(
        scenario.snapshot,
        Option.none(),
        initialCutoverProof,
        scenario.retainedRevision,
      ).pipe(Effect.provide(layer), Effect.flip);

      expect(Schema.is(ActiveApplicationCompositionPublicationError)(failure)).toBe(true);
      expect(failure).toMatchObject({ reason: 'publication_failed' });
      expect(requests.map(({ method }) => method)).toEqual(['GET']);
      expect(transactionStatements.at(-1)).toBe('ROLLBACK');
    }
  }),
);

it.effect('publishes and reads back the exact complete bundle through native KV with the publication credential', () =>
  Effect.gen(function* publishesCompleteBundle() {
    const snapshot = yield* snapshotAt(OBSERVED_AT);
    const encoded = yield* encodeActiveApplicationCompositionSnapshot(snapshot);
    const { events, layer, proofRequests, requests, statements } = provider((request, index) => {
      if (request.method === 'PUT') {
        return Response.json({ success: true });
      }
      return index === 0 ? new Response(null, { status: 404 }) : new Response(encoded);
    });

    const published = yield* publishSnapshot(snapshot, Option.none(), initialCutoverProof).pipe(Effect.provide(layer));

    expect(published).toEqual(snapshot);
    expect(proofRequests).toHaveLength(2);
    expect(proofRequests.map(({ method }) => method)).toEqual(['GET', 'GET']);
    expect(events.lastIndexOf('COMMIT')).toBeGreaterThan(events.indexOf(`GET ${proofRequests[0]?.url ?? ''}`));
    expect(events.findIndex((event) => event.includes(`/workers/scripts/${LEGACY_WORKER_NAME}`))).toBeLessThan(
      events.indexOf(`PUT ${KV_URL}`),
    );
    expect(requests.map(({ method }) => method)).toEqual(['GET', 'PUT', 'GET']);
    expect(requests.every(({ authorization, url }) => authorization === `Bearer ${TOKEN}` && url === KV_URL)).toBe(
      true,
    );
    expect(requests[1]?.contentType).toBe('application/octet-stream');
    expect(requests[1]?.body).toBe(encoded);
    expect(snapshot.composition.modules.map(({ moduleId }) => moduleId)).toEqual([
      CATALOG_MODULE_ID,
      'inventory.stock',
    ]);
    expect(statements.some((statement) => statement.includes('pg_advisory_xact_lock'))).toBe(true);
    expect(
      statements.some((statement) => statement.startsWith('insert into "core"."application_composition_authority"')),
    ).toBe(true);
    expect(events.lastIndexOf('COMMIT')).toBeGreaterThan(events.indexOf(`GET ${KV_URL}`));
    expect(events.lastIndexOf('COMMIT')).toBeGreaterThan(events.indexOf(`PUT ${KV_URL}`));
    const publicationLock = events.indexOf(PUBLICATION_LOCK_SQL);
    expect(publicationLock).toBeGreaterThanOrEqual(0);
    expect(publicationLock).toBeLessThan(events.indexOf(`GET ${KV_URL}`));
    expect(events.indexOf('BEGIN')).toBeGreaterThan(publicationLock);
    expect(events.indexOf(PUBLICATION_UNLOCK_SQL)).toBeGreaterThan(events.lastIndexOf('COMMIT'));
    expect(statements.filter((statement) => ['BEGIN', 'COMMIT', 'ROLLBACK'].includes(statement))).toEqual([
      'BEGIN',
      'COMMIT',
    ]);
    expect(statements.at(-1)).toBe(PUBLICATION_UNLOCK_SQL);
  }),
);

it.effect('refuses initial publication until every old Node service and Worker is absent', () =>
  Effect.gen(function* rejectsUnquiescedInitialCutover() {
    const snapshot = yield* snapshotAt(OBSERVED_AT);
    const states = [NODE_ACTIVE_STATE, NODE_STOPPED_STATE, WORKER_ACTIVE_STATE] as const;
    for (const state of states) {
      const { layer, proofRequests, requests, statements } = provider(
        () => new Response(null, { status: 404 }),
        KV_URL,
        true,
        state,
      );
      const failure = yield* publishSnapshot(snapshot, Option.none(), initialCutoverProof).pipe(
        Effect.provide(layer),
        Effect.flip,
      );
      expect(Schema.is(InitialCutoverProviderError)(failure)).toBe(true);
      expect(proofRequests.length).toBeGreaterThan(0);
      expect(requests).toEqual([]);
      expect(statements.filter((statement) => ['BEGIN', 'COMMIT', 'ROLLBACK'].includes(statement))).toEqual([]);
      expect(statements.at(-1)).toBe(PUBLICATION_UNLOCK_SQL);
      expect(
        statements.some((statement) => statement.startsWith('insert into "core"."application_composition_authority"')),
      ).toBe(false);
    }
  }),
);

it.effect('does not acknowledge a rejected, malformed, failed, or redirected provider write', () =>
  Effect.gen(function* rejectsFailedWrites() {
    const snapshot = yield* snapshotAt(OBSERVED_AT);
    const answers = [
      () => Response.json({ success: false }),
      () => Response.json({ errors: [{ message: 'write refused' }] }),
      () => Response.json({ success: true }, { status: 503 }),
      () => new Response(null, { headers: { location: 'https://other.example' }, status: 307 }),
    ];
    for (const answer of answers) {
      const { events, layer, requests, statements, transactionStatements } = provider((request) =>
        request.method === 'GET' ? new Response(null, { status: 404 }) : answer(),
      );
      const failure = yield* publishSnapshot(snapshot, Option.none(), initialCutoverProof).pipe(
        Effect.provide(layer),
        Effect.flip,
      );
      expect(Schema.is(ActiveApplicationCompositionPublicationError)(failure)).toBe(true);
      expect(requests.map(({ method }) => method)).toEqual(['GET', 'PUT']);
      expect(transactionStatements.at(-1)).toBe('ROLLBACK');
      expect(statements.at(-1)).toBe(PUBLICATION_UNLOCK_SQL);
      expect(events.lastIndexOf('ROLLBACK')).toBeGreaterThan(events.indexOf(`PUT ${KV_URL}`));
    }
  }),
);

it.effect('keeps the admitted bundle private when its caller mutates membership during publication', () =>
  Effect.gen(function* preservesPrivatePublicationSnapshot() {
    const snapshot = yield* snapshotAt(OBSERVED_AT);
    const encoded = yield* encodeActiveApplicationCompositionSnapshot(snapshot);
    const input = {
      ...snapshot,
      composition: { ...snapshot.composition, modules: [...snapshot.composition.modules] },
    };
    const { layer, requests } = provider((request, index) => {
      if (index === 0) {
        input.composition.modules.splice(0);
      }
      if (request.method === 'PUT') {
        return Response.json({ success: true });
      }
      return index === 0 ? new Response(null, { status: 404 }) : new Response(encoded);
    });

    const published = yield* publishSnapshot(input, Option.none(), initialCutoverProof).pipe(Effect.provide(layer));

    expect(input.composition.modules).toHaveLength(0);
    expect(published.composition).toEqual(snapshot.composition);
    expect(published.composition.modules).toHaveLength(2);
    expect(requests[1]?.body).toBe(encoded);
    expect(Object.isFrozen(published)).toBe(true);
    expect(Object.isFrozen(published.composition.modules)).toBe(true);
  }),
);

it.effect('rolls back rejected database authority and never writes the publication pointer', () =>
  Effect.gen(function* rejectsInvalidAuthorityBeforePointerWrite() {
    const snapshot = yield* snapshotAt(OBSERVED_AT);
    const { events, layer, requests, statements, transactionStatements } = provider(
      () => new Response(null, { status: 404 }),
      KV_URL,
      false,
    );
    const failure = yield* publishSnapshot(snapshot, Option.none(), initialCutoverProof).pipe(
      Effect.provide(layer),
      Effect.flip,
    );

    expect(Schema.is(ApplicationCompositionAuthorityError)(failure)).toBe(true);
    expect(requests).toEqual([]);
    expect(transactionStatements.at(-1)).toBe('ROLLBACK');
    expect(statements.at(-1)).toBe(PUBLICATION_UNLOCK_SQL);
    expect(events).not.toContain(`PUT ${KV_URL}`);
  }),
);

it.effect('accepts a missing initial value but fails closed on every other unsuccessful provider read', () =>
  Effect.gen(function* distinguishesAbsentFromUnavailable() {
    const absent = provider(() => new Response(null, { status: 404 }));
    expect(Option.isNone(yield* readPublishedSnapshot.pipe(Effect.provide(absent.layer)))).toBe(true);

    for (const status of [204, 301, 403, 429, 503]) {
      const { layer, requests } = provider(() => new Response(null, { status }));
      const failure = yield* readPublishedSnapshot.pipe(Effect.provide(layer), Effect.flip);
      expect(failure).toMatchObject({ reason: 'publication_failed' });
      expect(requests.map(({ method }) => method)).toEqual(['GET']);
    }
  }),
);

it.effect('rejects an older observation before it can overwrite the complete published bundle', () =>
  Effect.gen(function* rejectsStalePublication() {
    const older = yield* snapshotAt(OBSERVED_AT);
    const newer = yield* snapshotAt('2026-10-02T16:01:00.000Z');
    const encoded = yield* encodeActiveApplicationCompositionSnapshot(newer);
    const { layer, requests, statements, transactionStatements } = provider(() => new Response(encoded));
    const failure = yield* publishSnapshot(older, Option.none(), initialCutoverProof).pipe(
      Effect.provide(layer),
      Effect.flip,
    );

    expect(Schema.is(ActiveApplicationCompositionPublicationError)(failure)).toBe(true);
    expect(failure).toMatchObject({ reason: 'stale_observation' });
    expect(requests.map(({ method }) => method)).toEqual(['GET']);
    expect(transactionStatements.at(-1)).toBe('ROLLBACK');
    expect(statements.at(-1)).toBe(PUBLICATION_UNLOCK_SQL);
  }),
);

it.effect('renews expired authority without changing release identity or dropping any installed module', () =>
  Effect.gen(function* renewsCompleteBundle() {
    const expired = yield* snapshotAt('2026-09-29T16:00:00.000Z');
    const renewed = yield* snapshotAt(OBSERVED_AT);
    const previous = yield* encodeActiveApplicationCompositionSnapshot(expired);
    const next = yield* encodeActiveApplicationCompositionSnapshot(renewed);
    const { layer, requests } = provider((request, index) => {
      if (request.method === 'PUT') {
        return Response.json({ success: true });
      }
      return new Response(index === 0 ? previous : next);
    });

    const published = yield* publishSnapshot(renewed, Option.none(), initialCutoverProof).pipe(Effect.provide(layer));

    expect(published.composition).toEqual(expired.composition);
    expect(published.validUntil).toEqual(renewed.validUntil);
    expect(requests[1]?.body).toBe(next);
    expect(requests.map(({ method }) => method)).toEqual(['GET', 'PUT', 'GET']);
  }),
);

it.effect('repairs an undecodable stored value only by publishing and reading back a complete validated bundle', () =>
  Effect.gen(function* repairsInvalidAuthority() {
    const snapshot = yield* snapshotAt(OBSERVED_AT);
    const encoded = yield* encodeActiveApplicationCompositionSnapshot(snapshot);
    const { layer, requests } = provider((request, index) => {
      if (request.method === 'PUT') {
        return Response.json({ success: true });
      }
      return new Response(index === 0 ? 'corrupt publication' : encoded);
    });

    const published = yield* publishSnapshot(snapshot, Option.none(), initialCutoverProof).pipe(Effect.provide(layer));

    expect(published).toEqual(snapshot);
    expect(requests[1]?.body).toBe(encoded);
    expect(requests.map(({ method }) => method)).toEqual(['GET', 'PUT', 'GET']);
  }),
);

it.effect('rejects an invalid member without publishing a reduced inventory or touching provider storage', () =>
  Effect.gen(function* rejectsIncompleteBundle() {
    const snapshot = yield* snapshotAt(OBSERVED_AT);
    const invalid = {
      ...snapshot,
      composition: {
        ...snapshot.composition,
        modules: snapshot.composition.modules.map((module, index) =>
          index === 1 ? { ...module, contractDocument: '{}' } : module,
        ),
      },
    };
    const { layer, requests } = provider(() => Response.json({ success: true }));
    const failure = yield* publishSnapshot(invalid, Option.none(), initialCutoverProof).pipe(
      Effect.provide(layer),
      Effect.flip,
    );

    expect(Schema.is(ActiveApplicationCompositionPublicationError)(failure)).toBe(true);
    expect(failure).toMatchObject({ reason: 'invalid_observation' });
    expect(requests).toEqual([]);
  }),
);

it.effect('rejects a schema-valid release that points at a mutable artifact URL before publication', () =>
  Effect.gen(function* rejectsMutableReleaseArtifact() {
    const snapshot = yield* snapshotAt(OBSERVED_AT);
    const candidate = {
      ...snapshot.composition,
      modules: snapshot.composition.modules.map((module, index) =>
        index === 0
          ? {
              ...module,
              contract: { ...module.contract, url: 'https://catalog.example/.well-known/ontos-module-manifest.json' },
            }
          : module,
      ),
    };
    const mutable = {
      ...snapshot,
      composition: { ...candidate, revision: applicationCompositionRevision(candidate) },
    };
    const { layer, requests } = provider(() => new Response(null, { status: 404 }));
    const failure = yield* publishSnapshot(mutable, Option.none(), initialCutoverProof).pipe(
      Effect.provide(layer),
      Effect.flip,
    );

    expect(Schema.is(ActiveApplicationCompositionPublicationError)(failure)).toBe(true);
    expect(failure).toMatchObject({ reason: 'invalid_observation' });
    expect(requests).toEqual([]);
  }),
);

it.effect('rejects schema-valid mutable or mismatched Shell artifact origins before authority or provider access', () =>
  Effect.gen(function* rejectsMutableShellArtifacts() {
    const snapshot = yield* snapshotAt(OBSERVED_AT);
    const shells = [
      {
        ...snapshot.composition.shell,
        federationManifest: {
          ...snapshot.composition.shell.federationManifest,
          url: 'https://shell.example/mf-manifest.json',
        },
        runtimeContract: {
          ...snapshot.composition.shell.runtimeContract,
          url: 'https://shell.example/.well-known/ontos-shell-runtime.json',
        },
      },
      {
        ...snapshot.composition.shell,
        federationManifest: {
          ...snapshot.composition.shell.federationManifest,
          url: snapshot.composition.shell.federationManifest.url.replace('.test-account.', '.other-account.'),
        },
      },
    ];
    for (const shell of shells) {
      const candidate = { ...snapshot.composition, shell };
      const mutable = {
        ...snapshot,
        composition: { ...candidate, revision: applicationCompositionRevision(candidate) },
      };
      const valid = yield* validateActiveApplicationCompositionSnapshot(mutable);
      expect(valid.composition.shell).toEqual(shell);
      const { layer, proofRequests, requests, statements } = provider(() => new Response(null, { status: 404 }));
      const failure = yield* publishSnapshot(mutable, Option.none(), initialCutoverProof).pipe(
        Effect.provide(layer),
        Effect.flip,
      );

      expect(Schema.is(ActiveApplicationCompositionPublicationError)(failure)).toBe(true);
      expect(failure).toMatchObject({
        message: 'Shell artifacts must use their retained native release Worker',
        reason: 'invalid_observation',
      });
      expect(proofRequests).toEqual([]);
      expect(requests).toEqual([]);
      expect(statements).toEqual([]);
    }
  }),
);

it.effect('never sends publication credentials to a non-native or ambiguous destination', () =>
  Effect.gen(function* rejectsUntrustedDestinations() {
    const destinations = [
      'https://other.example/client/v4/accounts/a/storage/kv/namespaces/b/values/active',
      KV_URL.replace('https:', 'http:'),
      KV_URL.replace('https://', 'https://user@'),
      `${KV_URL}?redirect=other`,
      `${KV_URL}#fragment`,
      KV_URL.replace('/values/active', '/values/active/other'),
    ];
    for (const destination of destinations) {
      const { layer, requests } = provider(() => new Response(null, { status: 404 }), destination);
      const failure = yield* readPublishedSnapshot.pipe(Effect.provide(layer), Effect.flip);
      expect(failure).toMatchObject({ reason: 'invalid_observation' });
      expect(requests).toEqual([]);
    }
    const native = provider(() => new Response(null, { status: 404 }));
    expect(yield* publicationUrl.pipe(Effect.provide(native.layer))).toBe(KV_URL);
  }),
);

it.effect('observes exact artifact bytes without leaking the publication credential to the module', () =>
  Effect.gen(function* observesExactArtifactBytes() {
    const bytes = Uint8Array.of(0xef, 0xbb, 0xbf, 0x7b, 0x7d, 0x0a);
    const url = 'https://catalog.example/releases/catalog-immutable-build/.well-known/ontos-module-manifest.json';
    const { layer, requests } = provider(() => new Response(bytes));
    const observed = yield* fetchArtifact('catalog', url).pipe(Effect.provide(layer));

    expect(observed).toEqual({ bytes, url });
    expect(requests.map(({ method }) => method)).toEqual(['GET']);
    expect(requests[0]?.authorization).toBeUndefined();
  }),
);

it.effect(
  'stops oversized streamed artifacts and rejects redirect responses before accepting any deployment evidence',
  () =>
    Effect.gen(function* rejectsUnboundedArtifactObservation() {
      const url = 'https://catalog.example/releases/catalog-immutable-build/.well-known/ontos-module-manifest.json';
      const answers = [
        () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new Uint8Array(ONTOS_MODULE_CONTRACT_MAX_BYTES));
                controller.enqueue(Uint8Array.of(1));
                controller.close();
              },
            }),
          ),
        () => new Response(null, { headers: { location: 'https://other.example' }, status: 302 }),
      ];
      for (const answer of answers) {
        const { layer, requests } = provider(answer);
        const failure = yield* fetchArtifact('catalog', url).pipe(Effect.provide(layer), Effect.flip);
        expect(Schema.is(ActiveApplicationCompositionObservationError)(failure)).toBe(true);
        expect(requests).toHaveLength(1);
      }
    }),
);
