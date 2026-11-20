import { readFileSync } from 'node:fs';

import { TrustedPrincipalContextSchema, defineScopedRoutine, loadDatabaseConnectionPair } from '@app/core-runtime';
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

import { SymmyPinnedEffectSchema, SymmyPinnedJobPlanSchema } from '../../shared/domain/symmy-job-execution.ts';
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

// The exact routines the admission and the worker invoke.
const reserve = defineScopedRoutine({
  name: 'reserve_symmy_membership_order',
  ownerModuleKey: 'integration.symmy',
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'uuid' },
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
    { source: 'input', type: 'boolean' },
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

/** The reservation routine called with a company of the caller's choosing instead of the scope's own. */
const reserveForCompany = defineScopedRoutine({
  name: 'reserve_symmy_membership_order',
  ownerModuleKey: 'integration.symmy',
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'uuid' },
  ],
  resultSchema: Schema.Struct({ effective_at: Schema.String, source_order: Schema.Int }),
  routineKey: 'symmy-membership.reserve-order-for-company',
  schema: 'symmy_integration',
});

const issuer = 'internal-membership-issuer';
const namespace = 'internal-memberships';
/** A digest from a hexadecimal seed, one per admission of a route. */
const digest = (seed: string) => seed.repeat(64).slice(0, 64);

class FixtureRollback extends Schema.TaggedError<FixtureRollback>()('FixtureRollback', {}) {}

it.effect(
  'orders one profile across groups at admission, delivers in order across a restart and continues an upgraded ledger',
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
        openDatabase(connections.runtime.connectionString).pipe(
          Effect.flatMap((database) =>
            database.transaction((transaction) =>
              installOperationalScope(transaction, scope).pipe(Effect.flatMap(run)),
            ),
          ),
          Effect.scoped,
        );
      /**
       * The admission of one membership: reserve the lineage order, pin the job and its effect, record the order. A
       * public membership takes the time its reservation states; an internal plan states its own time.
       */
      const admit = (routeCode: keyof typeof routeIds, profile: string, seed: string, planDatedAt?: string) =>
        scoped((transaction) =>
          Effect.gen(function* admitMembership() {
            const [reserved] = yield* transaction.invoke(reserve, [issuer, namespace, profile]);
            if (reserved === undefined) {
              return yield* Effect.die('A reservation returns one order');
            }
            const jobId = crypto.randomUUID();
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
                  effectiveAt: planDatedAt ?? reserved.effective_at,
                  groupRef: {
                    ...profileRef,
                    resourceId: groupIds[routeCode],
                    resourceType: 'commerce.customer-context.customer-group',
                  },
                  manager: { factFamily: 'CUSTOMER_GROUP_MEMBERSHIP', issuer, sourceNamespace: namespace, tenantId },
                  operation: 'ASSIGN',
                  profile: { profileKind: 'RETAIL', profileRef },
                  reason:
                    'Qualified Symmy source explicitly assigns this customer profile to the selected customer group',
                  route: { id: routeIds[routeCode], revision: 'route-1' },
                  source: { assertionId: occurrenceId, effectId, order: reserved.source_order, sourceRecordId: seed },
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
            yield* transaction.insert(symmyImportJobs).values({
              executionPlan: Schema.decodeUnknownSync(SymmyPinnedJobPlanSchema)({
                items: [{ effects: [effect], itemId, itemKey: 'membership-0' }],
              }),
              fixtureId: 'INTERNAL_C14',
              idempotencyDigest: digest(seed),
              intentDigest: digest(seed),
              jobId,
              legalEntityId,
              mappingVersion: 'mapping-1',
              phase: 'admitted',
              principalId,
              routeCode,
              routeId: routeIds[routeCode],
              routeKey: 'customerGroupCustomersBatch',
              routeRevision: 'route-1',
              tenantId,
            });
            yield* transaction.insert(symmyJobEffects).values({
              effect,
              effectId,
              effectKey: effect.effectKey,
              itemId,
              jobId,
              state: 'planned',
              tenantId,
              version: 0,
            });
            const [recorded] = yield* transaction.invoke(record, [jobId, planDatedAt === undefined]);
            return { effectId, effectiveAt: reserved.effective_at, order: reserved.source_order, recorded };
          }),
        );
      const isReady = (effectId: string) =>
        scoped((transaction) => transaction.invoke(ready, [effectId])).pipe(Effect.map(([row]) => row?.ready));
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
          .invoke(reserve, [issuer, namespace, profileId])
          .pipe(Effect.andThen(Effect.fail(new FixtureRollback()))),
      ).pipe(Effect.flip);
      expect(Schema.is(FixtureRollback)(lost)).toBe(true);
      // The upper-case spelling of the profile is the same lineage: its order follows the two recorded ones.
      const upper = yield* admit('wholesale', profileId.toUpperCase(), 'c');
      expect(upper.order).toBe(3);

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

      // A blocked earlier membership is retried while its route is enrolled, so a later one waits for it. Once its
      // route's revision changes it can write nothing at the owner, so nothing waits for it any longer.
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
      yield* outletRevision('route-2');
      expect(yield* isReady(unblocked.effectId)).toBe(true);
      yield* outletRevision('route-1');
      expect(yield* isReady(unblocked.effectId)).toBe(false);

      // Only a time this ledger stated is a floor. An internal plan dated far ahead moves no later public time (the
      // owner refuses that later assignment as stale instead); a time the ledger stated keeps every later one at or
      // after it.
      const datedProfile = crypto.randomUUID();
      const planDated = yield* admit('wholesale', datedProfile, '13', '2099-01-01T00:00:00.000Z');
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
      const foreignReservation = scoped((transaction) =>
        transaction.invoke(reserveForCompany, [otherCompany, issuer, namespace, datedProfile]),
      );
      expect(yield* foreignReservation.pipe(Effect.isFailure)).toBe(true);
      const foreignJobId = crypto.randomUUID();
      yield* admin.insert(symmyImportJobs).values({
        executionPlan: null,
        fixtureId: 'INTERNAL_C14',
        idempotencyDigest: digest('16'),
        intentDigest: digest('16'),
        jobId: foreignJobId,
        legalEntityId: otherCompany,
        mappingVersion: 'mapping-1',
        phase: 'admitted',
        principalId,
        routeCode: 'wholesale',
        routeId: routeIds.wholesale,
        routeKey: 'customerGroupCustomersBatch',
        routeRevision: 'route-1',
        tenantId,
      });
      const foreignRecord = scoped((transaction) => transaction.invoke(record, [foreignJobId, true]));
      expect(yield* foreignRecord.pipe(Effect.isFailure)).toBe(true);

      // Upgrade: a membership admitted before the ledger existed has no recorded order. The migration's own backfill
      // records it, so the next reservation continues above it and waits for it.
      const legacyProfile = crypto.randomUUID();
      const legacy = yield* admit('wholesale', legacyProfile, 'e');
      yield* admin
        .delete(symmyMembershipSourceOrders)
        .where(
          and(
            eq(symmyMembershipSourceOrders.tenantId, tenantId),
            eq(symmyMembershipSourceOrders.effectId, legacy.effectId),
          ),
        );
      const migration = readFileSync(
        new URL('../../drizzle/20261120104916_c14-membership-source-order-routines/migration.sql', import.meta.url),
        'utf-8',
      );
      const backfill = yield* Effect.fromOption(
        Option.fromNullishOr(
          migration
            .split('--> statement-breakpoint')
            .find((statement) => statement.includes('Memberships admitted before this migration')),
        ),
      );
      yield* admin.execute(sql.raw(backfill));
      const upgraded = yield* admit('retail', legacyProfile, 'f');
      expect(upgraded.order).toBe(2);
      expect(yield* isReady(upgraded.effectId)).toBe(false);
      yield* setState(legacy.effectId, 'settled');
      expect(yield* isReady(upgraded.effectId)).toBe(true);

      // The backfill covers the owner's whole order range, and two effects with one order of a lineage fail it whole
      // instead of one of them being dropped.
      const collidingProfile = crypto.randomUUID();
      const firstColliding = yield* admit('wholesale', collidingProfile, '17');
      const secondColliding = yield* admit('retail', collidingProfile, '18');
      const colliding = and(
        eq(symmyMembershipSourceOrders.tenantId, tenantId),
        sql`${symmyMembershipSourceOrders.effectId} in (${firstColliding.effectId}, ${secondColliding.effectId})`,
      );
      const collidingRows = admin
        .select({ effectId: symmyMembershipSourceOrders.effectId, order: symmyMembershipSourceOrders.sourceOrder })
        .from(symmyMembershipSourceOrders)
        .where(colliding)
        .orderBy(symmyMembershipSourceOrders.sourceOrder);
      yield* admin.delete(symmyMembershipSourceOrders).where(colliding);
      const pinOrder = (order: number) =>
        admin
          .update(symmyJobEffects)
          .set({
            effect: sql`jsonb_set(${symmyJobEffects.effect}, '{intent,payload,source,order}', to_jsonb(${order}::integer))`,
          })
          .where(and(eq(symmyJobEffects.tenantId, tenantId), eq(symmyJobEffects.effectId, secondColliding.effectId)));
      yield* pinOrder(1);
      expect(yield* admin.execute(sql.raw(backfill)).pipe(Effect.isFailure)).toBe(true);
      expect(yield* collidingRows).toEqual([]);
      yield* pinOrder(2_147_483_647);
      yield* admin.execute(sql.raw(backfill));
      expect(yield* collidingRows).toEqual([
        { effectId: firstColliding.effectId, order: 1 },
        { effectId: secondColliding.effectId, order: 2_147_483_647 },
      ]);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, Reactivity.layer))),
);
