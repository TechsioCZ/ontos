import {
  ScopedRoutineInvocationError,
  TrustedPrincipalContextSchema,
  defineScopedRoutine,
  findPostgresFailure,
  loadDatabaseConnectionPair,
} from '@app/core-runtime';
import type { OperationalScope, ScopedTransactionExecutor } from '@app/core-runtime';
import { installOperationalScope } from '@app/core-runtime/testing/actions';
import { NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { and, eq } from 'drizzle-orm';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { SymmyEffectOutcomeSchema } from '@app/shared-contracts/symmy';
import { DateTime, Effect, Layer, Option, Redacted, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { expect, it } from 'effect-rstest';

import {
  SymmyEffectClaimSchema,
  SymmyFixtureExecutionPlanSchema,
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
const claimBase = {
  name: 'claim_symmy_job_effect',
  ownerModuleKey: 'integration.symmy',
  resultSchema: Schema.toEncoded(SymmyEffectClaimSchema),
  routineKey: 'symmy-job.claim-effect',
  schema: 'symmy_integration',
} as const;
/** The claim as a worker from before the ledger calls it: it states no membership protocol. */
const legacyClaim = defineScopedRoutine({
  ...claimBase,
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'uuid' },
  ],
});
const claim = defineScopedRoutine({
  ...claimBase,
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'integer' },
  ],
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
  ],
  resultSchema: Schema.Struct({ effective_at: Schema.String, source_order: Schema.Int }),
  routineKey: 'symmy-membership.reserve-order-for-company',
  schema: 'symmy_integration',
});

const issuer = 'erp-membership-issuer';
/** A source namespace reserved for ERP memberships: the ledger issues its orders. */
const namespace = 'erp-membership-v1:akros';
/** A membership source its callers order themselves: the ledger never sees it. */
const internalNamespace = 'internal-memberships';
const erpContract = 'ERP_MEMBERSHIP_V1';
const internalContract = 'INTERNAL_C14';
/** A digest from a hexadecimal seed, one per admission of a route. */
const digest = (seed: string) => seed.repeat(64).slice(0, 64);

/** The PostgreSQL SQLSTATE a scoped routine failed with, as its invocation error reports it. */
const sqlStateOf = <Failure>(failure: Failure) =>
  Schema.is(ScopedRoutineInvocationError)(failure) ? Option.getOrUndefined(failure.postgresCode) : undefined;
/** The SQLSTATE a statement or a commit failed with. */
const postgresCodeOf = <Failure>(failure: Failure) => Option.getOrUndefined(findPostgresFailure(failure))?.code;

class FixtureRollback extends Schema.TaggedError<FixtureRollback>()('FixtureRollback', {}) {}

/** The enrollment of a membership route: the owner's membership write under one membership source. */
const membershipEnrollment = (sourceNamespace: string) =>
  Schema.decodeUnknownSync(SymmyFixtureExecutionPlanSchema)({
    items: [
      {
        effects: [
          {
            effectKey: 'enrolled-membership',
            operation: {
              entrypointKey: 'commerce.customer-context.apply-customer-group-membership-source',
              moduleId: 'commerce.customer-context',
              schemaVersion: '1',
            },
          },
        ],
        itemKey: 'membership',
        source: {
          entityKind: 'CUSTOMER_GROUP_MEMBERSHIP',
          issuerId: issuer,
          sourceNamespace,
          sourceRecordId: 'enrollment',
        },
      },
    ],
  });

it.effect(
  'orders ERP memberships of one profile in its ledger alone, delivers them in order and never skips an earlier one',
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
      // Three ERP membership routes, each selecting another group, share the membership source of one issuer. A
      // fourth route of the same kind keeps the contract it always had, for memberships its callers order themselves.
      const routeIds = {
        internal: crypto.randomUUID(),
        outlet: crypto.randomUUID(),
        retail: crypto.randomUUID(),
        wholesale: crypto.randomUUID(),
      };
      const groupIds = {
        internal: crypto.randomUUID(),
        outlet: crypto.randomUUID(),
        retail: crypto.randomUUID(),
        wholesale: crypto.randomUUID(),
      };
      const routeRow = (
        routeCode: string,
        routeId: string,
        fixtureIds: readonly string[],
        sourceNamespace: string,
        company: string | null = legalEntityId,
      ) => ({
        active: true,
        fixtureIds: [...fixtureIds],
        fixturePlan: membershipEnrollment(sourceNamespace),
        legalEntityId: company,
        mappingVersion: 'mapping-1',
        principalId,
        routeCode,
        routeId,
        routeKey: 'customerGroupCustomersBatch' as const,
        routeRevision: 'route-1',
        tenantId,
      });
      yield* admin
        .insert(symmyJobRoutes)
        .values(
          Object.entries(routeIds).map(([routeCode, routeId]) =>
            routeCode === 'internal'
              ? routeRow(routeCode, routeId, [internalContract], internalNamespace)
              : routeRow(routeCode, routeId, [erpContract], namespace),
          ),
        );
      // The reserved namespace belongs to ERP membership routes alone, and such a route enrolls nothing else.
      for (const [routeCode, refused] of Object.entries({
        'mixed-contracts': routeRow('mixed-contracts', crypto.randomUUID(), [internalContract, erpContract], namespace),
        'no-company': routeRow('no-company', crypto.randomUUID(), [erpContract], namespace, null),
        'other-contract': routeRow('other-contract', crypto.randomUUID(), [internalContract], namespace),
        'other-namespace': routeRow('other-namespace', crypto.randomUUID(), [erpContract], internalNamespace),
      })) {
        const failure = yield* admin.insert(symmyJobRoutes).values(refused).pipe(Effect.flip);
        expect(postgresCodeOf(failure), routeCode).toBe('23514');
      }
      const reenrolled = yield* admin
        .update(symmyJobRoutes)
        .set({ fixtureIds: [internalContract, erpContract] })
        .where(and(eq(symmyJobRoutes.tenantId, tenantId), eq(symmyJobRoutes.routeId, routeIds.retail)))
        .pipe(Effect.flip);
      expect(postgresCodeOf(reenrolled)).toBe('23514');

      const scoped = <A, E>(run: (transaction: ScopedTransactionExecutor) => Effect.Effect<A, E>) =>
        inScope(connections.runtime.connectionString, scope, run);
      /** One membership effect of a job, pinned exactly as the admission pins it. */
      const membershipEffect = (
        routeCode: keyof typeof routeIds,
        profile: string,
        seed: string,
        effectiveAt: string,
        order: number,
        sourceNamespace = namespace,
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
              manager: { factFamily: 'CUSTOMER_GROUP_MEMBERSHIP', issuer, sourceNamespace, tenantId },
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
                sourceNamespace,
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
        fixtureId = erpContract,
      ) =>
        Effect.gen(function* insertAdmittedJob() {
          const jobId = crypto.randomUUID();
          yield* writer.insert(symmyImportJobs).values({
            executionPlan: Schema.decodeUnknownSync(SymmyPinnedJobPlanSchema)({
              items: [{ effects: [pinned.effect], itemId: pinned.itemId, itemKey: 'membership-0' }],
            }),
            fixtureId,
            idempotencyDigest,
            intentDigest: idempotencyDigest,
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
       * The admission of one ERP membership: reserve the lineage order for this admission, pin the job and its effect
       * with the order and time the reservation issued, record. `jobDigest` admits the job under another idempotency
       * digest than the one the order was reserved for, and `statedAt` makes it state another time than the one issued.
       */
      const admit = (
        routeCode: keyof typeof routeIds,
        profile: string,
        seed: string,
        options: { readonly jobDigest?: string; readonly statedAt?: DateTime.Utc } = {},
      ) =>
        scoped((transaction) =>
          Effect.gen(function* admitMembership() {
            const [reserved] = yield* transaction.invoke(reserve, [
              routeIds[routeCode],
              digest(seed),
              issuer,
              namespace,
              profile,
            ]);
            if (reserved === undefined) {
              return yield* Effect.die('A reservation returns one order');
            }
            const pinned = membershipEffect(
              routeCode,
              profile,
              seed,
              options.statedAt === undefined ? reserved.effective_at : DateTime.formatIso(options.statedAt),
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
      interface Admitted {
        readonly effectId: string;
        readonly jobId: string;
      }
      /** What the claim of a worker that implements the membership protocol makes of an effect. */
      const claimMode = (admitted: Admitted) =>
        scoped((transaction) =>
          transaction.invoke(claim, [admitted.jobId, admitted.effectId, crypto.randomUUID(), 1]),
        ).pipe(Effect.map(([row]) => row?.mode));
      /** What the claim of a worker from before the ledger makes of it. */
      const legacyClaimMode = (admitted: Admitted) =>
        scoped((transaction) =>
          transaction.invoke(legacyClaim, [admitted.jobId, admitted.effectId, crypto.randomUUID()]),
        ).pipe(Effect.map(([row]) => row?.mode));
      const saved = (effectId: string) =>
        admin
          .select({ outcome: symmyJobEffects.outcome, state: symmyJobEffects.state })
          .from(symmyJobEffects)
          .where(and(eq(symmyJobEffects.tenantId, tenantId), eq(symmyJobEffects.effectId, effectId)))
          .pipe(Effect.map(([row]) => ({ state: row?.state, status: row?.outcome?.status })));
      /** Moves an effect as a worker would: its owner call uncertain, or settled by the owner's answer. */
      const setState = Effect.fn('MembershipOrderFixture.setState')(function* setState(
        effectId: string,
        state: 'indeterminate' | 'settled',
      ) {
        return yield* admin
          .update(symmyJobEffects)
          .set({
            claimToken: null,
            leaseUntil: null,
            outcome:
              state === 'settled'
                ? Schema.decodeUnknownSync(SymmyEffectOutcomeSchema)({
                    effectId,
                    owner: 'commerce.customer-context',
                    status: 'accepted_change',
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

      // An admission that loses its job (a lost same-key race or any rollback) consumes no order, and a reservation
      // no job of its admission takes cannot commit at all: the ledger holds no order without its effect.
      const lost = yield* scoped((transaction) =>
        transaction
          .invoke(reserve, [routeIds.wholesale, digest('c'), issuer, namespace, profileId])
          .pipe(Effect.andThen(Effect.fail(new FixtureRollback()))),
      ).pipe(Effect.flip);
      expect(Schema.is(FixtureRollback)(lost)).toBe(true);
      const unbound = yield* scoped((transaction) =>
        transaction.invoke(reserve, [routeIds.wholesale, digest('c'), issuer, namespace, profileId]),
      ).pipe(Effect.flip);
      expect(postgresCodeOf(unbound)).toBe('55000');
      // The upper-case spelling of the profile is the same lineage: its order follows the two recorded ones.
      const third = yield* admit('wholesale', profileId.toUpperCase(), 'c');
      expect(third.order).toBe(3);

      // A job records only orders its own admission reserved, at the time that reservation issued. A job admitted
      // under another idempotency digest than the reservation's, or one stating another time, is refused, and its
      // whole admission with it: no order is consumed.
      const unreserved = yield* admit('retail', profileId, '1', { jobDigest: digest('2') }).pipe(Effect.flip);
      expect(sqlStateOf(unreserved)).toBe('42501');
      const otherTime = yield* admit('retail', profileId, '3', {
        statedAt: DateTime.makeUnsafe('2020-01-01T00:00:00.000Z'),
      }).pipe(Effect.flip);
      expect(sqlStateOf(otherTime)).toBe('42501');
      const fourth = yield* admit('retail', profileId, '4');
      expect(fourth.order).toBe(4);
      expect(fourth.effectiveAt >= third.effectiveAt).toBe(true);

      // Only an ERP membership route reserves, and only for the source it enrolls.
      for (const [routeId, sourceNamespace] of [
        [routeIds.retail, 'erp-membership-v1:another'],
        [routeIds.retail, internalNamespace],
        [routeIds.internal, namespace],
        [routeIds.internal, internalNamespace],
      ] as const) {
        const refused = yield* scoped((transaction) =>
          transaction.invoke(reserve, [routeId, digest('5'), issuer, sourceNamespace, profileId]),
        ).pipe(Effect.flip);
        expect(sqlStateOf(refused), sourceNamespace).toBe('42501');
      }

      // Delivery is sequenced in the claim itself: a later order is handed to no worker until every earlier order of
      // its lineage is settled. A worker from before the ledger states no protocol and is handed none of them.
      expect(yield* claimMode(second)).toBe('waiting');
      expect(yield* legacyClaimMode(first)).toBe('blocked');
      expect(yield* saved(first.effectId)).toMatchObject({ state: 'planned' });
      expect(yield* claimMode(first)).toBe('execute');
      // The first is with the owner, then uncertain after a restart: the second still waits for it.
      expect(yield* claimMode(second)).toBe('waiting');
      yield* setState(first.effectId, 'indeterminate');
      expect(yield* claimMode(second)).toBe('waiting');
      yield* setState(first.effectId, 'settled');
      expect(yield* claimMode(second)).toBe('execute');
      expect(yield* claimMode(third)).toBe('waiting');
      yield* setState(second.effectId, 'settled');

      // Another profile is another lineage and never waits for this one.
      const other = yield* admit('retail', crypto.randomUUID(), 'd');
      expect(other.order).toBe(1);
      expect(yield* claimMode(other)).toBe('execute');

      // An earlier order whose route is no longer active is not skipped and not left to return: it was never handed to
      // the owner, so the claim refuses it for good, and only then is the later order released.
      const wholesaleRevision = (routeRevision: string) =>
        admin
          .update(symmyJobRoutes)
          .set({ routeRevision })
          .where(and(eq(symmyJobRoutes.tenantId, tenantId), eq(symmyJobRoutes.routeId, routeIds.wholesale)));
      yield* wholesaleRevision('route-2');
      expect(yield* claimMode(fourth)).toBe('waiting');
      expect(yield* claimMode(third)).toBe('settled');
      expect(yield* saved(third.effectId)).toEqual({ state: 'settled', status: 'denied' });
      // The route returns: the refused order stays refused, so it can never reach the owner after the later one.
      yield* wholesaleRevision('route-1');
      expect(yield* claimMode(third)).toBe('settled');
      expect(yield* saved(third.effectId)).toEqual({ state: 'settled', status: 'denied' });
      expect(yield* claimMode(fourth)).toBe('execute');

      // An earlier order that stays uncertain holds its lineage: a later one waits a bounded time from the first claim
      // that found it waiting and is then refused unresolved. The uncertain owner call is neither repeated nor dropped.
      const heldProfile = crypto.randomUUID();
      const uncertain = yield* admit('outlet', heldProfile, '11');
      const waiting = yield* admit('retail', heldProfile, '12');
      expect(yield* claimMode(uncertain)).toBe('execute');
      yield* setState(uncertain.effectId, 'indeterminate');
      const waitingSince = admin
        .select({ waitingSince: symmyMembershipSourceOrders.waitingSince })
        .from(symmyMembershipSourceOrders)
        .where(
          and(
            eq(symmyMembershipSourceOrders.tenantId, tenantId),
            eq(symmyMembershipSourceOrders.effectId, waiting.effectId),
          ),
        )
        .pipe(Effect.map(([row]) => row?.waitingSince ?? null));
      expect(yield* waitingSince).toBeNull();
      expect(yield* claimMode(waiting)).toBe('waiting');
      const since = yield* waitingSince;
      expect(since).not.toBeNull();
      // A second look keeps the first moment: a worker outage does not extend the wait.
      expect(yield* claimMode(waiting)).toBe('waiting');
      expect(yield* waitingSince).toEqual(since);
      yield* admin
        .update(symmyMembershipSourceOrders)
        .set({ waitingSince: DateTime.toDate(DateTime.makeUnsafe('2000-01-01T00:00:00.000Z')) })
        .where(
          and(
            eq(symmyMembershipSourceOrders.tenantId, tenantId),
            eq(symmyMembershipSourceOrders.effectId, waiting.effectId),
          ),
        );
      expect(yield* claimMode(waiting)).toBe('settled');
      expect(yield* saved(waiting.effectId)).toEqual({ state: 'settled', status: 'unresolved' });
      expect(yield* saved(uncertain.effectId)).toMatchObject({ state: 'indeterminate' });
      // The lineage stays ordered behind the uncertain call until its recovery settles it.
      const next = yield* admit('wholesale', heldProfile, '13');
      expect(next.order).toBe(3);
      expect(yield* claimMode(next)).toBe('waiting');
      expect(yield* claimMode(uncertain)).toBe('recover');
      yield* setState(uncertain.effectId, 'settled');
      expect(yield* claimMode(next)).toBe('execute');

      // The routines serve the company the transaction is scoped to only, never another company of the tenant.
      const otherCompany = crypto.randomUUID();
      const foreignReservation = yield* scoped((transaction) =>
        transaction.invoke(reserveForCompany, [
          otherCompany,
          routeIds.wholesale,
          digest('16'),
          issuer,
          namespace,
          heldProfile,
        ]),
      ).pipe(Effect.flip);
      expect(sqlStateOf(foreignReservation)).toBe('42501');
      const foreignRecord = yield* inScope(
        connections.runtime.connectionString,
        makeScope(tenantId, principalId, otherCompany),
        (transaction) => transaction.invoke(record, [next.jobId]),
      ).pipe(Effect.flip);
      expect(sqlStateOf(foreignRecord)).toBe('42501');

      // A binary from before the ledger pins a membership of the reserved namespace without a reservation: it cannot
      // commit, under either contract.
      for (const [seed, fixtureId] of [
        ['17', erpContract],
        ['18', internalContract],
      ] as const) {
        const unordered = membershipEffect('retail', crypto.randomUUID(), seed, '2026-11-20T00:00:00.000Z', 1);
        const rejected = yield* scoped((transaction) =>
          insertJob(transaction, 'retail', digest(seed), unordered, fixtureId),
        ).pipe(Effect.flip);
        expect(postgresCodeOf(rejected), fixtureId).toBe('55000');
        expect(
          yield* admin
            .select({ jobId: symmyImportJobs.jobId })
            .from(symmyImportJobs)
            .where(and(eq(symmyImportJobs.tenantId, tenantId), eq(symmyImportJobs.idempotencyDigest, digest(seed)))),
        ).toEqual([]);
      }

      // A membership its caller orders itself, of a source outside the reserved namespaces, is not the ledger's: it
      // is admitted with the order it states, holds no ledger row and is claimed exactly as before, by any worker.
      const callerOrdered = membershipEffect(
        'internal',
        profileId,
        '19',
        '2026-11-20T00:00:00.000Z',
        7,
        internalNamespace,
      );
      const callerJob = yield* scoped((transaction) =>
        insertJob(transaction, 'internal', digest('19'), callerOrdered, internalContract),
      );
      expect(
        yield* admin
          .select({ effectId: symmyMembershipSourceOrders.effectId })
          .from(symmyMembershipSourceOrders)
          .where(
            and(
              eq(symmyMembershipSourceOrders.tenantId, tenantId),
              eq(symmyMembershipSourceOrders.effectId, callerOrdered.effectId),
            ),
          ),
      ).toEqual([]);
      expect(yield* legacyClaimMode({ effectId: callerOrdered.effectId, jobId: callerJob })).toBe('execute');
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, Reactivity.layer))),
);
