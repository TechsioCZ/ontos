import { ConfigProvider, DateTime, Effect, Fiber, Layer, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { expect, it } from 'effect-rstest';
import { HttpClient, HttpClientResponse } from 'effect/unstable/http';

import { governedSharedSingletonPackages } from '../../module-federation.shared.ts';
import { CoreDatabase } from '../../packages/core-runtime/src/db/client.ts';
import {
  moduleReleaseAssetWorkerName,
  moduleReleaseWorkerName,
} from '../../packages/core-runtime/src/http/module-release-identity.ts';
import type { ActiveApplicationCompositionSnapshot } from '../../packages/core-runtime/src/index.ts';
import { ActiveApplicationCompositionUnavailableError } from '../../packages/core-runtime/src/index.ts';
import { ApplicationCompositionAuthorityError } from '../../packages/core-runtime/src/modules/application-composition-authority.ts';
import { ApplicationCompositionCloudflareWorkerBackendSchema } from '../../packages/core-runtime/src/modules/application-composition-backend.ts';
import { makeTestDatabase } from '../../packages/core-runtime/tests/support/database.ts';
import {
  ACTIVE_APPLICATION_COMPOSITION_POLICY,
  ActiveApplicationCompositionPublicationError,
  deriveActiveApplicationCompositionSnapshot,
  encodeActiveApplicationCompositionSnapshot,
} from '../active-application-composition.mts';
import { createShellRuntimeContract } from '../generate-ontos-shell-runtime-contract.mts';
import {
  resumeApplicationCompositionDurableWork,
  runApplicationCompositionMigration,
} from '../application-composition-authority-publication.mts';
import { verifyInitialCutoverProviderInventory } from '../initial-composition-cutover-provider.mts';
import { assertPublishedShellIngressSnapshot } from '../publish-active-application-composition.mts';
import { ZeropsPublicApiLive } from '../zerops-public-api.mts';

const KV_URL = `https://api.cloudflare.com/client/v4/accounts/${'a'.repeat(32)}/storage/kv/namespaces/${'b'.repeat(32)}/values/active`;
const OBSERVED_AT = '2026-10-02T16:00:00.000Z';
const SHELL_BUILD_MARKER = 'shell-lifecycle-build';
const MODULE_APP_ID = 'catalog';
const MODULE_BUILD_MARKER = 'catalog-lifecycle-build';
const OLD_REVISION = `sha256:${'1'.repeat(64)}`;
const INITIAL_NODE_ID = 'A'.repeat(22);
const INITIAL_ACCOUNT_ID = 'c'.repeat(32);
const INITIAL_WORKER_NAME = 'old-shell-worker';
const SESSION_UNLOCK = 'SESSION UNLOCK';
const MIGRATION_EVENT = 'MIGRATION';
const COMMITTED_DRAINING = 'COMMITTED draining';
const DURABLE_COMPLETE = 'DURABLE COMPLETE';
const ROLLBACK_EVENT = 'TRANSACTION ROLLBACK';
const AUTHORITY_FROM = 'from "core"."application_composition_authority"';
const initialProviderProof = verifyInitialCutoverProviderInventory({
  cloudflare: { accountId: INITIAL_ACCOUNT_ID, workerNames: [INITIAL_WORKER_NAME] },
  zeropsServiceIds: [INITIAL_NODE_ID],
});
const JsonText = Schema.fromJsonString(Schema.Unknown);
const JsonRecord = Schema.Record(Schema.String, Schema.Unknown);
const artifact = (url: string, document: typeof JsonText.Type) => ({
  bytes: new TextEncoder().encode(Schema.encodeSync(JsonText)(document)),
  url,
});

const completeSnapshot = Effect.gen(function* deriveLifecycleSnapshot() {
  yield* TestClock.setTime(Date.parse('2026-10-02T16:02:00.000Z'));
  const shellAssets = yield* moduleReleaseAssetWorkerName('shell-super-app', SHELL_BUILD_MARKER);
  const moduleAssets = yield* moduleReleaseAssetWorkerName(MODULE_APP_ID, MODULE_BUILD_MARKER);
  const workerName = yield* moduleReleaseWorkerName(MODULE_APP_ID, MODULE_BUILD_MARKER);
  const backend = yield* Schema.decodeEffect(ApplicationCompositionCloudflareWorkerBackendSchema)({
    baseUrl: `https://${workerName}.test-account.workers.dev/`,
    transport: 'cloudflare-worker',
    versionId: '023e105f-2a42-4f8b-a1c1-73f6a2a30c0f',
    workerName,
  });
  return yield* deriveActiveApplicationCompositionSnapshot({
    environment: 'stage',
    modules: [
      {
        appId: MODULE_APP_ID,
        backend,
        contract: artifact(`https://${moduleAssets}.test-account.workers.dev/.well-known/ontos-module-manifest.json`, {
          deployment: { appId: MODULE_APP_ID, buildMarker: MODULE_BUILD_MARKER },
          manifest: {
            activation: {
              defaultState: 'inactive',
              preservesHistoryWhenInactive: true,
              scope: 'tenant',
              supportedStates: ['inactive', 'active'],
            },
            module: {
              description: 'Catalog products',
              displayName: 'Catalog',
              id: 'catalog.products',
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
        }),
      },
    ],
    observedAt: DateTime.makeUnsafe(OBSERVED_AT),
    shell: {
      federationManifest: artifact(`https://${shellAssets}.test-account.workers.dev/mf-manifest.json`, {
        exposes: [],
        name: 'shellSuperApp',
        shared: governedSharedSingletonPackages.map((name) => ({ name, requiredVersion: '1.0.0', singleton: true })),
      }),
      runtimeContract: artifact(
        `https://${shellAssets}.test-account.workers.dev/.well-known/ontos-shell-runtime.json`,
        createShellRuntimeContract(SHELL_BUILD_MARKER),
      ),
    },
    validity: ACTIVE_APPLICATION_COMPOSITION_POLICY.validity,
  });
});

const authorityRow = (snapshot: ActiveApplicationCompositionSnapshot) => ({
  phase: 'active',
  revision: snapshot.composition.revision,
  unexpired: true,
});

const shellReceipt = (snapshot: ActiveApplicationCompositionSnapshot) => ({
  deployment: snapshot.composition.shell.deployment,
  federationManifest: snapshot.composition.shell.federationManifest,
  runtimeContract: snapshot.composition.shell.runtimeContract,
});

const gateFixture = (value: string, authorityRows: readonly object[], status = 200) => {
  const requests: { readonly authorization: string | undefined; readonly method: string; readonly url: string }[] = [];
  const statements: string[] = [];
  const client = HttpClient.make((request, destination) => {
    requests.push({ authorization: request.headers.authorization, method: request.method, url: destination.href });
    return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(value, { status })));
  });
  return {
    layer: Layer.mergeAll(
      Layer.succeed(HttpClient.HttpClient, client),
      Layer.effect(
        CoreDatabase,
        makeTestDatabase((sql) =>
          Effect.sync(() => {
            statements.push(sql);
            if (sql.includes('as isolation')) {
              return [{ isolation: 'read committed' }];
            }
            return sql.includes(AUTHORITY_FROM) ? authorityRows : [];
          }),
        ).pipe(Effect.map((executor) => ({ executor }))),
      ),
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          [ACTIVE_APPLICATION_COMPOSITION_POLICY.sourceUrlVariable]: KV_URL,
          CLOUDFLARE_API_TOKEN: 'shell-lifecycle-publication-token',
        }),
      ),
    ),
    requests,
    statements,
  };
};

it.effect('admits only the exact Shell receipt in the fresh published release and active database authority', () =>
  Effect.gen(function* admitsPublishedShellIngress() {
    const snapshot = yield* completeSnapshot;
    const encoded = yield* encodeActiveApplicationCompositionSnapshot(snapshot);
    const { layer, requests, statements } = gateFixture(encoded, [authorityRow(snapshot)]);

    yield* assertPublishedShellIngressSnapshot(shellReceipt(snapshot)).pipe(Effect.provide(layer));

    expect(requests).toEqual([
      { authorization: 'Bearer shell-lifecycle-publication-token', method: 'GET', url: KV_URL },
    ]);
    expect(statements.some((statement) => statement.includes('application_composition_authority'))).toBe(true);
    expect(statements.some((statement) => statement.includes('ontos.application-composition-publication'))).toBe(false);
    expect(statements.some((statement) => /^(?:insert|update|delete) /u.test(statement))).toBe(false);
  }),
);

it.effect('refuses Shell mutation when database authority is missing, different, expired, draining, or sealed', () =>
  Effect.gen(function* rejectsUnapprovedShellAuthority() {
    const snapshot = yield* completeSnapshot;
    const encoded = yield* encodeActiveApplicationCompositionSnapshot(snapshot);
    const active = authorityRow(snapshot);
    const states = [
      { name: 'missing', rows: [] },
      { name: 'different revision', rows: [{ ...active, revision: `sha256:${'0'.repeat(64)}` }] },
      { name: 'expired', rows: [{ ...active, unexpired: false }] },
      { name: 'draining', rows: [{ ...active, phase: 'draining' }] },
      { name: 'sealed', rows: [{ ...active, phase: 'sealed' }] },
      { name: 'migrated', rows: [{ ...active, phase: 'migrated' }] },
    ];
    for (const state of states) {
      const { layer, requests, statements } = gateFixture(encoded, state.rows);
      let ingressMutated = false;
      const failure = yield* assertPublishedShellIngressSnapshot(shellReceipt(snapshot)).pipe(
        Effect.andThen(
          Effect.sync(() => {
            ingressMutated = true;
          }),
        ),
        Effect.provide(layer),
        Effect.flip,
      );

      expect({ refused: Schema.is(ActiveApplicationCompositionPublicationError)(failure), state: state.name }).toEqual({
        refused: true,
        state: state.name,
      });
      expect(ingressMutated).toBe(false);
      expect(requests.map(({ method }) => method)).toEqual(['GET']);
      expect(statements.some((statement) => /^(?:insert|update|delete) /u.test(statement))).toBe(false);
    }
  }),
);

it.effect('refuses a changed Shell build marker, artifact URL, or digest before ingress mutation', () =>
  Effect.gen(function* rejectsDifferentShellReceipt() {
    const snapshot = yield* completeSnapshot;
    const encoded = yield* encodeActiveApplicationCompositionSnapshot(snapshot);
    const approved = shellReceipt(snapshot);
    const digest = '0'.repeat(64);
    const receipts = [
      { ...approved, deployment: { ...approved.deployment, buildMarker: 'different-shell-build' } },
      {
        ...approved,
        runtimeContract: {
          ...approved.runtimeContract,
          url: 'https://shell.example/.well-known/ontos-shell-runtime.json',
        },
      },
      { ...approved, runtimeContract: { ...approved.runtimeContract, sha256: digest } },
      {
        ...approved,
        federationManifest: { ...approved.federationManifest, url: 'https://shell.example/mf-manifest.json' },
      },
      { ...approved, federationManifest: { ...approved.federationManifest, sha256: digest } },
    ];
    for (const receipt of receipts) {
      const { layer, requests, statements } = gateFixture(encoded, [authorityRow(snapshot)]);
      let ingressMutated = false;
      const failure = yield* assertPublishedShellIngressSnapshot(receipt).pipe(
        Effect.andThen(
          Effect.sync(() => {
            ingressMutated = true;
          }),
        ),
        Effect.provide(layer),
        Effect.flip,
      );

      expect(Schema.is(ActiveApplicationCompositionPublicationError)(failure)).toBe(true);
      expect(ingressMutated).toBe(false);
      expect(requests.map(({ method }) => method)).toEqual(['GET']);
      expect(statements.some((statement) => /^(?:insert|update|delete) /u.test(statement))).toBe(false);
    }
  }),
);

it.effect('never admits a Shell from missing, malformed, unavailable, or expired publication evidence', () =>
  Effect.gen(function* rejectsUnavailableShellPublication() {
    const snapshot = yield* completeSnapshot;
    const encoded = yield* encodeActiveApplicationCompositionSnapshot(snapshot);
    const document = yield* Schema.decodeEffect(Schema.fromJsonString(JsonRecord))(encoded);
    const composition = yield* Schema.decodeUnknownEffect(JsonRecord)(document.composition);
    const modules = yield* Schema.decodeUnknownEffect(Schema.Array(JsonRecord))(composition.modules);
    const missingBackend = yield* Schema.encodeEffect(JsonText)({
      ...document,
      composition: { ...composition, modules: modules.map((module) => ({ ...module, backend: null })) },
    });
    const sources = [
      { status: 404, value: '' },
      { status: 200, value: '{}' },
      { status: 200, value: missingBackend },
      { status: 503, value: encoded },
    ];
    for (const source of sources) {
      const { layer, requests } = gateFixture(source.value, [authorityRow(snapshot)], source.status);
      const failure = yield* assertPublishedShellIngressSnapshot(shellReceipt(snapshot)).pipe(
        Effect.provide(layer),
        Effect.flip,
      );
      expect(Schema.is(ActiveApplicationCompositionPublicationError)(failure)).toBe(true);
      expect(requests.map(({ method }) => method)).toEqual(['GET']);
    }
    yield* TestClock.setTime(DateTime.toEpochMillis(snapshot.validUntil));
    const expired = gateFixture(encoded, [authorityRow(snapshot)]);
    const failure = yield* assertPublishedShellIngressSnapshot(shellReceipt(snapshot)).pipe(
      Effect.provide(expired.layer),
      Effect.flip,
    );
    expect(Schema.is(ActiveApplicationCompositionUnavailableError)(failure)).toBe(true);
    expect(expired.requests.map(({ method }) => method)).toEqual(['GET']);
  }),
);

interface MigrationFixtureOptions {
  readonly durableBlocks?: readonly boolean[];
  readonly initialPhase?: 'active' | 'draining' | 'sealed' | 'migrated';
  readonly leaseRemainingMillis?: number;
  readonly legacyTransactionsActive?: boolean;
  readonly missingAuthority?: boolean;
  readonly ownerWorkPending?: boolean;
  readonly progressBlocks?: readonly boolean[];
  readonly resumeUnexpired?: boolean;
  readonly schemaInitialized?: boolean;
  readonly sealOutboxPending?: boolean;
  readonly sealRevisionChanged?: boolean;
}

const migrationFixture = (options: MigrationFixtureOptions = {}) => {
  let phase = options.initialPhase ?? 'active';
  let admission = 'open';
  let progressRead = 0;
  let durableRead = 0;
  let durablePoll = false;
  const pendingPhases: (typeof phase | undefined)[] = [];
  const pendingAdmissions: (string | undefined)[] = [];
  const statements: string[] = [];
  const events: string[] = [];
  const proofRequests: string[] = [];
  const recordTransaction = (sql: string) => {
    if (sql === 'BEGIN') {
      pendingPhases.push(undefined);
      pendingAdmissions.push(undefined);
    } else if (sql === 'COMMIT') {
      const changed = pendingPhases.pop();
      const changedAdmission = pendingAdmissions.pop();
      if (changed !== undefined) {
        phase = changed;
        events.push(`COMMITTED ${phase}`);
      }
      if (changedAdmission !== undefined) {
        admission = changedAdmission;
        events.push(`COMMITTED admission ${admission}`);
      }
    } else if (sql === 'ROLLBACK') {
      pendingPhases.pop();
      pendingAdmissions.pop();
      events.push(ROLLBACK_EVENT);
    }
  };
  const blockedWork = (sql: string) => {
    if (sql.includes('pg_stat_activity')) {
      events.push('LEGACY TRANSACTION CHECK');
      return [{ blocked: options.legacyTransactionsActive ?? false }];
    }
    const durableWork = sql.includes('application_composition_durable_work');
    const outboxWork = sql.includes('outbox_messages');
    if (durableWork && outboxWork) {
      const blocked = options.progressBlocks?.[progressRead] ?? false;
      progressRead += 1;
      events.push(blocked ? 'DRAIN BLOCKED' : 'DRAIN COMPLETE');
      return [{ blocked }];
    }
    if (durablePoll) {
      durablePoll = false;
      const blocked = options.durableBlocks?.[durableRead] ?? options.ownerWorkPending ?? false;
      durableRead += 1;
      events.push(blocked ? 'DURABLE BLOCKED' : DURABLE_COMPLETE);
      return [{ blocked }];
    }
    return [{ blocked: durableWork ? (options.ownerWorkPending ?? false) : (options.sealOutboxPending ?? false) }];
  };
  const stageAuthorityChange = (params: readonly unknown[]) => {
    const [next, , expectedRevision] = params;
    if (expectedRevision !== OLD_REVISION || (next === 'sealed' && options.sealRevisionChanged === true)) {
      return [];
    }
    if (next === 'closed' || next === 'open') {
      if (phase !== 'active' || (next === 'open' && options.resumeUnexpired === false)) {
        return [];
      }
      pendingAdmissions[pendingAdmissions.length - 1] = next;
      return [{ revision: OLD_REVISION }];
    }
    if (next === 'active' || next === 'draining' || next === 'sealed' || next === 'migrated') {
      pendingPhases[pendingPhases.length - 1] = next;
      return [{ revision: OLD_REVISION }];
    }
    return [];
  };
  const client = HttpClient.make((request, destination) => {
    proofRequests.push(`${request.method} ${destination.href}`);
    events.push(`PROOF ${destination.href}`);
    const response =
      destination.pathname === `/api/rest/public/service-stack/${INITIAL_NODE_ID}`
        ? Response.json({ error: { code: 'serviceStackNotFound' } }, { status: 400 })
        : Response.json({ errors: [{ code: 10_007 }], success: false }, { status: 404 });
    return Effect.succeed(HttpClientResponse.fromWeb(request, response));
  });
  const layer = Layer.mergeAll(
    Layer.succeed(HttpClient.HttpClient, client),
    ZeropsPublicApiLive.pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, client))),
    ConfigProvider.layer(
      ConfigProvider.fromUnknown({
        CLOUDFLARE_API_TOKEN: 'cutover-provider-token',
        ZEROPS_TOKEN: 'cutover-node-token',
      }),
    ),
    Layer.effect(
      CoreDatabase,
      makeTestDatabase((sql, params) =>
        Effect.sync(() => {
          statements.push(sql);
          recordTransaction(sql);
          if (sql.includes('pg_advisory_unlock(')) {
            events.push(SESSION_UNLOCK);
            return [{ unlocked: true }];
          }
          if (sql.includes('pg_advisory_lock(')) {
            events.push('SESSION LOCK');
            return [];
          }
          if (sql.includes('as initialized')) {
            return [{ initialized: options.schemaInitialized ?? true }];
          } else if (sql.includes('as isolation')) {
            return [{ isolation: 'read committed' }];
          } else if (sql.includes('as remaining')) {
            return [{ remaining: options.leaseRemainingMillis ?? 1_230_000 }];
          } else if (sql.startsWith('select') && sql.includes(AUTHORITY_FROM)) {
            if (options.missingAuthority === true) {
              return [];
            }
            if (sql.includes('"durable_work_admission"')) {
              durablePoll = true;
              return [{ durableWorkAdmission: admission, phase, revision: OLD_REVISION }];
            }
            return sql.includes('"valid_until"')
              ? [{ phase, revision: OLD_REVISION, validUntil: new Date('2026-10-03T16:00:00.000Z') }]
              : [{ phase, revision: OLD_REVISION }];
          } else if (sql.includes('as blocked')) {
            return blockedWork(sql);
          } else if (sql.startsWith('update "core"."application_composition_authority"')) {
            return stageAuthorityChange(params);
          }
          return [];
        }),
      ).pipe(Effect.map((executor) => ({ executor }))),
    ),
  );
  return { admission: () => admission, events, layer, phase: () => phase, proofRequests, statements };
};

it.effect('commits draining and sealing before migration, then records completion under the same session lock', () =>
  Effect.gen(function* migratesOnlyAfterCommittedSeal() {
    const fixture = migrationFixture({ progressBlocks: [true, false] });
    const migration = Effect.sync(() => {
      expect(fixture.phase()).toBe('sealed');
      fixture.events.push(MIGRATION_EVENT);
      return 'native-migration-complete';
    });
    const fiber = yield* runApplicationCompositionMigration(migration, initialProviderProof).pipe(
      Effect.provide(fixture.layer),
      Effect.forkChild,
    );
    yield* TestClock.adjust('3 seconds');
    expect(yield* Fiber.join(fiber)).toBe('native-migration-complete');

    expect(fixture.events).toEqual([
      'SESSION LOCK',
      'COMMITTED admission closed',
      DURABLE_COMPLETE,
      COMMITTED_DRAINING,
      'DRAIN BLOCKED',
      'DRAIN COMPLETE',
      'COMMITTED sealed',
      MIGRATION_EVENT,
      'COMMITTED migrated',
      SESSION_UNLOCK,
    ]);
    expect(fixture.phase()).toBe('migrated');
    expect(fixture.proofRequests).toEqual([]);
    expect(fixture.statements.some((statement) => statement.startsWith('SAVEPOINT'))).toBe(false);
  }),
);

it.effect('keeps the drain committed and never migrates when the final seal finds new work or a changed revision', () =>
  Effect.gen(function* retainsCommittedDrainAfterSealFailure() {
    for (const options of [{ sealOutboxPending: true }, { sealRevisionChanged: true }]) {
      const fixture = migrationFixture(options);
      const failure = yield* runApplicationCompositionMigration(
        Effect.sync(() => {
          fixture.events.push(MIGRATION_EVENT);
        }),
        initialProviderProof,
      ).pipe(Effect.provide(fixture.layer), Effect.flip);

      expect(Schema.is(ApplicationCompositionAuthorityError)(failure)).toBe(true);
      expect(fixture.phase()).toBe('draining');
      expect(fixture.events).toContain(COMMITTED_DRAINING);
      expect(fixture.events).toContain(ROLLBACK_EVENT);
      expect(fixture.events).not.toContain(MIGRATION_EVENT);
      expect(fixture.events.at(-1)).toBe(SESSION_UNLOCK);
    }
  }),
);

it.effect('closes new durable admission and leaves existing jobs active until the durable ledger is empty', () =>
  Effect.gen(function* waitsForDurableOwnerCompletion() {
    const fixture = migrationFixture({ durableBlocks: [true, false] });
    const fiber = yield* runApplicationCompositionMigration(
      Effect.sync(() => {
        fixture.events.push(MIGRATION_EVENT);
      }),
      initialProviderProof,
    ).pipe(Effect.provide(fixture.layer), Effect.forkChild);

    yield* TestClock.adjust('0 seconds');
    expect(fixture.phase()).toBe('active');
    expect(fixture.admission()).toBe('closed');
    expect(fixture.events).toContain('DURABLE BLOCKED');
    expect(fixture.events).not.toContain(COMMITTED_DRAINING);
    expect(fixture.events).not.toContain(MIGRATION_EVENT);

    yield* TestClock.adjust('3 seconds');
    yield* Fiber.join(fiber);
    expect(fixture.phase()).toBe('migrated');
    expect(fixture.events.indexOf(DURABLE_COMPLETE)).toBeLessThan(fixture.events.indexOf(COMMITTED_DRAINING));
    expect(fixture.events.at(-1)).toBe(SESSION_UNLOCK);
  }),
);

it.effect('preserves the sealed fence after native migration failure and refuses a repeated completed migration', () =>
  Effect.gen(function* preservesMigrationFailureFence() {
    const failed = migrationFixture();
    const failure = yield* runApplicationCompositionMigration(
      Effect.fail('native migration failed'),
      initialProviderProof,
    ).pipe(Effect.provide(failed.layer), Effect.flip);
    expect(failure).toBe('native migration failed');
    expect(failed.phase()).toBe('sealed');
    expect(failed.events).not.toContain('COMMITTED migrated');
    expect(failed.events.at(-1)).toBe(SESSION_UNLOCK);

    const completed = migrationFixture({ initialPhase: 'migrated' });
    const repeated = yield* runApplicationCompositionMigration(
      Effect.sync(() => {
        completed.events.push(MIGRATION_EVENT);
      }),
      initialProviderProof,
    ).pipe(Effect.provide(completed.layer), Effect.flip);
    expect(Schema.is(ApplicationCompositionAuthorityError)(repeated)).toBe(true);
    expect(completed.events).not.toContain(MIGRATION_EVENT);
    expect(completed.statements.some((statement) => statement.startsWith('update '))).toBe(false);
  }),
);

it.effect('requires native provider absence and quiescent database transactions before the first migration', () =>
  Effect.gen(function* verifiesInitialMigrationRetirement() {
    for (const options of [{ missingAuthority: true }, { schemaInitialized: false }]) {
      const fixture = migrationFixture(options);
      yield* runApplicationCompositionMigration(
        Effect.sync(() => {
          fixture.events.push(MIGRATION_EVENT);
        }),
        initialProviderProof,
      ).pipe(Effect.provide(fixture.layer));
      expect(fixture.proofRequests).toHaveLength(2);
      expect(fixture.events.indexOf('LEGACY TRANSACTION CHECK')).toBeLessThan(fixture.events.indexOf(MIGRATION_EVENT));
      expect(fixture.events.at(-1)).toBe(SESSION_UNLOCK);
      expect(fixture.statements).not.toContain('BEGIN');
      if (options.schemaInitialized === false) {
        expect(fixture.statements.some((statement) => statement.includes(AUTHORITY_FROM))).toBe(false);
      }
    }

    const blocked = migrationFixture({ legacyTransactionsActive: true, missingAuthority: true });
    const failure = yield* runApplicationCompositionMigration(
      Effect.sync(() => {
        blocked.events.push(MIGRATION_EVENT);
      }),
      initialProviderProof,
    ).pipe(Effect.provide(blocked.layer), Effect.flip);
    expect(Schema.is(ApplicationCompositionAuthorityError)(failure)).toBe(true);
    expect(blocked.proofRequests).toHaveLength(2);
    expect(blocked.events).not.toContain(MIGRATION_EVENT);
    expect(blocked.events.at(-1)).toBe(SESSION_UNLOCK);
  }),
);

it.effect('bounds durable draining by the lease and leaves the current release active with admission closed', () =>
  Effect.gen(function* preservesActiveReleaseAfterDrainTimeout() {
    const fixture = migrationFixture({ leaseRemainingMillis: 35_000, ownerWorkPending: true });
    const fiber = yield* runApplicationCompositionMigration(
      Effect.sync(() => {
        fixture.events.push(MIGRATION_EVENT);
      }),
      initialProviderProof,
    ).pipe(Effect.provide(fixture.layer), Effect.flip, Effect.forkChild);
    yield* TestClock.adjust('5 seconds');
    const failure = yield* Fiber.join(fiber);

    expect(Schema.is(ApplicationCompositionAuthorityError)(failure)).toBe(true);
    expect(fixture.phase()).toBe('active');
    expect(fixture.admission()).toBe('closed');
    expect(fixture.events).not.toContain(COMMITTED_DRAINING);
    expect(fixture.events).not.toContain(MIGRATION_EVENT);
    expect(fixture.events.at(-1)).toBe(SESSION_UNLOCK);

    yield* resumeApplicationCompositionDurableWork(OLD_REVISION).pipe(Effect.provide(fixture.layer));
    expect(fixture.phase()).toBe('active');
    expect(fixture.admission()).toBe('open');
    expect(fixture.events).toContain('COMMITTED admission open');
  }),
);

it.effect('refuses operator resumption for an expired, different, or already retired authority', () =>
  Effect.gen(function* rejectsUnsafeDurableResumption() {
    const states = [
      { options: { resumeUnexpired: false }, revision: OLD_REVISION },
      { options: {}, revision: `sha256:${'0'.repeat(64)}` },
      { options: { initialPhase: 'sealed' as const }, revision: OLD_REVISION },
    ];
    for (const state of states) {
      const fixture = migrationFixture(state.options);
      const failure = yield* resumeApplicationCompositionDurableWork(state.revision).pipe(
        Effect.provide(fixture.layer),
        Effect.flip,
      );
      expect(Schema.is(ApplicationCompositionAuthorityError)(failure)).toBe(true);
      expect(fixture.events).not.toContain('COMMITTED admission open');
      expect(fixture.events).toContain(ROLLBACK_EVENT);
      expect(fixture.events.at(-1)).toBe(SESSION_UNLOCK);
    }
  }),
);
