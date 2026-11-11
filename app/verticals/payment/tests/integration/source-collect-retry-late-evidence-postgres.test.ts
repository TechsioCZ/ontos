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
import type { PaymentBankAccountingReceiptBinding } from '../../shared/domain/payment-execution-binding.ts';
import type { PaymentObservationFactKind } from '../../shared/domain/payment-vocabulary.ts';
import { paymentUnavailableOwnerPortsLive } from '../../api/payment-production-layers.ts';
import { startPaymentCollectionAction } from '../../src/actions/start-payment-collection.action.ts';
import { paymentRegistration } from '../../vertical.registration.ts';
import { makeTestScope } from './database-fixture.ts';
import {
  BANK_BINDING,
  COMPOSITION_R1,
  COMPOSITION_R2,
  evidenceAllowedPermission,
  evidenceContextAccess,
  evidenceScenarioOf,
  principalOf,
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
  readonly operationId?: string;
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

      const ambiguous = yield* evidence.accept(
        gopayStatement({
          amount: czk(100_000),
          economicEffectKey: 'gopay:payment:attempt-1',
          factKind: 'COLLECTION_CONFIRMED',
          paymentId: payment.paymentId,
        }),
      );
      expect(ambiguous).toMatchObject({ acceptanceOutcome: 'HELD_UNRESOLVED', interpretation: 'HOLD' });
      expect(ambiguous.operationId).toBeUndefined();
      expect(ambiguous.reconciliationCaseId).toBeDefined();
      expect(ambiguous.outcomeChange).toBeUndefined();

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

it.live('#1152 bank receipt proves its original source but cannot select between two collection attempts', () =>
  native(
    Effect.gen(function* bankReceiptAcrossRetries() {
      const evidence = yield* scenario();
      const source = {
        accountRef: 'account-original',
        environment: 'production',
        sourceKind: 'BANK_ACCOUNTING',
        sourceSystem: 'bank-erp',
      } as const;
      const method = 'BANK_TRANSFER_ADVANCE';
      const factFamily = 'BANK_ACCOUNTING_RECEIPT';
      const authority = yield* evidence.configureSource({
        factFamily,
        method,
        reason: 'Original receipt authority',
        refundRoute: false,
        source,
        status: 'ACTIVE',
        submitterPrincipalIds: [evidence.scope.principalId],
      });
      const payment = yield* evidence.createPayment(100_000, BANK_BINDING, method);
      const binding: PaymentBankAccountingReceiptBinding = {
        _tag: 'BANK_ACCOUNTING_RECEIPT',
        receiptAuthority: {
          accountRef: source.accountRef,
          environment: source.environment,
          sourceAuthorityId: authority.sourceAuthorityId,
          sourceSystem: source.sourceSystem,
        },
      };
      const start = (operationKey: string) =>
        evidence.startOperation({ amountMinor: 100_000, binding, operationKey, paymentId: payment.paymentId });
      const first = yield* start('collect-attempt-1');
      yield* evidence.settle(payment.paymentId, first.operationId, 1, 'NOT_EFFECTED_CONFIRMED');
      const retry = yield* start('collect-attempt-2');
      const receipt = {
        amount: czk(100_000),
        economicEffectKey: 'bank-receipt-original',
        factFamily,
        factKind: 'COLLECTION_CONFIRMED',
        paymentId: payment.paymentId,
        source,
        sourceOccurrenceId: 'receipt-without-attempt',
        sourceRevision: 1,
      } as const;

      const held = yield* evidence.accept(receipt);
      expect(held).toMatchObject({
        acceptanceOutcome: 'HELD_UNRESOLVED',
        interpretation: 'HOLD',
        sourceAuthorityId: authority.sourceAuthorityId,
      });
      expect(held.operationId).toBeUndefined();
      expect(held.reconciliationCaseId).toBeDefined();
      expect(yield* outcomesOf(evidence, payment.paymentId)).toEqual([
        ['collect-attempt-1', 'NOT_EFFECTED_CONFIRMED'],
        ['collect-attempt-2', 'PENDING'],
      ]);

      const exact = yield* evidence.accept({
        ...receipt,
        operationId: retry.operationId,
        sourceOccurrenceId: 'receipt-with-exact-attempt',
      });
      expect(exact).toMatchObject({
        acceptanceOutcome: 'ACCEPTED_OBSERVATION',
        operationId: retry.operationId,
        outcomeChange: { to: 'EFFECT_CONFIRMED' },
      });
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

it.live('#1151 Open conflict debt blocks a further collection even when every COLLECT reads not effected', () =>
  native(
    Effect.gen(function* collectionBlockedByDebt() {
      const database = yield* nativeDatabase;
      const scope = yield* makeTestScope;
      yield* seedCoreScope(database, scope);
      const r1 = yield* makeRuntimes(database, COMPOSITION_R1);
      const r2 = yield* makeRuntimes(database, COMPOSITION_R2);
      const evidence = evidenceScenarioOf({ native: database, r1, r2, scope });
      const { first, payment, retry } = yield* retriedCollection(evidence);

      // Late success for attempt 1 is kept as conflict debt; attempt 2 is then proven not effected.
      const late = yield* evidence.accept(
        gopayStatement({
          amount: czk(100_000),
          economicEffectKey: 'gopay:payment:attempt-1',
          factKind: 'COLLECTION_CONFIRMED',
          operationId: first.operationId,
          paymentId: payment.paymentId,
        }),
      );
      expect(late).toMatchObject({ acceptanceOutcome: 'CONFLICT' });
      yield* evidence.accept(
        gopayStatement({
          economicEffectKey: 'gopay:payment:attempt-2',
          factKind: 'COLLECTION_NOT_EFFECTED',
          operationId: retry.operationId,
          paymentId: payment.paymentId,
        }),
      );
      expect(yield* outcomesOf(evidence, payment.paymentId)).toEqual([
        ['collect-attempt-1', 'NOT_EFFECTED_CONFIRMED'],
        ['collect-attempt-2', 'NOT_EFFECTED_CONFIRMED'],
      ]);

      // The unresolved evidence says attempt 1 may already have collected: no third COLLECT is admitted.
      const refusal = yield* Effect.flip(
        r1.actions
          .runAction({
            payload: {
              amount: czk(100_000),
              method: payment.method,
              operationKey: 'collect-attempt-3',
              paymentId: payment.paymentId,
            },
            principal: principalOf(scope),
            registration: startPaymentCollectionAction,
            transport: { correlationId: 'payment-collect-blocked-by-debt', idempotencyKey: randomUUID() },
          })
          .pipe(Effect.provide(paymentUnavailableOwnerPortsLive)),
      );
      expect(refusal).toMatchObject({ code: 'payment_held_for_reconciliation' });
      expect((yield* outcomesOf(evidence, payment.paymentId)).map(([operationKey]) => operationKey)).toEqual([
        'collect-attempt-1',
        'collect-attempt-2',
      ]);
    }),
  ),
);
