import { sql } from 'drizzle-orm';
import {
  PricingCurrencySupportRevisionIdSchema,
  PricingCurrencySupportRootIdSchema,
  PricingInstantSchema,
} from '@app/pricing-contracts/domain/currency-support';
import { Deferred, Effect, Exit, Fiber, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { randomUUID } from 'node:crypto';

import { coreRelations } from '../../../../packages/core-runtime/src/db/schema.ts';
import {
  makeTestDatabaseFromClient,
  testDatabaseClients,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import type { TestDatabaseFromClient } from '../../../../packages/core-runtime/tests/support/database.ts';

type PricingTestDatabase = TestDatabaseFromClient<typeof coreRelations>;
type PricingTransaction = Parameters<Parameters<PricingTestDatabase['transaction']>[0]>[0];
type JsonValue = boolean | null | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

const RowSchema = Schema.Struct({ payload: Schema.Unknown });
const RoutinePrivilegeRowSchema = Schema.Struct({
  canExecute: Schema.Boolean,
  routine: Schema.String,
});
const scoped = <Value, Failure>(
  database: PricingTestDatabase,
  tenantId: string,
  operation: (transaction: PricingTransaction) => Effect.Effect<Value, Failure>,
) =>
  database.transaction((transaction) =>
    Effect.gen(function* scopedOperation() {
      yield* transaction.execute(sql`select set_config('ontos.tenant_id', ${tenantId}, true)`, 'objects');
      return yield* operation(transaction);
    }),
  );
const invokeSet = (
  transaction: PricingTransaction,
  tenantId: string,
  input: Readonly<Record<string, JsonValue>>,
  version: 'v1' | 'v2',
) => {
  const request = JSON.stringify(input);
  const query =
    version === 'v1'
      ? sql`select payload from pricing.set_tenant_currency_support_v1(${tenantId}::uuid, ${request}::jsonb)`
      : sql`select payload from pricing.set_tenant_currency_support_v2(${tenantId}::uuid, ${request}::jsonb)`;
  return transaction
    .execute(query, 'objects')
    .pipe(Effect.map(([row]) => Schema.decodeUnknownSync(RowSchema)(row).payload));
};
const lookup = (transaction: PricingTransaction, tenantId: string, invocationId: string, principalId: string) => {
  const request = JSON.stringify({ actingPrincipalId: principalId, actionInvocationId: invocationId });
  return transaction
    .execute(
      sql`select payload from pricing.lookup_tenant_currency_support_result_v1(${tenantId}::uuid, ${request}::jsonb)`,
      'objects',
    )
    .pipe(Effect.map(([row]) => Schema.decodeUnknownSync(RowSchema)(row).payload));
};
const compensateRecovery = (
  transaction: PricingTransaction,
  tenantId: string,
  input: Readonly<Record<string, JsonValue>>,
) => {
  const request = JSON.stringify(input);
  return transaction
    .execute(
      sql`select payload from pricing.compensate_tenant_currency_support_recovery_v1(
        ${tenantId}::uuid, ${request}::jsonb
      )`,
      'objects',
    )
    .pipe(Effect.map(([row]) => Schema.decodeUnknownSync(RowSchema)(row).payload));
};
const readSupportAt = (transaction: PricingTransaction, tenantId: string, effectiveAt: string) => {
  const request = JSON.stringify({ effectiveAt, evaluationMode: 'HISTORICAL_AS_OF' });
  return transaction
    .execute(
      sql`select payload from pricing.read_tenant_currency_support_v1(${tenantId}::uuid, ${request}::jsonb)`,
      'objects',
    )
    .pipe(Effect.map(([row]) => Schema.decodeUnknownSync(RowSchema)(row).payload));
};
const verifyGeneration = (
  transaction: PricingTransaction,
  tenantId: string,
  input: Readonly<Record<string, JsonValue>>,
) => {
  const request = JSON.stringify(input);
  return transaction
    .execute(
      sql`select payload from pricing.verify_tenant_currency_support_generation_v1(
        ${tenantId}::uuid, ${request}::jsonb
      )`,
      'objects',
    )
    .pipe(Effect.map(([row]) => Schema.decodeUnknownSync(RowSchema)(row).payload));
};
const issueProof = (transaction: PricingTransaction, tenantId: string, input: Readonly<Record<string, JsonValue>>) => {
  const request = JSON.stringify(input);
  return transaction
    .execute(
      sql`select payload from pricing.issue_tenant_currency_support_proof_v1(
        ${tenantId}::uuid, ${request}::jsonb
      )`,
      'objects',
    )
    .pipe(Effect.map(([row]) => Schema.decodeUnknownSync(RowSchema)(row).payload));
};
const resolveProof = (transaction: PricingTransaction, tenantId: string, verificationRef: string) => {
  const request = JSON.stringify({ verificationRef });
  return transaction
    .execute(
      sql`select payload from pricing.resolve_tenant_currency_support_proof_v1(
        ${tenantId}::uuid, ${request}::jsonb
      )`,
      'objects',
    )
    .pipe(Effect.map(([row]) => Schema.decodeUnknownSync(RowSchema)(row).payload));
};
const cleanup = (database: PricingTestDatabase, tenantId: string) =>
  database.transaction((transaction) =>
    Effect.gen(function* cleanupCurrencySupportResult() {
      yield* transaction.execute(
        sql`delete from pricing.currency_support_recovery_compensation_receipts where tenant_id = ${tenantId}::uuid`,
      );
      yield* transaction.execute(
        sql`delete from pricing.currency_support_proof_receipts where tenant_id = ${tenantId}::uuid`,
      );
      yield* transaction.execute(
        sql`delete from pricing.currency_support_action_result_receipts where tenant_id = ${tenantId}::uuid`,
      );
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
      yield* transaction.execute(sql`delete from pricing.currency_support_roots where tenant_id = ${tenantId}::uuid`);
    }),
  );

it.live('recovers a lost old-signature response and journals exact results across the N/N-1 overlap', () =>
  Effect.scoped(
    Effect.gen(function* resultLookupProof() {
      const tenantId = randomUUID();
      const principalId = randomUUID();
      const firstInvocationId = randomUUID();
      const noopInvocationId = randomUUID();
      const { admin: adminClient, runtime: runtimeClient } = yield* testDatabaseClients;
      const admin = yield* makeTestDatabaseFromClient(adminClient, coreRelations);
      const runtime = yield* makeTestDatabaseFromClient(runtimeClient, coreRelations);
      yield* Effect.addFinalizer(() => cleanup(admin, tenantId).pipe(Effect.orDie));
      const routinePrivileges = yield* admin.transaction((transaction) =>
        transaction.execute(
          sql`
            select routine,
                   pg_catalog.has_function_privilege('ontos_runtime', routine, 'EXECUTE') as "canExecute"
              from (values
                ('pricing.compensate_tenant_currency_support_recovery_v1(uuid,jsonb)'),
                ('pricing.set_tenant_currency_support_v1(uuid,jsonb)'),
                ('pricing.set_tenant_currency_support_v2(uuid,jsonb)'),
                ('pricing.lookup_tenant_currency_support_result_v1(uuid,jsonb)'),
                ('pricing.issue_tenant_currency_support_proof_v1(uuid,jsonb)'),
                ('pricing.resolve_tenant_currency_support_proof_v1(uuid,jsonb)'),
                ('pricing.set_tenant_currency_support_unjournaled_v1(uuid,jsonb)'),
                ('pricing.execute_tenant_currency_support_with_result_v1(uuid,jsonb,boolean)'),
                ('pricing.currency_support_expected_summary_v1(uuid,uuid,uuid,timestamptz,timestamptz)')
              ) as routines(routine)
             order by routine
          `,
          'objects',
        ),
      );
      const decodedRoutinePrivileges = yield* Schema.decodeUnknownEffect(Schema.Array(RoutinePrivilegeRowSchema))(
        routinePrivileges,
      );
      expect(decodedRoutinePrivileges).toEqual([
        {
          canExecute: true,
          routine: 'pricing.compensate_tenant_currency_support_recovery_v1(uuid,jsonb)',
        },
        {
          canExecute: false,
          routine: 'pricing.currency_support_expected_summary_v1(uuid,uuid,uuid,timestamptz,timestamptz)',
        },
        {
          canExecute: false,
          routine: 'pricing.execute_tenant_currency_support_with_result_v1(uuid,jsonb,boolean)',
        },
        {
          canExecute: true,
          routine: 'pricing.issue_tenant_currency_support_proof_v1(uuid,jsonb)',
        },
        {
          canExecute: true,
          routine: 'pricing.lookup_tenant_currency_support_result_v1(uuid,jsonb)',
        },
        {
          canExecute: true,
          routine: 'pricing.resolve_tenant_currency_support_proof_v1(uuid,jsonb)',
        },
        {
          canExecute: false,
          routine: 'pricing.set_tenant_currency_support_unjournaled_v1(uuid,jsonb)',
        },
        {
          canExecute: true,
          routine: 'pricing.set_tenant_currency_support_v1(uuid,jsonb)',
        },
        {
          canExecute: true,
          routine: 'pricing.set_tenant_currency_support_v2(uuid,jsonb)',
        },
      ]);
      const [clockRow] = yield* admin.transaction((transaction) =>
        transaction.execute(
          sql`select to_char((clock_timestamp() - interval '1 minute') at time zone 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "effectiveFrom"`,
          'objects',
        ),
      );
      const { effectiveFrom } = yield* Schema.decodeUnknownEffect(Schema.Struct({ effectiveFrom: Schema.String }))(
        clockRow,
      );
      const establishWithoutExpectedState = {
        actionInvocationId: firstInvocationId,
        actorPrincipalId: principalId,
        effectiveFrom,
        expectedGeneration: 0,
        expectedScheduleRevision: 0,
        intendedEffectivePeriod: { effectiveFrom, effectiveTo: null },
        intent: 'ESTABLISH_CURRENT',
        reason: 'Establish the Tenant launch currency.',
        supportedCurrencies: ['CZK'],
        trustedOperationAt: effectiveFrom,
      };
      const missingExpectedState = yield* Effect.exit(
        scoped(runtime, tenantId, (transaction) =>
          invokeSet(transaction, tenantId, establishWithoutExpectedState, 'v1'),
        ),
      );
      expect(Exit.isFailure(missingExpectedState)).toBe(true);

      const establish = {
        ...establishWithoutExpectedState,
        expectedState: { state: 'ABSENT' },
      };
      // Model N-1 sending the old signature with the same exact-state contract
      // as N, then losing the transport response.
      const created = yield* scoped(runtime, tenantId, (transaction) =>
        invokeSet(transaction, tenantId, establish, 'v1'),
      );
      expect(created).toMatchObject({ changed: true, outcome: 'APPLIED', supportedCurrencies: ['CZK'] });
      expect(
        yield* scoped(runtime, tenantId, (transaction) =>
          lookup(transaction, tenantId, firstInvocationId, principalId),
        ),
      ).toEqual({
        actingPrincipalId: principalId,
        actionInvocationId: firstInvocationId,
        intent: 'ESTABLISH_CURRENT',
        outcome: 'CURRENCY_SUPPORT_ACTION_RESULT_FOUND',
        result: created,
      });
      expect(
        yield* scoped(runtime, tenantId, (transaction) => invokeSet(transaction, tenantId, establish, 'v2')),
      ).toEqual(created);

      const createdValue = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          current: Schema.Struct({ supportRevisionId: PricingCurrencySupportRevisionIdSchema }),
          supportId: PricingCurrencySupportRootIdSchema,
        }),
      )(created);
      const issued = yield* scoped(runtime, tenantId, (transaction) =>
        issueProof(transaction, tenantId, {
          effectiveAt: effectiveFrom,
          generation: 1,
          scheduleRevision: 1,
          supportId: createdValue.supportId,
          supportRevisionId: createdValue.current.supportRevisionId,
        }),
      );
      const issuedProof = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          factProofs: Schema.Array(
            Schema.Struct({ factRef: Schema.String, factRevisionRef: Schema.String, verificationRef: Schema.String }),
          ),
          observedAt: PricingInstantSchema,
          outcome: Schema.Literal('CURRENCY_SUPPORT_PROOF_ISSUED'),
          predicateRef: Schema.String,
          supportedCurrencies: Schema.Array(Schema.String),
          verificationRef: Schema.String,
        }),
      )(issued);
      expect(issuedProof.verificationRef).not.toBe(createdValue.current.supportRevisionId);
      expect(issuedProof.verificationRef).toMatch(/^commerce\.pricing\.currency-support-proof:/u);
      expect(issuedProof.factProofs).toEqual([
        {
          factRef: createdValue.supportId,
          factRevisionRef: createdValue.current.supportRevisionId,
          verificationRef: issuedProof.verificationRef,
        },
      ]);
      expect(issuedProof.supportedCurrencies).toEqual(['CZK']);
      const resolvedBeforeMutation = yield* scoped(runtime, tenantId, (transaction) =>
        resolveProof(transaction, tenantId, issuedProof.verificationRef),
      );
      expect(resolvedBeforeMutation).toMatchObject({
        factProofs: issuedProof.factProofs,
        observedAt: issuedProof.observedAt,
        outcome: 'CURRENCY_SUPPORT_PROOF_RESOLVED',
        predicateRef: issuedProof.predicateRef,
        supportedCurrencies: ['CZK'],
        supportId: createdValue.supportId,
        supportRevisionId: createdValue.current.supportRevisionId,
        verificationRef: issuedProof.verificationRef,
      });
      const [observationRow] = yield* admin.transaction((transaction) =>
        transaction.execute(
          sql`select to_char(clock_timestamp() at time zone 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "observedAt"`,
          'objects',
        ),
      );
      const { observedAt } = yield* Schema.decodeUnknownEffect(Schema.Struct({ observedAt: PricingInstantSchema }))(
        observationRow,
      );
      const expectedState = {
        current: {
          effectivePeriod: { effectiveFrom, effectiveTo: null },
          generation: 1,
          supportedCurrencies: ['CZK'],
          supportRevisionRef: {
            moduleId: 'commerce.pricing',
            resourceId: createdValue.current.supportRevisionId,
            resourceType: 'commerce.pricing.currency-support-revision',
            supportRootId: createdValue.supportId,
            tenantId,
          },
        },
        future: [],
        observedAt,
        scheduleRevision: 1,
        state: 'PRESENT',
        supportRootRef: {
          moduleId: 'commerce.pricing',
          resourceId: createdValue.supportId,
          resourceType: 'commerce.pricing.currency-support',
          tenantId,
        },
      };
      expect(
        yield* scoped(runtime, tenantId, (transaction) =>
          verifyGeneration(transaction, tenantId, {
            effectiveAt: effectiveFrom,
            evidenceObservedAt: observedAt,
            generation: 1,
            scheduleRevision: 1,
            supportId: createdValue.supportId,
            supportRevisionId: createdValue.current.supportRevisionId,
            through: observedAt,
          }),
        ),
      ).toMatchObject({
        generation: 1,
        outcome: 'CURRENCY_SUPPORT_UNCHANGED_THROUGH',
        scheduleRevision: 1,
        supportId: createdValue.supportId,
        supportRevisionId: createdValue.current.supportRevisionId,
        verifiedThrough: observedAt,
      });
      const noop = {
        ...establish,
        actionInvocationId: noopInvocationId,
        expectedCurrent: {
          effectiveFrom,
          effectiveTo: null,
          supportRevisionId: createdValue.current.supportRevisionId,
        },
        expectedGeneration: 1,
        expectedScheduleRevision: 1,
        expectedState,
        intent: 'VALUE_ONLY_CURRENT',
      };
      const unchanged = yield* scoped(runtime, tenantId, (transaction) => invokeSet(transaction, tenantId, noop, 'v2'));
      expect(unchanged).toMatchObject({ changed: false, outcome: 'UNCHANGED', supportId: createdValue.supportId });
      expect(
        yield* scoped(runtime, tenantId, (transaction) =>
          invokeSet(
            transaction,
            tenantId,
            {
              ...noop,
              scheduleAcknowledgement: { fingerprint: 'reconstructed-transport-metadata' },
              trustedOperationAt: observedAt,
            },
            'v2',
          ),
        ),
      ).toEqual(unchanged);
      expect(
        yield* scoped(runtime, tenantId, (transaction) => lookup(transaction, tenantId, noopInvocationId, principalId)),
      ).toMatchObject({ outcome: 'CURRENCY_SUPPORT_ACTION_RESULT_FOUND', result: unchanged });

      const falseExpectedState = {
        ...noop,
        actionInvocationId: randomUUID(),
        expectedState: {
          ...expectedState,
          current: { ...expectedState.current, supportedCurrencies: ['EUR'] },
        },
      };
      expect(
        yield* scoped(runtime, tenantId, (transaction) => invokeSet(transaction, tenantId, falseExpectedState, 'v1')),
      ).toMatchObject({ changed: false, outcome: 'CURRENT_STATE_CONFLICT' });

      const staleSameValue = { ...noop, actionInvocationId: randomUUID(), expectedGeneration: 0 };
      expect(
        yield* scoped(runtime, tenantId, (transaction) => invokeSet(transaction, tenantId, staleSameValue, 'v2')),
      ).toMatchObject({ changed: false, outcome: 'REVISION_CONFLICT' });
      expect(
        yield* scoped(runtime, tenantId, (transaction) =>
          invokeSet(transaction, tenantId, { ...noop, reason: 'Changed replay payload.' }, 'v2'),
        ),
      ).toMatchObject({ outcome: 'CURRENT_STATE_CONFLICT', reason: 'IDEMPOTENCY_CONFLICT' });
      expect(
        yield* scoped(runtime, tenantId, (transaction) => lookup(transaction, tenantId, randomUUID(), principalId)),
      ).toMatchObject({ actingPrincipalId: principalId, outcome: 'CURRENCY_SUPPORT_ACTION_RESULT_UNKNOWN' });
      const wrongPrincipal = yield* Effect.exit(
        scoped(runtime, tenantId, (transaction) => lookup(transaction, tenantId, firstInvocationId, randomUUID())),
      );
      expect(Exit.isFailure(wrongPrincipal)).toBe(true);

      // Simulate a changed pre-journal invocation: the immutable value revision
      // remains, but its original APPLIED result cannot be reconstructed.
      yield* admin.transaction((transaction) =>
        transaction.execute(sql`
          delete from pricing.currency_support_action_result_receipts
           where tenant_id = ${tenantId}::uuid and action_invocation_id = ${firstInvocationId}::uuid
        `),
      );
      expect(
        yield* scoped(runtime, tenantId, (transaction) =>
          lookup(transaction, tenantId, firstInvocationId, principalId),
        ),
      ).toMatchObject({ outcome: 'CURRENCY_SUPPORT_ACTION_RESULT_UNKNOWN' });
      const legacyReplay = yield* Effect.exit(
        scoped(runtime, tenantId, (transaction) => invokeSet(transaction, tenantId, establish, 'v2')),
      );
      expect(Exit.isFailure(legacyReplay)).toBe(true);

      const [mutationTimeRow] = yield* admin.transaction((transaction) =>
        transaction.execute(
          sql`select to_char(clock_timestamp() at time zone 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "mutationAt"`,
          'objects',
        ),
      );
      const { mutationAt } = yield* Schema.decodeUnknownEffect(Schema.Struct({ mutationAt: PricingInstantSchema }))(
        mutationTimeRow,
      );
      const releaseWriter = yield* Deferred.make<null>();
      const writerApplied = yield* Deferred.make<{
        readonly changedThrough: string;
        readonly successor: unknown;
        readonly writerPid: number;
      }>();
      const writer = yield* Effect.forkScoped(
        scoped(runtime, tenantId, (transaction) =>
          Effect.gen(function* holdCurrencySupportWriterUntilVerifierWaits() {
            const [pidRow] = yield* transaction.execute(sql`select pg_backend_pid() as pid`, 'objects');
            const { pid: writerPid } = yield* Schema.decodeUnknownEffect(Schema.Struct({ pid: Schema.Finite }))(pidRow);
            const successor = yield* invokeSet(
              transaction,
              tenantId,
              {
                ...noop,
                actionInvocationId: randomUUID(),
                effectiveFrom: mutationAt,
                intendedEffectivePeriod: { effectiveFrom: mutationAt, effectiveTo: null },
                reason: 'Advance the same Launch set at a new immutable boundary.',
                trustedOperationAt: mutationAt,
              },
              'v2',
            );
            const [throughRow] = yield* transaction.execute(
              sql`select to_char(clock_timestamp() at time zone 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "changedThrough"`,
              'objects',
            );
            const { changedThrough } = yield* Schema.decodeUnknownEffect(
              Schema.Struct({ changedThrough: PricingInstantSchema }),
            )(throughRow);
            yield* Deferred.succeed(writerApplied, { changedThrough, successor, writerPid });
            yield* Deferred.await(releaseWriter);
            return successor;
          }),
        ),
      );
      const { changedThrough, successor, writerPid } = yield* Deferred.await(writerApplied);
      expect(successor).toMatchObject({ changed: true, outcome: 'APPLIED', scheduleRevision: 2 });
      const verifierConnection = yield* Deferred.make<number>();
      const verification = yield* Effect.forkScoped(
        scoped(runtime, tenantId, (transaction) =>
          Effect.gen(function* verifyAfterCommitOrderedWriter() {
            const [pidRow] = yield* transaction.execute(sql`select pg_backend_pid() as pid`, 'objects');
            const { pid } = yield* Schema.decodeUnknownEffect(Schema.Struct({ pid: Schema.Finite }))(pidRow);
            yield* Deferred.succeed(verifierConnection, pid);
            return yield* verifyGeneration(transaction, tenantId, {
              effectiveAt: effectiveFrom,
              evidenceObservedAt: observedAt,
              generation: 1,
              scheduleRevision: 1,
              supportId: createdValue.supportId,
              supportRevisionId: createdValue.current.supportRevisionId,
              through: changedThrough,
            });
          }),
        ),
      );
      const verifierPid = yield* Deferred.await(verifierConnection);
      expect(verifierPid).not.toBe(writerPid);
      let observedWaitingLock = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const [lockRow] = yield* admin.transaction((transaction) =>
          transaction.execute(
            sql`select exists(
                  select 1 from pg_catalog.pg_locks
                   where pid = ${verifierPid}
                     and locktype = 'advisory'
                     and not granted
                ) as "isWaiting"`,
            'objects',
          ),
        );
        const { isWaiting } = yield* Schema.decodeUnknownEffect(Schema.Struct({ isWaiting: Schema.Boolean }))(lockRow);
        if (isWaiting) {
          observedWaitingLock = true;
          break;
        }
        yield* admin.transaction((transaction) => transaction.execute(sql`select pg_sleep(0.01)`));
      }
      yield* Effect.suspend(() =>
        observedWaitingLock ? Effect.void : Effect.die('Currency Support verifier did not wait for the writer lock'),
      );
      yield* Deferred.succeed(releaseWriter, null);
      yield* Fiber.join(writer);
      expect(
        yield* scoped(runtime, tenantId, (transaction) =>
          resolveProof(transaction, tenantId, issuedProof.verificationRef),
        ),
      ).toEqual(resolvedBeforeMutation);
      expect(yield* Fiber.join(verification)).toMatchObject({
        outcome: 'CURRENCY_SUPPORT_CHANGED_BEFORE_FENCE',
        verifiedThrough: changedThrough,
      });
    }),
  ),
);

it.live('persists rollback as a new governed schedule, denies legacy writes, and survives failure injection', () =>
  Effect.scoped(
    Effect.gen(function* recoveryCompensationProof() {
      const tenantId = randomUUID();
      const legalEntityId = randomUUID();
      const principalId = randomUUID();
      const committedInvocationId = randomUUID();
      const preCommitCompensationInvocationId = randomUUID();
      const compensationInvocationId = randomUUID();
      const { admin: adminClient, runtime: runtimeClient } = yield* testDatabaseClients;
      const admin = yield* makeTestDatabaseFromClient(adminClient, coreRelations);
      const runtime = yield* makeTestDatabaseFromClient(runtimeClient, coreRelations);
      yield* Effect.addFinalizer(() => cleanup(admin, tenantId).pipe(Effect.orDie));

      const [clockRow] = yield* admin.transaction((transaction) =>
        transaction.execute(
          sql`select
                to_char((clock_timestamp() - interval '2 minutes') at time zone 'UTC',
                  'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "effectiveFrom",
                to_char(clock_timestamp() at time zone 'UTC',
                  'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "operationAt"`,
          'objects',
        ),
      );
      const { effectiveFrom, operationAt } = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ effectiveFrom: PricingInstantSchema, operationAt: PricingInstantSchema }),
      )(clockRow);
      const establish = {
        actionInvocationId: committedInvocationId,
        actorPrincipalId: principalId,
        effectiveFrom,
        expectedGeneration: 0,
        expectedScheduleRevision: 0,
        expectedState: { state: 'ABSENT' },
        intendedEffectivePeriod: { effectiveFrom, effectiveTo: null },
        intent: 'ESTABLISH_CURRENT',
        reason: 'Establish the explicit governed recovery baseline.',
        supportedCurrencies: ['CZK'],
        trustedOperationAt: operationAt,
      };

      const rolledBackEstablish = yield* Effect.exit(
        scoped(runtime, tenantId, (transaction) =>
          Effect.gen(function* injectFailureBeforeCanonicalCommit() {
            yield* invokeSet(transaction, tenantId, establish, 'v2');
            return yield* Effect.fail('injected failure before canonical commit');
          }),
        ),
      );
      expect(Exit.isFailure(rolledBackEstablish)).toBe(true);
      expect(
        yield* scoped(runtime, tenantId, (transaction) =>
          compensateRecovery(transaction, tenantId, {
            actionInvocationId: preCommitCompensationInvocationId,
            actorPrincipalId: principalId,
            committedActionInvocationId: committedInvocationId,
            reason: 'A rolled-back write has no committed recovery result to compensate.',
            trustedOperationAt: operationAt,
          }),
        ),
      ).toEqual({
        outcome: 'CURRENCY_SUPPORT_RECOVERY_COMPENSATION_CONFLICT',
        reason: 'COMMITTED_RESULT_NOT_FOUND',
      });

      const created = yield* scoped(runtime, tenantId, (transaction) =>
        invokeSet(transaction, tenantId, establish, 'v2'),
      );
      const committed = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          current: Schema.Struct({
            generation: Schema.Finite,
            supportRevisionId: PricingCurrencySupportRevisionIdSchema,
          }),
          scheduleRevision: Schema.Finite,
          supportId: PricingCurrencySupportRootIdSchema,
        }),
      )(created);
      const [compensationClockRow] = yield* admin.transaction((transaction) =>
        transaction.execute(
          sql`select to_char(clock_timestamp() at time zone 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "compensationAt"`,
          'objects',
        ),
      );
      const { compensationAt } = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ compensationAt: PricingInstantSchema }),
      )(compensationClockRow);
      expect(
        yield* scoped(runtime, tenantId, (transaction) => readSupportAt(transaction, tenantId, operationAt)),
      ).toMatchObject({
        current: {
          supportedCurrencies: ['CZK'],
          supportRevisionId: committed.current.supportRevisionId,
        },
        outcome: 'CURRENCY_SUPPORT_CURRENT',
        supportId: committed.supportId,
      });

      const compensation = {
        actionInvocationId: compensationInvocationId,
        actorPrincipalId: principalId,
        committedActionInvocationId: committedInvocationId,
        reason: 'End the exact committed recovery state without deleting its history.',
        trustedOperationAt: compensationAt,
      };
      const rolledBackCompensation = yield* Effect.exit(
        scoped(runtime, tenantId, (transaction) =>
          Effect.gen(function* injectFailureAfterCompensationWrite() {
            yield* compensateRecovery(transaction, tenantId, compensation);
            return yield* Effect.fail('injected failure after compensation write');
          }),
        ),
      );
      expect(Exit.isFailure(rolledBackCompensation)).toBe(true);
      expect(
        yield* scoped(runtime, tenantId, (transaction) => readSupportAt(transaction, tenantId, compensationAt)),
      ).toMatchObject({ outcome: 'CURRENCY_SUPPORT_CURRENT', supportId: committed.supportId });

      const compensated = yield* scoped(runtime, tenantId, (transaction) =>
        compensateRecovery(transaction, tenantId, compensation),
      );
      expect(compensated).toMatchObject({
        absentFrom: compensationAt,
        committedActionInvocationId: committedInvocationId,
        committedGeneration: committed.current.generation,
        committedScheduleRevision: committed.scheduleRevision,
        committedSupportRevisionId: committed.current.supportRevisionId,
        compensationScheduleRevision: committed.scheduleRevision + 1,
        outcome: 'CURRENCY_SUPPORT_RECOVERY_COMPENSATED',
        supportId: committed.supportId,
      });
      expect(
        yield* scoped(runtime, tenantId, (transaction) => compensateRecovery(transaction, tenantId, compensation)),
      ).toEqual(compensated);
      expect(
        yield* scoped(runtime, tenantId, (transaction) => readSupportAt(transaction, tenantId, compensationAt)),
      ).toMatchObject({ activeRevisionCount: 0, outcome: 'CURRENCY_SUPPORT_GAP' });

      const legacyWrite = yield* Effect.exit(
        scoped(runtime, tenantId, (transaction) =>
          Effect.gen(function* attemptLegacyWrite() {
            yield* transaction.execute(
              sql`select set_config('ontos.legal_entity_id', ${legalEntityId}, true)`,
              'objects',
            );
            yield* transaction.execute(sql`
              insert into pricing.currency_support_revisions (
                tenant_id, legal_entity_id, context_revision, storefront_id, market_id, channel_id,
                cart_id, subject_fingerprint, generation, pricing_revision, supported_currencies,
                effective_from, effective_to, action_invocation_id, actor_principal_id, reason
              ) values (
                ${tenantId}::uuid, ${legalEntityId}::uuid, 'legacy-context', 'legacy-storefront',
                'legacy-market', 'legacy-channel', 'legacy-cart', 'legacy-subject', 1,
                'pricing-currency-support:1', '["CZK"]'::jsonb, ${effectiveFrom}::timestamptz,
                null, ${randomUUID()}::uuid, ${principalId}::uuid, 'Forbidden legacy write.'
              )
            `);
          }),
        ),
      );
      expect(Exit.isFailure(legacyWrite)).toBe(true);

      const [continuityRow] = yield* admin.transaction((transaction) =>
        transaction.execute(
          sql`select
                (select count(*)::integer from pricing.currency_support_roots
                  where tenant_id = ${tenantId}::uuid) as "rootCount",
                (select count(*)::integer from pricing.currency_support_value_revisions
                  where tenant_id = ${tenantId}::uuid) as "valueRevisionCount",
                (select count(*)::integer from pricing.currency_support_schedule_revisions
                  where tenant_id = ${tenantId}::uuid) as "scheduleRevisionCount",
                (select count(*)::integer from pricing.currency_support_recovery_compensation_receipts
                  where tenant_id = ${tenantId}::uuid) as "compensationReceiptCount",
                (select count(*)::integer from pricing.currency_support_revisions
                  where tenant_id = ${tenantId}::uuid) as "legacyRevisionCount",
                pg_catalog.has_table_privilege(
                  'ontos_runtime', 'pricing.currency_support_revisions', 'INSERT'
                ) as "legacyInsertPrivilege"`,
          'objects',
        ),
      );
      const continuity = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          compensationReceiptCount: Schema.Finite,
          legacyInsertPrivilege: Schema.Boolean,
          legacyRevisionCount: Schema.Finite,
          rootCount: Schema.Finite,
          scheduleRevisionCount: Schema.Finite,
          valueRevisionCount: Schema.Finite,
        }),
      )(continuityRow);
      expect(continuity).toEqual({
        compensationReceiptCount: 1,
        legacyInsertPrivilege: false,
        legacyRevisionCount: 0,
        rootCount: 1,
        scheduleRevisionCount: 2,
        valueRevisionCount: 1,
      });
    }),
  ),
);
