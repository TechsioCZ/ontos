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
import { Clock, Crypto, DateTime, Duration, Effect, Fiber, Layer, Option, Ref, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { CoreDatabase, makeCoreDatabase } from '../../packages/core-runtime/src/db/client.ts';
import type { CoreDbExecutor } from '../../packages/core-runtime/src/db/types.ts';
import {
  applicationCompositionAuthority,
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
import { listUndrainableOutboxWork } from '../../packages/core-runtime/src/outbox/undrainable-work.ts';
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
} from '../application-composition-authority-publication.mts';

const services = NodeChildProcessSpawner.layer.pipe(Layer.provideMerge(NodeServices.layer));
const FIXTURE_NAME = 'core-system-drain';
const CLAIM_OWNER = `${FIXTURE_NAME}-claimer`;
/** All five shipped core-system registrations, exactly as the Zerops Outbox host binds them. */
const ALL_CORE_WORKERS = [...coreSystemOutboxWorkers, ...corePeopleSearchOutboxWorkers];
/** The window in which a promotion may refuse reads: the quiescent drain, not a budget's worth of outage. */
const QUIESCENT_WINDOW_MS = 30_000;
/** A tenant-module worker key the fixture composition never approves, so nothing can consume it. */
const ABSENT_WORKER_KEY = 'commerce.merchandise.project-offer';

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
const fixture = Effect.fn('coreSystemDrainFixture')(function* coreSystemDrainFixture(
  options: { readonly moduleStateFor?: string } = {},
) {
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
  if (options.moduleStateFor !== undefined) {
    yield* runtime.insert(tenantModuleStates).values({ moduleKey: options.moduleStateFor, state: 'active', tenantId });
  }
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
        .set({ consumerModuleKey: 'commerce.merchandise', workerKey: ABSENT_WORKER_KEY })
        .where(eq(outboxDeliveries.workerKey, corePrincipalLifecycleSubscription.workerKey));
      const next = yield* snapshotFor(`${FIXTURE_NAME}-new`, 7200);

      const failure = yield* publishApplicationCompositionAuthoritySnapshot(next, Effect.void, Effect.void).pipe(
        Effect.provide(f.layer),
        Effect.flip,
      );
      expect(Schema.is(ApplicationCompositionAuthorityError)(failure)).toBe(true);
      const reason = Schema.is(ApplicationCompositionAuthorityError)(failure) ? failure.reason : '';
      expect(reason).toContain('drain was not started: durable admission is unchanged');
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
      // A short freshness lease bounds the drain wait at about ten seconds.
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
      // The retiring release approved that descriptor and its own host claims it, so the work has a consumer and
      // the pre-flight admits the drain. It is simply not this release's to finish: the drain waits for it.
      expect(reason).not.toContain('drain was not started');
      expect(reason).toContain('did not finish within its freshness lease');
      expect(yield* deliveryRow(f.runtime)).toMatchObject({ attempts: 0, status: 'pending' });
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
        coreSystemConsumers: sets.coreSystemConsumers,
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
          coreSystemConsumers: sets.coreSystemConsumers,
        }),
      ).toHaveLength(0);

      // A tenant-module delivery with no installed module: the pre-flight blocks and the verdict turns to no.
      yield* f.runtime
        .update(outboxDeliveries)
        .set({ consumerModuleKey: 'commerce.merchandise', workerKey: ABSENT_WORKER_KEY })
        .where(eq(outboxDeliveries.workerKey, corePrincipalLifecycleSubscription.workerKey));
      const blocked = yield* listDrainWork(f.runtime, {
        budgetMs,
        carriedOverWorkerKeys: sets.carriedOverWorkerKeys,
        coreSystemConsumers: sets.coreSystemConsumers,
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
          coreSystemConsumers: sets.coreSystemConsumers,
        }),
      ).toHaveLength(1);
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
        operatorName: 'operator@example.test',
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
        coreSystemConsumers: sets.coreSystemConsumers,
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
        coreSystemConsumers: sets.coreSystemConsumers,
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

      const failure = yield* publishApplicationCompositionAuthoritySnapshot(next, Effect.void, Effect.void).pipe(
        Effect.provide(f.layer),
        Effect.flip,
      );
      expect(Schema.is(ApplicationCompositionAuthorityError)(failure)).toBe(true);
      const reason = Schema.is(ApplicationCompositionAuthorityError)(failure) ? failure.reason : '';
      // The pre-flight admitted it (work in flight drains); the drain then waited for it and ran out of lease.
      expect(reason).not.toContain('drain was not started');
      expect(reason).toContain('did not finish within its freshness lease');
      expect(yield* deliveryRow(f.runtime)).toMatchObject({ status: 'processing' });
    }),
  );
});
