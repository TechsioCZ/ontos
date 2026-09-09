// @effect-diagnostics nodeBuiltinImport:off -- Live database fixtures require collision-free IDs; expires: 2027-03-31.
import { loadDatabaseConnectionPair } from '@app/core-runtime';
import { expect, it } from 'effect-rstest';
import { Effect, Schema } from 'effect';
import { randomUUID } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import { Pool } from 'pg';
import { ManualFxPolicyRevisionSchema } from '../../shared/domain/manual-commercial-rate-policy.ts';
import type { ChangeManualFxRatePolicyCommand } from '../../shared/domain/manual-commercial-rate-policy.ts';

interface ManualFxPolicyRoutineInput extends ChangeManualFxRatePolicyCommand {
  readonly actingPrincipalId: string;
  readonly actionInvocationId: string;
}

const AppliedMutationSchema = Schema.TaggedStruct('APPLIED', {
  current: ManualFxPolicyRevisionSchema,
});
const UnchangedMutationSchema = Schema.TaggedStruct('UNCHANGED', {
  current: ManualFxPolicyRevisionSchema,
});
const RevisionConflictSchema = Schema.TaggedStruct('REVISION_CONFLICT', {
  currentRevision: Schema.Int,
});
const ActionInvocationReusedSchema = Schema.TaggedStruct('ACTION_INVOCATION_REUSED', {
  currentRevision: Schema.Int,
});
const MutationRoutineResultSchema = Schema.Union([
  ActionInvocationReusedSchema,
  AppliedMutationSchema,
  UnchangedMutationSchema,
  RevisionConflictSchema,
  Schema.TaggedStruct('SOURCE_REVISION_REUSED', { currentRevision: Schema.Int }),
]);
type MutationRoutineResult = typeof MutationRoutineResultSchema.Type;

const ResolvedPolicySchema = Schema.TaggedStruct('RESOLVED', {
  current: ManualFxPolicyRevisionSchema,
});
const StalePolicySchema = Schema.TaggedStruct('STALE', {});
const NotConfiguredPolicySchema = Schema.TaggedStruct('NOT_CONFIGURED', {});
const ResolutionRoutineResultSchema = Schema.Union([
  NotConfiguredPolicySchema,
  ResolvedPolicySchema,
  StalePolicySchema,
  Schema.TaggedStruct('INDETERMINATE', {}),
]);
type ResolutionRoutineResult = typeof ResolutionRoutineResultSchema.Type;

const PostgresFailureSchema = Schema.Struct({ code: Schema.String });
const DurablePolicyCountsSchema = Schema.Struct({
  journal_count: Schema.Int,
  revision_count: Schema.Int,
});
type DurablePolicyCounts = typeof DurablePolicyCountsSchema.Type;
const PendingMutationCountSchema = Schema.Struct({ pending_count: Schema.Int });
type ManualFxPolicyContext = ManualFxPolicyRoutineInput['context'];
const manualFxPolicyContext: ManualFxPolicyContext = {
  channelId: 'web',
  marketId: 'cz',
  purpose: 'PURCHASE_LIMIT_COMPARISON',
  sourceCurrencyCode: 'CZK',
  storefrontId: 'akros-cz',
  targetCurrencyCode: 'EUR',
};

interface BarrierReplayOutcome {
  readonly pendingCount: number;
  readonly results: readonly MutationRoutineResult[];
}

interface PayloadRow extends QueryResultRow {
  readonly payload: unknown;
}

const endPool = (pool: Pool) => Effect.promise(() => pool.end());

// eslint-disable-next-line effect-native/no-promise-shaped-port -- This is the node-postgres transaction driver boundary for live database assertions. expires: 2027-03-31.
const scopedTransaction = async <Value>(
  pool: Pool,
  tenantId: string,
  legalEntityId: string,
  // eslint-disable-next-line effect-native/no-promise-shaped-port -- The callback is the raw node-postgres driver operation executed inside this transaction. expires: 2027-03-31.
  operation: (client: PoolClient) => Promise<Value>,
): Promise<Value> => {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query("set local statement_timeout = '5s'");
    await client.query(
      "select set_config('ontos.tenant_id', $1, true), set_config('ontos.legal_entity_id', $2, true)",
      [tenantId, legalEntityId],
    );
    const value = await operation(client);
    await client.query('commit');
    return value;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
};

// eslint-disable-next-line effect-native/no-promise-shaped-port -- This is the raw node-postgres routine driver boundary under test. expires: 2027-03-31.
const invokeChange = async (
  client: PoolClient,
  tenantId: string,
  legalEntityId: string,
  input: ManualFxPolicyRoutineInput,
): Promise<MutationRoutineResult> => {
  const result = await client.query<PayloadRow>(
    'select payload from commerce_fx.change_manual_rate_policy($1::uuid, $2::uuid, $3::jsonb)',
    [tenantId, legalEntityId, JSON.stringify(input)],
  );
  return Schema.decodeUnknownSync(MutationRoutineResultSchema)(result.rows[0]?.payload);
};

// eslint-disable-next-line effect-native/no-promise-shaped-port -- Promise identity is required to start both raw driver calls before releasing the row-lock barrier. expires: 2027-03-31.
const invokeConcurrentChange = (
  runtime: Pool,
  tenantId: string,
  legalEntityId: string,
  input: ManualFxPolicyRoutineInput,
): Promise<MutationRoutineResult> =>
  scopedTransaction(runtime, tenantId, legalEntityId, (client) =>
    invokeChange(client, tenantId, legalEntityId, input),
  );

const invokeResolution = async (
  client: PoolClient,
  tenantId: string,
  legalEntityId: string,
  operationAt: string,
  context: ManualFxPolicyContext = manualFxPolicyContext,
): Promise<ResolutionRoutineResult> => {
  const result = await client.query<PayloadRow>(
    `select payload from commerce_fx.resolve_manual_rate_policy(
      $1::uuid, $2::uuid, $3::text, $4::text, $5::text, $6::text,
      $7::text, $8::text, $9::timestamptz
    )`,
    [
      tenantId,
      legalEntityId,
      context.channelId,
      context.marketId,
      context.storefrontId,
      context.purpose,
      context.sourceCurrencyCode,
      context.targetCurrencyCode,
      operationAt,
    ],
  );
  return Schema.decodeUnknownSync(ResolutionRoutineResultSchema)(result.rows[0]?.payload);
};

const invokeRevision = async (
  client: PoolClient,
  tenantId: string,
  legalEntityId: string,
  revisionId: string,
  context: ManualFxPolicyContext,
): Promise<ResolutionRoutineResult> => {
  const result = await client.query<PayloadRow>(
    `select payload from commerce_fx.read_manual_rate_policy_revision(
      $1::uuid, $2::uuid, $3::uuid, $4::text, $5::text, $6::text,
      $7::text, $8::text, $9::text
    )`,
    [
      tenantId,
      legalEntityId,
      revisionId,
      context.channelId,
      context.marketId,
      context.storefrontId,
      context.purpose,
      context.sourceCurrencyCode,
      context.targetCurrencyCode,
    ],
  );
  return Schema.decodeUnknownSync(ResolutionRoutineResultSchema)(result.rows[0]?.payload);
};

const readDurablePolicyCounts = async (
  admin: Pool,
  tenantId: string,
  legalEntityId: string,
): Promise<DurablePolicyCounts> => {
  const result = await admin.query(
    `select
      (select count(*)::int from commerce_fx.manual_rate_policy_mutation_journal where tenant_id = $1 and legal_entity_id = $2) as journal_count,
      (select count(*)::int from commerce_fx.manual_rate_policy_revisions where tenant_id = $1 and legal_entity_id = $2) as revision_count`,
    [tenantId, legalEntityId],
  );
  return Schema.decodeUnknownSync(DurablePolicyCountsSchema)(result.rows[0]);
};

const waitForBlockedRuntimeChanges = (
  admin: Pool,
  runtimeApplicationName: string,
  attemptsRemaining = 100,
): Effect.Effect<number> =>
  Effect.gen(function* waitForBlockedChanges() {
    const result = yield* Effect.promise(() =>
      admin.query(
        `select count(*)::int as pending_count
         from pg_catalog.pg_stat_activity
         where application_name = $1
           and state = 'active'
           and wait_event is not null
           and query like '%commerce_fx.change_manual_rate_policy%'`,
        [runtimeApplicationName],
      ),
    );
    const { pending_count: pendingCount } = Schema.decodeUnknownSync(PendingMutationCountSchema)(
      result.rows[0],
    );
    if (pendingCount >= 2 || attemptsRemaining <= 1) {
      return pendingCount;
    }
    // eslint-disable-next-line effect-native/no-native-timers -- This it.live database barrier needs bounded real-time polling; TestClock would prevent PostgreSQL from progressing. expires: 2027-03-31.
    yield* Effect.sleep('20 millis');
    return yield* waitForBlockedRuntimeChanges(
      admin,
      runtimeApplicationName,
      attemptsRemaining - 1,
    );
  });

const concurrentlyInvokeThroughHeadBarrier = (
  admin: Pool,
  runtime: Pool,
  runtimeApplicationName: string,
  tenantId: string,
  legalEntityId: string,
  input: ManualFxPolicyRoutineInput,
): Effect.Effect<BarrierReplayOutcome> =>
  Effect.gen(function* invokeThroughHeadBarrier() {
    const prepared = yield* Effect.scoped(
      Effect.acquireRelease(
        Effect.promise(async () => {
          const barrier = await admin.connect();
          await barrier.query('begin');
          await barrier.query(
            `select manual_rate_policy_head_id
             from commerce_fx.manual_rate_policy_heads
             where tenant_id = $1 and legal_entity_id = $2
             for update`,
            [tenantId, legalEntityId],
          );
          return barrier;
        }),
        (barrier) =>
          Effect.promise(async () => {
            await barrier.query('rollback');
            barrier.release();
          }),
      ).pipe(
        Effect.flatMap(() => {
          const pendingResults = [input, input].map((concurrentInput) =>
            invokeConcurrentChange(runtime, tenantId, legalEntityId, concurrentInput),
          );
          return waitForBlockedRuntimeChanges(admin, runtimeApplicationName).pipe(
            Effect.map((pendingCount) => ({ pendingCount, pendingResults })),
          );
        }),
      ),
    );
    const results = yield* Effect.promise(() => Promise.all(prepared.pendingResults));
    return { pendingCount: prepared.pendingCount, results };
  });

const policyInput = (
  actionInvocationId: string,
  actingPrincipalId: string,
  expectedRevision: number,
  sourceRevision: string,
  rate = '0.040000000000000001',
  context: ManualFxPolicyContext = manualFxPolicyContext,
): ManualFxPolicyRoutineInput => ({
  actingPrincipalId,
  actionInvocationId,
  change: {
    arithmeticVersion: 'commercial-fx-arithmetic.v1',
    direction: 'SOURCE_TO_TARGET',
    effectiveFrom: '2020-01-01T00:00:00.000Z',
    effectiveTo: '2099-01-01T00:00:00.000Z',
    inverseRatePermitted: false,
    maximumRateAgeSeconds: 31_536_000,
    operation: 'SET',
    rate,
    rateObservedAt: '2020-01-01T00:00:00.000Z',
    rateSourceId: 'manual-contract-rate',
    roundingIncrement: '0.01',
    roundingMode: 'half-even',
    roundingRuleRevision: 'commercial-rounding-r1',
    sourceRevision,
    targetMinorUnits: 2,
  },
  context,
  expectedRevision,
  reason: 'Live governed manual Commercial FX policy test',
});

it.live(
  'governs exact manual FX facts with idempotency, CAS serialization, typed resolution, and no raw runtime table access',
  () =>
    Effect.scoped(
      Effect.gen(function* governedManualFxPolicy() {
        const connections = yield* loadDatabaseConnectionPair();
        const runtimeApplicationName = `commerce-fx-manual-${randomUUID()}`;
        const runtime = yield* Effect.acquireRelease(
          Effect.sync(
            () =>
              new Pool({
                application_name: runtimeApplicationName,
                connectionString: connections.runtime.connectionString,
                max: 4,
              }),
          ),
          endPool,
        );
        const admin = yield* Effect.acquireRelease(
          Effect.sync(() => new Pool({ connectionString: connections.admin.connectionString })),
          endPool,
        );
        const tenantId = randomUUID();
        const legalEntityId = randomUUID();
        const principalId = randomUUID();
        const firstInvocationId = randomUUID();
        const initial = policyInput(firstInvocationId, principalId, 0, 'source-r1');

        const applied = yield* Effect.promise(() =>
          scopedTransaction(runtime, tenantId, legalEntityId, (client) =>
            invokeChange(client, tenantId, legalEntityId, initial),
          ),
        );
        const appliedResult = Schema.decodeUnknownSync(AppliedMutationSchema)(applied);
        expect(appliedResult.current).toMatchObject({
          change: { rate: '0.040000000000000001', sourceRevision: 'source-r1' },
          recordedAt: expect.stringMatching(/Z$/u),
          revision: 1,
        });

        const replay = yield* Effect.promise(() =>
          scopedTransaction(runtime, tenantId, legalEntityId, (client) =>
            invokeChange(client, tenantId, legalEntityId, initial),
          ),
        );
        expect(replay).toEqual(applied);

        const unchanged = yield* Effect.promise(() =>
          scopedTransaction(runtime, tenantId, legalEntityId, (client) =>
            invokeChange(
              client,
              tenantId,
              legalEntityId,
              policyInput(randomUUID(), principalId, 1, 'source-r1'),
            ),
          ),
        );
        const unchangedResult = Schema.decodeUnknownSync(UnchangedMutationSchema)(unchanged);
        expect(unchangedResult.current).toMatchObject({ revision: 1 });

        const contenders = [
          policyInput(randomUUID(), principalId, 1, 'source-r2-a', '0.041'),
          policyInput(randomUUID(), principalId, 1, 'source-r2-b', '0.042'),
        ];
        const concurrent = yield* Effect.promise(() =>
          Promise.all(
            contenders.map((input) =>
              scopedTransaction(runtime, tenantId, legalEntityId, (client) =>
                invokeChange(client, tenantId, legalEntityId, input),
              ),
            ),
          ),
        );
        expect(concurrent.filter(Schema.is(AppliedMutationSchema))).toHaveLength(1);
        expect(concurrent.filter(Schema.is(RevisionConflictSchema))).toHaveLength(1);

        const beforeConcurrentReplay = yield* Effect.promise(() =>
          readDurablePolicyCounts(admin, tenantId, legalEntityId),
        );
        expect(beforeConcurrentReplay).toEqual({ journal_count: 3, revision_count: 2 });

        const replayInvocationId = randomUUID();
        const concurrentlyReplayedInput = policyInput(
          replayInvocationId,
          principalId,
          2,
          'source-r3',
          '0.043',
        );
        const concurrentReplay = yield* concurrentlyInvokeThroughHeadBarrier(
          admin,
          runtime,
          runtimeApplicationName,
          tenantId,
          legalEntityId,
          concurrentlyReplayedInput,
        );
        expect(concurrentReplay.pendingCount).toBe(2);
        const firstConcurrentReplay = Schema.decodeUnknownSync(AppliedMutationSchema)(
          concurrentReplay.results[0],
        );
        const secondConcurrentReplay = Schema.decodeUnknownSync(AppliedMutationSchema)(
          concurrentReplay.results[1],
        );
        expect(secondConcurrentReplay).toEqual(firstConcurrentReplay);

        const afterConcurrentReplay = yield* Effect.promise(() =>
          readDurablePolicyCounts(admin, tenantId, legalEntityId),
        );
        expect(afterConcurrentReplay).toEqual({ journal_count: 4, revision_count: 3 });

        const reusedInvocation = yield* Effect.promise(() =>
          scopedTransaction(runtime, tenantId, legalEntityId, (client) =>
            invokeChange(
              client,
              tenantId,
              legalEntityId,
              policyInput(replayInvocationId, principalId, 2, 'source-r3-altered', '0.044'),
            ),
          ),
        );
        const invocationConflict = Schema.decodeUnknownSync(ActionInvocationReusedSchema)(
          reusedInvocation,
        );
        expect(invocationConflict.currentRevision).toBe(3);

        const malformedSetInput = {
          actingPrincipalId: principalId,
          actionInvocationId: randomUUID(),
          change: {
            arithmeticVersion: 'commercial-fx-arithmetic.v1',
            effectiveFrom: '2020-01-01T00:00:00.000Z',
            effectiveTo: '2099-01-01T00:00:00.000Z',
            inverseRatePermitted: false,
            maximumRateAgeSeconds: 31_536_000,
            operation: 'SET',
            rate: '0.045',
            rateObservedAt: '2020-01-01T00:00:00.000Z',
            rateSourceId: 'manual-contract-rate',
            roundingIncrement: '0.01',
            roundingMode: 'half-even',
            roundingRuleRevision: 'commercial-rounding-r1',
            sourceRevision: 'source-r4-malformed',
            targetMinorUnits: 2,
          },
          context: concurrentlyReplayedInput.context,
          expectedRevision: 3,
          reason: 'Malformed database boundary test without a required direction',
        };
        const malformedSetFailure = yield* Effect.tryPromise({
          catch: Schema.decodeUnknownSync(PostgresFailureSchema),
          try: () =>
            scopedTransaction(runtime, tenantId, legalEntityId, (client) =>
              client.query(
                'select payload from commerce_fx.change_manual_rate_policy($1::uuid, $2::uuid, $3::jsonb)',
                [tenantId, legalEntityId, JSON.stringify(malformedSetInput)],
              ),
            ),
        }).pipe(Effect.flip);
        expect(malformedSetFailure).toMatchObject({ code: '23514' });

        const overPrecisionIncrementInput = {
          ...concurrentlyReplayedInput,
          actionInvocationId: randomUUID(),
          change: {
            ...concurrentlyReplayedInput.change,
            roundingIncrement: '0.001',
            sourceRevision: 'source-r4-over-precision-increment',
          },
          expectedRevision: 3,
        };
        const overPrecisionIncrementFailure = yield* Effect.tryPromise({
          catch: Schema.decodeUnknownSync(PostgresFailureSchema),
          try: () =>
            scopedTransaction(runtime, tenantId, legalEntityId, (client) =>
              client.query(
                'select payload from commerce_fx.change_manual_rate_policy($1::uuid, $2::uuid, $3::jsonb)',
                [tenantId, legalEntityId, JSON.stringify(overPrecisionIncrementInput)],
              ),
            ),
        }).pipe(Effect.flip);
        expect(overPrecisionIncrementFailure).toMatchObject({ code: '23514' });

        const resolved = yield* Effect.promise(() =>
          scopedTransaction(runtime, tenantId, legalEntityId, (client) =>
            invokeResolution(client, tenantId, legalEntityId, '2098-01-01T00:00:00.000Z'),
          ),
        );
        const resolvedPolicy = Schema.decodeUnknownSync(ResolvedPolicySchema)(resolved);
        expect(resolvedPolicy.current).toMatchObject({ revision: 3 });
        const stale = yield* Effect.promise(() =>
          scopedTransaction(runtime, tenantId, legalEntityId, (client) =>
            invokeResolution(client, tenantId, legalEntityId, '2100-01-01T00:00:00.000Z'),
          ),
        );
        expect(Schema.is(StalePolicySchema)(stale)).toBe(true);

        const wrongScopeFailure = yield* Effect.tryPromise({
          catch: Schema.decodeUnknownSync(PostgresFailureSchema),
          try: () =>
            scopedTransaction(runtime, tenantId, randomUUID(), (client) =>
              invokeResolution(client, tenantId, legalEntityId, '2098-01-01T00:00:00.000Z'),
            ),
        }).pipe(Effect.flip);
        expect(wrongScopeFailure).toMatchObject({ code: '42501' });

        const rawTableFailure = yield* Effect.tryPromise({
          catch: Schema.decodeUnknownSync(PostgresFailureSchema),
          try: () =>
            scopedTransaction(runtime, tenantId, legalEntityId, (client) =>
              client.query('select * from commerce_fx.manual_rate_policy_heads'),
            ),
        }).pipe(Effect.flip);
        expect(rawTableFailure).toMatchObject({ code: '42501' });

        const durableCounts = yield* Effect.promise(() =>
          readDurablePolicyCounts(admin, tenantId, legalEntityId),
        );
        expect(durableCounts).toEqual({ journal_count: 4, revision_count: 3 });
      }),
    ),
);

it.live('withdraws by effective precedence without losing either immutable policy revision', () =>
  Effect.scoped(
    Effect.gen(function* withdrawalPrecedence() {
      const connections = yield* loadDatabaseConnectionPair();
      const runtime = yield* Effect.acquireRelease(
        Effect.sync(
          () => new Pool({ connectionString: connections.runtime.connectionString, max: 2 }),
        ),
        endPool,
      );
      const tenantId = randomUUID();
      const legalEntityId = randomUUID();
      const principalId = randomUUID();
      const context: ManualFxPolicyContext = {
        ...manualFxPolicyContext,
        storefrontId: `withdraw-${randomUUID()}`,
      };

      const setOutcome = yield* Effect.promise(() =>
        scopedTransaction(runtime, tenantId, legalEntityId, (client) =>
          invokeChange(
            client,
            tenantId,
            legalEntityId,
            policyInput(randomUUID(), principalId, 0, 'withdraw-source-r1', '0.05', context),
          ),
        ),
      );
      const setApplied = Schema.decodeUnknownSync(AppliedMutationSchema)(setOutcome);

      const withdrawInput: ManualFxPolicyRoutineInput = {
        actingPrincipalId: principalId,
        actionInvocationId: randomUUID(),
        change: {
          effectiveFrom: '2098-06-01T00:00:00.000Z',
          operation: 'WITHDRAW',
          rateSourceId: 'manual-contract-rate',
          sourceRevision: 'withdraw-source-r2',
        },
        context,
        expectedRevision: 1,
        reason: 'End the governed manual Commercial FX contract rate',
      };
      const withdrawOutcome = yield* Effect.promise(() =>
        scopedTransaction(runtime, tenantId, legalEntityId, (client) =>
          invokeChange(client, tenantId, legalEntityId, withdrawInput),
        ),
      );
      const withdrawApplied = Schema.decodeUnknownSync(AppliedMutationSchema)(withdrawOutcome);

      const beforeWithdrawal = yield* Effect.promise(() =>
        scopedTransaction(runtime, tenantId, legalEntityId, (client) =>
          invokeResolution(client, tenantId, legalEntityId, '2098-05-31T23:59:59.999Z', context),
        ),
      );
      const activeSet = Schema.decodeUnknownSync(ResolvedPolicySchema)(beforeWithdrawal);
      expect(activeSet.current).toMatchObject({
        policyRevisionId: setApplied.current.policyRevisionId,
        revision: 1,
      });

      for (const operationAt of ['2098-06-01T00:00:00.000Z', '2098-07-01T00:00:00.000Z']) {
        const withdrawn = yield* Effect.promise(() =>
          scopedTransaction(runtime, tenantId, legalEntityId, (client) =>
            invokeResolution(client, tenantId, legalEntityId, operationAt, context),
          ),
        );
        expect(Schema.is(NotConfiguredPolicySchema)(withdrawn)).toBe(true);
      }

      const exactSet = yield* Effect.promise(() =>
        scopedTransaction(runtime, tenantId, legalEntityId, (client) =>
          invokeRevision(
            client,
            tenantId,
            legalEntityId,
            setApplied.current.policyRevisionId,
            context,
          ),
        ),
      );
      const exactWithdrawal = yield* Effect.promise(() =>
        scopedTransaction(runtime, tenantId, legalEntityId, (client) =>
          invokeRevision(
            client,
            tenantId,
            legalEntityId,
            withdrawApplied.current.policyRevisionId,
            context,
          ),
        ),
      );
      expect(Schema.decodeUnknownSync(ResolvedPolicySchema)(exactSet).current).toMatchObject({
        change: { operation: 'SET', sourceRevision: 'withdraw-source-r1' },
        policyRevisionId: setApplied.current.policyRevisionId,
        revision: 1,
      });
      expect(Schema.decodeUnknownSync(ResolvedPolicySchema)(exactWithdrawal).current).toMatchObject(
        {
          change: { operation: 'WITHDRAW', sourceRevision: 'withdraw-source-r2' },
          policyRevisionId: withdrawApplied.current.policyRevisionId,
          revision: 2,
        },
      );
    }),
  ),
);
