import { NodeServices } from '@effect/platform-node';
import { ConfigProvider, DateTime, Effect, Fiber, FileSystem, Layer, Option, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { expect, it } from 'effect-rstest';
import { HttpClient, HttpClientResponse, HttpEffect } from 'effect/http';
import type { HttpServerRequest } from 'effect/http';

import { governedSharedSingletonPackages } from '../../module-federation.shared.ts';
import { CoreDatabase } from '../../packages/core-runtime/src/db/client.ts';
import {
  moduleReleaseAssetWorkerName,
  moduleReleaseWorkerName,
} from '../../packages/core-runtime/src/http/module-release-identity.ts';
import type { ActiveApplicationCompositionSnapshot } from '../../packages/core-runtime/src/index.ts';
import { ApplicationCompositionAuthorityError } from '../../packages/core-runtime/src/modules/application-composition-authority.ts';
import { ApplicationCompositionCloudflareWorkerBackendSchema } from '../../packages/core-runtime/src/modules/application-composition-backend.ts';
import { makeTestDatabase } from '../../packages/core-runtime/tests/support/database.ts';
import {
  ACTIVE_APPLICATION_COMPOSITION_POLICY,
  deriveActiveApplicationCompositionSnapshot,
  encodeActiveApplicationCompositionSnapshot,
} from '../active-application-composition.mts';
import { createShellRuntimeContract } from '../generate-ontos-shell-runtime-contract.mts';
import {
  resumeApplicationCompositionDurableWork,
  runApplicationCompositionMigration,
  ApplicationCompositionPublicationTimeout,
} from '../application-composition-authority-publication.mts';
import { ZeropsPublicApiLive } from '../zerops-public-api.mts';
import {
  developmentCompositionApplication,
  makeDevelopmentCompositionPointer,
} from '../siampark/development-composition.mts';

const OBSERVED_AT = '2026-10-02T16:00:00.000Z';
const SHELL_BUILD_MARKER = 'shell-lifecycle-build';
const MODULE_APP_ID = 'catalog';
const MODULE_BUILD_MARKER = 'catalog-lifecycle-build';
const OLD_REVISION = `sha256:${'1'.repeat(64)}`;
const INITIAL_NODE_ID = 'A'.repeat(22);
const INITIAL_ACCOUNT_ID = 'a'.repeat(32);
const INITIAL_NAMESPACE_ID = 'b'.repeat(32);
const INITIAL_NAMESPACE_PATH = `/client/v4/accounts/${INITIAL_ACCOUNT_ID}/storage/kv/namespaces/${INITIAL_NAMESPACE_ID}`;
const SESSION_UNLOCK = 'SESSION UNLOCK';
const MIGRATION_EVENT = 'MIGRATION';
const COMMITTED_DRAINING = 'COMMITTED draining';
const DURABLE_COMPLETE = 'DURABLE COMPLETE';
const DURABLE_BLOCKED = 'DURABLE BLOCKED';
const ROLLBACK_EVENT = 'TRANSACTION ROLLBACK';
const AUTHORITY_FROM = 'from "core"."application_composition_authority"';
const JsonText = Schema.fromJsonString(Schema.Unknown);
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

interface MigrationFixtureOptions {
  readonly currentSnapshot?: ActiveApplicationCompositionSnapshot;
  readonly durableBlocked?: () => boolean;
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
  const oldRevision = options.currentSnapshot?.composition.revision ?? OLD_REVISION;
  const validUntil =
    options.currentSnapshot === undefined
      ? new Date('2026-10-03T16:00:00.000Z')
      : DateTime.toDateUtc(options.currentSnapshot.validUntil);
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
      const blocked =
        options.durableBlocked?.() ?? options.durableBlocks?.[durableRead] ?? options.ownerWorkPending ?? false;
      durableRead += 1;
      events.push(blocked ? DURABLE_BLOCKED : DURABLE_COMPLETE);
      return [{ blocked }];
    }
    return [{ blocked: durableWork ? (options.ownerWorkPending ?? false) : (options.sealOutboxPending ?? false) }];
  };
  const stageAuthorityChange = (params: readonly unknown[]) => {
    const [next, , expectedRevision] = params;
    if (expectedRevision !== oldRevision || (next === 'sealed' && options.sealRevisionChanged === true)) {
      return [];
    }
    if (next === 'closed' || next === 'open') {
      if (phase !== 'active' || (next === 'open' && options.resumeUnexpired === false)) {
        return [];
      }
      pendingAdmissions[pendingAdmissions.length - 1] = next;
      return [{ revision: oldRevision }];
    }
    if (next === 'active' || next === 'draining' || next === 'sealed' || next === 'migrated') {
      pendingPhases[pendingPhases.length - 1] = next;
      return [{ revision: oldRevision }];
    }
    return [];
  };
  const client = HttpClient.make((request, destination) => {
    proofRequests.push(`${request.method} ${destination.href}`);
    events.push(`PROOF ${destination.href}`);
    if (destination.pathname.startsWith(INITIAL_NAMESPACE_PATH)) {
      const pointerResponse =
        destination.pathname === INITIAL_NAMESPACE_PATH
          ? Response.json({ errors: [], result: { id: INITIAL_NAMESPACE_ID }, success: true })
          : new Response(null, { status: 404 });
      return Effect.succeed(HttpClientResponse.fromWeb(request, pointerResponse));
    }
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
          } else if (sql.includes('as "validUntilMillis"')) {
            return [{ phase, revision: oldRevision, validUntilMillis: validUntil.getTime() }];
          } else if (sql.startsWith('select') && sql.includes(AUTHORITY_FROM)) {
            if (options.missingAuthority === true) {
              return [];
            }
            if (sql.includes('"durable_work_admission"')) {
              durablePoll = true;
              return [{ durableWorkAdmission: admission, phase, revision: oldRevision }];
            }
            return sql.includes('"valid_until"')
              ? [{ phase, revision: oldRevision, validUntil }]
              : [{ phase, revision: oldRevision }];
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
    const fiber = yield* runApplicationCompositionMigration(migration, Effect.void).pipe(
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
        Effect.void,
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
      Effect.void,
    ).pipe(Effect.provide(fixture.layer), Effect.forkChild);

    yield* TestClock.adjust('0 seconds');
    expect(fixture.phase()).toBe('active');
    expect(fixture.admission()).toBe('closed');
    expect(fixture.events).toContain(DURABLE_BLOCKED);
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
    const failure = yield* runApplicationCompositionMigration(Effect.fail('native migration failed'), Effect.void).pipe(
      Effect.provide(failed.layer),
      Effect.flip,
    );
    expect(failure).toBe('native migration failed');
    expect(failed.phase()).toBe('sealed');
    expect(failed.events).not.toContain('COMMITTED migrated');
    expect(failed.events.at(-1)).toBe(SESSION_UNLOCK);

    const completed = migrationFixture({ initialPhase: 'migrated' });
    const repeated = yield* runApplicationCompositionMigration(
      Effect.sync(() => {
        completed.events.push(MIGRATION_EVENT);
      }),
      Effect.void,
    ).pipe(Effect.provide(completed.layer), Effect.flip);
    expect(Schema.is(ApplicationCompositionAuthorityError)(repeated)).toBe(true);
    expect(completed.events).not.toContain(MIGRATION_EVENT);
    expect(completed.statements.some((statement) => statement.startsWith('update '))).toBe(false);
  }),
);

it.effect('bounds durable draining by the lease and leaves the current release active with admission closed', () =>
  Effect.gen(function* preservesActiveReleaseAfterDrainTimeout() {
    const fixture = migrationFixture({ leaseRemainingMillis: 35_000, ownerWorkPending: true });
    const fiber = yield* runApplicationCompositionMigration(
      Effect.sync(() => {
        fixture.events.push(MIGRATION_EVENT);
      }),
      Effect.void,
    ).pipe(Effect.provide(fixture.layer), Effect.flip, Effect.forkChild);
    yield* TestClock.adjust('5 seconds');
    const failure = yield* Fiber.join(fiber);

    expect(Schema.is(ApplicationCompositionPublicationTimeout)(failure)).toBe(true);
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

it.effect('serves the restored /active authority to the durable job that a native drain is waiting on', () =>
  Effect.gen(function* resumesDurableJobAfterPublisherRestart() {
    const snapshot = yield* completeSnapshot;
    const fs = yield* FileSystem.FileSystem;
    const statePath = `${yield* fs.makeTempDirectoryScoped()}/pointer.json`;
    let durablePending = true;
    const fixture = migrationFixture({ currentSnapshot: snapshot, durableBlocked: () => durablePending });
    const original = yield* makeDevelopmentCompositionPointer(statePath).pipe(Effect.provide(fixture.layer));
    yield* original.publish(snapshot);
    // A new publisher has no in-memory pointer. Its exact approved bytes survive the restart.
    const restarted = yield* makeDevelopmentCompositionPointer(statePath).pipe(Effect.provide(fixture.layer));
    const migration = yield* runApplicationCompositionMigration(Effect.void, Effect.void).pipe(
      Effect.provide(fixture.layer),
      Effect.forkChild,
    );
    yield* TestClock.adjust('0 seconds');
    expect(fixture.admission()).toBe('closed');
    expect(fixture.phase()).toBe('active');
    expect(fixture.events).toContain(DURABLE_BLOCKED);
    const handler = HttpEffect.toWebHandlerWith<never, HttpServerRequest.HttpServerRequest>(yield* Effect.context())(
      developmentCompositionApplication(restarted.load),
    );
    const response = yield* Effect.promise(() => handler(new Request('http://127.0.0.1/active')));
    expect(response.status).toBe(200);
    expect(yield* Effect.promise(() => response.text())).toBe(
      yield* encodeActiveApplicationCompositionSnapshot(snapshot),
    );
    durablePending = false;
    yield* TestClock.adjust('3 seconds');
    yield* Fiber.join(migration);
    expect(fixture.phase()).toBe('migrated');
    expect(Option.isNone(yield* restarted.load)).toBe(true);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('keeps the committed bytes across a crash before renewal commits and rejects stale or forged authority', () =>
  Effect.gen(function* restoresOnlyExactDatabaseApproval() {
    const snapshot = yield* completeSnapshot;
    const fs = yield* FileSystem.FileSystem;
    const statePath = `${yield* fs.makeTempDirectoryScoped()}/pointer.json`;
    const { revision: approvedRevision } = snapshot.composition;
    let revision = approvedRevision;
    let phase = 'active';
    let validUntilMillis = DateTime.toEpochMillis(snapshot.validUntil);
    const database = Layer.effect(
      CoreDatabase,
      makeTestDatabase(() => Effect.sync(() => [{ phase, revision, validUntilMillis }])).pipe(
        Effect.map((executor) => ({ executor })),
      ),
    );
    const pointer = yield* makeDevelopmentCompositionPointer(statePath).pipe(Effect.provide(database));
    yield* pointer.publish(snapshot);
    const renewed = { ...snapshot, validUntil: DateTime.add(snapshot.validUntil, { minutes: 1 }) };
    yield* pointer.publish(renewed);
    const restarted = yield* makeDevelopmentCompositionPointer(statePath).pipe(Effect.provide(database));
    expect(yield* restarted.load).toEqual(Option.some(yield* encodeActiveApplicationCompositionSnapshot(snapshot)));
    validUntilMillis = DateTime.toEpochMillis(renewed.validUntil);
    expect(yield* restarted.load).toEqual(Option.some(yield* encodeActiveApplicationCompositionSnapshot(renewed)));
    revision = '0'.repeat(64);
    expect(Option.isNone(yield* restarted.load)).toBe(true);
    revision = approvedRevision;
    phase = 'sealed';
    expect(Option.isNone(yield* restarted.load)).toBe(true);
    phase = 'draining';
    expect(Option.isSome(yield* restarted.load)).toBe(true);
    yield* TestClock.adjust('25 hours');
    expect(Option.isNone(yield* restarted.load)).toBe(true);
  }).pipe(Effect.provide(NodeServices.layer)),
);
