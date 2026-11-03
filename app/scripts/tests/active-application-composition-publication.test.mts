import { createHash } from 'node:crypto';

import { NodeServices } from '@effect/platform-node';
import {
  Array as EffectArray,
  ConfigProvider,
  DateTime,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Match,
  Option,
  Order,
  Schema,
} from 'effect';
import { TestClock } from 'effect/testing';
import { expect, it } from 'effect-rstest';
import { HttpClient, HttpClientError, HttpClientResponse } from 'effect/http';

import { governedSharedSingletonPackages } from '../../module-federation.shared.ts';
import { CoreDatabase } from '../../packages/core-runtime/src/db/client.ts';
import { ApplicationCompositionAuthorityError } from '../../packages/core-runtime/src/modules/application-composition-authority.ts';
import {
  moduleReleaseAssetWorkerName,
  moduleReleaseWorkerName,
} from '../../packages/core-runtime/src/http/module-release-identity.ts';
import {
  ONTOS_MODULE_CONTRACT_MAX_BYTES,
  ActiveApplicationCompositionUnavailableError,
  OntosModuleDeploymentContractSchema,
  defineTenantModuleEntrypoint,
  validateActiveApplicationCompositionSnapshot,
} from '../../packages/core-runtime/src/index.ts';
import type { ActiveApplicationCompositionSnapshot } from '../../packages/core-runtime/src/index.ts';
import {
  ApplicationCompositionBackendSchema,
  ApplicationCompositionCloudflareWorkerBackendSchema,
} from '../../packages/core-runtime/src/modules/application-composition.ts';
import { makeTestDatabase } from '../../packages/core-runtime/tests/support/database.ts';
import {
  ACTIVE_APPLICATION_COMPOSITION_POLICY,
  ARTIFACT_FETCH_TIMEOUT,
  ActiveApplicationCompositionPublicationError,
  applicationCompositionRevision,
  deriveActiveApplicationCompositionSnapshot,
  encodeActiveApplicationCompositionSnapshot,
} from '../active-application-composition.mts';
import type { ObservedArtifact } from '../active-application-composition.mts';
import { createShellRuntimeContract } from '../generate-ontos-shell-runtime-contract.mts';
import {
  InitialCutoverProviderError,
  verifyInitialCutoverProviderInventory,
} from '../initial-composition-cutover-provider.mts';
import {
  ActiveApplicationCompositionObservationError,
  ApplicationCompositionPublicationCandidateSchema,
  captureApprovedApplicationCompositionSnapshot,
  fetchArtifact,
  observeCandidate,
  publicationUrl,
  prepareCandidate,
  publishSnapshot,
  readPublishedSnapshot,
  refreshApplicationComposition,
  stageBackendUrl,
  validateExpectedApplicationComposition,
} from '../publish-active-application-composition.mts';
import { selectApplicationReleaseUnits } from '../application-release-intent.mts';
import { ZeropsPublicApiLive } from '../zerops-public-api.mts';
import { legacyCompletionPublicationFixture } from './support/legacy-completion-publication.mts';

const KV_URL = `https://api.cloudflare.com/client/v4/accounts/${'a'.repeat(32)}/storage/kv/namespaces/${'b'.repeat(32)}/values/active`;
const PUBLICATION_LOCK_SQL =
  "select pg_advisory_lock(hashtextextended('ontos.application-composition-publication', 0))";
const PUBLICATION_UNLOCK_SQL =
  "select pg_advisory_unlock(hashtextextended('ontos.application-composition-publication', 0))";
const TOKEN = 'publication-test-token';
const LEGACY_NODE_SERVICE_ID = 'legacy-node-service';
const LEGACY_WORKER_NAME = 'legacy-worker';
const CUTOVER_ACCOUNT_ID = 'a'.repeat(32);
const CUTOVER_NAMESPACE_ID = 'b'.repeat(32);
const CUTOVER_NAMESPACE_PATH = `/client/v4/accounts/${CUTOVER_ACCOUNT_ID}/storage/kv/namespaces/${CUTOVER_NAMESPACE_ID}`;
const NODE_ACTIVE_STATE = 'node-active';
const NODE_STOPPED_STATE = 'node-stopped';
const WORKER_ACTIVE_STATE = 'worker-active';
const SHELL_BUILD_MARKER = 'shell-immutable-build';
const WORKER_VERSION_ID = 'c302ec41-290b-4d31-8105-5c3467008799';
const WORKER_ACCOUNT_SUBDOMAIN = 'test-account';
const CATALOG_MODULE_ID = 'catalog.products';
const INVENTORY_MODULE_ID = 'inventory.stock';
const PUBLICATION_TIME = '2026-10-02T16:02:00.000Z';
const AUTHORITY_INSERT_SQL = 'insert into "core"."application_composition_authority"';
const initialCutoverProof = verifyInitialCutoverProviderInventory({
  cloudflare: {
    accountId: CUTOVER_ACCOUNT_ID,
    compositionPointer: {
      namespaceId: CUTOVER_NAMESPACE_ID,
      sha256: createHash('sha256').update('obsolete publication fixture pointer').digest('hex'),
    },
    workerNames: [LEGACY_WORKER_NAME],
  },
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

const deployedModule = (appId: string, moduleId: string, buildMarker = `${appId}-immutable-build`) =>
  Effect.gen(function* deployedTestModule() {
    const worker = yield* moduleReleaseAssetWorkerName(appId, buildMarker);
    const workerName = yield* moduleReleaseWorkerName(appId, buildMarker);
    return {
      appId,
      backend: yield* Schema.decodeUnknownEffect(ApplicationCompositionCloudflareWorkerBackendSchema)({
        baseUrl: `https://${workerName}.${WORKER_ACCOUNT_SUBDOMAIN}.workers.dev/`,
        transport: 'cloudflare-worker',
        versionId: WORKER_VERSION_ID,
        workerName,
      }),
      contract: artifact(`https://${worker}.test-account.workers.dev/.well-known/ontos-module-manifest.json`, {
        deployment: { appId, buildMarker },
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
    yield* TestClock.setTime(Date.parse(PUBLICATION_TIME));
    return yield* deriveActiveApplicationCompositionSnapshot({
      environment: 'stage',
      modules: yield* Effect.all([
        deployedModule('catalog', CATALOG_MODULE_ID),
        deployedModule('inventory', INVENTORY_MODULE_ID),
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
interface ProviderOptions {
  readonly authorityTable?: 'present' | 'absent' | 'unavailable';
  readonly transportUnavailable?: boolean;
}

const provider = (
  answer: (request: RecordedRequest, index: number) => Response,
  url = KV_URL,
  authorityUnexpired = true,
  oldRuntime: 'retired' | typeof NODE_ACTIVE_STATE | typeof NODE_STOPPED_STATE | typeof WORKER_ACTIVE_STATE = 'retired',
  currentSnapshot?: ActiveApplicationCompositionSnapshot,
  currentPhase: 'active' | 'draining' | 'sealed' | 'migrated' = 'active',
  options: ProviderOptions = {},
) => {
  const requests: RecordedRequest[] = [];
  const proofRequests: RecordedRequest[] = [];
  let awaitingCutoverPointer = false;
  const statements: string[] = [];
  const transactionStatements: string[] = [];
  const events: string[] = [];
  const legacy = legacyCompletionPublicationFixture(events);
  let authority =
    currentSnapshot === undefined
      ? undefined
      : {
          authorityKey: 'active',
          durableWorkAdmission: 'closed',
          phase: currentPhase,
          revision: currentSnapshot.composition.revision,
          subscriptionsJson: [],
          updatedAt: DateTime.toDateUtc(currentSnapshot.observedAt),
          validUntil: DateTime.toDateUtc(currentSnapshot.validUntil),
        };
  let pendingValidUntil: Date | null = null;
  const authorityWrites: (readonly unknown[])[] = [];
  const projectAuthority = (statement: string) => {
    if (authority === undefined) {
      return [];
    }
    if (statement.startsWith('select "phase", "revision",')) {
      return statement.includes('clock_timestamp()')
        ? [{ phase: authority.phase, revision: authority.revision, unexpired: authorityUnexpired }]
        : [{ phase: authority.phase, revision: authority.revision, validUntil: authority.validUntil }];
    }
    if (statement.startsWith('select "revision" from')) {
      return [{ revision: authority.revision }];
    }
    // The scripted driver uses Object.values; preserve the physical SELECT * projection order.
    return [
      Object.fromEntries<unknown>([
        ['authorityKey', authority.authorityKey],
        ['revision', authority.revision],
        ['phase', authority.phase],
        ['durableWorkAdmission', authority.durableWorkAdmission],
        ['validUntil', authority.validUntil],
        ['subscriptionsJson', authority.subscriptionsJson],
        ['updatedAt', authority.updatedAt],
      ]),
    ];
  };
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
    if (destination.pathname === CUTOVER_NAMESPACE_PATH) {
      proofRequests.push(recorded);
      awaitingCutoverPointer = true;
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json({ errors: [], result: { id: CUTOVER_NAMESPACE_ID }, success: true }),
        ),
      );
    }
    if (destination.href === KV_URL && awaitingCutoverPointer) {
      proofRequests.push(recorded);
      awaitingCutoverPointer = false;
      return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 404 })));
    }
    requests.push(recorded);
    if (options.transportUnavailable === true) {
      return Effect.fail(
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({
            cause: new Error('Scripted publication transport unavailable'),
            request,
          }),
        }),
      );
    }
    return Effect.succeed(HttpClientResponse.fromWeb(request, answer(recorded, requests.length - 1)));
  });
  const layer = Layer.mergeAll(
    NodeServices.layer,
    legacy.layer,
    Layer.succeed(HttpClient.HttpClient, client),
    ZeropsPublicApiLive.pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, client))),
    Layer.effect(
      CoreDatabase,
      makeTestDatabase((sql, params) =>
        Effect.sync(() => {
          statements.push(sql);
          if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
            transactionStatements.push(sql);
          }
          events.push(sql);
          const legacyRows = legacy.sqlResponse(sql, params);
          if (legacyRows !== null) {
            return legacyRows;
          }
          if (sql.includes("to_regclass('core.application_composition_authority')")) {
            return options.authorityTable === 'unavailable' ? [] : [{ installed: options.authorityTable !== 'absent' }];
          }
          if (sql === 'COMMIT' && authority !== undefined && pendingValidUntil !== null) {
            authority = { ...authority, validUntil: pendingValidUntil };
            pendingValidUntil = null;
          }
          if (sql === 'ROLLBACK') {
            pendingValidUntil = null;
          }
          if (sql.startsWith('select') && sql.includes('from "core"."application_composition_authority"')) {
            return projectAuthority(sql);
          }
          if (sql.startsWith(AUTHORITY_INSERT_SQL)) {
            authorityWrites.push(params);
            const [validUntil] = params.slice(4);
            if (Schema.is(Schema.String)(validUntil)) {
              pendingValidUntil = new Date(validUntil);
            }
          }
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
  return {
    authority: () => authority,
    authorityWrites,
    events,
    layer,
    legacy,
    proofRequests,
    requests,
    statements,
    transactionStatements,
  };
};

const candidateObservation = Effect.gen(function* nativeCandidateObservationFixture() {
  yield* TestClock.setTime(Date.parse(PUBLICATION_TIME));
  const module = yield* deployedModule('catalog', CATALOG_MODULE_ID);
  const shell = yield* shellArtifacts(SHELL_BUILD_MARKER);
  const snapshot = yield* deriveActiveApplicationCompositionSnapshot({
    environment: 'stage',
    modules: [module],
    observedAt: yield* DateTime.now,
    shell,
    validity: ACTIVE_APPLICATION_COMPOSITION_POLICY.validity,
  });
  const [approvedModule] = snapshot.composition.modules;
  if (approvedModule === undefined) {
    return yield* Effect.die('Expected the derived candidate module');
  }
  const candidate = {
    baseline: { retainedModuleAppIds: [], revision: null, shellMode: 'fresh' as const },
    modules: [
      {
        appId: module.appId,
        backend: module.backend,
        contract: approvedModule.contract,
        deployment: approvedModule.deployment,
      },
    ],
    shell: {
      deployment: snapshot.composition.shell.deployment,
      federationManifest: snapshot.composition.shell.federationManifest,
      runtimeContract: snapshot.composition.shell.runtimeContract,
    },
  };
  const intent = { modules: [{ appId: module.appId }] };
  const selection = yield* selectApplicationReleaseUnits(
    intent,
    [
      {
        id: module.appId,
        packageName: '@app/catalog',
        path: 'verticals/catalog',
        workerName: module.backend.workerName,
      },
      {
        id: candidate.shell.deployment.appId,
        packageName: '@app/shell-super-app',
        path: 'shell/super-app',
        workerName: 'shell-super-app',
      },
    ],
    [],
  );
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
    intent,
    makeProvider: (
      unmatched?: (request: RecordedRequest) => Response,
      artifactOverrides: readonly ObservedArtifact[] = [],
      backendOverrides: ReadonlyMap<string, Response> = new Map(),
      currentSnapshot?: ActiveApplicationCompositionSnapshot,
    ) =>
      provider(
        (request) => {
          const backendOverride = backendOverrides.get(request.url);
          if (backendOverride !== undefined) {
            return backendOverride;
          }
          const replacement = artifactOverrides.find(({ url }) => url === request.url);
          if (replacement !== undefined) {
            return new Response(new Uint8Array(replacement.bytes));
          }
          if (backendDocuments.has(request.url)) {
            return Response.json(backendDocuments.get(request.url));
          }
          const observedArtifact = [module.contract, shell.runtimeContract, shell.federationManifest].find(
            ({ url }) => url === request.url,
          );
          return observedArtifact === undefined
            ? (unmatched?.(request) ?? new Response(null, { status: 404 }))
            : new Response(observedArtifact.bytes);
        },
        KV_URL,
        true,
        'retired',
        currentSnapshot,
      ),
    module,
    selection,
    shell,
    snapshot,
  };
});

it.effect('refreshes exact active content and freshness despite an exercised business endpoint failure', () =>
  Effect.gen(function* refreshesWithoutBusinessHealthAuthority() {
    for (const businessStatus of [200, 500]) {
      const fixture = yield* candidateObservation;
      let pointer = yield* encodeActiveApplicationCompositionSnapshot(fixture.snapshot);
      const businessUrl = new URL('/api/business-probe', fixture.module.backend.baseUrl).href;
      const { authority, authorityWrites, layer, proofRequests, requests } = fixture.makeProvider(
        (request) => {
          if (request.url === businessUrl) {
            return new Response(null, { status: businessStatus });
          }
          if (request.url !== KV_URL) {
            return new Response(null, { status: 404 });
          }
          if (request.method === 'PUT') {
            pointer = request.body;
            return Response.json({ success: true });
          }
          return new Response(pointer);
        },
        [],
        new Map(),
        fixture.snapshot,
      );
      const probe = yield* HttpClient.HttpClient.pipe(
        Effect.flatMap((client) => client.get(businessUrl)),
        Effect.provide(layer),
      );
      expect(probe.status).toBe(businessStatus);
      yield* TestClock.adjust(ACTIVE_APPLICATION_COMPOSITION_POLICY.refreshInterval);
      const renewed = yield* refreshApplicationComposition('stage').pipe(Effect.provide(layer));
      expect(renewed.composition).toEqual(fixture.snapshot.composition);
      expect(DateTime.toEpochMillis(renewed.observedAt)).toBe(
        DateTime.toEpochMillis(fixture.snapshot.observedAt) +
          Duration.toMillis(ACTIVE_APPLICATION_COMPOSITION_POLICY.refreshInterval),
      );
      expect(DateTime.toEpochMillis(renewed.validUntil)).toBe(
        DateTime.toEpochMillis(renewed.observedAt) + Duration.toMillis(ACTIVE_APPLICATION_COMPOSITION_POLICY.validity),
      );
      expect(authority()?.revision).toBe(fixture.snapshot.composition.revision);
      expect(authority()?.phase).toBe('active');
      expect(authority()?.durableWorkAdmission).toBe('closed');
      expect(authority()?.validUntil).toEqual(DateTime.toDateUtc(renewed.validUntil));
      expect(authorityWrites).toHaveLength(1);
      expect(requests.filter(({ url }) => url === businessUrl)).toHaveLength(1);
      expect(requests.filter(({ method }) => method === 'PUT').map(({ body }) => body)).toEqual([
        yield* encodeActiveApplicationCompositionSnapshot(renewed),
      ]);
      expect(proofRequests).toEqual([]);
    }
  }),
);

it.effect(
  'refuses changed artifacts and unavailable backend identity without promotion or extending original expiry',
  () =>
    Effect.gen(function* refusesIdentityDriftAndObservationFailure() {
      for (const fault of ['http', 'changed-artifact', 'backend-identity']) {
        const fixture = yield* candidateObservation;
        const encoded = yield* encodeActiveApplicationCompositionSnapshot(fixture.snapshot);
        const document = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(OntosModuleDeploymentContractSchema))(
          new TextDecoder().decode(fixture.module.contract.bytes),
        );
        const changed = artifact(fixture.module.contract.url, {
          ...document,
          deployment: { ...document.deployment, buildMarker: 'different-refresh-release' },
        });
        const deploymentUrl = fixture.backendUrls.find((url) => url.endsWith('/deployments'));
        if (deploymentUrl === undefined) {
          return yield* Effect.die('Expected the existing backend deployment observation URL');
        }
        const overrides = new Map<string, Response>();
        if (fault === 'http') {
          overrides.set(fixture.module.contract.url, new Response(null, { status: 503 }));
        } else if (fault === 'backend-identity') {
          overrides.set(
            deploymentUrl,
            Response.json({
              result: {
                deployments: [{ versions: [{ percentage: 100, version_id: '44444444-4444-4444-8444-444444444444' }] }],
              },
              success: true,
            }),
          );
        }
        const { authority, authorityWrites, layer, proofRequests, requests } = fixture.makeProvider(
          (request) => (request.url === KV_URL ? new Response(encoded) : new Response(null, { status: 404 })),
          fault === 'changed-artifact' ? [changed] : [],
          overrides,
          fixture.snapshot,
        );
        yield* TestClock.adjust(ACTIVE_APPLICATION_COMPOSITION_POLICY.refreshInterval);
        expect(
          Exit.isFailure(yield* refreshApplicationComposition('stage').pipe(Effect.provide(layer), Effect.exit)),
        ).toBe(true);
        expect(authorityWrites).toEqual([]);
        expect(authority()?.revision).toBe(fixture.snapshot.composition.revision);
        expect(authority()?.validUntil).toEqual(DateTime.toDateUtc(fixture.snapshot.validUntil));
        expect(requests.some(({ method }) => method === 'PUT')).toBe(false);
        expect(proofRequests).toEqual([]);
        expect(yield* validateActiveApplicationCompositionSnapshot(fixture.snapshot)).toEqual(fixture.snapshot);
        yield* TestClock.setTime(DateTime.toEpochMillis(fixture.snapshot.validUntil) + 1);
        const expired = yield* validateActiveApplicationCompositionSnapshot(fixture.snapshot).pipe(Effect.flip);
        expect(Schema.is(ActiveApplicationCompositionUnavailableError)(expired)).toBe(true);
      }
      return yield* Effect.void;
    }),
);

it.effect('bounds stalled identity observation and leaves the original snapshot to expire without renewal', () =>
  Effect.gen(function* boundsRefreshIdentityTimeout() {
    const fixture = yield* candidateObservation;
    const encoded = yield* encodeActiveApplicationCompositionSnapshot(fixture.snapshot);
    const { authority, authorityWrites, layer, proofRequests, requests } = fixture.makeProvider(
      (request) => (request.url === KV_URL ? new Response(encoded) : new Response(null, { status: 404 })),
      [],
      new Map([[fixture.module.contract.url, new Response(new ReadableStream<Uint8Array>())]]),
      fixture.snapshot,
    );
    yield* TestClock.adjust(ACTIVE_APPLICATION_COMPOSITION_POLICY.refreshInterval);
    const refreshing = yield* refreshApplicationComposition('stage').pipe(Effect.provide(layer), Effect.forkChild);
    yield* TestClock.adjust(ARTIFACT_FETCH_TIMEOUT);
    const failure = yield* Fiber.join(refreshing).pipe(Effect.flip);
    expect(Schema.is(ActiveApplicationCompositionObservationError)(failure)).toBe(true);
    expect(failure).toMatchObject({ appId: fixture.module.appId, message: `${fixture.module.contract.url} timed out` });
    expect(authorityWrites).toEqual([]);
    expect(authority()?.validUntil).toEqual(DateTime.toDateUtc(fixture.snapshot.validUntil));
    expect(requests.some(({ method }) => method === 'PUT')).toBe(false);
    expect(proofRequests).toEqual([]);
    yield* TestClock.setTime(DateTime.toEpochMillis(fixture.snapshot.validUntil) + 1);
    const expired = yield* validateActiveApplicationCompositionSnapshot(fixture.snapshot).pipe(Effect.flip);
    expect(Schema.is(ActiveApplicationCompositionUnavailableError)(expired)).toBe(true);
  }),
);

it.effect('binds expected composition to exact reviewed membership partition and immutable candidate pins', () =>
  Effect.gen(function* bindsExpectedComposition() {
    const fixture = yield* candidateObservation;
    const candidate = yield* Schema.decodeUnknownEffect(ApplicationCompositionPublicationCandidateSchema)(
      fixture.candidate,
    );
    const { composition } = fixture.snapshot;
    const { intent, selection } = fixture;
    const input = { candidate, composition, intent, selection };
    expect(yield* validateExpectedApplicationComposition(input)).toEqual(composition);
    const [module] = candidate.modules;
    if (module === undefined) {
      return yield* Effect.die('Expected the pinned planning module');
    }
    const differentBackend = yield* Schema.decodeUnknownEffect(ApplicationCompositionCloudflareWorkerBackendSchema)({
      ...fixture.module.backend,
      versionId: '44444444-4444-4444-8444-444444444444',
    });
    expect(
      yield* validateExpectedApplicationComposition({
        ...input,
        candidate: {
          ...candidate,
          baseline: { retainedModuleAppIds: [module.appId], revision: composition.revision, shellMode: 'fresh' },
        },
        selection: { ...selection, fresh: [], retained: selection.complete },
      }),
    ).toEqual(composition);
    const invalid = [
      { ...input, intent: { modules: [] } },
      { ...input, intent: { modules: [...intent.modules, ...intent.modules] } },
      { ...input, selection: { ...selection, complete: [...selection.complete, ...selection.complete] } },
      { ...input, selection: { ...selection, fresh: [] } },
      { ...input, selection: { ...selection, retained: selection.complete } },
      { ...input, candidate: { ...candidate, modules: [] } },
      {
        ...input,
        candidate: {
          ...candidate,
          baseline: { ...candidate.baseline, retainedModuleAppIds: [module.appId], revision: composition.revision },
        },
      },
      { ...input, selection: { ...selection, shell: { ...selection.shell, mode: 'retained' } } },
      {
        ...input,
        candidate: {
          ...candidate,
          modules: [{ ...module, contract: { ...module.contract, sha256: 'd'.repeat(64) } }],
        },
      },
      {
        ...input,
        candidate: {
          ...candidate,
          modules: [{ ...module, deployment: { ...module.deployment, buildMarker: 'different-planned-build' } }],
        },
      },
      {
        ...input,
        candidate: {
          ...candidate,
          modules: [{ ...module, backend: differentBackend }],
        },
      },
      {
        ...input,
        candidate: {
          ...candidate,
          shell: {
            ...candidate.shell,
            runtimeContract: { ...candidate.shell.runtimeContract, sha256: 'e'.repeat(64) },
          },
        },
      },
      { ...input, composition: { ...composition, revision: '0'.repeat(64) } },
    ] satisfies readonly Parameters<typeof validateExpectedApplicationComposition>[0][];
    for (const changed of invalid) {
      const failure = yield* validateExpectedApplicationComposition(changed).pipe(Effect.flip);
      expect(Schema.is(ActiveApplicationCompositionPublicationError)(failure)).toBe(true);
    }
    return yield* Effect.void;
  }),
);

it.effect('rejects canonically pinned expected contract content with an unavailable intrinsic provider', () =>
  Effect.gen(function* rejectsExpectedSemanticIncompatibility() {
    const fixture = yield* candidateObservation;
    const [module] = fixture.snapshot.composition.modules;
    if (module === undefined) {
      return yield* Effect.die('Expected the semantic planning module');
    }
    const codec = Schema.fromJsonString(OntosModuleDeploymentContractSchema);
    const document = yield* Schema.decodeUnknownEffect(codec)(module.contractDocument);
    const contractDocument = yield* Schema.encodeEffect(codec)({
      ...document,
      manifest: {
        ...document.manifest,
        requirements: {
          coreCapabilities: [],
          intrinsic: [
            {
              moduleId: INVENTORY_MODULE_ID,
              requiredOperations: [{ entrypointKey: `${INVENTORY_MODULE_ID}.api.execute`, schemaVersion: '2' }],
            },
          ],
          operations: [],
          schemaVersion: '1',
        },
      },
    });
    const contract = { ...module.contract, sha256: createHash('sha256').update(contractDocument).digest('hex') };
    const changed = {
      ...fixture.snapshot.composition,
      modules: [
        {
          ...module,
          contract,
          contractDocument,
          dependencies: [INVENTORY_MODULE_ID],
          publicContract: { ...module.publicContract, sha256: contract.sha256 },
        },
      ],
    };
    const composition = { ...changed, revision: applicationCompositionRevision(changed) };
    const candidate = yield* Schema.decodeUnknownEffect(ApplicationCompositionPublicationCandidateSchema)({
      ...fixture.candidate,
      modules: [{ ...fixture.candidate.modules[0], contract }],
    });
    const failure = yield* validateExpectedApplicationComposition({
      candidate,
      composition,
      intent: fixture.intent,
      selection: fixture.selection,
    }).pipe(Effect.flip);
    expect(Schema.is(ActiveApplicationCompositionPublicationError)(failure)).toBe(true);
    return yield* Effect.void;
  }),
);

it.effect('requires the actually observed composition to equal the planned revision before promotion', () =>
  Effect.gen(function* rejectsDifferentObservedRevision() {
    const fixture = yield* candidateObservation;
    const candidate = yield* Schema.decodeUnknownEffect(ApplicationCompositionPublicationCandidateSchema)(
      fixture.candidate,
    );
    const other = yield* snapshotAt(PUBLICATION_TIME);
    expect(other.composition.revision).not.toBe(fixture.snapshot.composition.revision);
    for (const expected of [fixture.snapshot.composition, other.composition]) {
      const { layer, proofRequests, requests, statements } = fixture.makeProvider();
      const observation = observeCandidate('stage', candidate, expected).pipe(Effect.provide(layer));
      if (expected.revision === fixture.snapshot.composition.revision) {
        expect(yield* observation).toEqual(fixture.snapshot);
      } else {
        const failure = yield* observation.pipe(
          Effect.flatMap((observed) =>
            publishSnapshot(observed, Option.none(), initialCutoverProof).pipe(Effect.provide(layer)),
          ),
          Effect.flip,
        );
        expect(Schema.is(ActiveApplicationCompositionPublicationError)(failure)).toBe(true);
        expect(failure).toMatchObject({ reason: 'conflicting_revision' });
      }
      expect(requests.every(({ method }) => method === 'GET')).toBe(true);
      expect(proofRequests).toEqual([]);
      expect(statements).toEqual([]);
    }
  }),
);

it.effect('captures absence only when explicitly allowed and both provider and native authority are absent', () =>
  Effect.gen(function* capturesConfirmedAbsence() {
    const fixture = yield* candidateObservation;
    const scenarios = [
      { allowAbsent: false, allowed: false, authorityTable: 'present', current: null },
      { allowAbsent: true, allowed: true, authorityTable: 'present', current: null },
      { allowAbsent: true, allowed: true, authorityTable: 'absent', current: null },
      { allowAbsent: true, allowed: false, authorityTable: 'present', current: fixture.snapshot },
      { allowAbsent: true, allowed: false, authorityTable: 'unavailable', current: null },
    ] satisfies readonly {
      readonly allowAbsent: boolean;
      readonly allowed: boolean;
      readonly authorityTable: NonNullable<ProviderOptions['authorityTable']>;
      readonly current: ActiveApplicationCompositionSnapshot | null;
    }[];
    for (const scenario of scenarios) {
      const { events, layer, proofRequests, requests, statements } = provider(
        () => new Response(null, { status: 404 }),
        KV_URL,
        true,
        'retired',
        scenario.current ?? undefined,
        'active',
        { authorityTable: scenario.authorityTable },
      );
      const capture = (
        scenario.allowAbsent
          ? captureApprovedApplicationCompositionSnapshot({ allowAbsent: true })
          : captureApprovedApplicationCompositionSnapshot()
      ).pipe(Effect.provide(layer));
      if (scenario.allowed) {
        expect(Option.isNone(yield* capture)).toBe(true);
      } else {
        const failure = yield* capture.pipe(Effect.flip);
        expect(Schema.is(ActiveApplicationCompositionPublicationError)(failure)).toBe(true);
      }
      expect(events.filter((event) => event === PUBLICATION_LOCK_SQL || event === PUBLICATION_UNLOCK_SQL)).toEqual([
        PUBLICATION_LOCK_SQL,
        PUBLICATION_UNLOCK_SQL,
      ]);
      expect(events.indexOf(PUBLICATION_LOCK_SQL)).toBeLessThan(events.indexOf(`GET ${KV_URL}`));
      expect(events.at(-1)).toBe(PUBLICATION_UNLOCK_SQL);
      expect(requests.map(({ method }) => method)).toEqual(['GET']);
      expect(proofRequests).toEqual([]);
      expect(statements.some((statement) => /^(?:begin|insert|update|delete|alter|create)\b/iu.test(statement))).toBe(
        false,
      );
      if (scenario.authorityTable === 'absent') {
        expect(
          statements.some((statement) => statement.includes('from "core"."application_composition_authority"')),
        ).toBe(false);
      }
    }
  }),
);

it.effect('never treats transport errors invalid pointers or expired releases as captured absence', () =>
  Effect.gen(function* rejectsUnavailableCapture() {
    const fixture = yield* candidateObservation;
    const expired = yield* snapshotAt('2026-09-29T16:00:00.000Z');
    const encoded = yield* encodeActiveApplicationCompositionSnapshot(fixture.snapshot);
    const expiredEncoded = yield* encodeActiveApplicationCompositionSnapshot(expired);
    for (const scenario of [
      { body: '', status: 503, transportUnavailable: false },
      { body: '', status: 200, transportUnavailable: true },
      { body: 'not a composition document', status: 200, transportUnavailable: false },
      { body: expiredEncoded, status: 200, transportUnavailable: false },
    ]) {
      const { events, layer, proofRequests, requests, statements } = provider(
        () => new Response(scenario.body, { status: scenario.status }),
        KV_URL,
        true,
        'retired',
        undefined,
        'active',
        { transportUnavailable: scenario.transportUnavailable },
      );
      const exit = yield* captureApprovedApplicationCompositionSnapshot({ allowAbsent: true }).pipe(
        Effect.provide(layer),
        Effect.exit,
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(events.at(-1)).toBe(PUBLICATION_UNLOCK_SQL);
      expect(requests.map(({ method }) => method)).toEqual(['GET']);
      expect(proofRequests).toEqual([]);
      expect(statements.some((statement) => /^(?:begin|insert|update|delete|alter|create)\b/iu.test(statement))).toBe(
        false,
      );
    }
    const valid = provider(() => new Response(encoded), KV_URL, true, 'retired', fixture.snapshot);
    expect(yield* captureApprovedApplicationCompositionSnapshot().pipe(Effect.provide(valid.layer))).toEqual(
      Option.some(fixture.snapshot),
    );
    for (const current of [null, expired]) {
      const { layer } = provider(() => new Response(encoded), KV_URL, true, 'retired', current ?? undefined);
      expect(
        Exit.isFailure(
          yield* captureApprovedApplicationCompositionSnapshot({ allowAbsent: true }).pipe(
            Effect.provide(layer),
            Effect.exit,
          ),
        ),
      ).toBe(true);
    }
  }),
);

it.effect(
  'prepares only pinned canonical content without observing backend authority or creating a dated approval',
  () =>
    Effect.gen(function* preparesPinnedContentOnly() {
      const fixture = yield* candidateObservation;
      const candidate = yield* Schema.decodeUnknownEffect(ApplicationCompositionPublicationCandidateSchema)(
        fixture.candidate,
      );
      const [module] = candidate.modules;
      if (module === undefined) {
        return yield* Effect.die('Expected the content preparation module');
      }
      const { layer, proofRequests, requests, statements } = fixture.makeProvider();
      const input = { candidate, intent: fixture.intent, selection: fixture.selection };
      const prepared = yield* prepareCandidate('stage', input).pipe(Effect.provide(layer));
      expect(prepared).toEqual(fixture.snapshot.composition);
      expect(prepared).not.toHaveProperty('observedAt');
      expect(prepared).not.toHaveProperty('validUntil');
      expect(
        EffectArray.sort(
          requests.map(({ url }) => url),
          Order.String,
        ),
      ).toEqual(
        EffectArray.sort(
          [module.contract.url, candidate.shell.runtimeContract.url, candidate.shell.federationManifest.url],
          Order.String,
        ),
      );
      expect(requests.every(({ method }) => method === 'GET')).toBe(true);
      expect(requests.some(({ url }) => fixture.backendUrls.includes(url))).toBe(false);
      expect(proofRequests).toEqual([]);
      expect(statements).toEqual([]);

      for (const changed of [
        { ...candidate, modules: [{ ...module, contract: { ...module.contract, sha256: 'd'.repeat(64) } }] },
        {
          ...candidate,
          shell: {
            ...candidate.shell,
            runtimeContract: { ...candidate.shell.runtimeContract, sha256: 'e'.repeat(64) },
          },
        },
        {
          ...candidate,
          shell: {
            ...candidate.shell,
            federationManifest: { ...candidate.shell.federationManifest, sha256: 'f'.repeat(64) },
          },
        },
      ]) {
        const rejected = fixture.makeProvider();
        const failure = yield* prepareCandidate('stage', { ...input, candidate: changed }).pipe(
          Effect.provide(rejected.layer),
          Effect.flip,
        );
        expect(Schema.is(ActiveApplicationCompositionPublicationError)(failure)).toBe(true);
        expect(rejected.requests.every(({ method }) => method === 'GET')).toBe(true);
        expect(rejected.requests.some(({ url }) => fixture.backendUrls.includes(url))).toBe(false);
        expect(rejected.proofRequests).toEqual([]);
        expect(rejected.statements).toEqual([]);
      }
      return yield* Effect.void;
    }),
);

it.effect('prepares CF content only after optional independent native backend checks succeed', () =>
  Effect.gen(function* verifiesPreparedNativeBackends() {
    const fixture = yield* candidateObservation;
    const positive = fixture.makeProvider();
    const prepared = yield* prepareCandidate('stage', fixture, { observeBackends: true }).pipe(
      Effect.provide(positive.layer),
    );
    expect(prepared).toEqual(fixture.snapshot.composition);
    expect(prepared).not.toHaveProperty('observedAt');
    expect(prepared).not.toHaveProperty('validUntil');
    expect(positive.requests.filter(({ url }) => fixture.backendUrls.includes(url))).toHaveLength(4);
    expect(positive.requests.every(({ method }) => method === 'GET')).toBe(true);
    expect(positive.proofRequests).toEqual([]);
    expect(positive.statements).toEqual([]);
    const deploymentsUrl = fixture.backendUrls.find((url) => url.endsWith('/deployments'));
    const versionUrl = fixture.backendUrls.find((url) => url.includes('/versions/'));
    if (deploymentsUrl === undefined || versionUrl === undefined) {
      return yield* Effect.die(
        new Error('The existing CF fixture must expose its actual deployment and version reads'),
      );
    }
    for (const [url, response] of new Map([
      [versionUrl, new Response(null, { status: 404 })],
      [
        deploymentsUrl,
        Response.json({
          result: {
            deployments: [{ versions: [{ percentage: 100, version_id: '55555555-5555-4555-8555-555555555555' }] }],
          },
          success: true,
        }),
      ],
    ])) {
      const rejected = fixture.makeProvider(undefined, [], new Map([[url, response]]));
      const failure = yield* prepareCandidate('stage', fixture, { observeBackends: true }).pipe(
        Effect.provide(rejected.layer),
        Effect.flip,
      );
      expect(Schema.is(ActiveApplicationCompositionPublicationError)(failure)).toBe(true);
      expect(rejected.requests.some((request) => request.url === url)).toBe(true);
      expect(rejected.requests.every(({ method }) => method === 'GET')).toBe(true);
      expect(rejected.proofRequests).toEqual([]);
      expect(rejected.statements).toEqual([]);
    }
    return yield* Effect.void;
  }),
);

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
        candidate.modules[0]?.contract.url,
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
      expect(
        yield* publishSnapshot(observed, Option.none(), initialCutoverProof, candidate.baseline).pipe(
          Effect.provide(layer),
        ),
      ).toEqual(fixture.snapshot);
      const write = events.indexOf(`PUT ${KV_URL}`);
      expect(write).toBeGreaterThan(0);
      for (const url of [
        ...fixture.backendUrls,
        candidate.modules[0]?.contract.url,
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

it.effect(
  'rejects missing business deployment or digest pins, app-ID disagreement and duplicate slots before pointer work',
  () =>
    Effect.gen(function* rejectsUnpinnedBusinessCandidate() {
      const fixture = yield* candidateObservation;
      const [module] = fixture.candidate.modules;
      if (module === undefined) {
        return yield* Effect.die('Expected the pinned business module');
      }
      const invalidModules = [
        [{ appId: module.appId, backend: module.backend, contractUrl: module.contract.url }],
        [{ appId: module.appId, backend: module.backend, contract: module.contract }],
        [{ ...module, contract: { url: module.contract.url } }],
        [{ ...module, deployment: { ...module.deployment, appId: 'inventory' } }],
        [{ ...module, contractUrl: module.contract.url }],
        [module, module],
      ];
      for (const modules of invalidModules) {
        const { layer, proofRequests, requests, statements } = fixture.makeProvider();
        yield* Schema.decodeUnknownEffect(ApplicationCompositionPublicationCandidateSchema, {
          onExcessProperty: 'error',
        })({ ...fixture.candidate, modules }).pipe(
          Effect.flatMap((candidate) => observeCandidate('stage', candidate)),
          Effect.flatMap((observed) => publishSnapshot(observed, Option.none(), initialCutoverProof)),
          Effect.provide(layer),
          Effect.flip,
        );
        expect(requests).toEqual([]);
        expect(proofRequests).toEqual([]);
        expect(statements).toEqual([]);
      }
      return yield* Effect.void;
    }),
);

it.effect('rejects business digest or deployment drift before backend proof and pointer mutation', () =>
  Effect.gen(function* rejectsChangedBusinessPins() {
    const fixture = yield* candidateObservation;
    const [module] = fixture.candidate.modules;
    if (module === undefined) {
      return yield* Effect.die('Expected the pinned business module');
    }
    const variants = [
      {
        changed: { ...module, contract: { ...module.contract, sha256: '0'.repeat(64) } },
        message: 'observed module artifact digest differs from the exact approved candidate pin',
      },
      {
        changed: { ...module, deployment: { ...module.deployment, buildMarker: 'different-module-build' } },
        message: 'observed module deployment differs from the exact approved candidate deployment',
      },
      {
        changed: { ...module, appId: 'inventory', deployment: { ...module.deployment, appId: 'inventory' } },
        message: 'observed module deployment differs from the exact approved candidate deployment',
      },
    ];
    for (const { changed, message } of variants) {
      const candidate = yield* Schema.decodeUnknownEffect(ApplicationCompositionPublicationCandidateSchema)({
        ...fixture.candidate,
        modules: [changed],
      });
      const { layer, proofRequests, requests, statements } = fixture.makeProvider();
      const failure = yield* observeCandidate('stage', candidate).pipe(
        Effect.flatMap((observed) => publishSnapshot(observed, Option.none(), initialCutoverProof)),
        Effect.provide(layer),
        Effect.flip,
      );
      expect(failure).toMatchObject({ message, reason: 'invalid_observation' });
      expect(requests.some(({ method }) => method !== 'GET')).toBe(false);
      expect(requests.some(({ url }) => fixture.backendUrls.includes(url))).toBe(false);
      expect(proofRequests).toEqual([]);
      expect(statements).toEqual([]);
    }
    return yield* Effect.void;
  }),
);

it.effect(
  'observes the exact browser manifest pin and rejects changed or missing manifest digests before pointer mutation',
  () =>
    Effect.gen(function* observesPinnedBusinessManifest() {
      const fixture = yield* candidateObservation;
      const manifest = artifact(new URL('mf-manifest.json', fixture.module.contract.url).href, {
        exposes: [],
        name: 'catalogFixture',
        shared: governedSharedSingletonPackages.map((name) => ({ name, requiredVersion: '1.0.0', singleton: true })),
      });
      const snapshot = yield* deriveActiveApplicationCompositionSnapshot({
        environment: 'stage',
        modules: [{ ...fixture.module, federationManifest: manifest }],
        observedAt: yield* DateTime.now,
        shell: fixture.shell,
        validity: ACTIVE_APPLICATION_COMPOSITION_POLICY.validity,
      });
      const [module] = snapshot.composition.modules;
      if (module === undefined || module.federation.execution !== 'browser') {
        return yield* Effect.die('Expected the derived browser module');
      }
      const browser = { ...fixture.candidate.modules[0], federationManifest: module.federation.manifest };
      const candidate = yield* Schema.decodeUnknownEffect(ApplicationCompositionPublicationCandidateSchema)({
        ...fixture.candidate,
        modules: [browser],
      });
      const servedManifest = (request: RecordedRequest) =>
        request.url === manifest.url ? new Response(manifest.bytes) : new Response(null, { status: 404 });
      const { layer } = fixture.makeProvider(servedManifest);
      expect(yield* observeCandidate('stage', candidate).pipe(Effect.provide(layer))).toEqual(snapshot);
      for (const federationManifest of [
        { ...module.federation.manifest, sha256: '0'.repeat(64) },
        { url: manifest.url },
      ]) {
        const { layer: deniedLayer, proofRequests, requests, statements } = fixture.makeProvider(servedManifest);
        yield* Schema.decodeUnknownEffect(ApplicationCompositionPublicationCandidateSchema, {
          onExcessProperty: 'error',
        })({ ...fixture.candidate, modules: [{ ...browser, federationManifest }] }).pipe(
          Effect.flatMap((changed) => observeCandidate('stage', changed)),
          Effect.flatMap((observed) => publishSnapshot(observed, Option.none(), initialCutoverProof)),
          Effect.provide(deniedLayer),
          Effect.flip,
        );
        expect(requests.every(({ method }) => method === 'GET')).toBe(true);
        expect(requests.some(({ url }) => fixture.backendUrls.includes(url))).toBe(false);
        expect(proofRequests).toEqual([]);
        expect(statements).toEqual([]);
      }
      return yield* Effect.void;
    }),
);

it.effect(
  'observes complete business membership and refuses unsupported public-operation versions despite matching deployment-document formats',
  () =>
    Effect.gen(function* observesExactOperationCompatibility() {
      const fixture = yield* candidateObservation;
      const inventory = yield* deployedModule('inventory', INVENTORY_MODULE_ID);
      const catalogDocument = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(OntosModuleDeploymentContractSchema),
      )(new TextDecoder().decode(fixture.module.contract.bytes));
      const inventoryDocument = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(OntosModuleDeploymentContractSchema),
      )(new TextDecoder().decode(inventory.contract.bytes));
      const entrypoint = defineTenantModuleEntrypoint({
        access: 'read',
        authorization: { kind: 'context_permission', permission: 'module.access' },
        entrypointKey: `${INVENTORY_MODULE_ID}.api.execute`,
        moduleKey: INVENTORY_MODULE_ID,
        role: 'api',
      });
      const providerDocument = {
        ...inventoryDocument,
        manifest: {
          ...inventoryDocument.manifest,
          publicSurface: {
            ...inventoryDocument.manifest.publicSurface,
            api: [{ key: `${INVENTORY_MODULE_ID}.api`, operationKeys: ['execute'] }],
            operationContracts: [
              { apiKey: `${INVENTORY_MODULE_ID}.api`, entrypoint, operationKey: 'execute', schemaVersion: '1' },
            ],
          },
        },
      };
      yield* Schema.decodeUnknownEffect(OntosModuleDeploymentContractSchema)(providerDocument);
      const providerArtifact = artifact(inventory.contract.url, providerDocument);
      const workersApi = `https://api.cloudflare.com/client/v4/accounts/${'a'.repeat(32)}/workers`;
      const scriptApi = `${workersApi}/scripts/${inventory.backend.workerName}`;
      const providerDocuments = new Map<string, Schema.Json>([
        [`${scriptApi}/subdomain`, { result: { enabled: true }, success: true }],
        [
          `${scriptApi}/deployments`,
          {
            result: { deployments: [{ versions: [{ percentage: 100, version_id: inventory.backend.versionId }] }] },
            success: true,
          },
        ],
        [
          `${scriptApi}/versions/${inventory.backend.versionId}`,
          { result: { id: inventory.backend.versionId }, success: true },
        ],
      ]);
      for (const schemaVersion of ['1', '2']) {
        const consumerDocument = {
          ...catalogDocument,
          manifest: {
            ...catalogDocument.manifest,
            requirements: {
              coreCapabilities: [],
              intrinsic: [
                {
                  moduleId: INVENTORY_MODULE_ID,
                  requiredOperations: [{ entrypointKey: entrypoint.entrypointKey, schemaVersion }],
                },
              ],
              operations: [],
              schemaVersion: '1',
            },
          },
        };
        yield* Schema.decodeUnknownEffect(OntosModuleDeploymentContractSchema)(consumerDocument);
        const consumerArtifact = artifact(fixture.module.contract.url, consumerDocument);
        // Pins originate from these arranged fixture bytes, before any HTTP observation; they are never rewritten from fetched bytes.
        const candidate = yield* Schema.decodeUnknownEffect(ApplicationCompositionPublicationCandidateSchema)({
          ...fixture.candidate,
          modules: [
            {
              appId: fixture.module.appId,
              backend: fixture.module.backend,
              contract: {
                sha256: createHash('sha256').update(consumerArtifact.bytes).digest('hex'),
                url: consumerArtifact.url,
              },
              deployment: catalogDocument.deployment,
            },
            {
              appId: inventory.appId,
              backend: inventory.backend,
              contract: {
                sha256: createHash('sha256').update(providerArtifact.bytes).digest('hex'),
                url: providerArtifact.url,
              },
              deployment: inventoryDocument.deployment,
            },
          ],
        });
        const { layer, proofRequests, requests, statements } = fixture.makeProvider(
          (request) =>
            providerDocuments.has(request.url)
              ? Response.json(providerDocuments.get(request.url))
              : new Response(null, { status: 404 }),
          [consumerArtifact, providerArtifact],
        );
        const observation = observeCandidate('stage', candidate).pipe(Effect.provide(layer));
        if (schemaVersion === '1') {
          const observed = yield* observation;
          expect(observed.composition.modules.map(({ deployment }) => deployment.appId)).toEqual([
            'catalog',
            'inventory',
          ]);
        } else {
          const failure = yield* observation.pipe(
            Effect.flatMap((observed) =>
              publishSnapshot(observed, Option.none(), initialCutoverProof).pipe(Effect.provide(layer)),
            ),
            Effect.flip,
          );
          expect(failure).toMatchObject({ reason: 'invalid_observation' });
          expect(requests.every(({ method }) => method === 'GET')).toBe(true);
          expect(proofRequests).toEqual([]);
          expect(statements).toEqual([]);
        }
      }
    }),
);

it.effect('retains the exact approved Shell while publishing a changed complete module inventory', () =>
  Effect.gen(function* publishesRetainedShell() {
    const previous = yield* snapshotAt(OBSERVED_AT);
    const { candidate: observedCandidate, snapshot } = yield* candidateObservation;
    const candidate = yield* Schema.decodeUnknownEffect(ApplicationCompositionPublicationCandidateSchema, {
      onExcessProperty: 'error',
    })({
      ...observedCandidate,
      baseline: { retainedModuleAppIds: [], revision: previous.composition.revision, shellMode: 'retained' },
    });
    const previousEncoded = yield* encodeActiveApplicationCompositionSnapshot(previous);
    const encoded = yield* encodeActiveApplicationCompositionSnapshot(snapshot);
    const { layer, requests } = provider(
      (request, index) =>
        request.method === 'PUT'
          ? Response.json({ success: true })
          : new Response(index === 0 ? previousEncoded : encoded),
      KV_URL,
      true,
      'retired',
      previous,
      'migrated',
    );

    const published = yield* publishSnapshot(snapshot, Option.none(), initialCutoverProof, candidate.baseline).pipe(
      Effect.provide(layer),
    );

    expect(candidate.baseline.revision).toBe(previous.composition.revision);
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
      { current: previousEncoded, retainedRevision: 'f'.repeat(64), snapshot },
      { current: previousEncoded, retainedRevision: previous.composition.revision, snapshot: changedShellSnapshot },
    ];
    for (const scenario of cases) {
      const { authority, authorityWrites, layer, requests, statements, transactionStatements } = provider(
        () => (scenario.current === null ? new Response(null, { status: 404 }) : new Response(scenario.current)),
        KV_URL,
        true,
        'retired',
        previous,
        'migrated',
      );
      const failure = yield* publishSnapshot(scenario.snapshot, Option.none(), initialCutoverProof, {
        retainedModuleAppIds: [],
        revision: scenario.retainedRevision,
        shellMode: 'retained',
      }).pipe(Effect.provide(layer), Effect.flip);

      if (scenario.retainedRevision === previous.composition.revision) {
        expect(Schema.is(ActiveApplicationCompositionPublicationError)(failure)).toBe(true);
        expect(failure).toMatchObject({ reason: 'publication_failed' });
        expect(transactionStatements.at(-1)).toBe('ROLLBACK');
      } else {
        expect(Schema.is(ApplicationCompositionAuthorityError)(failure)).toBe(true);
        expect(authorityWrites).toEqual([]);
        expect(statements.some((statement) => /^(?:insert|update|delete) /iu.test(statement))).toBe(false);
      }
      expect(requests.map(({ method }) => method)).toEqual(
        scenario.retainedRevision === previous.composition.revision ? ['GET'] : [],
      );
      expect(authority()?.phase).toBe('migrated');
      expect(authority()?.validUntil).toEqual(DateTime.toDateUtc(previous.validUntil));
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
    expect(events.indexOf('OWNER ACQUIRE')).toBeGreaterThan(events.indexOf('BEGIN'));
    expect(events.indexOf('OWNER ACQUIRE')).toBeGreaterThan(
      events.findIndex((event) => event.includes('pg_advisory_xact_lock(')),
    );
    expect(events.indexOf('OWNER RELEASE')).toBeGreaterThan(events.lastIndexOf('COMMIT'));
    expect(events.indexOf('OWNER RETAIN')).toBeLessThan(events.indexOf(`PUT ${KV_URL}`));
    expect(proofRequests).toHaveLength(4);
    expect(proofRequests.map(({ method }) => method)).toEqual(['GET', 'GET', 'GET', 'GET']);
    expect(proofRequests.slice(-2).map(({ url }) => url)).toEqual([
      `https://api.cloudflare.com${CUTOVER_NAMESPACE_PATH}`,
      KV_URL,
    ]);
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
      INVENTORY_MODULE_ID,
    ]);
    expect(statements.some((statement) => statement.includes('pg_advisory_xact_lock'))).toBe(true);
    expect(statements.some((statement) => statement.startsWith(AUTHORITY_INSERT_SQL))).toBe(true);
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
      expect(statements.some((statement) => statement.startsWith(AUTHORITY_INSERT_SQL))).toBe(false);
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
    const { authority, authorityWrites, layer, legacy, proofRequests, requests, statements } = provider(
      (request, index) => {
        if (request.method === 'PUT') {
          return Response.json({ success: true });
        }
        return new Response(index === 0 ? previous : next);
      },
      KV_URL,
      true,
      'retired',
      expired,
    );
    expect(authority()?.validUntil.getTime()).toBeLessThan(Date.parse(PUBLICATION_TIME));
    expect(authority()?.revision).toBe(renewed.composition.revision);
    expect(authority()?.durableWorkAdmission).toBe('closed');

    const published = yield* publishSnapshot(renewed, Option.none(), initialCutoverProof).pipe(Effect.provide(layer));

    expect(published.composition).toEqual(expired.composition);
    expect(authority()?.revision).toBe(expired.composition.revision);
    expect(authority()?.phase).toBe('active');
    expect(authority()?.durableWorkAdmission).toBe('closed');
    expect(authority()?.validUntil).toEqual(DateTime.toDateUtc(renewed.validUntil));
    expect(authorityWrites).toHaveLength(1);
    expect(authorityWrites[0]?.slice(0, 4)).toEqual(['active', renewed.composition.revision, 'active', 'closed']);
    expect(legacy.observations).toEqual([]);
    expect(proofRequests).toEqual([]);
    expect(statements.some((sql) => sql.startsWith('update '))).toBe(false);
    expect(published.composition.modules.map(({ moduleId }) => moduleId)).toEqual([
      CATALOG_MODULE_ID,
      INVENTORY_MODULE_ID,
    ]);
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

it.effect('rejects missing or contradictory captured-baseline metadata before observation', () =>
  Effect.gen(function* rejectsInvalidBaselineMetadata() {
    const fixture = yield* candidateObservation;
    const { baseline, ...missingBaseline } = fixture.candidate;
    expect(baseline.revision).toBeNull();
    for (const captured of [
      baseline,
      { retainedModuleAppIds: ['catalog'], revision: fixture.snapshot.composition.revision, shellMode: 'retained' },
    ]) {
      const candidate = yield* Schema.decodeUnknownEffect(ApplicationCompositionPublicationCandidateSchema)({
        ...fixture.candidate,
        baseline: captured,
      });
      const codec = Schema.fromJsonString(ApplicationCompositionPublicationCandidateSchema);
      const encoded = yield* Schema.encodeEffect(codec)(candidate);
      expect((yield* Schema.decodeEffect(codec)(encoded)).baseline).toEqual(captured);
      if (captured.revision === null) {
        expect(encoded).toContain('"revision":null');
      }
    }
    const invalid = [
      missingBaseline,
      { ...fixture.candidate, baseline: { retainedModuleAppIds: [], shellMode: 'fresh' } },
      { ...fixture.candidate, retainedShellRevision: 'a'.repeat(64) },
      { ...fixture.candidate, baseline: { retainedModuleAppIds: ['catalog'], revision: null, shellMode: 'fresh' } },
      { ...fixture.candidate, baseline: { retainedModuleAppIds: [], revision: null, shellMode: 'retained' } },
      {
        ...fixture.candidate,
        baseline: { retainedModuleAppIds: ['catalog', 'catalog'], revision: 'a'.repeat(64), shellMode: 'fresh' },
      },
      {
        ...fixture.candidate,
        baseline: { retainedModuleAppIds: ['inventory'], revision: 'a'.repeat(64), shellMode: 'fresh' },
      },
    ];
    for (const candidate of invalid) {
      const { layer, requests, statements } = fixture.makeProvider();
      yield* Schema.decodeUnknownEffect(ApplicationCompositionPublicationCandidateSchema, {
        onExcessProperty: 'error',
      })(candidate).pipe(
        Effect.flatMap((decoded) => observeCandidate('stage', decoded)),
        Effect.provide(layer),
        Effect.flip,
      );
      expect(requests).toEqual([]);
      expect(statements).toEqual([]);
    }
  }),
);

it.effect(
  'rejects unrelated native authority captured-absence mismatch and nonactive target retry before any publication mutation',
  () =>
    Effect.gen(function* nativeBaselinePreconditionFailures() {
      const { snapshot } = yield* candidateObservation;
      const other = yield* snapshotAt(OBSERVED_AT);
      const scenarios = [
        { current: other, phase: 'active' as const, revision: 'f'.repeat(64) },
        { current: other, phase: 'active' as const, revision: null },
        { phase: 'active' as const, revision: other.composition.revision },
        { current: snapshot, phase: 'draining' as const, revision: other.composition.revision },
        { current: snapshot, phase: 'sealed' as const, revision: other.composition.revision },
        { current: snapshot, phase: 'migrated' as const, revision: other.composition.revision },
      ];
      for (const scenario of scenarios) {
        const fixture = provider(
          () => new Response(null, { status: 404 }),
          KV_URL,
          true,
          'retired',
          scenario.current,
          scenario.phase,
        );
        const failure = yield* publishSnapshot(snapshot, Option.none(), initialCutoverProof, {
          retainedModuleAppIds: [],
          revision: scenario.revision,
          shellMode: 'fresh',
        }).pipe(Effect.provide(fixture.layer), Effect.flip);
        expect(Schema.is(ApplicationCompositionAuthorityError)(failure)).toBe(true);
        expect(fixture.requests).toEqual([]);
        expect(fixture.proofRequests).toEqual([]);
        expect(fixture.legacy.observations).toEqual([]);
        expect(fixture.authorityWrites).toEqual([]);
        expect(
          fixture.statements.some((statement) => /^(?:insert|update|delete|alter|create) /iu.test(statement)),
        ).toBe(false);
        expect(fixture.statements.filter((statement) => statement === PUBLICATION_LOCK_SQL)).toHaveLength(1);
        expect(fixture.statements.filter((statement) => statement === PUBLICATION_UNLOCK_SQL)).toHaveLength(1);
      }
    }),
);

it.effect(
  'keeps baseline-equals-target renewals in their existing phase and admission while accepting active target retries',
  () =>
    Effect.gen(function* preservesSameRevisionLifecycle() {
      const { snapshot } = yield* candidateObservation;
      const encoded = yield* encodeActiveApplicationCompositionSnapshot(snapshot);
      for (const phase of ['active', 'draining', 'sealed', 'migrated'] as const) {
        const fixture = provider(
          (request) => (request.method === 'PUT' ? Response.json({ success: true }) : new Response(encoded)),
          KV_URL,
          true,
          'retired',
          snapshot,
          phase,
        );
        const result = yield* publishSnapshot(snapshot, Option.none(), initialCutoverProof, {
          retainedModuleAppIds: snapshot.composition.modules.map(({ deployment }) => deployment.appId),
          revision: snapshot.composition.revision,
          shellMode: 'retained',
        }).pipe(Effect.provide(fixture.layer));
        expect(result).toEqual(snapshot);
        expect(fixture.authority()?.phase).toBe(phase);
        expect(fixture.authority()?.durableWorkAdmission).toBe('closed');
        expect(fixture.authorityWrites[0]?.slice(0, 4)).toEqual([
          'active',
          snapshot.composition.revision,
          phase,
          'closed',
        ]);
        expect(fixture.requests.map(({ method }) => method)).toEqual(['GET', 'PUT', 'GET']);
        expect(fixture.proofRequests).toEqual([]);
        expect(fixture.legacy.observations).toEqual([]);
        expect(fixture.statements.some((statement) => statement.startsWith('update '))).toBe(false);
      }
      const retry = provider(
        (request) => (request.method === 'PUT' ? Response.json({ success: true }) : new Response(encoded)),
        KV_URL,
        true,
        'retired',
        snapshot,
      );
      expect(
        yield* publishSnapshot(snapshot, Option.none(), initialCutoverProof, {
          retainedModuleAppIds: [],
          revision: 'f'.repeat(64),
          shellMode: 'fresh',
        }).pipe(Effect.provide(retry.layer)),
      ).toEqual(snapshot);
      expect(retry.authority()?.phase).toBe('active');
      expect(retry.requests.map(({ method }) => method)).toEqual(['GET', 'PUT', 'GET']);
      expect(retry.legacy.observations).toEqual([]);
      expect(retry.proofRequests).toEqual([]);
    }),
);

it.effect(
  'accepts fresh Shell with retained business only from exact baseline or canonical target pointer and rejects changed retained pins',
  () =>
    Effect.gen(function* providerBaselineAndExactTargetRetries() {
      const fixture = yield* candidateObservation;
      const baseline = fixture.snapshot;
      yield* TestClock.setTime(Date.parse(PUBLICATION_TIME) + 60_000);
      const target = yield* deriveActiveApplicationCompositionSnapshot({
        environment: 'stage',
        modules: [fixture.module],
        observedAt: yield* DateTime.now,
        shell: yield* shellArtifacts('fresh-shell-next-build'),
        validity: ACTIVE_APPLICATION_COMPOSITION_POLICY.validity,
      });
      const baselineEncoded = yield* encodeActiveApplicationCompositionSnapshot(baseline);
      const targetEncoded = yield* encodeActiveApplicationCompositionSnapshot(target);
      const metadata: (typeof ApplicationCompositionPublicationCandidateSchema.Type)['baseline'] = {
        retainedModuleAppIds: ['catalog'],
        revision: baseline.composition.revision,
        shellMode: 'fresh',
      };
      for (const currentPointer of [baselineEncoded, targetEncoded]) {
        const retry = provider(
          (request, index) =>
            request.method === 'PUT'
              ? Response.json({ success: true })
              : new Response(index === 0 ? currentPointer : targetEncoded),
          KV_URL,
          true,
          'retired',
          target,
        );
        expect(
          yield* publishSnapshot(target, Option.none(), initialCutoverProof, metadata).pipe(
            Effect.provide(retry.layer),
          ),
        ).toEqual(target);
        expect(retry.requests.map(({ method }) => method)).toEqual(['GET', 'PUT', 'GET']);
        expect(retry.requests[1]?.body).toBe(targetEncoded);
        expect(retry.legacy.observations).toEqual([]);
        expect(retry.proofRequests).toEqual([]);
      }
      const changedModule = yield* deployedModule('catalog', CATALOG_MODULE_ID, 'changed-retained-catalog-build');
      const changedTarget = yield* deriveActiveApplicationCompositionSnapshot({
        environment: 'stage',
        modules: [changedModule],
        observedAt: yield* DateTime.now,
        shell: yield* shellArtifacts('fresh-shell-next-build'),
        validity: ACTIVE_APPLICATION_COMPOSITION_POLICY.validity,
      });
      const denied = provider(() => new Response(baselineEncoded), KV_URL, true, 'retired', baseline, 'migrated');
      const failure = yield* publishSnapshot(changedTarget, Option.none(), initialCutoverProof, metadata).pipe(
        Effect.provide(denied.layer),
        Effect.flip,
      );
      expect(Schema.is(ActiveApplicationCompositionPublicationError)(failure)).toBe(true);
      expect(denied.requests.map(({ method }) => method)).toEqual(['GET']);
      expect(denied.transactionStatements.at(-1)).toBe('ROLLBACK');
      expect(denied.authority()?.phase).toBe('migrated');
    }),
);

const originServiceId = 'registered-node-service';
const originProjectId = 'registered-node-project';
const originServiceName = 'actual-node';
const originNativeHost = 'node-9.prg1.zerops.app';
const originPrivateValue = 'must-not-expose-origin-provider-body';

const backendOriginGateway = (
  options: {
    readonly envFile?: string;
    readonly providerFailure?: boolean;
    readonly serviceName?: string;
    readonly stageVariables?: Readonly<Record<string, string>>;
  } = {},
) => {
  const requests: { readonly method: string; readonly url: URL }[] = [];
  const client = HttpClient.make((request, url) => {
    requests.push({ method: request.method, url });
    return Effect.sync(() => {
      if (options.providerFailure === true) {
        return new Response(originPrivateValue, { status: 503 });
      }
      if (url.pathname.endsWith('/env-file')) {
        return Response.json({
          envFile: options.envFile ?? `${originServiceName}_zeropsSubdomain=${originNativeHost}`,
        });
      }
      return Response.json({
        name: options.serviceName ?? originServiceName,
        status: 'STOPPED',
        subdomainAccess: false,
      });
    }).pipe(Effect.map((response) => HttpClientResponse.fromWeb(request, response)));
  });
  return {
    layer: Layer.merge(
      ZeropsPublicApiLive.pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, client))),
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          STAGE_VARIABLES_JSON: JSON.stringify(
            options.stageVariables ?? { ZEROPS_CATALOG_SERVICE_ID: originServiceId },
          ),
          ZEROPS_PROJECT_ID: originProjectId,
          ZEROPS_TOKEN: 'zerops-test-token',
        }),
      ),
    ),
    requests,
  };
};

it.effect('captures approved legacy Node content only as an explicit non-reusable baseline', () =>
  Effect.gen(function* capturesLegacyBaselineOnly() {
    const fixture = yield* candidateObservation;
    const legacyBackend = yield* Schema.decodeUnknownEffect(ApplicationCompositionBackendSchema)({
      baseUrl: 'https://legacy-node.example/',
      transport: 'node-http',
    });
    const legacyUnrevised = {
      ...fixture.snapshot.composition,
      modules: fixture.snapshot.composition.modules.map((module) => ({
        ...module,
        backend: legacyBackend,
        contract: { ...module.contract, url: 'https://legacy-node.example/.well-known/ontos-module-manifest.json' },
      })),
    };
    const legacy = {
      ...fixture.snapshot,
      composition: { ...legacyUnrevised, revision: applicationCompositionRevision(legacyUnrevised) },
    };
    expect(yield* validateActiveApplicationCompositionSnapshot(legacy)).toEqual(legacy);
    const encoded = yield* encodeActiveApplicationCompositionSnapshot(legacy);
    const expired = {
      ...legacy,
      observedAt: DateTime.add(legacy.observedAt, { hours: -25 }),
      validUntil: DateTime.add(legacy.validUntil, { hours: -25 }),
    };
    const expiredEncoded = yield* encodeActiveApplicationCompositionSnapshot(expired);
    for (const baselineOnly of [false, true]) {
      const approved = provider(() => new Response(encoded), KV_URL, true, 'retired', legacy);
      const result = yield* captureApprovedApplicationCompositionSnapshot({ baselineOnly }).pipe(
        Effect.provide(approved.layer),
        Effect.exit,
      );
      expect(Exit.isSuccess(result)).toBe(baselineOnly);
      if (baselineOnly) {
        expect(result).toMatchObject({ value: Option.some(legacy) });
      }
      for (const scenario of [
        { body: 'not JSON', current: legacy },
        { body: expiredEncoded, current: legacy },
        { body: encoded, current: fixture.snapshot },
      ]) {
        const rejected = provider(() => new Response(scenario.body), KV_URL, true, 'retired', scenario.current);
        expect(
          Exit.isFailure(
            yield* captureApprovedApplicationCompositionSnapshot({ baselineOnly }).pipe(
              Effect.provide(rejected.layer),
              Effect.exit,
            ),
          ),
        ).toBe(true);
      }
      expect(approved.authorityWrites).toEqual([]);
      expect(approved.requests.map(({ method }) => method)).toEqual(['GET']);
    }
  }),
);

it.effect('discovers only the configured Node service automatic public origin without provisioning', () =>
  Effect.gen(function* discoversNativeBackendOrigin() {
    for (const value of [originNativeHost, `https://${originNativeHost}/`]) {
      const gateway = backendOriginGateway({ envFile: `${originServiceName}_zeropsSubdomain=${value}` });
      expect(yield* stageBackendUrl('catalog').pipe(Effect.provide(gateway.layer))).toBe(
        `https://${originNativeHost}/`,
      );
      expect(gateway.requests.map(({ method, url }) => `${method} ${url.pathname}`)).toEqual([
        `GET /api/rest/public/service-stack/${originServiceId}`,
        `GET /api/rest/public/project/${originProjectId}/env-file`,
      ]);
      expect(gateway.requests[1]?.url.searchParams.get('userOnly')).toBe('false');
      expect(gateway.requests[1]?.url.searchParams.get('reveal')).toBe('false');
    }
  }),
);

it.effect('rejects missing or unsafe automatic Node origins and redacts provider metadata failures', () =>
  Effect.gen(function* rejectsUnsafeNativeOrigin() {
    const unsafe = [
      '',
      `http://${originNativeHost}`,
      `https://user:password@${originNativeHost}`,
      `https://${originNativeHost}/private`,
      `https://${originNativeHost}/../`,
      `https://${originNativeHost}?secret=value`,
      `https://${originNativeHost}#fragment`,
      `https://${originNativeHost}:8443/`,
      'localhost',
      '127.0.0.1',
      [10, 0, 0, 1].join('.'),
      'example.com',
      'localhost.zerops.app',
    ];
    for (const value of unsafe) {
      const gateway = backendOriginGateway({ envFile: `${originServiceName}_zeropsSubdomain=${value}` });
      const failure = yield* stageBackendUrl('catalog').pipe(Effect.provide(gateway.layer), Effect.flip);
      expect(Schema.is(ActiveApplicationCompositionPublicationError)(failure)).toBe(true);
      expect(failure.message).toBe('The registered native Node backend origin could not be established');
      expect(gateway.requests.every(({ method }) => method === 'GET')).toBe(true);
    }
    const mismatched = backendOriginGateway({ envFile: `catalog_zeropsSubdomain=${originNativeHost}` });
    expect(Exit.isFailure(yield* stageBackendUrl('catalog').pipe(Effect.provide(mismatched.layer), Effect.exit))).toBe(
      true,
    );
    const missing = backendOriginGateway({ stageVariables: {} });
    expect(Exit.isFailure(yield* stageBackendUrl('catalog').pipe(Effect.provide(missing.layer), Effect.exit))).toBe(
      true,
    );
    expect(missing.requests).toEqual([]);
    for (const gateway of [
      backendOriginGateway({ serviceName: '' }),
      backendOriginGateway({ providerFailure: true }),
    ]) {
      const failure = yield* stageBackendUrl('catalog').pipe(Effect.provide(gateway.layer), Effect.flip);
      expect(Schema.is(ActiveApplicationCompositionPublicationError)(failure)).toBe(true);
      expect(JSON.stringify(failure)).not.toContain(originPrivateValue);
      expect(failure.message).toBe('The registered native Node backend origin could not be established');
    }
  }),
);
