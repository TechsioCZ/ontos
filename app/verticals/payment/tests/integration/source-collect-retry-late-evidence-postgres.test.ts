import { randomUUID } from 'node:crypto';

import { NodeCrypto } from '@effect/platform-node';
import { Crypto, Effect } from 'effect';
import type { Scope } from 'effect';
import { expect, it } from 'effect-rstest';

import { allowOwnerAuthorizationOverlay } from '../../../../packages/core-runtime/src/access/enforcement/owner-overlay.ts';
import { makeActionRepository } from '../../../../packages/core-runtime/src/actions/repository.ts';
import { makeActionRuntime } from '../../../../packages/core-runtime/src/actions/runtime.ts';
import { coreRelations } from '../../../../packages/core-runtime/src/db/schema.ts';
import { makeReadRuntime } from '../../../../packages/core-runtime/src/reads/runtime.ts';
import { makeScriptedBoundAccessGate } from '../../../../packages/core-runtime/src/testing/access-gate.ts';
import { testOperationalScopeResolver } from '../../../../packages/core-runtime/tests/fixtures/operational-scope.ts';
import { openActionRuntimeOptions } from '../../../../packages/core-runtime/tests/support/action-runtime-options.ts';
import {
  makeTestDatabaseFromClient,
  testDatabaseClients,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import { openModuleEntrypointGateway } from '../../../../packages/core-runtime/tests/support/open-module-entrypoint-gateway.ts';
import type { PaymentObservationFactKind } from '../../shared/domain/payment-vocabulary.ts';
import { paymentRegistration } from '../../vertical.registration.ts';
import { makeTestScope } from './database-fixture.ts';
import {
  COMPOSITION_R1,
  COMPOSITION_R2,
  evidenceAllowedPermission,
  evidenceContextAccess,
  evidenceScenarioOf,
  seedCoreScope,
} from './evidence-native-support.ts';
import type { EvidenceNativeDatabase, EvidenceScenario } from './evidence-native-support.ts';

/**
 * #1151/#1152 on native PostgreSQL through the registered `accept-payment-observation` Action: after a
 * permitted collection retry (COLLECT A NOT_EFFECTED_CONFIRMED, COLLECT B live or proven), late
 * contradictory evidence about A is kept as explicit reconciliation debt. The one-collection-lineage
 * rule forbids reopening A while B stands, so A keeps its outcome, the observation and its
 * OPERATION_CONFLICT case are committed, and Current coverage is held.
 */

const native = <A, E>(effect: Effect.Effect<A, E, Crypto.Crypto | Scope.Scope>) =>
  Effect.scoped(effect).pipe(Effect.provide(NodeCrypto.layer));

const nativeDatabase = Effect.gen(function* lateEvidenceNativeDatabase() {
  const { admin, runtime } = yield* testDatabaseClients;
  const coreAdmin = yield* makeTestDatabaseFromClient(admin, coreRelations);
  const database = yield* makeTestDatabaseFromClient(runtime, coreRelations);
  return { coreAdmin, database, runtimeClient: runtime } satisfies EvidenceNativeDatabase;
});

/** The real Core Action and Read runtimes under one approved Composition revision. */
const makeRuntimes = Effect.fn('LateCollectEvidence.makeRuntimes')(function* makeRuntimes(
  database: EvidenceNativeDatabase,
  compositionRevision: string,
) {
  const crypto = yield* Crypto.Crypto;
  const accessDecision = makeScriptedBoundAccessGate('allowed').bound;
  const actions = makeActionRuntime(
    { executor: database.database },
    makeActionRepository(crypto),
    evidenceAllowedPermission,
    testOperationalScopeResolver,
    {
      ...openActionRuntimeOptions,
      accessDecision,
      contextAccess: evidenceContextAccess,
      ownerAuthorizationOverlay: allowOwnerAuthorizationOverlay,
      ownerRegistration: paymentRegistration,
      resolveCompositionRevision: () => Effect.succeed(compositionRevision),
    },
  );
  const reads = makeReadRuntime(
    { executor: database.database },
    openModuleEntrypointGateway,
    testOperationalScopeResolver,
    evidenceContextAccess,
    {
      accessDecision,
      ownerAuthorizationOverlay: allowOwnerAuthorizationOverlay,
      ownerRegistration: paymentRegistration,
    },
  );
  return { actions, reads };
});

const scenario = Effect.fn('LateCollectEvidence.scenario')(function* scenario() {
  const database = yield* nativeDatabase;
  const scope = yield* makeTestScope;
  yield* seedCoreScope(database, scope);
  const r1 = yield* makeRuntimes(database, COMPOSITION_R1);
  const r2 = yield* makeRuntimes(database, COMPOSITION_R2);
  return evidenceScenarioOf({ native: database, r1, r2, scope });
});

const GOPAY_SOURCE = {
  accountRef: 'gopay-account-1',
  environment: 'production',
  sourceKind: 'PAYMENT_GATEWAY',
  sourceSystem: 'GOPAY',
} as const;

const czk = (amountMinor: number) => ({ amountMinor, currency: 'CZK' as const });

/** One GoPay callback carrying exactly the statement members the scenario names. */
const gopayStatement = (fields: {
  readonly amount?: { readonly amountMinor: number; readonly currency: 'CZK' };
  readonly correctsObservationId?: string;
  readonly economicEffectKey?: string;
  readonly factKind: PaymentObservationFactKind;
  readonly operationId: string;
  readonly paymentId: string;
}) => ({
  factFamily: 'GATEWAY_OUTCOME' as const,
  source: GOPAY_SOURCE,
  sourceOccurrenceId: `gopay-callback-${randomUUID()}`,
  sourceRevision: 0,
  ...fields,
});

/**
 * GoPay is the configured gateway authority; COLLECT A is proven not effected by a qualified callback
 * and the permitted retry COLLECT B is admitted. Returns the Payment, both operations and A's evidence.
 */
const retriedCollection = Effect.fn('LateCollectEvidence.retriedCollection')(function* retriedCollection(
  evidence: EvidenceScenario,
) {
  yield* evidence.configureSource({
    factFamily: 'GATEWAY_OUTCOME',
    reason: 'GoPay callbacks are the gateway outcome authority',
    refundRoute: false,
    source: GOPAY_SOURCE,
    status: 'ACTIVE',
    submitterPrincipalIds: [evidence.scope.principalId],
  });
  const payment = yield* evidence.createPayment();
  const first = yield* evidence.startOperation({
    amountMinor: 100_000,
    operationKey: 'collect-attempt-1',
    paymentId: payment.paymentId,
  });
  const notEffected = yield* evidence.accept(
    gopayStatement({
      economicEffectKey: 'gopay:payment:attempt-1',
      factKind: 'COLLECTION_NOT_EFFECTED',
      operationId: first.operationId,
      paymentId: payment.paymentId,
    }),
  );
  expect(notEffected).toMatchObject({ acceptanceOutcome: 'ACCEPTED_OBSERVATION', interpretation: 'TRANSITION' });
  const retry = yield* evidence.startOperation({
    amountMinor: 100_000,
    operationKey: 'collect-attempt-2',
    paymentId: payment.paymentId,
  });
  return { first, notEffected, payment, retry };
});

const outcomesOf = (evidence: EvidenceScenario, paymentId: string) =>
  evidence.rows
    .operations(paymentId)
    .pipe(Effect.map((operations) => operations.map((operation) => [operation.operationKey, operation.outcome])));

/** The committed observation and the open OPERATION_CONFLICT case it carries. */
const expectConflictDebt = Effect.fn('LateCollectEvidence.expectConflictDebt')(function* expectConflictDebt(
  evidence: EvidenceScenario,
  paymentId: string,
  operationId: string,
  accepted: { readonly observationId: string; readonly reconciliationCaseId?: string | undefined },
) {
  const [observation] = yield* evidence.rows.observation(accepted.observationId);
  expect(observation).toMatchObject({ acceptanceOutcome: 'CONFLICT', operationId, paymentId });
  const cases = yield* evidence.rows.cases(paymentId);
  expect(
    cases
      .filter((reconciliationCase) => reconciliationCase.observationId === accepted.observationId)
      .map(({ caseId, caseKind, operationId: caseOperationId, status }) => ({
        caseId,
        caseKind,
        operationId: caseOperationId,
        status,
      })),
  ).toEqual([{ caseId: accepted.reconciliationCaseId, caseKind: 'OPERATION_CONFLICT', operationId, status: 'OPEN' }]);
  expect(yield* evidence.coverage(paymentId)).toBe('Held UNRESOLVED_EVIDENCE');
});

it.live('#1151 Late collection success for a not-effected attempt after a live retry stays held conflict debt', () =>
  native(
    Effect.gen(function* lateSuccessAfterLiveRetry() {
      const evidence = yield* scenario();
      const { first, payment } = yield* retriedCollection(evidence);

      // GoPay later reports that attempt 1 did collect after all, while attempt 2 is still pending.
      const late = yield* evidence.accept(
        gopayStatement({
          amount: czk(100_000),
          economicEffectKey: 'gopay:payment:attempt-1',
          factKind: 'COLLECTION_CONFIRMED',
          operationId: first.operationId,
          paymentId: payment.paymentId,
        }),
      );
      expect(late).toMatchObject({ acceptanceOutcome: 'CONFLICT', interpretation: 'CONFLICT' });
      expect(late.outcomeChange).toBeUndefined();
      expect(yield* outcomesOf(evidence, payment.paymentId)).toEqual([
        ['collect-attempt-1', 'NOT_EFFECTED_CONFIRMED'],
        ['collect-attempt-2', 'PENDING'],
      ]);
      yield* expectConflictDebt(evidence, payment.paymentId, first.operationId, late);
    }),
  ),
);

it.live('#1151 A correction disproving the not-effected attempt after a proven retry stays held conflict debt', () =>
  native(
    Effect.gen(function* correctionAfterProvenRetry() {
      const evidence = yield* scenario();
      const { first, notEffected, payment, retry } = yield* retriedCollection(evidence);
      const proven = yield* evidence.accept(
        gopayStatement({
          amount: czk(100_000),
          economicEffectKey: 'gopay:payment:attempt-2',
          factKind: 'COLLECTION_CONFIRMED',
          operationId: retry.operationId,
          paymentId: payment.paymentId,
        }),
      );
      expect(proven).toMatchObject({ acceptanceOutcome: 'ACCEPTED_OBSERVATION', interpretation: 'TRANSITION' });

      // GoPay withdraws its "attempt 1 did not collect" statement after attempt 2 already collected.
      const correction = yield* evidence.accept(
        gopayStatement({
          correctsObservationId: notEffected.observationId,
          economicEffectKey: 'gopay:correction:attempt-1',
          factKind: 'SOURCE_CORRECTION',
          operationId: first.operationId,
          paymentId: payment.paymentId,
        }),
      );
      expect(correction).toMatchObject({ acceptanceOutcome: 'CONFLICT', interpretation: 'CONFLICT' });
      expect(correction.outcomeChange).toBeUndefined();
      expect(yield* outcomesOf(evidence, payment.paymentId)).toEqual([
        ['collect-attempt-1', 'NOT_EFFECTED_CONFIRMED'],
        ['collect-attempt-2', 'EFFECT_CONFIRMED'],
      ]);
      yield* expectConflictDebt(evidence, payment.paymentId, first.operationId, correction);
    }),
  ),
);
