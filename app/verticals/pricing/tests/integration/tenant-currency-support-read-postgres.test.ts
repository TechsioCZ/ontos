import { sql } from 'drizzle-orm';
import { DateTime, Deferred, Effect, Exit, Fiber, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { randomUUID } from 'node:crypto';
import {
  CurrencySupportEffectivePeriodSchema,
  CurrencySupportScheduleAcknowledgementPrincipalIdSchema,
  CurrencySupportScheduleFingerprintSchema,
  PricingCurrencyCodeSetSchema,
  PricingCurrencySupportGenerationSchema,
  PricingCurrencySupportRevisionIdSchema,
  PricingCurrencySupportRootIdSchema,
  PricingCurrencySupportScheduleRevisionSchema,
  PricingInstantSchema,
  PricingRevisionSchema,
} from '@app/pricing-contracts/domain/currency-support';

import { coreRelations } from '../../../../packages/core-runtime/src/db/schema.ts';
import {
  makeTestDatabaseFromClient,
  testDatabaseClients,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import type { TestDatabaseFromClient } from '../../../../packages/core-runtime/tests/support/database.ts';

type PricingTestDatabase = TestDatabaseFromClient<typeof coreRelations>;
type PricingTransaction = Parameters<Parameters<PricingTestDatabase['transaction']>[0]>[0];

const RoutineRowSchema = Schema.Struct({ payload: Schema.Unknown });
const OutcomeSchema = Schema.Struct({ outcome: Schema.String });
const CountSchema = Schema.Struct({ count: Schema.Finite });
const TimestampSchema = Schema.Struct({ observedAt: PricingInstantSchema });
const StoredRevisionSchema = Schema.Struct({
  effectiveFrom: CurrencySupportEffectivePeriodSchema.fields.effectiveFrom,
  effectiveTo: CurrencySupportEffectivePeriodSchema.fields.effectiveTo,
  generation: PricingCurrencySupportGenerationSchema,
  pricingRevision: PricingRevisionSchema,
  supportedCurrencies: PricingCurrencyCodeSetSchema,
  supportRevisionId: PricingCurrencySupportRevisionIdSchema,
});
const AcknowledgedRevisionSchema = Schema.Struct({
  effectiveFrom: CurrencySupportEffectivePeriodSchema.fields.effectiveFrom,
  effectiveTo: CurrencySupportEffectivePeriodSchema.fields.effectiveTo,
  generation: PricingCurrencySupportGenerationSchema,
  supportedCurrencies: PricingCurrencyCodeSetSchema,
  supportRevisionId: PricingCurrencySupportRevisionIdSchema,
});
const CurrentReadSchema = Schema.Struct({
  activeRevisionCount: Schema.Finite,
  current: StoredRevisionSchema,
  evaluatedAt: PricingInstantSchema,
  evaluationMode: Schema.Literal('CURRENT_WITH_REVALIDATION'),
  nextApplicabilityBoundary: Schema.optionalKey(CurrencySupportEffectivePeriodSchema.fields.effectiveTo),
  observedAt: PricingInstantSchema,
  outcome: Schema.Literal('CURRENCY_SUPPORT_CURRENT'),
  revalidatedAt: PricingInstantSchema,
  schedule: Schema.Struct({
    current: StoredRevisionSchema,
    future: Schema.Array(StoredRevisionSchema),
    revisions: Schema.Array(StoredRevisionSchema),
  }),
  scheduleRevision: PricingCurrencySupportScheduleRevisionSchema,
  supportId: PricingCurrencySupportRootIdSchema,
});
const HistoricalReadSchema = Schema.Struct({
  ...CurrentReadSchema.fields,
  evaluationMode: Schema.Literal('HISTORICAL_AS_OF'),
  revalidatedAt: Schema.optionalKey(PricingInstantSchema),
});
const MutationSuccessSchema = Schema.Struct({
  changed: Schema.Boolean,
  current: StoredRevisionSchema,
  outcome: Schema.Literals(['APPLIED', 'UNCHANGED']),
  scheduleRevision: PricingCurrencySupportScheduleRevisionSchema,
  supportId: PricingCurrencySupportRootIdSchema,
});
const AcknowledgementChallengeSchema = Schema.Struct({
  outcome: Schema.Literal('SCHEDULE_ACKNOWLEDGEMENT_REQUIRED'),
  scheduleAcknowledgement: Schema.Struct({
    actingPrincipalId: CurrencySupportScheduleAcknowledgementPrincipalIdSchema,
    fingerprint: CurrencySupportScheduleFingerprintSchema,
    intendedEffectivePeriod: CurrencySupportEffectivePeriodSchema,
    intendedSupportedCurrencies: PricingCurrencyCodeSetSchema,
    presentedFuture: Schema.Array(AcknowledgedRevisionSchema),
    scheduleRevision: PricingCurrencySupportScheduleRevisionSchema,
    supportId: PricingCurrencySupportRootIdSchema,
    targetEffectivePeriod: CurrencySupportEffectivePeriodSchema,
    targetRevisionId: PricingCurrencySupportRevisionIdSchema,
  }),
});

type StoredRevision = typeof StoredRevisionSchema.Type;
type CurrentRead = typeof CurrentReadSchema.Type;

type JsonValue = boolean | null | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

interface ScopeIdentity {
  readonly correlationId: string;
  readonly legalEntityId: string;
  readonly tenantId: string;
}

interface SeedRevision {
  readonly effectiveFrom: string;
  readonly effectiveTo: null | string;
  readonly generation: number;
  readonly revisionId: string;
}

const scopeIdentity = (tenantId: string): ScopeIdentity => ({
  correlationId: `currency-support:${tenantId}`,
  legalEntityId: randomUUID(),
  tenantId,
});

const shiftInstant = (instant: string, duration: Parameters<typeof DateTime.add>[1]) =>
  DateTime.formatIso(DateTime.add(DateTime.makeUnsafe(instant), duration));

const scoped = <Value, Failure>(
  database: PricingTestDatabase,
  identity: ScopeIdentity,
  operation: (transaction: PricingTransaction) => Effect.Effect<Value, Failure>,
) =>
  database.transaction((transaction) =>
    Effect.gen(function* scopedOperation() {
      yield* transaction.execute(
        sql`select set_config('ontos.tenant_id', ${identity.tenantId}, true),
                   set_config('ontos.legal_entity_id', ${identity.legalEntityId}, true),
                   set_config('ontos.correlation_id', ${identity.correlationId}, true)`,
        'objects',
      );
      return yield* operation(transaction);
    }),
  );

const invokeRoutine = (
  transaction: PricingTransaction,
  routine: 'read_tenant_currency_support_v1' | 'set_tenant_currency_support_v1',
  tenantId: string,
  input: Readonly<Record<string, JsonValue>>,
) => {
  const serialized = JSON.stringify(input);
  const query =
    routine === 'read_tenant_currency_support_v1'
      ? sql`select payload from pricing.read_tenant_currency_support_v1(${tenantId}::uuid, ${serialized}::jsonb)`
      : sql`select payload from pricing.set_tenant_currency_support_v1(${tenantId}::uuid, ${serialized}::jsonb)`;
  return transaction.execute(query, 'objects').pipe(
    Effect.map(([row]) => {
      expect(row).toBeDefined();
      return Schema.decodeUnknownSync(RoutineRowSchema)(row).payload;
    }),
  );
};

const invokeRevalidation = (transaction: PricingTransaction, tenantId: string) =>
  transaction
    .execute(sql`select payload from pricing.revalidate_tenant_currency_support_v1(${tenantId}::uuid)`, 'objects')
    .pipe(
      Effect.map(([row]) => {
        expect(row).toBeDefined();
        return Schema.decodeUnknownSync(RoutineRowSchema)(row).payload;
      }),
    );

const expectedRevision = (tenantId: string, supportId: string, revision: StoredRevision) => ({
  effectivePeriod: {
    effectiveFrom: revision.effectiveFrom,
    effectiveTo: revision.effectiveTo,
  },
  generation: revision.generation,
  supportedCurrencies: revision.supportedCurrencies,
  supportRevisionRef: {
    moduleId: 'commerce.pricing',
    resourceId: revision.supportRevisionId,
    resourceType: 'commerce.pricing.currency-support-revision',
    supportRootId: supportId,
    tenantId,
  },
});

const expectedStateFromCurrent = (tenantId: string, current: CurrentRead) => ({
  current: expectedRevision(tenantId, current.supportId, current.current),
  future: current.schedule.future.map((revision) => expectedRevision(tenantId, current.supportId, revision)),
  observedAt: current.observedAt,
  scheduleRevision: current.scheduleRevision,
  state: 'PRESENT',
  supportRootRef: {
    moduleId: 'commerce.pricing',
    resourceId: current.supportId,
    resourceType: 'commerce.pricing.currency-support',
    tenantId,
  },
});

const readThrough = (
  database: PricingTestDatabase,
  identity: ScopeIdentity,
  effectiveAt: string,
  evaluationMode: 'CURRENT_WITH_REVALIDATION' | 'HISTORICAL_AS_OF' = 'CURRENT_WITH_REVALIDATION',
) =>
  scoped(database, identity, (transaction) =>
    evaluationMode === 'CURRENT_WITH_REVALIDATION'
      ? invokeRevalidation(transaction, identity.tenantId)
      : invokeRoutine(transaction, 'read_tenant_currency_support_v1', identity.tenantId, {
          effectiveAt,
          evaluationMode,
        }),
  );

const setThrough = (
  database: PricingTestDatabase,
  identity: ScopeIdentity,
  input: Readonly<Record<string, JsonValue>>,
) =>
  scoped(database, identity, (transaction) =>
    Effect.gen(function* setWithExpectedState() {
      if ('expectedState' in input) {
        return yield* invokeRoutine(transaction, 'set_tenant_currency_support_v1', identity.tenantId, input);
      }
      const observed = yield* invokeRevalidation(transaction, identity.tenantId);
      const { outcome } = yield* Schema.decodeUnknownEffect(OutcomeSchema)(observed);
      const expectedState =
        outcome === 'CURRENCY_SUPPORT_ABSENT'
          ? { state: 'ABSENT' }
          : expectedStateFromCurrent(identity.tenantId, yield* Schema.decodeUnknownEffect(CurrentReadSchema)(observed));
      return yield* invokeRoutine(transaction, 'set_tenant_currency_support_v1', identity.tenantId, {
        ...input,
        expectedState,
      });
    }),
  );

const cleanupTenants = (database: PricingTestDatabase, tenantIds: readonly string[]) =>
  database.transaction((transaction) =>
    Effect.forEach(
      tenantIds,
      (tenantId) =>
        Effect.gen(function* cleanupTenant() {
          yield* transaction.execute(
            sql`delete from pricing.currency_support_schedule_heads where tenant_id = ${tenantId}::uuid`,
          );
          yield* transaction.execute(
            sql`delete from pricing.currency_support_schedule_entries where tenant_id = ${tenantId}::uuid`,
          );
          yield* transaction.execute(
            sql`delete from pricing.currency_support_schedule_revisions where tenant_id = ${tenantId}::uuid`,
          );
          yield* transaction.execute(
            sql`delete from pricing.currency_support_value_revisions where tenant_id = ${tenantId}::uuid`,
          );
          yield* transaction.execute(
            sql`delete from pricing.currency_support_roots where tenant_id = ${tenantId}::uuid`,
          );
        }),
      { concurrency: 1, discard: true },
    ),
  );

const countTenantRows = (database: PricingTestDatabase, tenantId: string, relation: 'roots' | 'values') =>
  database.transaction((transaction) => {
    const query =
      relation === 'roots'
        ? sql`select count(*)::integer as count from pricing.currency_support_roots where tenant_id = ${tenantId}::uuid`
        : sql`select count(*)::integer as count from pricing.currency_support_value_revisions where tenant_id = ${tenantId}::uuid`;
    return transaction
      .execute(query, 'objects')
      .pipe(Effect.map(([row]) => Schema.decodeUnknownSync(CountSchema)(row).count));
  });

const databaseNow = (database: PricingTestDatabase) =>
  database.transaction((transaction) =>
    transaction
      .execute(
        sql`select to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "observedAt"`,
        'objects',
      )
      .pipe(Effect.map(([row]) => Schema.decodeUnknownSync(TimestampSchema)(row).observedAt)),
  );

const seedSchedule = (
  database: PricingTestDatabase,
  tenantId: string,
  supportId: string,
  scheduleId: string,
  revisions: readonly SeedRevision[],
) =>
  database.transaction((transaction) =>
    Effect.gen(function* seedTenantSchedule() {
      const principalId = randomUUID();
      yield* transaction.execute(sql`
        insert into pricing.currency_support_roots (
          currency_support_id, tenant_id, created_by_action_invocation_id, created_by_principal_id
        ) values (${supportId}::uuid, ${tenantId}::uuid, ${randomUUID()}::uuid, ${principalId}::uuid)
      `);
      yield* Effect.forEach(
        revisions,
        (revision) =>
          transaction.execute(sql`
            insert into pricing.currency_support_value_revisions (
              currency_support_revision_id, tenant_id, currency_support_id, generation, pricing_revision,
              supported_currencies, previous_revision_id, action_invocation_id, acting_principal_id, reason
            ) values (
              ${revision.revisionId}::uuid, ${tenantId}::uuid, ${supportId}::uuid, ${revision.generation},
              ${`pricing-currency-support:${revision.generation}`}, '["CZK"]'::jsonb, null,
              ${randomUUID()}::uuid, ${principalId}::uuid, 'Seed canonical Currency Support acceptance state.'
            )
          `),
        { concurrency: 1, discard: true },
      );
      yield* transaction.execute(sql`
        insert into pricing.currency_support_schedule_revisions (
          currency_support_schedule_revision_id, tenant_id, currency_support_id, schedule_revision,
          previous_schedule_revision_id, action_invocation_id, acting_principal_id, schedule_acknowledgement, reason
        ) values (
          ${scheduleId}::uuid, ${tenantId}::uuid, ${supportId}::uuid, 1, null,
          ${randomUUID()}::uuid, ${principalId}::uuid, null, 'Seed canonical Currency Support schedule.'
        )
      `);
      yield* Effect.forEach(
        revisions,
        (revision) =>
          transaction.execute(sql`
            insert into pricing.currency_support_schedule_entries (
              tenant_id, currency_support_id, currency_support_revision_id,
              currency_support_schedule_revision_id, schedule_revision, effective_from, effective_to
            ) values (
              ${tenantId}::uuid, ${supportId}::uuid, ${revision.revisionId}::uuid,
              ${scheduleId}::uuid, 1, ${revision.effectiveFrom}::timestamptz,
              ${revision.effectiveTo}::timestamptz
            )
          `),
        { concurrency: 1, discard: true },
      );
      yield* transaction.execute(sql`
        insert into pricing.currency_support_schedule_heads (
          tenant_id, currency_support_id, currency_support_schedule_revision_id, schedule_revision
        ) values (${tenantId}::uuid, ${supportId}::uuid, ${scheduleId}::uuid, 1)
      `);
    }),
  );

const managementInput = (
  actionInvocationId: string,
  actorPrincipalId: string,
  effectiveFrom: string,
  supportedCurrencies: readonly string[],
) => ({
  actionInvocationId,
  actorPrincipalId,
  effectiveFrom,
  expectedGeneration: 0,
  expectedScheduleRevision: 0,
  intendedEffectivePeriod: { effectiveFrom, effectiveTo: null },
  intent: 'ESTABLISH_CURRENT',
  reason: 'Manage canonical Tenant Currency Support.',
  supportedCurrencies,
});

it.live('keeps one Tenant root across legal-entity and correlation contexts with real database observation time', () =>
  Effect.scoped(
    Effect.gen(function* tenantRootAcceptance() {
      const tenantId = randomUUID();
      const otherTenantId = randomUUID();
      const principalId = randomUUID();
      const firstScope = {
        correlationId: 'currency-support:first-context',
        legalEntityId: randomUUID(),
        tenantId,
      };
      const secondScope = {
        correlationId: 'currency-support:second-context',
        legalEntityId: randomUUID(),
        tenantId,
      };
      const otherTenantScope = {
        correlationId: 'currency-support:other-tenant',
        legalEntityId: randomUUID(),
        tenantId: otherTenantId,
      };
      const { admin: adminClient, runtime: runtimeClient } = yield* testDatabaseClients;
      const admin = yield* makeTestDatabaseFromClient(adminClient, coreRelations);
      const runtime = yield* makeTestDatabaseFromClient(runtimeClient, coreRelations);
      const now = yield* databaseNow(admin);
      const effectiveFrom = shiftInstant(now, { minutes: -1 });
      yield* cleanupTenants(admin, [tenantId, otherTenantId]);
      yield* Effect.addFinalizer(() => cleanupTenants(admin, [tenantId, otherTenantId]).pipe(Effect.orDie));

      const created = yield* Schema.decodeUnknownEffect(MutationSuccessSchema)(
        yield* setThrough(runtime, firstScope, managementInput(randomUUID(), principalId, effectiveFrom, ['CZK'])),
      );
      expect(created).toMatchObject({ changed: true, outcome: 'APPLIED', scheduleRevision: 1 });
      expect(created.current).toMatchObject({ effectiveTo: null, supportedCurrencies: ['CZK'] });

      const lowerBound = yield* databaseNow(admin);
      const fromFirstContext = yield* Schema.decodeUnknownEffect(CurrentReadSchema)(
        yield* readThrough(runtime, firstScope, yield* databaseNow(admin)),
      );
      const fromSecondContext = yield* Schema.decodeUnknownEffect(CurrentReadSchema)(
        yield* readThrough(runtime, secondScope, yield* databaseNow(admin)),
      );

      expect(fromFirstContext.supportId).toBe(created.supportId);
      expect(fromSecondContext.supportId).toBe(created.supportId);
      expect(fromSecondContext.current).toMatchObject({ effectiveTo: null, supportedCurrencies: ['CZK'] });
      expect(DateTime.toEpochMillis(DateTime.makeUnsafe(fromFirstContext.observedAt))).toBeGreaterThanOrEqual(
        DateTime.toEpochMillis(DateTime.makeUnsafe(lowerBound)),
      );
      expect(DateTime.toEpochMillis(DateTime.makeUnsafe(fromFirstContext.revalidatedAt))).toBeGreaterThanOrEqual(
        DateTime.toEpochMillis(DateTime.makeUnsafe(fromFirstContext.observedAt)),
      );
      expect(yield* countTenantRows(admin, tenantId, 'roots')).toBe(1);

      const otherTenantOutcome = yield* Schema.decodeUnknownEffect(OutcomeSchema)(
        yield* readThrough(runtime, otherTenantScope, yield* databaseNow(admin)),
      );
      expect(otherTenantOutcome).toEqual({ outcome: 'CURRENCY_SUPPORT_ABSENT' });
      const crossTenantEffectiveAt = yield* databaseNow(admin);
      const crossTenantAttempt = yield* Effect.exit(
        scoped(runtime, otherTenantScope, (transaction) =>
          invokeRoutine(transaction, 'read_tenant_currency_support_v1', tenantId, {
            effectiveAt: crossTenantEffectiveAt,
            evaluationMode: 'HISTORICAL_AS_OF',
          }),
        ),
      );
      expect(Exit.isFailure(crossTenantAttempt)).toBe(true);
    }),
  ),
);

it.live('enforces Launch exactly CZK without narrowing generalized currency storage', () =>
  Effect.scoped(
    Effect.gen(function* launchCurrencyAcceptance() {
      const tenantId = randomUUID();
      const principalId = randomUUID();
      const identity = { correlationId: 'currency-support:launch', legalEntityId: randomUUID(), tenantId };
      const { admin: adminClient, runtime: runtimeClient } = yield* testDatabaseClients;
      const admin = yield* makeTestDatabaseFromClient(adminClient, coreRelations);
      const runtime = yield* makeTestDatabaseFromClient(runtimeClient, coreRelations);
      const effectiveFrom = shiftInstant(yield* databaseNow(admin), { minutes: -1 });
      yield* cleanupTenants(admin, [tenantId]);
      yield* Effect.addFinalizer(() => cleanupTenants(admin, [tenantId]).pipe(Effect.orDie));

      for (const unsupported of [['EUR'], ['CZK', 'EUR']]) {
        const outcome = yield* Schema.decodeUnknownEffect(OutcomeSchema)(
          yield* setThrough(runtime, identity, managementInput(randomUUID(), principalId, effectiveFrom, unsupported)),
        );
        expect(outcome).toEqual({ outcome: 'LAUNCH_CURRENCY_REJECTED' });
      }
      expect(yield* countTenantRows(admin, tenantId, 'roots')).toBe(0);
      expect(yield* countTenantRows(admin, tenantId, 'values')).toBe(0);
    }),
  ),
);

it.live('serializes concurrent first creation and verifies expectations before a no-op', () =>
  Effect.scoped(
    Effect.gen(function* concurrentCreationAcceptance() {
      const tenantId = randomUUID();
      const principalId = randomUUID();
      const identity = { correlationId: 'currency-support:concurrent', legalEntityId: randomUUID(), tenantId };
      const { admin: adminClient, runtime: runtimeClient } = yield* testDatabaseClients;
      const admin = yield* makeTestDatabaseFromClient(adminClient, coreRelations);
      const runtime = yield* makeTestDatabaseFromClient(runtimeClient, coreRelations);
      const effectiveFrom = shiftInstant(yield* databaseNow(admin), { minutes: -1 });
      yield* cleanupTenants(admin, [tenantId]);
      yield* Effect.addFinalizer(() => cleanupTenants(admin, [tenantId]).pipe(Effect.orDie));

      const attempts = yield* Effect.all(
        [
          setThrough(runtime, identity, managementInput(randomUUID(), principalId, effectiveFrom, ['CZK'])),
          setThrough(runtime, identity, managementInput(randomUUID(), principalId, effectiveFrom, ['CZK'])),
        ],
        { concurrency: 2 },
      );
      const outcomes = attempts.map((payload) => Schema.decodeUnknownSync(OutcomeSchema)(payload).outcome);
      expect(outcomes.filter((outcome) => outcome === 'APPLIED')).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome === 'CURRENT_STATE_CONFLICT')).toHaveLength(1);
      expect(yield* countTenantRows(admin, tenantId, 'roots')).toBe(1);
      expect(yield* countTenantRows(admin, tenantId, 'values')).toBe(1);

      const current = yield* Schema.decodeUnknownEffect(CurrentReadSchema)(
        yield* readThrough(runtime, identity, yield* databaseNow(admin)),
      );
      const expectedCurrent = {
        effectiveFrom: current.current.effectiveFrom,
        effectiveTo: current.current.effectiveTo,
        supportRevisionId: current.current.supportRevisionId,
      };
      const repeated = {
        actionInvocationId: randomUUID(),
        actorPrincipalId: principalId,
        effectiveFrom: current.current.effectiveFrom,
        expectedCurrent,
        expectedGeneration: 0,
        expectedScheduleRevision: current.scheduleRevision,
        intendedEffectivePeriod: {
          effectiveFrom: current.current.effectiveFrom,
          effectiveTo: current.current.effectiveTo,
        },
        intent: 'VALUE_ONLY_CURRENT',
        reason: 'A stale expectation must not be hidden by a no-op.',
        supportedCurrencies: ['CZK'],
      };
      const repeatedOutcome = yield* Schema.decodeUnknownEffect(OutcomeSchema)(
        yield* setThrough(runtime, identity, repeated),
      );
      expect(repeatedOutcome).toEqual({ outcome: 'REVISION_CONFLICT' });
      const unchanged = yield* Schema.decodeUnknownEffect(MutationSuccessSchema)(
        yield* setThrough(runtime, identity, {
          ...repeated,
          actionInvocationId: randomUUID(),
          expectedGeneration: current.current.generation,
        }),
      );
      expect(unchanged).toMatchObject({ changed: false, outcome: 'UNCHANGED' });
      expect(yield* countTenantRows(admin, tenantId, 'values')).toBe(1);
    }),
  ),
);

it.live('revalidates in a fresh statement after another connection commits a new schedule head', () =>
  Effect.scoped(
    Effect.gen(function* twoStatementRevalidationAcceptance() {
      const tenantId = randomUUID();
      const principalId = randomUUID();
      const identity = { correlationId: 'currency-support:two-statement-read', legalEntityId: randomUUID(), tenantId };
      const { admin: adminClient, runtime: runtimeClient } = yield* testDatabaseClients;
      const admin = yield* makeTestDatabaseFromClient(adminClient, coreRelations);
      const runtime = yield* makeTestDatabaseFromClient(runtimeClient, coreRelations);
      const now = yield* databaseNow(admin);
      const initialFrom = shiftInstant(now, { hours: -1 });
      const historicalAt = shiftInstant(initialFrom, { minutes: 10 });
      const editFrom = shiftInstant(now, { minutes: -1 });
      yield* cleanupTenants(admin, [tenantId]);
      yield* Effect.addFinalizer(() => cleanupTenants(admin, [tenantId]).pipe(Effect.orDie));

      const established = yield* Schema.decodeUnknownEffect(MutationSuccessSchema)(
        yield* setThrough(runtime, identity, managementInput(randomUUID(), principalId, initialFrom, ['CZK'])),
      );
      const firstReadComplete = yield* Deferred.make<null>();
      const writerCommitted = yield* Deferred.make<string>();
      const reader = yield* Effect.forkScoped(
        scoped(runtime, identity, (transaction) =>
          Effect.gen(function* observeThenRevalidate() {
            const historicalPayload = yield* invokeRoutine(transaction, 'read_tenant_currency_support_v1', tenantId, {
              effectiveAt: historicalAt,
              evaluationMode: 'HISTORICAL_AS_OF',
            });
            yield* Deferred.succeed(firstReadComplete, null);
            const committedAt = yield* Deferred.await(writerCommitted);
            const revalidatedPayload = yield* invokeRevalidation(transaction, tenantId);
            const stableHistoricalPayload = yield* invokeRoutine(
              transaction,
              'read_tenant_currency_support_v1',
              tenantId,
              { effectiveAt: committedAt, evaluationMode: 'HISTORICAL_AS_OF' },
            );
            const stableRevalidatedPayload = yield* invokeRevalidation(transaction, tenantId);
            return {
              committedAt,
              historicalPayload,
              revalidatedPayload,
              stableHistoricalPayload,
              stableRevalidatedPayload,
            };
          }),
        ),
      );

      yield* Deferred.await(firstReadComplete);
      const revised = yield* Schema.decodeUnknownEffect(MutationSuccessSchema)(
        yield* setThrough(runtime, identity, {
          actionInvocationId: randomUUID(),
          actorPrincipalId: principalId,
          effectiveFrom: editFrom,
          expectedCurrent: {
            effectiveFrom: initialFrom,
            effectiveTo: null,
            supportRevisionId: established.current.supportRevisionId,
          },
          expectedGeneration: 1,
          expectedScheduleRevision: 1,
          intendedEffectivePeriod: { effectiveFrom: editFrom, effectiveTo: null },
          intent: 'VALUE_ONLY_CURRENT',
          reason: 'Commit a new head between observation and final revalidation.',
          supportedCurrencies: ['CZK'],
        }),
      );
      const committedAt = yield* databaseNow(admin);
      yield* Deferred.succeed(writerCommitted, committedAt);
      const observed = yield* Fiber.join(reader);

      const historical = yield* Schema.decodeUnknownEffect(HistoricalReadSchema)(observed.historicalPayload);
      expect(observed.historicalPayload).not.toHaveProperty('revalidatedAt');
      expect(historical).toMatchObject({
        evaluatedAt: historicalAt,
        evaluationMode: 'HISTORICAL_AS_OF',
        scheduleRevision: 1,
        supportId: established.supportId,
      });
      expect(historical.current.supportRevisionId).toBe(established.current.supportRevisionId);
      expect(historical.current.supportRevisionId).not.toBe(revised.current.supportRevisionId);

      const revalidated = yield* Schema.decodeUnknownEffect(CurrentReadSchema)(observed.revalidatedPayload);
      expect(revalidated).toMatchObject({
        evaluationMode: 'CURRENT_WITH_REVALIDATION',
        scheduleRevision: 2,
        supportId: established.supportId,
      });
      expect(revalidated.current.supportRevisionId).toBe(revised.current.supportRevisionId);
      expect(DateTime.toEpochMillis(DateTime.makeUnsafe(revalidated.observedAt))).toBeGreaterThanOrEqual(
        DateTime.toEpochMillis(DateTime.makeUnsafe(observed.committedAt)),
      );
      expect(DateTime.toEpochMillis(DateTime.makeUnsafe(revalidated.revalidatedAt))).toBeGreaterThanOrEqual(
        DateTime.toEpochMillis(DateTime.makeUnsafe(revalidated.observedAt)),
      );

      const stableHistorical = yield* Schema.decodeUnknownEffect(HistoricalReadSchema)(
        observed.stableHistoricalPayload,
      );
      const stableRevalidated = yield* Schema.decodeUnknownEffect(CurrentReadSchema)(observed.stableRevalidatedPayload);
      expect(observed.stableHistoricalPayload).not.toHaveProperty('revalidatedAt');
      expect(stableHistorical.evaluationMode).toBe('HISTORICAL_AS_OF');
      expect(stableHistorical.supportId).toBe(stableRevalidated.supportId);
      expect(stableHistorical.scheduleRevision).toBe(stableRevalidated.scheduleRevision);
      expect(stableHistorical.current).toEqual(stableRevalidated.current);
    }),
  ),
);

it.live('returns typed absent, gap, and conflicting schedule evidence', () =>
  Effect.scoped(
    Effect.gen(function* unavailableStateAcceptance() {
      const absentTenantId = randomUUID();
      const gapTenantId = randomUUID();
      const conflictTenantId = randomUUID();
      const { admin: adminClient, runtime: runtimeClient } = yield* testDatabaseClients;
      const admin = yield* makeTestDatabaseFromClient(adminClient, coreRelations);
      const runtime = yield* makeTestDatabaseFromClient(runtimeClient, coreRelations);
      const evaluatedAt = yield* databaseNow(admin);
      const future = shiftInstant(evaluatedAt, { hours: 1 });
      const past = shiftInstant(evaluatedAt, { hours: -1 });
      const tenantIds = [absentTenantId, gapTenantId, conflictTenantId];
      yield* cleanupTenants(admin, tenantIds);
      yield* Effect.addFinalizer(() => cleanupTenants(admin, tenantIds).pipe(Effect.orDie));

      yield* seedSchedule(admin, gapTenantId, randomUUID(), randomUUID(), [
        { effectiveFrom: future, effectiveTo: null, generation: 1, revisionId: randomUUID() },
      ]);
      yield* seedSchedule(admin, conflictTenantId, randomUUID(), randomUUID(), [
        { effectiveFrom: past, effectiveTo: null, generation: 1, revisionId: randomUUID() },
      ]);
      yield* admin.transaction((transaction) =>
        transaction.execute(
          sql`delete from pricing.currency_support_schedule_heads where tenant_id = ${conflictTenantId}::uuid`,
        ),
      );

      const absent = yield* Schema.decodeUnknownEffect(OutcomeSchema)(
        yield* readThrough(runtime, scopeIdentity(absentTenantId), evaluatedAt),
      );
      expect(absent).toEqual({ outcome: 'CURRENCY_SUPPORT_ABSENT' });
      const gap = yield* Schema.decodeUnknownEffect(OutcomeSchema)(
        yield* readThrough(runtime, scopeIdentity(gapTenantId), evaluatedAt),
      );
      expect(gap).toEqual({ outcome: 'CURRENCY_SUPPORT_GAP' });
      const conflict = yield* readThrough(runtime, scopeIdentity(conflictTenantId), evaluatedAt);
      const conflictOutcome = yield* Schema.decodeUnknownEffect(OutcomeSchema)(conflict);
      expect(conflictOutcome).toEqual({ outcome: 'CURRENCY_SUPPORT_CONFLICT' });
      expect(conflict).toMatchObject({ activeRevisionCount: 0 });
    }),
  ),
);

it.live(
  'preserves finite, open, and future periods behind exact acknowledgement and rejects stale acknowledgement',
  () =>
    Effect.scoped(
      Effect.gen(function* schedulePreservationAcceptance() {
        const tenantId = randomUUID();
        const principalId = randomUUID();
        const identity = { correlationId: 'currency-support:schedule-edit', legalEntityId: randomUUID(), tenantId };
        const { admin: adminClient, runtime: runtimeClient } = yield* testDatabaseClients;
        const admin = yield* makeTestDatabaseFromClient(adminClient, coreRelations);
        const runtime = yield* makeTestDatabaseFromClient(runtimeClient, coreRelations);
        const now = yield* databaseNow(admin);
        const currentFrom = shiftInstant(now, { hours: -1 });
        const editFrom = shiftInstant(now, { minutes: -1 });
        const futureFrom = shiftInstant(now, { hours: 1 });
        yield* cleanupTenants(admin, [tenantId]);
        yield* Effect.addFinalizer(() => cleanupTenants(admin, [tenantId]).pipe(Effect.orDie));

        const established = yield* Schema.decodeUnknownEffect(MutationSuccessSchema)(
          yield* setThrough(runtime, identity, {
            ...managementInput(randomUUID(), principalId, currentFrom, ['CZK']),
            intendedEffectivePeriod: { effectiveFrom: currentFrom, effectiveTo: futureFrom },
          }),
        );
        const { current: establishedCurrent, supportId } = established;
        const currentRevisionId = establishedCurrent.supportRevisionId;
        const scheduled = yield* Schema.decodeUnknownEffect(MutationSuccessSchema)(
          yield* setThrough(runtime, identity, {
            actionInvocationId: randomUUID(),
            actorPrincipalId: principalId,
            effectiveFrom: futureFrom,
            expectedCurrent: {
              effectiveFrom: currentFrom,
              effectiveTo: futureFrom,
              supportRevisionId: currentRevisionId,
            },
            expectedGeneration: 1,
            expectedScheduleRevision: 1,
            intendedEffectivePeriod: { effectiveFrom: futureFrom, effectiveTo: null },
            intent: 'SCHEDULE_REVISION',
            reason: 'Schedule an open future while preserving the finite Current interval.',
            supportedCurrencies: ['CZK'],
          }),
        );
        expect(scheduled).toMatchObject({ changed: true, outcome: 'APPLIED', scheduleRevision: 2 });
        const beforeEdit = yield* Schema.decodeUnknownEffect(CurrentReadSchema)(
          yield* readThrough(runtime, identity, yield* databaseNow(admin)),
        );
        const [futureRevisionCandidate] = beforeEdit.schedule.future;
        if (futureRevisionCandidate === undefined) {
          return yield* Effect.die('The scheduled Currency Support revision was not returned');
        }
        const futureRevision = yield* Schema.decodeEffect(StoredRevisionSchema)(futureRevisionCandidate);
        const futureRevisionId = futureRevision.supportRevisionId;

        const edit = {
          actionInvocationId: randomUUID(),
          actorPrincipalId: principalId,
          effectiveFrom: editFrom,
          expectedCurrent: {
            effectiveFrom: currentFrom,
            effectiveTo: futureFrom,
            supportRevisionId: currentRevisionId,
          },
          expectedGeneration: 1,
          expectedScheduleRevision: 2,
          intendedEffectivePeriod: { effectiveFrom: editFrom, effectiveTo: futureFrom },
          intent: 'VALUE_ONLY_CURRENT',
          reason: 'Preserve the finite Current end and the complete future schedule.',
          supportedCurrencies: ['CZK'],
        };
        const challenge = yield* Schema.decodeUnknownEffect(AcknowledgementChallengeSchema)(
          yield* setThrough(runtime, identity, edit),
        );
        expect(challenge.scheduleAcknowledgement).toMatchObject({
          actingPrincipalId: principalId,
          scheduleRevision: 2,
          supportId,
          targetRevisionId: currentRevisionId,
        });

        const staleAcknowledgement = yield* Schema.decodeUnknownEffect(OutcomeSchema)(
          yield* setThrough(runtime, identity, {
            ...edit,
            actionInvocationId: randomUUID(),
            scheduleAcknowledgement: { ...challenge.scheduleAcknowledgement, fingerprint: '0'.repeat(64) },
          }),
        );
        expect(staleAcknowledgement).toEqual({ outcome: 'SCHEDULE_ACKNOWLEDGEMENT_STALE' });
        const applied = yield* Schema.decodeUnknownEffect(MutationSuccessSchema)(
          yield* setThrough(runtime, identity, {
            ...edit,
            actionInvocationId: randomUUID(),
            scheduleAcknowledgement: challenge.scheduleAcknowledgement,
          }),
        );
        expect(applied).toMatchObject({ changed: true, outcome: 'APPLIED', scheduleRevision: 3 });
        expect(applied.current.effectiveTo).toBe(futureFrom);

        const after = yield* Schema.decodeUnknownEffect(CurrentReadSchema)(
          yield* readThrough(runtime, identity, yield* databaseNow(admin)),
        );
        expect(after.current).toMatchObject({ effectiveFrom: editFrom, effectiveTo: futureFrom });
        expect(after.schedule.future).toEqual([
          expect.objectContaining({
            effectiveFrom: futureFrom,
            effectiveTo: null,
            supportRevisionId: futureRevisionId,
          }),
        ]);
        expect(after.schedule.revisions).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ effectiveFrom: currentFrom, effectiveTo: editFrom }),
            expect.objectContaining({ effectiveFrom: editFrom, effectiveTo: futureFrom }),
            expect.objectContaining({ effectiveFrom: futureFrom, effectiveTo: null }),
          ]),
        );
        return yield* Effect.void;
      }),
    ),
);
