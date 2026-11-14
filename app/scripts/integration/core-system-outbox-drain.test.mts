/**
 * Stage's shape on 13 November 2026, and the release that has to get past it.
 *
 * Core's own Outbox work must be claimable in a tenant that has no module state for `core.authorization`, because
 * Core is not an installable tenant module and nothing ever writes such a row. A pending, never-attempted
 * core-system delivery must then carry over into the next release instead of blocking its drain, and a drain that
 * could never finish must be refused before durable admission closes, so the running release keeps serving.
 *
 * Without the claim-eligibility fix the first expectation collapses: every core-system delivery stays `pending`
 * with zero attempts for ever. Without the carry-over the publication waits for it until its budget expires and
 * leaves the authority in `draining`, which is the 45-minute storefront outage this suite exists to prevent.
 */
import { applicationCompositionContentRevision } from '@app/core-runtime';
import { NodeChildProcessSpawner, NodeServices } from '@effect/platform-node';
import { and, eq, sql } from 'drizzle-orm';
import { Clock, Crypto, DateTime, Deferred, Duration, Effect, Fiber, Layer, Option, Ref, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { CoreDatabase, makeCoreDatabase } from '../../packages/core-runtime/src/db/client.ts';
import type { CoreDbExecutor } from '../../packages/core-runtime/src/db/types.ts';
import {
  applicationCompositionAuthority,
  applicationCompositionDrainAbandonments,
  domainEvents,
  outboxDeliveries,
  outboxDeliveryResolutions,
  outboxMessages,
  tenantModuleStates,
  tenants,
} from '../../packages/core-runtime/src/db/schema.ts';
import {
  ApplicationCompositionAuthorityError,
  carriedOverCoreSystemWorkerKeys,
} from '../../packages/core-runtime/src/modules/application-composition-authority.ts';
import {
  classifyDrainWork,
  describeWorkerKeyIdentity,
  listDrainWork,
} from '../../packages/core-runtime/src/outbox/drain-preflight.ts';
import {
  countStalledUnmatchedMessages,
  listUndrainableOutboxWork,
} from '../../packages/core-runtime/src/outbox/undrainable-work.ts';
import {
  ActiveApplicationCompositionService,
  validateActiveApplicationCompositionSnapshot,
} from '../../packages/core-runtime/src/modules/active-application-composition.ts';
import {
  LegacyCompletionPublication,
  LegacyCompletionTransactionIdSchema,
} from '../../packages/core-runtime/src/modules/legacy-completion-publication.ts';
import { corePrincipalLifecycleSubscription } from '../../packages/core-runtime/src/outbox/core-system-subscriptions.ts';
import {
  corePeopleSearchOutboxWorkers,
  coreSystemOutboxWorkers,
} from '../../packages/core-runtime/src/outbox/core-system-worker-entry.ts';
import { makeOutboxRepository } from '../../packages/core-runtime/src/outbox/repository.ts';
import { withWorkerRuntimeBinding } from '../../packages/core-runtime/src/outbox/worker-runtime-binding.ts';
import { makeIsolatedNativeDatabaseFixture } from '../../packages/core-runtime/src/testing/isolated-native-database.ts';
import { makeApplicationCompositionSnapshotFixture } from '../../packages/core-runtime/src/testing/module-contract.ts';
import {
  APPLICATION_COMPOSITION_PUBLICATION_BUDGETS,
  publishApplicationCompositionAuthoritySnapshot,
  runApplicationCompositionMigration,
  withApplicationCompositionPublicationLock,
} from '../application-composition-authority-publication.mts';
import { abandonDrainAsOperator, CompositionAbandonDrainCommandError } from '../composition-abandon-drain.mts';

const services = NodeChildProcessSpawner.layer.pipe(Layer.provideMerge(NodeServices.layer));
const FIXTURE_NAME = 'core-system-drain';
const CLAIM_OWNER = `${FIXTURE_NAME}-claimer`;
/** All five shipped core-system registrations, exactly as the Zerops Outbox host binds them. */
const ALL_CORE_WORKERS = [...coreSystemOutboxWorkers, ...corePeopleSearchOutboxWorkers];
/** The window in which a promotion may refuse reads: the quiescent drain, not a budget's worth of outage. */
const QUIESCENT_WINDOW_MS = 30_000;
/** A tenant-module worker key the fixture composition never approves, so nothing can consume it. */
const ABSENT_WORKER_KEY = 'commerce.merchandise.project-offer';
/** The tenant module the fixture never installs. */
const ABSENT_CONSUMER = 'commerce.merchandise';
/** How every refusal before admission closes reads. */
const REFUSED_BEFORE_ADMISSION = 'drain was not started: durable admission is unchanged';
/** How a failed publication reports that it returned the authority itself. */
const RETURNED_TO_ACTIVE = 'returned to active with durable admission open';

const snapshotFor = (buildMarker: string, validitySeconds: number) =>
  Effect.gen(function* buildSnapshot() {
    const base = yield* makeApplicationCompositionSnapshotFixture([FIXTURE_NAME], buildMarker);
    return yield* validateActiveApplicationCompositionSnapshot({
      ...base,
      composition: {
        ...base.composition,
        revision: yield* applicationCompositionContentRevision(base.composition),
      },
      validUntil: DateTime.addDuration(yield* DateTime.now, Duration.seconds(validitySeconds)),
    });
  });

/** An isolated database carrying stage's shape: an old active revision and one unclaimed core-system delivery. */
const fixture = Effect.fn('coreSystemDrainFixture')(function* coreSystemDrainFixture() {
  const isolated = yield* makeIsolatedNativeDatabaseFixture({
    mode: 'empty',
    purpose: 'publication-drain-core-system',
  });
  yield* isolated.migrateCoreSchema();
  const old = yield* snapshotFor(`${FIXTURE_NAME}-old`, 3600);
  yield* isolated.publishInitialComposition(old);
  const admin = yield* makeCoreDatabase(isolated.connections.admin);
  const { executor: runtime } = yield* makeCoreDatabase(isolated.connections.runtime);
  const runtimeTarget = {
    databaseName: isolated.connections.runtime.database,
    host: isolated.connections.runtime.host,
    port: isolated.connections.runtime.port,
    user: isolated.connections.runtime.user,
  };
  const [identity] = yield* admin.executor.execute<{
    readonly databaseName: string;
    readonly databaseOid: string;
    readonly databaseUser: string;
    readonly runtimeRoleOid: string;
    readonly systemIdentifier: string;
  }>(
    sql`select current_database() as "databaseName", (select oid::text from pg_database where datname=current_database()) as "databaseOid",
    current_user as "databaseUser", (select oid::text from pg_roles where rolname=${isolated.connections.runtime.user}) as "runtimeRoleOid",
    (pg_control_system()).system_identifier::text as "systemIdentifier"`,
    'objects',
  );
  if (identity === undefined) {
    return yield* Effect.die('Missing native test identity');
  }
  const binding = {
    ...identity,
    observedAt: yield* DateTime.now,
    runtimeTarget,
    runtimeUser: runtimeTarget.user,
    transactionId: yield* Schema.decodeUnknownEffect(LegacyCompletionTransactionIdSchema)('native-core-system-drain'),
  };
  // The legacy owner gate is not under test here; one artificial owner attests absence.
  const owners = Layer.succeed(LegacyCompletionPublication, {
    owners: [
      {
        producerModuleKey: 'fixture.owner',
        topic: 'fixture.completed',
        withLease: (run) =>
          run({
            binding,
            verify: (observation) =>
              Effect.succeed({
                binding: observation.binding,
                evidenceReference: observation.evidenceReference,
                status: 'VERIFIED_ABSENT',
              }),
          }),
      },
    ],
    retainEvidence: () => Effect.void,
    runtimeTarget,
    runtimeUser: runtimeTarget.user,
  });
  const tenantId = yield* Crypto.Crypto.use((crypto) => crypto.randomUUIDv4());
  yield* runtime.insert(tenants).values({
    defaultLocale: 'en',
    name: 'Core system drain fixture',
    slug: `${FIXTURE_NAME}-${tenantId}`,
    status: 'active',
    tenantId,
  });
  // Deliberately no `core.authorization` module state: no product code ever writes one, exactly as on stage.
  const messageId = yield* runtime.transaction(
    Effect.fn(function* acceptPrincipalLifecycleWork(transaction) {
      const [event] = yield* transaction
        .insert(domainEvents)
        .values({
          eventType: corePrincipalLifecycleSubscription.topic,
          payloadJson: {},
          producerModuleKey: corePrincipalLifecycleSubscription.producerModuleKey,
          subjectModuleKey: corePrincipalLifecycleSubscription.producerModuleKey,
          subjectResourceId: tenantId,
          subjectResourceType: 'principal',
          tenantId,
        })
        .returning({ id: domainEvents.domainEventId });
      const [message] = yield* transaction
        .insert(outboxMessages)
        .values({
          domainEventId: Option.getOrThrow(Option.fromNullishOr(event)).id,
          payloadJson: { data: { principalId: tenantId, state: 'disabled', tenantId }, schemaVersion: 1 },
          producerModuleKey: corePrincipalLifecycleSubscription.producerModuleKey,
          tenantId,
          topic: corePrincipalLifecycleSubscription.topic,
        })
        .returning({ id: outboxMessages.outboxMessageId });
      return Option.getOrThrow(Option.fromNullishOr(message)).id;
    }),
  );
  const repository = makeOutboxRepository(runtime, yield* Crypto.Crypto);
  yield* repository.matchUnmatched(old.composition.revision, yield* DateTime.nowAsDate);
  return {
    admin,
    layer: Layer.merge(owners, Layer.succeed(CoreDatabase, admin)),
    messageId,
    old,
    repository,
    runtime,
    tenantId,
  };
});

const authorityRow = (runtime: CoreDbExecutor) =>
  runtime
    .select({
      durableWorkAdmission: applicationCompositionAuthority.durableWorkAdmission,
      phase: applicationCompositionAuthority.phase,
      revision: applicationCompositionAuthority.revision,
    })
    .from(applicationCompositionAuthority)
    .pipe(Effect.map((rows) => rows[0]));

const deliveryRow = (runtime: CoreDbExecutor) =>
  runtime
    .select({
      attempts: outboxDeliveries.attemptsCount,
      claimedBy: outboxDeliveries.claimedBy,
      status: outboxDeliveries.status,
    })
    .from(outboxDeliveries)
    .where(eq(outboxDeliveries.workerKey, corePrincipalLifecycleSubscription.workerKey))
    .pipe(Effect.map((rows) => rows[0]));

type DrainFixture = Effect.Success<ReturnType<typeof fixture>>;

/** One claim exactly as a live Outbox host of the retiring release makes it: its binding, its five registrations. */
const claimAsRetiringHost = (f: DrainFixture) =>
  Effect.gen(function* claimAsRetiringHostEffect() {
    return yield* withWorkerRuntimeBinding(
      {
        authority: { load: Effect.succeed(f.old) },
        expectedDeployment: f.old.composition.shell.deployment,
        registrations: ALL_CORE_WORKERS,
      },
      f.repository.claimNext(ALL_CORE_WORKERS, CLAIM_OWNER, yield* DateTime.nowAsDate, f.old.composition.revision),
    ).pipe(Effect.provideService(ActiveApplicationCompositionService, { load: Effect.succeed(f.old) }));
  });

/** A second, matched delivery for a tenant module that is installed nowhere: work no host can ever claim. */
const writeUnclaimableDelivery = (f: DrainFixture) =>
  Effect.gen(function* writeUnclaimableDeliveryEffect() {
    const [message] = yield* f.admin.executor
      .select({ id: outboxMessages.outboxMessageId })
      .from(outboxMessages)
      .limit(1);
    if (message === undefined) {
      return yield* Effect.die('the fixture message is missing');
    }
    yield* f.admin.executor.insert(outboxDeliveries).values({
      consumerModuleKey: ABSENT_CONSUMER,
      outboxMessageId: message.id,
      workerKey: ABSENT_WORKER_KEY,
    });
    return yield* Effect.void;
  });

/** A live worker of the retiring release holds the lifecycle delivery, so a drain waits for it. */
const holdLifecycleDelivery = (f: DrainFixture) =>
  f.runtime
    .update(outboxDeliveries)
    .set({
      claimedAt: sql`clock_timestamp()`,
      claimedBy: 'retiring-release-worker',
      claimExpiresAt: sql`clock_timestamp() + interval '10 minutes'`,
      status: 'processing',
    })
    .where(eq(outboxDeliveries.workerKey, corePrincipalLifecycleSubscription.workerKey));

/** Waits, bounded, until the authority reaches `phase`. */
const untilPhase = (f: DrainFixture, phase: string) =>
  Effect.gen(function* untilPhaseEffect() {
    for (;;) {
      const row = yield* authorityRow(f.runtime);
      if (row?.phase === phase) {
        return yield* Effect.void;
      }
      yield* Effect.sleep('100 millis');
    }
  }).pipe(Effect.timeout('60 seconds'), Effect.orDie);

/** One more committed, unmatched principal-lifecycle message in the fixture tenant, as an Action writes it. */
const writeLifecycleMessage = (f: DrainFixture) =>
  f.runtime.transaction(
    Effect.fn(function* writeLifecycleMessageEffect(transaction) {
      const [event] = yield* transaction
        .insert(domainEvents)
        .values({
          eventType: corePrincipalLifecycleSubscription.topic,
          payloadJson: {},
          producerModuleKey: corePrincipalLifecycleSubscription.producerModuleKey,
          subjectModuleKey: corePrincipalLifecycleSubscription.producerModuleKey,
          subjectResourceId: f.tenantId,
          subjectResourceType: 'principal',
          tenantId: f.tenantId,
        })
        .returning({ id: domainEvents.domainEventId });
      yield* transaction.insert(outboxMessages).values({
        domainEventId: Option.getOrThrow(Option.fromNullishOr(event)).id,
        payloadJson: { data: { principalId: f.tenantId, state: 'disabled', tenantId: f.tenantId }, schemaVersion: 1 },
        producerModuleKey: corePrincipalLifecycleSubscription.producerModuleKey,
        tenantId: f.tenantId,
        topic: corePrincipalLifecycleSubscription.topic,
      });
      return yield* Effect.void;
    }),
  );

/** The operator and reason every abandonment in this suite records. */
const OPERATOR = 'operator@example.test';
const OPERATOR_REASON = 'The deploy failed and no publisher is alive';

/** The operator's evidence for one abandonment of `revision`. */
const operatorFlags = (revision: string) => ({ operator: OPERATOR, reason: OPERATOR_REASON, revision });

/** A refusal's own words, whichever of the two refusal types carried it. */
const reasonOf = <Failure,>(failure: Failure) =>
  Schema.is(ApplicationCompositionAuthorityError)(failure) || Schema.is(CompositionAbandonDrainCommandError)(failure)
    ? failure.reason
    : '';

it.layer(services, { excludeTestServices: true })('core-system Outbox claim, carry-over and drain', (suite) => {
  suite.effect('claims core lifecycle work in a tenant that has no core module state', () =>
    Effect.gen(function* claimsCoreSystemWork() {
      const f = yield* fixture();
      expect(yield* deliveryRow(f.runtime)).toMatchObject({ attempts: 0, status: 'pending' });
      expect(
        yield* f.runtime
          .select({ moduleKey: tenantModuleStates.moduleKey })
          .from(tenantModuleStates)
          .where(
            and(
              eq(tenantModuleStates.tenantId, f.tenantId),
              eq(tenantModuleStates.moduleKey, corePrincipalLifecycleSubscription.consumerModuleKey),
            ),
          ),
      ).toHaveLength(0);

      // The genuine Core registrations, bound to the composition's own Shell deployment, as the host binds them.
      const claim = yield* withWorkerRuntimeBinding(
        {
          authority: { load: Effect.succeed(f.old) },
          expectedDeployment: f.old.composition.shell.deployment,
          registrations: ALL_CORE_WORKERS,
        },
        f.repository.claimNext(ALL_CORE_WORKERS, CLAIM_OWNER, yield* DateTime.nowAsDate, f.old.composition.revision),
      ).pipe(Effect.provideService(ActiveApplicationCompositionService, { load: Effect.succeed(f.old) }));
      expect(Option.isSome(claim)).toBe(true);
      // Two core-system subscriptions consume this topic; either may be claimed first, and both must be claimable.
      expect(ALL_CORE_WORKERS.map(({ descriptor }) => descriptor.workerKey)).toContain(
        Option.getOrThrow(claim).workerKey,
      );
    }),
  );

  suite.effect('promotes a new release past an unclaimed core-system delivery, then finishes it', () =>
    Effect.gen(function* carriesOverCoreSystemWork() {
      const f = yield* fixture();
      const next = yield* snapshotFor(`${FIXTURE_NAME}-new`, 7200);

      // Sample the authority while the publication runs: reads are refused only while the phase is not `active`.
      const refused = yield* Ref.make<readonly number[]>([]);
      const sampler = yield* Effect.forever(
        Effect.gen(function* samplePhase() {
          const row = yield* authorityRow(f.runtime).pipe(Effect.orElseSucceed(() => null));
          if (row !== null && row !== undefined && row.phase !== 'active') {
            const at = yield* Clock.currentTimeMillis;
            yield* Ref.update(refused, (samples) => [...samples, at]);
          }
          yield* Effect.sleep('50 millis');
        }),
      ).pipe(Effect.forkChild);

      yield* publishApplicationCompositionAuthoritySnapshot(next, Effect.void, Effect.void).pipe(
        Effect.provide(f.layer),
      );
      yield* Fiber.interrupt(sampler);

      // The new release holds the authority, admission is open and reads are admitted again.
      expect(yield* authorityRow(f.runtime)).toMatchObject({
        durableWorkAdmission: 'open',
        phase: 'active',
        revision: next.composition.revision,
      });
      const samples = yield* Ref.get(refused);
      const window = samples.length === 0 ? 0 : (samples.at(-1) ?? 0) - (samples[0] ?? 0);
      expect(window).toBeLessThan(QUIESCENT_WINDOW_MS);

      // The carried-over delivery is untouched by the promotion, and the new release claims and settles it.
      expect(yield* deliveryRow(f.runtime)).toMatchObject({ attempts: 0, claimedBy: null, status: 'pending' });
      // Both core-system deliveries of this topic are now claimable under the new authority; drain them.
      yield* Effect.forEach(
        [0, 1],
        () =>
          Effect.gen(function* claimAndComplete() {
            const claim = yield* withWorkerRuntimeBinding(
              {
                authority: { load: Effect.succeed(next) },
                expectedDeployment: next.composition.shell.deployment,
                registrations: ALL_CORE_WORKERS,
              },
              f.repository.claimNext(
                ALL_CORE_WORKERS,
                CLAIM_OWNER,
                yield* DateTime.nowAsDate,
                next.composition.revision,
              ),
            ).pipe(Effect.provideService(ActiveApplicationCompositionService, { load: Effect.succeed(next) }));
            expect(Option.isSome(claim)).toBe(true);
            yield* f.repository.complete(Option.getOrThrow(claim), yield* DateTime.nowAsDate);
          }),
        { concurrency: 1, discard: true },
      );
      expect(yield* deliveryRow(f.runtime)).toMatchObject({ status: 'done' });
    }),
  );

  suite.effect('refuses to start a drain that waits for a tenant module with no eligible consumer', () =>
    Effect.gen(function* refusesIneligibleTenantModuleWork() {
      const f = yield* fixture();
      // A tenant-module delivery whose module is not installed: it can never be claimed and never carries over.
      yield* f.runtime
        .update(outboxDeliveries)
        .set({ consumerModuleKey: ABSENT_CONSUMER, workerKey: ABSENT_WORKER_KEY })
        .where(eq(outboxDeliveries.workerKey, corePrincipalLifecycleSubscription.workerKey));
      const next = yield* snapshotFor(`${FIXTURE_NAME}-new`, 7200);

      const failure = yield* publishApplicationCompositionAuthoritySnapshot(next, Effect.void, Effect.void).pipe(
        Effect.provide(f.layer),
        Effect.flip,
      );
      expect(Schema.is(ApplicationCompositionAuthorityError)(failure)).toBe(true);
      const reason = Schema.is(ApplicationCompositionAuthorityError)(failure) ? failure.reason : '';
      expect(reason).toContain(REFUSED_BEFORE_ADMISSION);
      expect(reason).toContain('no-eligible-consumer');
      expect(reason).toContain(`--worker-key ${ABSENT_WORKER_KEY}`);

      // Nothing was written: the old release still holds the authority with durable admission open.
      expect(yield* authorityRow(f.runtime)).toMatchObject({
        durableWorkAdmission: 'open',
        phase: 'active',
        revision: f.old.composition.revision,
      });
    }),
  );

  suite.effect('does not carry over a core-system subscription whose descriptor changed', () =>
    Effect.gen(function* refusesChangedDescriptor() {
      const f = yield* fixture();
      // A short freshness lease bounds the wait, so without the refusal this test fails fast instead of hanging.
      yield* f.admin.executor
        .update(applicationCompositionAuthority)
        .set({ validUntil: sql`clock_timestamp() + interval '40 seconds'` });
      // The retiring authority approved a different descriptor under this worker key, so identity is not proven.
      yield* f.admin.executor.execute(
        sql`update ${applicationCompositionAuthority}
            set subscriptions_json = (
              select jsonb_agg(case when entry->>'workerKey' = ${corePrincipalLifecycleSubscription.workerKey}
                then jsonb_set(entry, '{topic}', '"core.identity.principal-lifecycle-changed.v2"')
                else entry end)
              from jsonb_array_elements(subscriptions_json::jsonb) as entry
            )::json
            where ${applicationCompositionAuthority.authorityKey} = 'active'`,
        'objects',
      );
      const next = yield* snapshotFor(`${FIXTURE_NAME}-new`, 7200);

      const failure = yield* publishApplicationCompositionAuthoritySnapshot(next, Effect.void, Effect.void).pipe(
        Effect.provide(f.layer),
        Effect.flip,
      );
      expect(Schema.is(ApplicationCompositionAuthorityError)(failure)).toBe(true);
      const reason = Schema.is(ApplicationCompositionAuthorityError)(failure) ? failure.reason : '';
      // The descriptor differs, so this release cannot carry the row over, and nothing in the authority row says
      // whether the retiring release can claim it. The pre-flight therefore assumes no live consumer and refuses
      // before admission closes, instead of starting a drain that might stall with reads refused.
      expect(reason).toContain(REFUSED_BEFORE_ADMISSION);
      expect(reason).toContain(`no-eligible-consumer: --tenant-id ${f.tenantId}`);
      expect(reason).toContain(corePrincipalLifecycleSubscription.workerKey);
      expect(yield* authorityRow(f.runtime)).toMatchObject({
        durableWorkAdmission: 'open',
        phase: 'active',
        revision: f.old.composition.revision,
      });
      expect(yield* deliveryRow(f.runtime)).toMatchObject({ attempts: 0, status: 'pending' });
      return yield* Effect.void;
    }),
  );

  suite.effect('the operator pre-flight reports carry-over, and blocks on a module with no consumer', () =>
    Effect.gen(function* reportsPreflight() {
      const f = yield* fixture();
      const sets = yield* f.runtime.transaction((transaction) => carriedOverCoreSystemWorkerKeys(transaction));
      expect(sets.carriedOverWorkerKeys).toContain(corePrincipalLifecycleSubscription.workerKey);

      const budgetMs = APPLICATION_COMPOSITION_PUBLICATION_BUDGETS.drainMs;
      const rows = yield* listDrainWork(f.runtime, {
        budgetMs,
        carriedOverWorkerKeys: sets.carriedOverWorkerKeys,
        coreSystemConsumers: sets.liveCoreSystemConsumers,
      });
      // Two core-system subscriptions consume `principal-lifecycle-changed.v1`: the authorization reconcile and
      // the People search projection. Both are Core's own untouched work, so both carry over.
      expect(rows).toHaveLength(2);
      for (const candidate of rows) {
        expect(classifyDrainWork(candidate).outcome).toBe('carry-over');
        expect(describeWorkerKeyIdentity(candidate.workerKey, sets)).toBe('identical');
      }
      const row = rows.find(({ workerKey }) => workerKey === corePrincipalLifecycleSubscription.workerKey);
      if (row === undefined) {
        return yield* Effect.die('the fixture delivery is missing');
      }
      // The verdict is the publisher's own pre-flight: it would start its drain.
      expect(
        yield* listUndrainableOutboxWork(f.runtime, {
          budgetMs,
          carriedOverWorkerKeys: sets.carriedOverWorkerKeys,
          coreSystemConsumers: sets.liveCoreSystemConsumers,
        }),
      ).toHaveLength(0);

      // A tenant-module delivery with no installed module: the pre-flight blocks and the verdict turns to no.
      yield* f.runtime
        .update(outboxDeliveries)
        .set({ consumerModuleKey: ABSENT_CONSUMER, workerKey: ABSENT_WORKER_KEY })
        .where(eq(outboxDeliveries.workerKey, corePrincipalLifecycleSubscription.workerKey));
      const blocked = yield* listDrainWork(f.runtime, {
        budgetMs,
        carriedOverWorkerKeys: sets.carriedOverWorkerKeys,
        coreSystemConsumers: sets.liveCoreSystemConsumers,
      });
      const blockedRow = blocked.find(({ workerKey }) => workerKey === ABSENT_WORKER_KEY);
      if (blockedRow === undefined) {
        return yield* Effect.die('the renamed fixture delivery is missing');
      }
      expect(classifyDrainWork(blockedRow)).toMatchObject({ outcome: 'block' });
      expect(describeWorkerKeyIdentity(blockedRow.workerKey, sets)).toBe('absent');
      expect(
        yield* listUndrainableOutboxWork(f.runtime, {
          budgetMs,
          carriedOverWorkerKeys: sets.carriedOverWorkerKeys,
          coreSystemConsumers: sets.liveCoreSystemConsumers,
        }),
      ).toHaveLength(1);

      // Aged past a whole budget, the same row is also caught by the generic catch-all. The specific reason must
      // still win, because only `no-eligible-consumer` names a remedy an operator can act on.
      yield* f.admin.executor.execute(
        sql`update ${outboxDeliveries} set available_at = clock_timestamp() - interval '2 hours'
            where ${outboxDeliveries.workerKey} = ${ABSENT_WORKER_KEY}`,
        'objects',
      );
      const aged = yield* listUndrainableOutboxWork(f.runtime, {
        budgetMs,
        carriedOverWorkerKeys: sets.carriedOverWorkerKeys,
        coreSystemConsumers: sets.liveCoreSystemConsumers,
      });
      expect(aged.find(({ workerKey }) => workerKey === ABSENT_WORKER_KEY)?.reason).toBe('no-eligible-consumer');
      return yield* Effect.void;
    }),
  );

  suite.effect('refuses a drain while a message waited a whole budget unmatched, not while one is fresh', () =>
    Effect.gen(function* refusesStalledUnmatchedMessage() {
      const f = yield* fixture();
      const budgetMs = APPLICATION_COMPOSITION_PUBLICATION_BUDGETS.drainMs;
      const messageId = yield* f.runtime.transaction(
        Effect.fn(function* writeUnmatchedMessage(transaction) {
          const [event] = yield* transaction
            .insert(domainEvents)
            .values({
              eventType: corePrincipalLifecycleSubscription.topic,
              payloadJson: {},
              producerModuleKey: corePrincipalLifecycleSubscription.producerModuleKey,
              subjectModuleKey: corePrincipalLifecycleSubscription.producerModuleKey,
              subjectResourceId: f.tenantId,
              subjectResourceType: 'principal',
              tenantId: f.tenantId,
            })
            .returning({ id: domainEvents.domainEventId });
          const [message] = yield* transaction
            .insert(outboxMessages)
            .values({
              domainEventId: Option.getOrThrow(Option.fromNullishOr(event)).id,
              payloadJson: {
                data: { principalId: f.tenantId, state: 'disabled', tenantId: f.tenantId },
                schemaVersion: 1,
              },
              producerModuleKey: corePrincipalLifecycleSubscription.producerModuleKey,
              tenantId: f.tenantId,
              topic: corePrincipalLifecycleSubscription.topic,
            })
            .returning({ id: outboxMessages.outboxMessageId });
          return Option.getOrThrow(Option.fromNullishOr(message)).id;
        }),
      );
      // Freshly written, the running matcher would take it: in-flight work, not a reason to refuse.
      expect(yield* countStalledUnmatchedMessages(f.runtime, budgetMs)).toBe(0);

      // Waiting a whole budget unmatched means no matcher runs: the drain would wait for it in vain.
      yield* f.admin.executor.execute(
        sql`update ${outboxMessages} set created_at = clock_timestamp() - interval '2 hours'
            where ${outboxMessages.outboxMessageId} = ${messageId}`,
        'objects',
      );
      expect(yield* countStalledUnmatchedMessages(f.runtime, budgetMs)).toBe(1);
      // A short freshness lease bounds the wait, so without the refusal this test fails fast rather than hanging.
      yield* f.admin.executor
        .update(applicationCompositionAuthority)
        .set({ validUntil: sql`clock_timestamp() + interval '40 seconds'` });
      const next = yield* snapshotFor(`${FIXTURE_NAME}-new`, 7200);
      const failure = yield* publishApplicationCompositionAuthoritySnapshot(next, Effect.void, Effect.void).pipe(
        Effect.provide(f.layer),
        Effect.flip,
      );
      const reason = Schema.is(ApplicationCompositionAuthorityError)(failure) ? failure.reason : '';
      expect(reason).toContain(REFUSED_BEFORE_ADMISSION);
      expect(reason).toContain('without being matched');
      expect(yield* authorityRow(f.runtime)).toMatchObject({
        durableWorkAdmission: 'open',
        phase: 'active',
        revision: f.old.composition.revision,
      });
      return yield* Effect.void;
    }),
  );

  suite.effect('promotes anyway when a live old host claims a carried-over row mid-promotion', () =>
    Effect.gen(function* promotesThroughInterleavedClaim() {
      const f = yield* fixture();
      const next = yield* snapshotFor(`${FIXTURE_NAME}-new`, 7200);
      const claims = yield* Ref.make(0);
      const claimedWorkerKey = yield* Ref.make('');
      // `verifyInitialCutover` is called once inside the drain (entering `draining`) and again immediately before
      // the promote. Claiming on that second call puts the claim deterministically between the drain poll and the
      // promote's own check — the interleaving a live host of the retiring release can really cause.
      const claimBeforePromote = Effect.gen(function* claimOnSecondCall() {
        if ((yield* Ref.updateAndGet(claims, (seen) => seen + 1)) !== 2) {
          return;
        }
        const claim = yield* withWorkerRuntimeBinding(
          {
            authority: { load: Effect.succeed(f.old) },
            expectedDeployment: f.old.composition.shell.deployment,
            registrations: ALL_CORE_WORKERS,
          },
          f.repository.claimNext(ALL_CORE_WORKERS, CLAIM_OWNER, yield* DateTime.nowAsDate, f.old.composition.revision),
        ).pipe(Effect.provideService(ActiveApplicationCompositionService, { load: Effect.succeed(f.old) }));
        // It must really be claimed, or this test would silently stop proving the retry.
        expect(Option.isSome(claim)).toBe(true);
        yield* Ref.set(claimedWorkerKey, Option.getOrThrow(claim).workerKey);
        // The retiring host finishes it while the publisher re-drains, so the retry can succeed.
        yield* f.repository
          .complete(Option.getOrThrow(claim), yield* DateTime.nowAsDate)
          .pipe(Effect.delay('500 millis'), Effect.forkChild);
      });

      yield* publishApplicationCompositionAuthoritySnapshot(next, Effect.void, claimBeforePromote).pipe(
        Effect.provide(f.layer),
      );
      // The claim happened where it was aimed, and the promotion still landed on the new revision.
      expect(yield* Ref.get(claims)).toBeGreaterThanOrEqual(2);
      expect(yield* authorityRow(f.runtime)).toMatchObject({
        durableWorkAdmission: 'open',
        phase: 'active',
        revision: next.composition.revision,
      });
      // The very row the retiring host claimed mid-promotion finished, which is what let the retry through.
      const [claimed] = yield* f.runtime
        .select({ status: outboxDeliveries.status })
        .from(outboxDeliveries)
        .where(eq(outboxDeliveries.workerKey, yield* Ref.get(claimedWorkerKey)));
      expect(claimed).toMatchObject({ status: 'done' });
    }),
  );

  suite.effect('does not carry over a delivery an operator redrove on this release', () =>
    Effect.gen(function* doesNotCarryOverRedriven() {
      const f = yield* fixture();
      // A redrive leaves the row pending with zero attempts and no claim, exactly like untouched work, so only
      // its resolution row distinguishes it. An operator chose to run it here, so this release drains it.
      const [delivery] = yield* f.runtime
        .select({ id: outboxDeliveries.outboxDeliveryId, messageId: outboxDeliveries.outboxMessageId })
        .from(outboxDeliveries)
        .where(eq(outboxDeliveries.workerKey, corePrincipalLifecycleSubscription.workerKey));
      if (delivery === undefined) {
        return yield* Effect.die('the fixture delivery is missing');
      }
      // The real sequence: the delivery died, then an operator redrove it. The resolution trigger itself resets
      // the row to pending with zero attempts and no claim, which is what makes it look untouched.
      yield* f.admin.executor
        .update(outboxDeliveries)
        .set({ attemptsCount: 3, status: 'dead' })
        .where(eq(outboxDeliveries.outboxDeliveryId, delivery.id));
      yield* f.admin.executor.insert(outboxDeliveryResolutions).values({
        action: 'redrive',
        deadAttemptsCount: 3,
        operatorName: OPERATOR,
        outboxDeliveryId: delivery.id,
        outboxMessageId: delivery.messageId,
        reason: 'Redriven on this release after the owner recovered',
        tenantId: f.tenantId,
        workerKey: corePrincipalLifecycleSubscription.workerKey,
      });
      const sets = yield* f.runtime.transaction((transaction) => carriedOverCoreSystemWorkerKeys(transaction));
      const rows = yield* listDrainWork(f.runtime, {
        budgetMs: APPLICATION_COMPOSITION_PUBLICATION_BUDGETS.drainMs,
        carriedOverWorkerKeys: sets.carriedOverWorkerKeys,
        coreSystemConsumers: sets.liveCoreSystemConsumers,
      });
      const redriven = rows.find(({ workerKey }) => workerKey === corePrincipalLifecycleSubscription.workerKey);
      if (redriven === undefined) {
        return yield* Effect.die('the redriven delivery is missing');
      }
      expect(redriven.carriesOver).toBe(false);
      expect(classifyDrainWork(redriven).outcome).not.toBe('carry-over');

      // Because it does not carry over, the pre-flight can see it: exempting by worker key alone would hide a row
      // the drain still blocks on. Aged past a whole budget, nothing has picked it up, so it is refused.
      yield* f.admin.executor.execute(
        sql`update ${outboxDeliveries} set available_at = clock_timestamp() - interval '2 hours'
            where ${outboxDeliveries.workerKey} = ${corePrincipalLifecycleSubscription.workerKey}`,
        'objects',
      );
      const undrainable = yield* listUndrainableOutboxWork(f.runtime, {
        budgetMs: APPLICATION_COMPOSITION_PUBLICATION_BUDGETS.drainMs,
        carriedOverWorkerKeys: sets.carriedOverWorkerKeys,
        coreSystemConsumers: sets.liveCoreSystemConsumers,
      });
      expect(undrainable.map(({ workerKey }) => workerKey)).toContain(corePrincipalLifecycleSubscription.workerKey);
      expect(undrainable.map(({ reason }) => reason)).toContain('unclaimed-longer-than-budget');
      return yield* Effect.void;
    }),
  );

  suite.effect('still waits for a core-system delivery that is in flight', () =>
    Effect.gen(function* waitsForInFlightWork() {
      const f = yield* fixture();
      // Claimed by a live worker of the retiring release: this is old-release work in flight and must drain.
      yield* f.runtime
        .update(outboxDeliveries)
        .set({
          claimedAt: sql`clock_timestamp()`,
          claimedBy: 'retiring-release-worker',
          claimExpiresAt: sql`clock_timestamp() + interval '10 minutes'`,
          status: 'processing',
        })
        .where(eq(outboxDeliveries.workerKey, corePrincipalLifecycleSubscription.workerKey));
      // A short freshness lease bounds the drain wait at about ten seconds.
      yield* f.admin.executor
        .update(applicationCompositionAuthority)
        .set({ validUntil: sql`clock_timestamp() + interval '40 seconds'` });
      const next = yield* snapshotFor(`${FIXTURE_NAME}-new`, 7200);
      // When did the running release last see its authority refuse reads?
      const lastRefused = yield* Ref.make(0);
      const sampler = yield* Effect.forever(
        Effect.gen(function* sampleRefusal() {
          const row = yield* authorityRow(f.runtime).pipe(Effect.orElseSucceed(() => null));
          if (row !== null && row !== undefined && row.phase !== 'active') {
            yield* Ref.set(lastRefused, yield* Clock.currentTimeMillis);
          }
          yield* Effect.sleep('50 millis');
        }),
      ).pipe(Effect.forkChild);

      const failure = yield* publishApplicationCompositionAuthoritySnapshot(next, Effect.void, Effect.void).pipe(
        Effect.provide(f.layer),
        Effect.flip,
      );
      const failedAt = yield* Clock.currentTimeMillis;
      yield* Fiber.interrupt(sampler);
      expect(Schema.is(ApplicationCompositionAuthorityError)(failure)).toBe(true);
      const reason = Schema.is(ApplicationCompositionAuthorityError)(failure) ? failure.reason : '';
      // The pre-flight admitted it (work in flight drains); the drain then waited for it and ran out of lease.
      expect(reason).not.toContain('drain was not started');
      expect(reason).toContain('did not finish within its freshness lease');
      // The failing publisher returned the same revision to active before it exited, and said so.
      expect(reason).toContain(RETURNED_TO_ACTIVE);
      expect(yield* authorityRow(f.runtime)).toMatchObject({
        durableWorkAdmission: 'open',
        phase: 'active',
        revision: f.old.composition.revision,
      });
      expect(failedAt - (yield* Ref.get(lastRefused))).toBeLessThan(5000);
      const [recorded] = yield* f.admin.executor.select().from(applicationCompositionDrainAbandonments);
      expect(recorded).toMatchObject({
        initiatedBy: 'publisher',
        operatorName: 'application-composition-publisher',
        revision: f.old.composition.revision,
      });
      expect(recorded?.reason).toContain('did not finish within its freshness lease');
      expect(yield* deliveryRow(f.runtime)).toMatchObject({ status: 'processing' });
      return yield* Effect.void;
    }),
  );

  suite.effect('never claims core work under the wrong consumer module, nor a tenant consumer without its module', () =>
    Effect.gen(function* refusesMispairedClaims() {
      const f = yield* fixture();
      // A core worker key paired with the wrong consumer module is not Core's own work, so the core-system
      // exemption does not apply to it.
      yield* f.admin.executor
        .update(outboxDeliveries)
        .set({ consumerModuleKey: 'core.identity' })
        .where(eq(outboxDeliveries.workerKey, corePrincipalLifecycleSubscription.workerKey));
      // The correctly paired People-search row is claimed and finished; after it nothing is claimable.
      const first = yield* claimAsRetiringHost(f);
      expect(Option.getOrThrow(first).workerKey).not.toBe(corePrincipalLifecycleSubscription.workerKey);
      yield* f.repository.complete(Option.getOrThrow(first), yield* DateTime.nowAsDate);
      expect(Option.isNone(yield* claimAsRetiringHost(f))).toBe(true);
      expect(yield* deliveryRow(f.runtime)).toMatchObject({ attempts: 0, claimedBy: null, status: 'pending' });

      // A tenant module's consumer without a module state in its tenant stays unclaimed as well. (The module-state
      // branch admitting a genuine tenant worker whose module is installed is proven in
      // `outbox-dead-delivery-drain.test.mts`, which claims and settles exactly such deliveries.)
      yield* f.admin.executor
        .update(outboxDeliveries)
        .set({ consumerModuleKey: ABSENT_CONSUMER })
        .where(eq(outboxDeliveries.workerKey, corePrincipalLifecycleSubscription.workerKey));
      expect(Option.isNone(yield* claimAsRetiringHost(f))).toBe(true);

      // Control: with its own consumer module restored, the very same row is claimed, so the pairing — nothing
      // else about the row — is what kept it unclaimed.
      yield* f.admin.executor
        .update(outboxDeliveries)
        .set({ consumerModuleKey: corePrincipalLifecycleSubscription.consumerModuleKey })
        .where(eq(outboxDeliveries.workerKey, corePrincipalLifecycleSubscription.workerKey));
      expect(Option.getOrThrow(yield* claimAsRetiringHost(f)).workerKey).toBe(
        corePrincipalLifecycleSubscription.workerKey,
      );
      return yield* Effect.void;
    }),
  );

  suite.effect('names a row scheduled past the budget and a claim that expired a whole budget ago', () =>
    Effect.gen(function* reportsScheduledAndExpiredClaims() {
      const f = yield* fixture();
      const budgetMs = APPLICATION_COMPOSITION_PUBLICATION_BUDGETS.drainMs;
      const reasonFor = Effect.gen(function* reasonForLifecycleRow() {
        const sets = yield* f.runtime.transaction((transaction) => carriedOverCoreSystemWorkerKeys(transaction));
        const undrainable = yield* listUndrainableOutboxWork(f.runtime, {
          budgetMs,
          carriedOverWorkerKeys: sets.carriedOverWorkerKeys,
          coreSystemConsumers: sets.liveCoreSystemConsumers,
        });
        return undrainable.find(({ workerKey }) => workerKey === corePrincipalLifecycleSubscription.workerKey)?.reason;
      });
      // Attempted once, so it no longer carries over, and its next attempt is a day away.
      yield* f.admin.executor.execute(
        sql`update ${outboxDeliveries} set attempts_count = 1, available_at = clock_timestamp() + interval '1 day'
            where ${outboxDeliveries.workerKey} = ${corePrincipalLifecycleSubscription.workerKey}`,
        'objects',
      );
      expect(yield* reasonFor).toBe('scheduled-beyond-budget');
      // Claimed by a host that vanished: its lease expired two hours ago and no live host has taken it back.
      yield* f.admin.executor.execute(
        sql`update ${outboxDeliveries}
            set status = 'processing', claimed_by = 'vanished-host', claimed_at = clock_timestamp() - interval '3 hours',
                claim_expires_at = clock_timestamp() - interval '2 hours', available_at = clock_timestamp() - interval '3 hours'
            where ${outboxDeliveries.workerKey} = ${corePrincipalLifecycleSubscription.workerKey}`,
        'objects',
      );
      expect(yield* reasonFor).toBe('unclaimed-longer-than-budget');
      return yield* Effect.void;
    }),
  );

  suite.effect('fails closed when the pre-flight cannot read the Outbox', () =>
    Effect.gen(function* failsClosedOnUnreadablePreflight() {
      const f = yield* fixture();
      // The carry-over predicate reads the resolution table; without it the pre-flight query itself fails.
      yield* f.admin.executor.execute(sql`drop table core.outbox_delivery_resolutions cascade`, 'objects');
      const next = yield* snapshotFor(`${FIXTURE_NAME}-new`, 7200);
      const failure = yield* publishApplicationCompositionAuthoritySnapshot(next, Effect.void, Effect.void).pipe(
        Effect.provide(f.layer),
        Effect.flip,
      );
      // An unreadable pre-flight is no evidence the drain is safe: nothing moved, and the old release serves.
      expect(Schema.is(ApplicationCompositionAuthorityError)(failure) ? failure.reason : '').toContain(
        'pre-flight could not read the outstanding Outbox work',
      );
      expect(yield* authorityRow(f.runtime)).toMatchObject({
        durableWorkAdmission: 'open',
        phase: 'active',
        revision: f.old.composition.revision,
      });
      return yield* Effect.void;
    }),
  );

  suite.effect(
    're-checks at the enter-draining fence and reopens admission when work arrived after the pre-flight',
    () =>
      Effect.gen(function* rechecksAtTheFence() {
        const f = yield* fixture();
        // A short freshness lease bounds the wait, so without the re-check this test fails fast instead of hanging.
        yield* f.admin.executor
          .update(applicationCompositionAuthority)
          .set({ validUntil: sql`clock_timestamp() + interval '40 seconds'` });
        const calls = yield* Ref.make(0);
        // `verifyInitialCutover` runs first right before the enter-draining fence, after the pre-flight passed and
        // durable admission closed: exactly the window in which new work escapes a point-in-time check.
        const arriveAfterPreflight = Effect.gen(function* arriveOnFirstCall() {
          if ((yield* Ref.updateAndGet(calls, (seen) => seen + 1)) === 1) {
            yield* writeUnclaimableDelivery(f);
          }
        });
        const next = yield* snapshotFor(`${FIXTURE_NAME}-new`, 7200);
        const failure = yield* publishApplicationCompositionAuthoritySnapshot(
          next,
          Effect.void,
          arriveAfterPreflight,
        ).pipe(Effect.provide(f.layer), Effect.flip);
        const reason = Schema.is(ApplicationCompositionAuthorityError)(failure) ? failure.reason : '';
        expect(reason).toContain('drain was not started');
        expect(reason).toContain(`--worker-key ${ABSENT_WORKER_KEY}`);
        expect(reason).toContain('Durable admission was reopened');
        // The authority is exactly as it was before the publication began: active, admission open, same revision.
        expect(yield* authorityRow(f.runtime)).toMatchObject({
          durableWorkAdmission: 'open',
          phase: 'active',
          revision: f.old.composition.revision,
        });
        return yield* Effect.void;
      }),
  );

  suite.effect('gives up after the last re-drain and says which phase the authority is left in', () =>
    Effect.gen(function* exhaustsRetries() {
      const f = yield* fixture();
      // A short lease makes every re-drain deadline pass at once, so all retries run within seconds.
      yield* f.admin.executor
        .update(applicationCompositionAuthority)
        .set({ validUntil: sql`clock_timestamp() + interval '40 seconds'` });
      const calls = yield* Ref.make(0);
      // On the call right before the promote, a retiring host claims a carried-over row and never finishes it.
      const claimAndHold = Effect.gen(function* claimOnSecondCall() {
        if ((yield* Ref.updateAndGet(calls, (seen) => seen + 1)) === 2) {
          expect(Option.isSome(yield* claimAsRetiringHost(f))).toBe(true);
        }
      });
      const next = yield* snapshotFor(`${FIXTURE_NAME}-new`, 7200);
      const failure = yield* publishApplicationCompositionAuthoritySnapshot(next, Effect.void, claimAndHold).pipe(
        Effect.provide(f.layer),
        Effect.flip,
      );
      const reason = Schema.is(ApplicationCompositionAuthorityError)(failure) ? failure.reason : '';
      expect(reason).toContain('re-drains, so the Application Composition transition was abandoned');
      // The exhausted promotion no longer leaves the authority draining: the publisher returned it to active.
      expect(reason).toContain(RETURNED_TO_ACTIVE);
      expect(yield* authorityRow(f.runtime)).toMatchObject({
        durableWorkAdmission: 'open',
        phase: 'active',
        revision: f.old.composition.revision,
      });
      expect(yield* f.admin.executor.select().from(applicationCompositionDrainAbandonments)).toHaveLength(1);
      return yield* Effect.void;
    }),
  );

  suite.effect('a publisher that already sealed never returns its authority to active', () =>
    Effect.gen(function* sealedNeverAborts() {
      const f = yield* fixture();
      // The drain and the seal succeed; the publisher's own schema migration then fails.
      const failure = yield* runApplicationCompositionMigration(
        Effect.fail(
          new ApplicationCompositionAuthorityError({
            code: 'application_composition_authority_unavailable',
            reason: 'the schema migration failed',
          }),
        ),
        Effect.void,
      ).pipe(Effect.provide(f.layer), Effect.flip);
      expect(reasonOf(failure)).toContain('the schema migration failed');
      // Sealed stays sealed: no abandonment was recorded and none can be.
      expect(yield* authorityRow(f.runtime)).toMatchObject({ phase: 'sealed', revision: f.old.composition.revision });
      expect(yield* f.admin.executor.select().from(applicationCompositionDrainAbandonments)).toEqual([]);
      const refused = yield* abandonDrainAsOperator(operatorFlags(f.old.composition.revision)).pipe(
        Effect.provide(f.layer),
        Effect.flip,
      );
      expect(reasonOf(refused)).toContain('never returned to active');
      // The ledger's own trigger refuses a hand-written abandonment of a sealed revision too.
      const forged = yield* f.admin.executor
        .execute(
          sql`insert into core.application_composition_drain_abandonments
                (revision, initiated_by, operator_name, reason, lease_valid_until)
              values (${f.old.composition.revision}, 'operator', 'forger', 'no reason', clock_timestamp())`,
          'objects',
        )
        .pipe(Effect.exit);
      expect(forged._tag).toBe('Failure');
      expect(yield* authorityRow(f.runtime)).toMatchObject({ phase: 'sealed' });
      return yield* Effect.void;
    }),
  );

  suite.effect('the operator command returns a draining authority to active and records who, why and when', () =>
    Effect.gen(function* operatorAbandonsDrain() {
      const f = yield* fixture();
      yield* f.admin.executor
        .update(applicationCompositionAuthority)
        .set({ durableWorkAdmission: 'closed', phase: 'draining' });
      // A hand-written return to active is refused: only a recorded abandonment may do it.
      const handWritten = yield* f.admin.executor
        .update(applicationCompositionAuthority)
        .set({ phase: 'active' })
        .pipe(Effect.exit);
      expect(handWritten._tag).toBe('Failure');
      // A different revision and malformed input are refused before anything changes.
      const otherRevision = yield* abandonDrainAsOperator(operatorFlags('f'.repeat(64))).pipe(
        Effect.provide(f.layer),
        Effect.flip,
      );
      expect(reasonOf(otherRevision)).toContain('Only the revision that holds');
      const malformed = yield* abandonDrainAsOperator({
        ...operatorFlags(f.old.composition.revision),
        revision: 'x',
      }).pipe(Effect.provide(f.layer), Effect.flip);
      expect(Schema.is(CompositionAbandonDrainCommandError)(malformed)).toBe(true);
      expect(yield* authorityRow(f.runtime)).toMatchObject({ phase: 'draining' });

      const recorded = yield* abandonDrainAsOperator(operatorFlags(f.old.composition.revision)).pipe(
        Effect.provide(f.layer),
      );
      expect(yield* authorityRow(f.runtime)).toMatchObject({
        durableWorkAdmission: 'open',
        phase: 'active',
        revision: f.old.composition.revision,
      });
      const [row] = yield* f.admin.executor.select().from(applicationCompositionDrainAbandonments);
      const [authority] = yield* f.admin.executor
        .select({ validUntil: applicationCompositionAuthority.validUntil })
        .from(applicationCompositionAuthority);
      expect(row).toMatchObject({
        drainAbandonmentId: recorded.drainAbandonmentId,
        initiatedBy: 'operator',
        operatorName: OPERATOR,
        reason: OPERATOR_REASON,
        revision: f.old.composition.revision,
      });
      expect(row?.recordedBy.length).toBeGreaterThan(0);
      expect(row?.leaseValidUntil.getTime()).toBe(authority?.validUntil.getTime());
      // Nothing left to abandon: a second run is refused.
      const again = yield* abandonDrainAsOperator(operatorFlags(f.old.composition.revision)).pipe(
        Effect.provide(f.layer),
        Effect.flip,
      );
      expect(reasonOf(again)).toContain('not draining');
      return yield* Effect.void;
    }),
  );

  suite.effect('the operator command refuses an expired lease, and while a publisher is alive', () =>
    Effect.gen(function* operatorRefusals() {
      const f = yield* fixture();
      yield* f.admin.executor.update(applicationCompositionAuthority).set({
        durableWorkAdmission: 'closed',
        phase: 'draining',
        validUntil: sql`clock_timestamp() - interval '1 second'`,
      });
      const expired = yield* abandonDrainAsOperator(operatorFlags(f.old.composition.revision)).pipe(
        Effect.provide(f.layer),
        Effect.flip,
      );
      expect(reasonOf(expired)).toContain('lease has expired');
      expect(yield* authorityRow(f.runtime)).toMatchObject({ phase: 'draining' });

      // A second publisher: while one holds the publication lock, the command refuses at once instead of waiting.
      yield* f.admin.executor
        .update(applicationCompositionAuthority)
        .set({ validUntil: sql`clock_timestamp() + interval '1 hour'` });
      const holding = yield* Deferred.make<boolean>();
      const release = yield* Deferred.make<boolean>();
      const publisher = yield* withApplicationCompositionPublicationLock(
        Deferred.succeed(holding, true).pipe(Effect.andThen(Deferred.await(release))),
      ).pipe(Effect.provide(f.layer), Effect.forkChild);
      yield* Deferred.await(holding);
      const whilePublishing = yield* abandonDrainAsOperator(operatorFlags(f.old.composition.revision)).pipe(
        Effect.provide(f.layer),
        Effect.flip,
      );
      expect(reasonOf(whilePublishing)).toContain('A publisher is alive');
      expect(yield* authorityRow(f.runtime)).toMatchObject({ phase: 'draining' });
      yield* Deferred.succeed(release, true);
      yield* Fiber.join(publisher);
      // Once no publisher is alive, the same command goes through.
      yield* abandonDrainAsOperator(operatorFlags(f.old.composition.revision)).pipe(Effect.provide(f.layer));
      expect(yield* authorityRow(f.runtime)).toMatchObject({ phase: 'active' });
      return yield* Effect.void;
    }),
  );

  suite.effect('an interrupted publication returns the authority to active and records the interruption', () =>
    Effect.gen(function* interruptedPublication() {
      const f = yield* fixture();
      // A delivery held by a live worker of the retiring release keeps the drain waiting.
      yield* holdLifecycleDelivery(f);
      const next = yield* snapshotFor(`${FIXTURE_NAME}-new`, 7200);
      const publication = yield* publishApplicationCompositionAuthoritySnapshot(next, Effect.void, Effect.void).pipe(
        Effect.provide(f.layer),
        Effect.forkChild,
      );
      yield* untilPhase(f, 'draining');
      // The platform stops the hung host (SIGTERM after its readiness timeout): the publication is interrupted.
      yield* Fiber.interrupt(publication);
      expect(yield* authorityRow(f.runtime)).toMatchObject({
        durableWorkAdmission: 'open',
        phase: 'active',
        revision: f.old.composition.revision,
      });
      const [recorded] = yield* f.admin.executor.select().from(applicationCompositionDrainAbandonments);
      expect(recorded).toMatchObject({ initiatedBy: 'publisher', revision: f.old.composition.revision });
      expect(recorded?.reason).toContain('interrupted');
      return yield* Effect.void;
    }),
  );

  suite.effect('a quiescence check that fails after draining still returns the authority to active', () =>
    Effect.gen(function* failingCheckAfterDraining() {
      const f = yield* fixture();
      const calls = yield* Ref.make(0);
      // The first check runs before the enter-draining fence; the second, after it and before the promote.
      const refuseAfterDraining = Ref.updateAndGet(calls, (seen) => seen + 1).pipe(
        Effect.flatMap((seen) =>
          seen === 2
            ? Effect.fail(
                new ApplicationCompositionAuthorityError({
                  code: 'application_composition_authority_unavailable',
                  reason: 'a retired executable is still running',
                }),
              )
            : Effect.void,
        ),
      );
      const next = yield* snapshotFor(`${FIXTURE_NAME}-new`, 7200);
      const failure = yield* publishApplicationCompositionAuthoritySnapshot(
        next,
        Effect.void,
        refuseAfterDraining,
      ).pipe(Effect.provide(f.layer), Effect.flip);
      expect(reasonOf(failure)).toContain('a retired executable is still running');
      expect(reasonOf(failure)).toContain(RETURNED_TO_ACTIVE);
      expect(yield* authorityRow(f.runtime)).toMatchObject({
        durableWorkAdmission: 'open',
        phase: 'active',
        revision: f.old.composition.revision,
      });
      expect(yield* f.admin.executor.select().from(applicationCompositionDrainAbandonments)).toHaveLength(1);
      return yield* Effect.void;
    }),
  );

  suite.effect('a message committed while the fence waited does not fail the publication', () =>
    Effect.gen(function* messageDuringFenceWait() {
      const f = yield* fixture();
      const calls = yield* Ref.make(0);
      // Right before the first fence attempt, ordinary traffic commits a message; the running matcher takes it a
      // moment later. Only a retried fence sees it matched.
      const trafficBeforeFence = Ref.updateAndGet(calls, (seen) => seen + 1).pipe(
        Effect.flatMap((seen) =>
          seen === 1
            ? writeLifecycleMessage(f).pipe(
                Effect.andThen(
                  Effect.gen(function* matchShortlyAfter() {
                    yield* Effect.sleep('1500 millis');
                    yield* f.repository.matchUnmatched(f.old.composition.revision, yield* DateTime.nowAsDate);
                  }).pipe(Effect.ignore, Effect.forkChild),
                ),
                Effect.asVoid,
              )
            : Effect.void,
        ),
      );
      const next = yield* snapshotFor(`${FIXTURE_NAME}-new`, 7200);
      yield* publishApplicationCompositionAuthoritySnapshot(next, Effect.void, trafficBeforeFence).pipe(
        Effect.provide(f.layer),
      );
      expect(yield* Ref.get(calls)).toBeGreaterThanOrEqual(3);
      expect(yield* authorityRow(f.runtime)).toMatchObject({
        durableWorkAdmission: 'open',
        phase: 'active',
        revision: next.composition.revision,
      });
      return yield* Effect.void;
    }),
  );
});
