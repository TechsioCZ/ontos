import {
  ScopedRoutineInvocationError,
  TrustedPrincipalContextSchema,
  defineScopedRoutine,
  loadDatabaseConnectionPair,
} from '@app/core-runtime';
import type { OperationalScope, ScopedTransactionExecutor } from '@app/core-runtime';
import { installOperationalScope } from '@app/core-runtime/testing/actions';
import { NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { and, eq, sql } from 'drizzle-orm';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { SymmyEffectOutcomeSchema } from '@app/shared-contracts/symmy';
import { DateTime, Effect, Layer, Option, Redacted, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { expect, it } from 'effect-rstest';

import {
  SymmyEffectClaimSchema,
  SymmyPinnedEffectSchema,
  SymmyPinnedJobPlanSchema,
} from '../../shared/domain/symmy-job-execution.ts';
import {
  symmyImportJobs,
  symmyIntegrationRelations,
  symmyJobEffects,
  symmyJobRoutes,
  symmyMembershipSourceOrders,
} from '../../src/db/schema.ts';

const openDatabase = (connectionString: string) =>
  PgClient.makeClient({ url: Redacted.make(connectionString) }).pipe(
    Effect.flatMap((client) =>
      makeWithDefaults({ relations: symmyIntegrationRelations }).pipe(Effect.provideService(PgClient.PgClient, client)),
    ),
  );
const makeScope = (tenantId: string, principalId: string, legalEntityId: string): OperationalScope => ({
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authBindingId: crypto.randomUUID(),
    authContextRef: 'better-auth-api-key:internal-membership-order-fixture',
    authMethod: 'api_key',
    legalEntityId,
    principalId,
    tenantId,
  }),
  audience: 'symmy-integration',
  correlationId: 'membership-order-fixture',
});
/** Runs `run` in one transaction of the runtime role, scoped to `scope`. */
const inScope = <A, E>(
  connectionString: string,
  scope: OperationalScope,
  run: (transaction: ScopedTransactionExecutor) => Effect.Effect<A, E>,
) =>
  openDatabase(connectionString).pipe(
    Effect.flatMap((database) =>
      database.transaction((transaction) => installOperationalScope(transaction, scope).pipe(Effect.flatMap(run))),
    ),
    Effect.scoped,
  );

// The exact routines the admission and the worker invoke.
const reserve = defineScopedRoutine({
  name: 'reserve_symmy_membership_order',
  ownerModuleKey: 'integration.symmy',
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'boolean' },
  ],
  resultSchema: Schema.Struct({ effective_at: Schema.String, source_order: Schema.Int }),
  routineKey: 'symmy-membership.reserve-order',
  schema: 'symmy_integration',
});
const record = defineScopedRoutine({
  name: 'record_symmy_membership_orders',
  ownerModuleKey: 'integration.symmy',
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'input', type: 'uuid' },
  ],
  resultSchema: Schema.Struct({ recorded: Schema.Int }),
  routineKey: 'symmy-membership.record-orders',
  schema: 'symmy_integration',
});
const ready = defineScopedRoutine({
  name: 'symmy_membership_order_ready',
  ownerModuleKey: 'integration.symmy',
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'input', type: 'uuid' },
  ],
  resultSchema: Schema.Struct({ ready: Schema.Boolean }),
  routineKey: 'symmy-job.membership-order-ready',
  schema: 'symmy_integration',
});
const claim = defineScopedRoutine({
  name: 'claim_symmy_job_effect',
  ownerModuleKey: 'integration.symmy',
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'uuid' },
  ],
  resultSchema: Schema.toEncoded(SymmyEffectClaimSchema),
  routineKey: 'symmy-job.claim-effect',
  schema: 'symmy_integration',
});

/** The reservation routine called with a company of the caller's choosing instead of the scope's own. */
const reserveForCompany = defineScopedRoutine({
  name: 'reserve_symmy_membership_order',
  ownerModuleKey: 'integration.symmy',
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'boolean' },
  ],
  resultSchema: Schema.Struct({ effective_at: Schema.String, source_order: Schema.Int }),
  routineKey: 'symmy-membership.reserve-order-for-company',
  schema: 'symmy_integration',
});

const issuer = 'internal-membership-issuer';
const namespace = 'internal-memberships';
/** A digest from a hexadecimal seed, one per admission of a route. */
const digest = (seed: string) => seed.repeat(64).slice(0, 64);

/** The PostgreSQL SQLSTATE a scoped routine failed with, as its invocation error reports it. */
const sqlStateOf = <Failure>(failure: Failure) =>
  Schema.is(ScopedRoutineInvocationError)(failure) ? Option.getOrUndefined(failure.postgresCode) : undefined;

class FixtureRollback extends Schema.TaggedError<FixtureRollback>()('FixtureRollback', {}) {}

it.effect(
  'orders one profile across groups at admission, binds each order to its own reservation and delivers in order',
  () =>
    Effect.gen(function* membershipOrders() {
      const connections = yield* loadDatabaseConnectionPair({ envPath: '/dev/null' });
      const admin = yield* openDatabase(connections.admin.connectionString);
      const tenantId = crypto.randomUUID();
      const legalEntityId = crypto.randomUUID();
      const principalId = crypto.randomUUID();
      const scope = makeScope(tenantId, principalId, legalEntityId);
      const profileId = crypto.randomUUID();
      yield* Effect.addFinalizer(() =>
        admin
          .delete(symmyMembershipSourceOrders)
          .where(eq(symmyMembershipSourceOrders.tenantId, tenantId))
          .pipe(
            Effect.andThen(admin.delete(symmyJobEffects).where(eq(symmyJobEffects.tenantId, tenantId))),
            Effect.andThen(admin.delete(symmyImportJobs).where(eq(symmyImportJobs.tenantId, tenantId))),
            Effect.andThen(admin.delete(symmyJobRoutes).where(eq(symmyJobRoutes.tenantId, tenantId))),
            Effect.orDie,
          ),
      );
      // Three enrolled routes, each selecting another group, share the membership source of one issuer.
      const routeIds = { outlet: crypto.randomUUID(), retail: crypto.randomUUID(), wholesale: crypto.randomUUID() };
      const groupIds = { outlet: crypto.randomUUID(), retail: crypto.randomUUID(), wholesale: crypto.randomUUID() };
      yield* admin.insert(symmyJobRoutes).values(
        Object.entries(routeIds).map(([routeCode, routeId]) => ({
          active: true,
          fixtureIds: ['INTERNAL_C14'],
          legalEntityId,
          mappingVersion: 'mapping-1',
          principalId,
          routeCode,
          routeId,
          routeKey: 'customerGroupCustomersBatch' as const,
          routeRevision: 'route-1',
          tenantId,
        })),
      );
      const scoped = <A, E>(run: (transaction: ScopedTransactionExecutor) => Effect.Effect<A, E>) =>
        inScope(connections.runtime.connectionString, scope, run);
      /** One membership effect of a job, pinned exactly as the admission pins it. */
      const membershipEffect = (
        routeCode: keyof typeof routeIds,
        profile: string,
        seed: string,
        effectiveAt: string,
        order: number,
      ) => {
        const itemId = crypto.randomUUID();
        const effectId = crypto.randomUUID();
        const occurrenceId = crypto.randomUUID();
        const profileRef = {
          moduleId: 'commerce.customer-context',
          resourceId: profile,
          resourceType: 'commerce.customer-context.retail-customer-profile',
          tenantId,
        };
        const effect = Schema.decodeUnknownSync(SymmyPinnedEffectSchema)({
          effectKey: 'customer-group-assignment',
          intent: {
            _tag: 'CustomerGroupMembership',
            payload: {
              effectiveAt,
              groupRef: {
                ...profileRef,
                resourceId: groupIds[routeCode],
                resourceType: 'commerce.customer-context.customer-group',
              },
              manager: { factFamily: 'CUSTOMER_GROUP_MEMBERSHIP', issuer, sourceNamespace: namespace, tenantId },
              operation: 'ASSIGN',
              profile: { profileKind: 'RETAIL', profileRef },
              reason: 'Qualified Symmy source explicitly assigns this customer profile to the selected customer group',
              route: { id: routeIds[routeCode], revision: 'route-1' },
              source: { assertionId: occurrenceId, effectId, order, sourceRecordId: seed },
            },
          },
          itemId,
          ref: {
            effectId,
            mappingVersion: 'mapping-1',
            occurrence: {
              occurrenceId,
              record: {
                entityKind: 'CUSTOMER_GROUP_MEMBERSHIP',
                issuerId: issuer,
                route: { integrationRouteId: routeIds[routeCode], tenantId },
                sourceNamespace: namespace,
                sourceRecordId: seed,
              },
            },
            operation: {
              entrypointKey: 'commerce.customer-context.apply-customer-group-membership-source',
              moduleId: 'commerce.customer-context',
              schemaVersion: '1',
            },
            originalTarget: profileRef,
            routeRevision: 'route-1',
          },
        });
        return { effect, effectId, itemId };
      };
      /** Inserts one admitted job with its one effect, as the admission does after it pinned the plan. */
      const insertJob = (
        writer: Pick<ScopedTransactionExecutor, 'insert'>,
        routeCode: keyof typeof routeIds,
        idempotencyDigest: string,
        pinned: ReturnType<typeof membershipEffect>,
        jobLegalEntity = legalEntityId,
      ) =>
        Effect.gen(function* insertAdmittedJob() {
          const jobId = crypto.randomUUID();
          yield* writer.insert(symmyImportJobs).values({
            executionPlan: Schema.decodeUnknownSync(SymmyPinnedJobPlanSchema)({
              items: [{ effects: [pinned.effect], itemId: pinned.itemId, itemKey: 'membership-0' }],
            }),
            fixtureId: 'INTERNAL_C14',
            idempotencyDigest,
            intentDigest: idempotencyDigest,
            jobId,
            legalEntityId: jobLegalEntity,
            mappingVersion: 'mapping-1',
            phase: 'admitted',
            principalId,
            routeCode,
            routeId: routeIds[routeCode],
            routeKey: 'customerGroupCustomersBatch',
            routeRevision: 'route-1',
            tenantId,
          });
          yield* writer.insert(symmyJobEffects).values({
            effect: pinned.effect,
            effectId: pinned.effectId,
            effectKey: pinned.effect.effectKey,
            itemId: pinned.itemId,
            jobId,
            state: 'planned',
            tenantId,
            version: 0,
          });
          return jobId;
        });
      /**
       * The admission of one membership: reserve the lineage order for this admission, pin the job and its effect,
       * record. A public membership states the time its reservation issued; an internal plan states its own time.
       * `jobDigest` admits the job under another idempotency digest than the one the order was reserved for, and
       * `statedAt` makes a public membership state another time than the one issued.
       */
      const admit = (
        routeCode: keyof typeof routeIds,
        profile: string,
        seed: string,
        options: {
          readonly jobDigest?: string;
          readonly planDatedAt?: DateTime.Utc;
          readonly statedAt?: DateTime.Utc;
        } = {},
      ) =>
        scoped((transaction) =>
          Effect.gen(function* admitMembership() {
            const [reserved] = yield* transaction.invoke(reserve, [
              routeIds[routeCode],
              digest(seed),
              issuer,
              namespace,
              profile,
              options.planDatedAt === undefined,
            ]);
            if (reserved === undefined) {
              return yield* Effect.die('A reservation returns one order');
            }
            const stated = options.planDatedAt ?? options.statedAt;
            const pinned = membershipEffect(
              routeCode,
              profile,
              seed,
              stated === undefined ? reserved.effective_at : DateTime.formatIso(stated),
              reserved.source_order,
            );
            const jobId = yield* insertJob(transaction, routeCode, options.jobDigest ?? digest(seed), pinned);
            const [recorded] = yield* transaction.invoke(record, [jobId]);
            return {
              effectId: pinned.effectId,
              effectiveAt: reserved.effective_at,
              jobId,
              order: reserved.source_order,
              recorded,
            };
          }),
        );
      const isReady = (effectId: string) =>
        scoped((transaction) => transaction.invoke(ready, [effectId])).pipe(Effect.map(([row]) => row?.ready));
      /** What the worker's claim makes of an effect: executed, or blocked because its route is no longer active. */
      const claimMode = (admitted: { readonly effectId: string; readonly jobId: string }) =>
        scoped((transaction) =>
          transaction.invoke(claim, [admitted.jobId, admitted.effectId, crypto.randomUUID()]),
        ).pipe(Effect.map(([row]) => row?.mode));
      /** Moves an effect as a worker would: claimed, its lease lost in a restart, uncertain, blocked, then settled. */
      const setState = Effect.fn('MembershipOrderFixture.setState')(function* setState(
        effectId: string,
        state: 'attempting' | 'blocked' | 'indeterminate' | 'settled',
      ) {
        // A lease that ended long ago: the claiming worker is gone.
        const expiredLease = DateTime.toDate(DateTime.makeUnsafe('2000-01-01T00:00:00.000Z'));
        return yield* admin
          .update(symmyJobEffects)
          .set({
            claimToken: state === 'attempting' ? crypto.randomUUID() : null,
            leaseUntil: state === 'attempting' ? expiredLease : null,
            outcome:
              state === 'settled' || state === 'blocked'
                ? Schema.decodeUnknownSync(SymmyEffectOutcomeSchema)({
                    effectId,
                    owner: 'commerce.customer-context',
                    status: state === 'settled' ? 'accepted_change' : 'denied',
                  })
                : null,
            state,
          })
          .where(and(eq(symmyJobEffects.tenantId, tenantId), eq(symmyJobEffects.effectId, effectId)));
      });

      // Two assignments of one profile to two groups, admitted concurrently, take distinct orders of one lineage.
      const [wholesale, retail] = yield* Effect.all(
        [admit('wholesale', profileId, 'a'), admit('retail', profileId, 'b')],
        { concurrency: 2 },
      );
      expect(new Set([wholesale.order, retail.order])).toEqual(new Set([1, 2]));
      expect([wholesale.recorded?.recorded, retail.recorded?.recorded]).toEqual([1, 1]);
      const [first, second] = wholesale.order < retail.order ? [wholesale, retail] : [retail, wholesale];
      expect(second.effectiveAt >= first.effectiveAt).toBe(true);

      // An admission that loses its job (a lost same-key race or any rollback) consumes no order.
      const lost = yield* scoped((transaction) =>
        transaction
          .invoke(reserve, [routeIds.wholesale, digest('c'), issuer, namespace, profileId, true])
          .pipe(Effect.andThen(Effect.fail(new FixtureRollback()))),
      ).pipe(Effect.flip);
      expect(Schema.is(FixtureRollback)(lost)).toBe(true);
      // The upper-case spelling of the profile is the same lineage: its order follows the two recorded ones.
      const upper = yield* admit('wholesale', profileId.toUpperCase(), 'c');
      expect(upper.order).toBe(3);

      // A job records only orders its own admission reserved, at the time that reservation issued. A job admitted
      // under another idempotency digest than the reservation's, or a public membership stating another time, is
      // refused, and its whole admission with it: no order is consumed.
      const unreserved = yield* admit('retail', profileId, '1', { jobDigest: digest('2') }).pipe(Effect.flip);
      expect(sqlStateOf(unreserved)).toBe('42501');
      const otherTime = yield* admit('retail', profileId, '3', {
        statedAt: DateTime.makeUnsafe('2020-01-01T00:00:00.000Z'),
      }).pipe(Effect.flip);
      expect(sqlStateOf(otherTime)).toBe('42501');
      expect((yield* admit('retail', profileId, '4')).order).toBe(4);

      // Delivery is sequenced: a later order waits until every earlier one of its lineage has settled.
      expect(yield* isReady(first.effectId)).toBe(true);
      expect(yield* isReady(second.effectId)).toBe(false);
      // A worker that claimed the first effect and died leaves it uncertain; a restarted worker still waits.
      yield* setState(first.effectId, 'attempting');
      expect(yield* isReady(second.effectId)).toBe(false);
      yield* setState(first.effectId, 'indeterminate');
      expect(yield* isReady(second.effectId)).toBe(false);
      yield* setState(first.effectId, 'settled');
      expect(yield* isReady(second.effectId)).toBe(true);
      expect(yield* isReady(upper.effectId)).toBe(false);
      yield* setState(second.effectId, 'settled');
      expect(yield* isReady(upper.effectId)).toBe(true);

      // Another profile is another lineage and never waits for this one.
      const other = yield* admit('retail', crypto.randomUUID(), 'd');
      expect(other.order).toBe(1);
      expect(yield* isReady(other.effectId)).toBe(true);

      // A later membership waits for an earlier one exactly while the claim would still execute that earlier one.
      const blockedProfile = crypto.randomUUID();
      const blocked = yield* admit('outlet', blockedProfile, '11');
      const unblocked = yield* admit('retail', blockedProfile, '12');
      yield* setState(blocked.effectId, 'blocked');
      expect(yield* isReady(unblocked.effectId)).toBe(false);
      const outletRevision = (routeRevision: string) =>
        admin
          .update(symmyJobRoutes)
          .set({ routeRevision })
          .where(and(eq(symmyJobRoutes.tenantId, tenantId), eq(symmyJobRoutes.routeId, routeIds.outlet)));
      // Its route's revision changed: the claim keeps it blocked, so nothing waits for it.
      yield* outletRevision('route-2');
      expect(yield* claimMode(blocked)).toBe('blocked');
      expect(yield* isReady(unblocked.effectId)).toBe(true);
      // The revision restored: the claim executes it again, so the later one waits for it again.
      yield* outletRevision('route-1');
      expect(yield* isReady(unblocked.effectId)).toBe(false);
      expect(yield* claimMode(blocked)).toBe('execute');
      expect(yield* isReady(unblocked.effectId)).toBe(false);

      // Only a time this ledger issued to a membership that states it is a floor. An internal plan dated far ahead
      // moves no later public time (the owner refuses that later assignment as stale instead); a time the ledger
      // issued keeps every later one at or after it.
      const datedProfile = crypto.randomUUID();
      const planDated = yield* admit('wholesale', datedProfile, '13', {
        planDatedAt: DateTime.makeUnsafe('2099-01-01T00:00:00.000Z'),
      });
      const afterPlan = yield* admit('retail', datedProfile, '14');
      expect([planDated.order, afterPlan.order]).toEqual([1, 2]);
      expect(afterPlan.effectiveAt < '2099-01-01T00:00:00.000Z').toBe(true);
      const ledgerTimes = yield* admin
        .select({
          effectId: symmyMembershipSourceOrders.effectId,
          effectiveAt: symmyMembershipSourceOrders.effectiveAt,
        })
        .from(symmyMembershipSourceOrders)
        .where(
          and(
            eq(symmyMembershipSourceOrders.tenantId, tenantId),
            sql`${symmyMembershipSourceOrders.effectId} in (${planDated.effectId}, ${afterPlan.effectId})`,
          ),
        );
      expect(ledgerTimes.find(({ effectId }) => effectId === planDated.effectId)?.effectiveAt).toBeNull();
      yield* admin
        .update(symmyMembershipSourceOrders)
        .set({ effectiveAt: DateTime.toDate(DateTime.makeUnsafe('2098-01-01T00:00:00.000Z')) })
        .where(
          and(
            eq(symmyMembershipSourceOrders.tenantId, tenantId),
            eq(symmyMembershipSourceOrders.effectId, afterPlan.effectId),
          ),
        );
      const floored = yield* admit('outlet', datedProfile, '15');
      expect(floored).toMatchObject({ effectiveAt: '2098-01-01T00:00:00.000Z', order: 3 });

      // The routines serve the company the transaction is scoped to only, never another company of the tenant.
      const otherCompany = crypto.randomUUID();
      const foreignReservation = yield* scoped((transaction) =>
        transaction.invoke(reserveForCompany, [
          otherCompany,
          routeIds.wholesale,
          digest('16'),
          issuer,
          namespace,
          datedProfile,
          true,
        ]),
      ).pipe(Effect.flip);
      expect(sqlStateOf(foreignReservation)).toBe('42501');
      const foreignPinned = membershipEffect('wholesale', crypto.randomUUID(), '16', '2026-11-20T00:00:00.000Z', 1);
      const foreignJobId = yield* insertJob(admin, 'wholesale', digest('16'), foreignPinned, otherCompany);
      const foreignRecord = yield* scoped((transaction) => transaction.invoke(record, [foreignJobId])).pipe(
        Effect.flip,
      );
      expect(sqlStateOf(foreignRecord)).toBe('42501');
      // Readiness refuses this company's effect to a transaction scoped to another company; the tenant-wide worker
      // reads every company's effects.
      const foreignReady = yield* inScope(
        connections.runtime.connectionString,
        makeScope(tenantId, principalId, otherCompany),
        (transaction) => transaction.invoke(ready, [other.effectId]),
      ).pipe(Effect.flip);
      expect(sqlStateOf(foreignReady)).toBe('42501');
      const { legalEntityId: _company, ...tenantScope } = scope;
      const tenantWide = yield* inScope(connections.runtime.connectionString, tenantScope, (transaction) =>
        transaction.invoke(ready, [other.effectId]),
      );
      expect(tenantWide).toEqual([{ ready: true }]);

      // A membership effect the ledger holds no order for is never delivered: readiness refuses it instead of
      // treating it as first of its lineage. An effect that is not a membership has no lineage to wait for.
      const unordered = membershipEffect('retail', crypto.randomUUID(), '17', '2026-11-20T00:00:00.000Z', 1);
      yield* insertJob(admin, 'retail', digest('17'), unordered);
      const unorderedReady = yield* isReady(unordered.effectId).pipe(Effect.flip);
      expect(sqlStateOf(unorderedReady)).toBe('55000');
      const notMembership = membershipEffect('retail', crypto.randomUUID(), '18', '2026-11-20T00:00:00.000Z', 1);
      const { intent: _intent, ...withoutIntent } = notMembership.effect;
      yield* insertJob(admin, 'retail', digest('18'), { ...notMembership, effect: withoutIntent });
      expect(yield* isReady(notMembership.effectId)).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, Reactivity.layer))),
);
