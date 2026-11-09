import { randomUUID } from 'node:crypto';

import { NodeCrypto } from '@effect/platform-node';
import { Crypto, Effect, Predicate, Schema } from 'effect';
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
import type { AcceptPaymentObservationPayloadSchema } from '../../shared/actions/accept-payment-observation.ts';
import type { RecordPaymentLocalEvidencePayloadSchema } from '../../shared/actions/record-payment-local-evidence.ts';
import type { PaymentExecutionBinding } from '../../shared/domain/payment-execution-binding.ts';
import { PaymentRefundBasisSchema } from '../../shared/domain/payment-refund-basis.ts';
import type { PaymentSourceBinding } from '../../shared/domain/source-statement.ts';
import { configurePaymentSourceAuthorityAction } from '../../src/actions/configure-payment-source-authority.action.ts';
import { recordPaymentLocalEvidenceAction } from '../../src/actions/record-payment-local-evidence.action.ts';
import { paymentRegistration } from '../../vertical.registration.ts';
import { failureCodeOf, makeTestScope, paymentTestRelations, randomUuid } from './database-fixture.ts';
import { acceptObservation, refundCaseFor } from '../support/refund-action-driver.ts';
import type { RefundCase } from '../support/refund-action-driver.ts';
import { refundRuntimeContextAccess, refundRuntimePermission, seedPayment } from '../support/refund-native-runtime.ts';
import type { RefundNativeRuntime, SeedPaymentOptions } from '../support/refund-native-runtime.ts';
import {
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
 * Regression tests for source qualification (#1150, #1151, #1152): exact duplicate
 * occurrences, source correction targets, issuing authority of a correction and the refund executor route.
 * Driven through the registered Actions.
 */

const czk = (amountMinor: number) => ({ amountMinor, currency: 'CZK' as const });

/** The refusal code of a failed Action, or `unknown` (no hand tag checks). */
const codeOf = <Failure>(failure: Failure) =>
  Predicate.hasProperty(failure, 'code') ? String(failure.code) : 'unknown';

// ---------------------------------------------------------------------------------------------------
// Evidence harness (GoPay / POS / refund statements through the accept and local-evidence Actions).
// ---------------------------------------------------------------------------------------------------

const nativeEvidence = <A, E>(effect: Effect.Effect<A, E, Crypto.Crypto | Scope.Scope>) =>
  Effect.scoped(effect).pipe(Effect.provide(NodeCrypto.layer));

const nativeDatabase = Effect.gen(function* sourceReplayNativeDatabase() {
  const { admin, runtime } = yield* testDatabaseClients;
  const coreAdmin = yield* makeTestDatabaseFromClient(admin, coreRelations);
  const database = yield* makeTestDatabaseFromClient(runtime, coreRelations);
  return { coreAdmin, database, runtimeClient: runtime } satisfies EvidenceNativeDatabase;
});

const makeRuntimes = Effect.fn('SourceReplayRoute.makeRuntimes')(function* makeRuntimes(
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

const scenario = Effect.fn('SourceReplayRoute.scenario')(function* scenario() {
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

type AcceptPayload = Parameters<EvidenceScenario['accept']>[0];

/** One GoPay statement; the scenario names the occurrence, revision, amount and correlation it needs. */
const gopay = (fields: Omit<AcceptPayload, 'factFamily' | 'source'>): AcceptPayload => ({
  factFamily: 'GATEWAY_OUTCOME',
  source: GOPAY_SOURCE,
  ...fields,
});

const configureGopay = (evidence: EvidenceScenario) =>
  evidence.configureSource({
    factFamily: 'GATEWAY_OUTCOME',
    reason: 'GoPay callbacks are the gateway outcome authority',
    refundRoute: false,
    source: GOPAY_SOURCE,
    status: 'ACTIVE',
    submitterPrincipalIds: [evidence.scope.principalId],
  });

/** `OK` when a governed decision succeeded, otherwise its refusal code. */
const reasonOf = <E>(effect: Effect.Effect<unknown, E>) =>
  Effect.match(effect, { onFailure: codeOf, onSuccess: () => 'OK' });

/** `<acceptanceOutcome>/<interpretation>` of an accepted statement, or the refusal code. */
const acceptedAs = <R extends { readonly acceptanceOutcome: string; readonly interpretation: string }, E>(
  effect: Effect.Effect<R, E>,
) =>
  Effect.match(effect, {
    onFailure: codeOf,
    onSuccess: (result) => `${result.acceptanceOutcome}/${result.interpretation}`,
  });

/** The method-neutral GoPay authority row of the binding, bound to the scope principal. */
const neutralGopayAuthority = (evidence: EvidenceScenario) => ({
  factFamily: 'GATEWAY_OUTCOME' as const,
  reason: 'GoPay callbacks are the gateway outcome authority',
  refundRoute: false,
  source: GOPAY_SOURCE,
  status: 'ACTIVE' as const,
  submitterPrincipalIds: [evidence.scope.principalId],
});

/** The method-specific ONLINE_GATEWAY row of the same binding, bound to the same principal. */
const specificGopayAuthority = (evidence: EvidenceScenario) => ({
  ...neutralGopayAuthority(evidence),
  method: 'ONLINE_GATEWAY' as const,
});

/** A full disproof of a receipt: same Payment, same operation, same amount, naming the receipt. */
const disproofOf = (
  setup: { readonly collect: { readonly operationId: string }; readonly payment: { readonly paymentId: string } },
  receiptObservationId: string,
) =>
  gopay({
    amount: czk(100_000),
    correctsObservationId: receiptObservationId,
    factKind: 'SOURCE_CORRECTION',
    operationId: setup.collect.operationId,
    paymentId: setup.payment.paymentId,
    sourceOccurrenceId: `gopay-disproof-${randomUUID()}`,
    sourceRevision: 0,
  });

/** A 100000 CZK ONLINE_GATEWAY Payment whose COLLECT is proven by one accepted GoPay receipt. */
const provenReceipt = Effect.fn('SourceReplayRoute.provenReceipt')(function* provenReceipt(evidence: EvidenceScenario) {
  const payment = yield* evidence.createPayment();
  const collect = yield* evidence.startOperation({
    amountMinor: 100_000,
    operationKey: 'collect-1',
    paymentId: payment.paymentId,
  });
  const receipt = yield* evidence.accept(
    gopay({
      amount: czk(100_000),
      factKind: 'COLLECTION_CONFIRMED',
      operationId: collect.operationId,
      paymentId: payment.paymentId,
      sourceOccurrenceId: `gopay-receipt-${randomUUID()}`,
      sourceRevision: 0,
    }),
  );
  expect(receipt.acceptanceOutcome).toBe('ACCEPTED_OBSERVATION');
  return { collect, payment, receipt };
});

const operationOutcome = (evidence: EvidenceScenario, paymentId: string, operationId: string) =>
  evidence.rows
    .operations(paymentId)
    .pipe(Effect.map((rows) => rows.find((row) => row.operationId === operationId)?.outcome));

// ---------------------------------------------------------------------------------------------------
// Bank-transfer harness (ERP receipts through the refund support driver), copied from the e6 ledger repro.
// ---------------------------------------------------------------------------------------------------

const nativeLedger = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(effect).pipe(Effect.provide(NodeCrypto.layer));

const ledgerRuntime = Effect.gen(function* acquireLedgerNativeRuntime() {
  const { admin, runtime } = yield* testDatabaseClients;
  const database = yield* makeTestDatabaseFromClient(runtime, paymentTestRelations);
  const coreAdmin = yield* makeTestDatabaseFromClient(admin, paymentTestRelations);
  const actionRuntime = makeActionRuntime(
    { executor: database },
    makeActionRepository(yield* Crypto.Crypto),
    refundRuntimePermission,
    testOperationalScopeResolver,
    {
      ...openActionRuntimeOptions,
      accessDecision: makeScriptedBoundAccessGate('allowed').bound,
      contextAccess: refundRuntimeContextAccess,
      ownerAuthorizationOverlay: allowOwnerAuthorizationOverlay,
      ownerRegistration: paymentRegistration,
    },
  );
  return { actionRuntime, admin, coreAdmin, database } satisfies RefundNativeRuntime;
});

/** The ERP bank account that reports receipts of bank-transfer Payments. */
const erpBank = {
  accountRef: 'CZ6508000000192000145399',
  environment: 'production',
  sourceKind: 'BANK_ACCOUNTING',
  sourceSystem: 'erp-helios',
} as const;

const bankTransferPayment: SeedPaymentOptions = {
  amountMinor: 100_000,
  binding: { _tag: 'BANK_ACCOUNTING_RECEIPT' },
  collected: false,
  method: 'BANK_TRANSFER_ADVANCE',
};

/** One bank transaction: the same economic effect whichever occurrence reports it. */
const BANK_TRANSACTION = 'erp-helios:bank-transaction:2026-11-08-17';

interface TwoPayments {
  readonly first: { readonly collectOperationId: string; readonly paymentId: string };
  readonly refundCase: RefundCase;
  readonly second: { readonly collectOperationId: string; readonly paymentId: string };
}

const configureBankSource = Effect.fn('SourceReplayRoute.configureBankSource')(function* configureBankSource(
  refundCase: RefundCase,
) {
  const key = yield* randomUuid;
  yield* refundCase.native.actionRuntime.runAction({
    payload: {
      factFamily: 'BANK_ACCOUNTING_RECEIPT',
      method: 'BANK_TRANSFER_ADVANCE',
      reason: 'The ERP bank account reports bank-transfer receipts',
      refundRoute: false,
      source: erpBank,
      status: 'ACTIVE',
      submitterPrincipalIds: [refundCase.scope.principalId],
    },
    principal: refundCase.principal,
    registration: configurePaymentSourceAuthorityAction,
    transport: { correlationId: 'payment-qualification-ledger', idempotencyKey: key },
  });
});

/** Two pending bank-transfer Payments of one Tenant / Selling Legal Entity and the ERP receipt authority. */
const twoBankTransferPayments = Effect.fn('SourceReplayRoute.twoPayments')(function* twoPayments() {
  const refundCase = yield* refundCaseFor(yield* ledgerRuntime, { ...bankTransferPayment, gatewayRoute: false });
  const second = yield* seedPayment(refundCase.native.database, refundCase.scope, bankTransferPayment);
  yield* configureBankSource(refundCase);
  return { first: refundCase.payment, refundCase, second } satisfies TwoPayments;
});

type AcceptEncoded = typeof AcceptPaymentObservationPayloadSchema.Encoded;

/** The same receipt reported without any Payment or operation correlation: unassigned held debt. */
const unassignedReceiptOf = (sourceOccurrenceId: string): AcceptEncoded => ({
  amount: { amountMinor: 100_000, currency: 'CZK' },
  economicEffectKey: BANK_TRANSACTION,
  factFamily: 'BANK_ACCOUNTING_RECEIPT',
  factKind: 'COLLECTION_CONFIRMED',
  source: erpBank,
  sourceOccurrenceId,
  sourceRevision: 0,
});

// ---------------------------------------------------------------------------------------------------
// Local POS / refund-route harness, copied from the e10 capability-source repro.
// ---------------------------------------------------------------------------------------------------

const posOperator = {
  accountRef: 'pos-drawer-1',
  environment: 'production',
  sourceKind: 'LOCAL_POS_OPERATOR',
  sourceSystem: 'store-pos',
} as const satisfies PaymentSourceBinding;

const pickupBinding: PaymentExecutionBinding = {
  _tag: 'PICKUP_CAPABILITY',
  capabilityEvidenceRef: 'pickup-capability-evidence-1',
  pickupCapabilityRef: 'pickup-prague-1',
};

const bankRefundRoute = {
  accountRef: 'refund-account-a',
  environment: 'production',
  sourceKind: 'BANK_ACCOUNTING',
  sourceSystem: 'erp-primary',
} as const satisfies PaymentSourceBinding;

const itemsBasis = (itemRef: string, amountMinor: number) =>
  Schema.decodeUnknownSync(PaymentRefundBasisSchema)({
    _tag: 'REFUNDABLE_ITEMS',
    items: [{ amountMinor, currency: 'CZK', itemRef, sourceEvidenceRef: `aftercare-${itemRef}` }],
  });

type LocalPayload = typeof RecordPaymentLocalEvidencePayloadSchema.Encoded;

/** One POS/operator statement through the LOCAL_EVIDENCE Action (record-payment-local-evidence). */
const recordLocal = (evidence: EvidenceScenario, payload: LocalPayload) =>
  evidence.r1.actions.runAction({
    payload,
    principal: principalOf(evidence.scope),
    registration: recordPaymentLocalEvidenceAction,
    transport: { correlationId: 'payment-qualification-local', idempotencyKey: randomUUID() },
  });

const posStatement = (
  paymentId: string,
  overrides: Partial<LocalPayload> & Pick<LocalPayload, 'factFamily' | 'factKind'>,
): LocalPayload => ({
  amount: czk(100_000),
  evidenceRef: `pos-evidence-${randomUUID()}`,
  paymentId,
  pickupCapabilityRef: 'pickup-prague-1',
  reason: 'Customer paid at the pickup counter',
  source: posOperator,
  sourceOccurrenceId: `pos-${randomUUID()}`,
  sourceRevision: 1,
  ...overrides,
});

const configurePos = (evidence: EvidenceScenario, factFamily: 'LOCAL_POS_COLLECTION' | 'REFUND_EXECUTION') =>
  evidence.configureSource({
    factFamily,
    method: 'PAY_ON_PICKUP_OR_ON_SITE',
    reason: `Store POS ${factFamily}`,
    refundRoute: factFamily === 'REFUND_EXECUTION',
    source: posOperator,
    status: 'ACTIVE',
    submitterPrincipalIds: [evidence.scope.principalId],
  });

const configureBankRefundRoute = (evidence: EvidenceScenario) =>
  evidence.configureSource({
    factFamily: 'REFUND_EXECUTION',
    method: 'PAY_ON_PICKUP_OR_ON_SITE',
    reason: 'Configured bank refund route for pickup',
    refundRoute: true,
    source: bankRefundRoute,
    status: 'ACTIVE',
    submitterPrincipalIds: [evidence.scope.principalId],
  });

const outcomeOf = (evidence: EvidenceScenario, paymentId: string, operationId: string) =>
  evidence
    .inTransaction((aggregate) => aggregate.loadAggregate(paymentId))
    .pipe(
      Effect.map(({ operations }) => operations.find((operation) => operation.operationId === operationId)?.outcome),
    );

/** A pickup Payment whose 100 000 CZK collection is confirmed by a capability-correlated POS receipt. */
const confirmedPickupCollect = Effect.fn('SourceReplayRoute.confirmedPickupCollect')(function* confirmedPickupCollect(
  evidence: EvidenceScenario,
) {
  const payment = yield* evidence.createPayment(100_000, pickupBinding, 'PAY_ON_PICKUP_OR_ON_SITE');
  yield* configurePos(evidence, 'LOCAL_POS_COLLECTION');
  const collect = yield* evidence.startOperation({
    amountMinor: 100_000,
    binding: pickupBinding,
    operationKey: 'collect-1',
    paymentId: payment.paymentId,
  });
  const receipt = yield* recordLocal(
    evidence,
    posStatement(payment.paymentId, { factFamily: 'LOCAL_POS_COLLECTION', factKind: 'COLLECTION_CONFIRMED' }),
  );
  expect(receipt.outcomeChange).toEqual({
    from: 'PENDING',
    operationId: collect.operationId,
    to: 'EFFECT_CONFIRMED',
  });
  return { collect, payment, receipt };
});

/** A pickup REFUND of the confirmed collection, requested through the given configured refund route. */
const requestPickupRefund = (evidence: EvidenceScenario, paymentId: string, collectId: string, routeId: string) =>
  Effect.gen(function* requestPickupRefundThroughRoute() {
    return yield* evidence.startOperation({
      amountMinor: 100_000,
      binding: pickupBinding,
      kind: 'REFUND',
      operationKey: 'refund-1',
      paymentId,
      refundBasis: itemsBasis('item-1', 100_000),
      refundExecutionRoute: yield* evidence.refundRouteOf(routeId),
      targetOperationId: collectId,
    });
  });

// ---------------------------------------------------------------------------------------------------
// Regression tests.
// ---------------------------------------------------------------------------------------------------

it.live(
  '#1151 an unassigned occurrence replayed with a Payment is not silently treated as a duplicate (bank receipt)',
  () =>
    nativeLedger(
      Effect.gen(function* replayCorrelatesUnassigned() {
        const { refundCase, second } = yield* twoBankTransferPayments();
        const unassigned = yield* acceptObservation(refundCase, unassignedReceiptOf('bank-statement-line-17'));
        expect(unassigned.acceptanceOutcome).toBe('HELD_UNRESOLVED');
        // Same occurrence and revision, now naming the second Payment: changed content, never a DUPLICATE.
        const refusal = yield* failureCodeOf(
          acceptObservation(refundCase, {
            ...unassignedReceiptOf('bank-statement-line-17'),
            paymentId: second.paymentId,
          }),
        );
        expect(refusal).toBe('payment_source_occurrence_conflict');
      }),
    ),
);

it.live('#1151 an unassigned pending occurrence replayed naming the same Payment is not an exact duplicate', () =>
  nativeEvidence(
    Effect.gen(function* unassignedReplayWithPayment() {
      const evidence = yield* scenario();
      const payment = yield* evidence.createPayment();
      yield* evidence.startOperation({ amountMinor: 100_000, operationKey: 'collect-1', paymentId: payment.paymentId });
      yield* configureGopay(evidence);
      const orphan = {
        amount: czk(100_000),
        economicEffectKey: 'gopay:payment:1',
        factKind: 'COLLECTION_CONFIRMED',
        sourceOccurrenceId: `gopay-orphan-${randomUUID()}`,
        sourceRevision: 1,
      } as const;
      expect(yield* acceptedAs(evidence.accept(gopay(orphan)))).toBe('HELD_UNRESOLVED/NOT_INTERPRETED');
      // Same occurrence and revision, now correlated to the Payment: the correlation must not be discarded.
      expect(yield* acceptedAs(evidence.accept(gopay({ ...orphan, paymentId: payment.paymentId })))).toBe(
        'payment_source_occurrence_conflict',
      );
      expect(yield* evidence.coverage(payment.paymentId)).toBe('NotCollected');
    }),
  ),
);

it.live('#1151 a pending occurrence replayed with a claimed amount is not an exact duplicate', () =>
  nativeEvidence(
    Effect.gen(function* pendingReplayWithAmount() {
      const evidence = yield* scenario();
      const payment = yield* evidence.createPayment();
      yield* evidence.startOperation({ amountMinor: 100_000, operationKey: 'collect-1', paymentId: payment.paymentId });
      yield* configureGopay(evidence);
      const pending = {
        factKind: 'COLLECTION_PENDING',
        paymentId: payment.paymentId,
        sourceOccurrenceId: `gopay-pending-${randomUUID()}`,
        sourceRevision: 1,
      } as const;
      expect(yield* acceptedAs(evidence.accept(gopay(pending)))).toBe('ACCEPTED_OBSERVATION/NO_CHANGE');
      // Same occurrence and revision, now claiming 100000 CZK: changed content, not an exact redelivery.
      expect(yield* acceptedAs(evidence.accept(gopay({ ...pending, amount: czk(100_000) })))).toBe(
        'payment_source_occurrence_conflict',
      );
    }),
  ),
);

it.live('#1151 an exact redelivery of an occurrence without amount still replays as a duplicate', () =>
  nativeEvidence(
    Effect.gen(function* exactPendingRedelivery() {
      const evidence = yield* scenario();
      const payment = yield* evidence.createPayment();
      yield* evidence.startOperation({ amountMinor: 100_000, operationKey: 'collect-1', paymentId: payment.paymentId });
      yield* configureGopay(evidence);
      const pending = {
        factKind: 'COLLECTION_PENDING',
        paymentId: payment.paymentId,
        sourceOccurrenceId: `gopay-pending-same-${randomUUID()}`,
        sourceRevision: 1,
      } as const;
      expect(yield* acceptedAs(evidence.accept(gopay(pending)))).toBe('ACCEPTED_OBSERVATION/NO_CHANGE');
      expect(yield* acceptedAs(evidence.accept(gopay(pending)))).toBe('DUPLICATE/NOT_INTERPRETED');
    }),
  ),
);

it.live('#1152 a correction naming an accepted receipt is correlated to its Payment and never held unassigned', () =>
  nativeEvidence(
    Effect.gen(function* unassignedCorrection() {
      const evidence = yield* scenario();
      yield* configureGopay(evidence);
      const payment = yield* evidence.createPayment();
      const collect = yield* evidence.startOperation({
        amountMinor: 100_000,
        operationKey: 'collect-1',
        paymentId: payment.paymentId,
      });
      const accepted = yield* evidence.accept(
        gopay({
          amount: czk(100_000),
          factKind: 'COLLECTION_CONFIRMED',
          operationId: collect.operationId,
          paymentId: payment.paymentId,
          sourceOccurrenceId: `gopay-receipt-${randomUUID()}`,
          sourceRevision: 0,
        }),
      );
      expect(accepted).toMatchObject({ acceptanceOutcome: 'ACCEPTED_OBSERVATION' });
      // The correction names no Payment: it is resolved through the receipt it corrects.
      const correction = yield* evidence.accept(
        gopay({
          amount: czk(100_000),
          correctsObservationId: accepted.observationId,
          factKind: 'SOURCE_CORRECTION',
          sourceOccurrenceId: `gopay-correction-${randomUUID()}`,
          sourceRevision: 0,
        }),
      );
      expect(correction).toMatchObject({
        acceptanceOutcome: 'ACCEPTED_OBSERVATION',
        interpretation: 'CORRECTION',
        paymentId: payment.paymentId,
      });
      expect(yield* operationOutcome(evidence, payment.paymentId, collect.operationId)).toBe('CONFLICT');
      // The case is an operation case, so the governed conflict decision is applicable (no dead end). Closing
      // then waits for the operation to reach a definitive outcome, which only a qualified statement can settle.
      const caseId = correction.reconciliationCaseId ?? '';
      expect(
        yield* reasonOf(
          evidence.decide({
            caseId,
            decision: { _tag: 'CLASSIFY_CONFLICT' },
            reason: 'The disproof is the governed resolution of the receipt conflict',
          }),
        ),
      ).toBe('OK');
      expect(
        yield* reasonOf(
          evidence.decide({
            caseId,
            decision: { _tag: 'CLOSE_CASE', evidenceRef: 'gopay-correction-resolution' },
            reason: 'Operator resolves the correction',
          }),
        ),
      ).toBe('payment_reconciliation_obligation_unresolved');
    }),
  ),
);

it.live('#1152 a bound ACTIVE neutral authority corrects its own receipt after a method-specific row is added', () =>
  nativeEvidence(
    Effect.gen(function* neutralThenSpecificCorrection() {
      const evidence = yield* scenario();
      yield* evidence.configureSource(neutralGopayAuthority(evidence));
      const setup = yield* provenReceipt(evidence);
      // The method-specific row for the same binding; the same principal stays bound and ACTIVE on both rows.
      yield* evidence.configureSource(specificGopayAuthority(evidence));
      expect(yield* acceptedAs(evidence.accept(disproofOf(setup, setup.receipt.observationId)))).toBe(
        'ACCEPTED_OBSERVATION/CORRECTION',
      );
    }),
  ),
);

it.live('#1152 a method-specific receipt authority still corrects its receipt after a neutral row is added', () =>
  nativeEvidence(
    Effect.gen(function* specificThenNeutralCorrection() {
      const evidence = yield* scenario();
      yield* evidence.configureSource(specificGopayAuthority(evidence));
      const setup = yield* provenReceipt(evidence);
      yield* evidence.configureSource(neutralGopayAuthority(evidence));
      expect(yield* acceptedAs(evidence.accept(disproofOf(setup, setup.receipt.observationId)))).toBe(
        'ACCEPTED_OBSERVATION/CORRECTION',
      );
    }),
  ),
);

it.live('#1150/#1152 a POS refund statement never confirms a REFUND requested through the bank route', () =>
  nativeEvidence(
    Effect.gen(function* posStatementAgainstBankRoute() {
      const evidence = yield* scenario();
      const { collect, payment } = yield* confirmedPickupCollect(evidence);
      const bank = yield* configureBankRefundRoute(evidence);
      const refund = yield* requestPickupRefund(
        evidence,
        payment.paymentId,
        collect.operationId,
        bank.sourceAuthorityId,
      );
      yield* configurePos(evidence, 'REFUND_EXECUTION');
      const refusal = yield* failureCodeOf(
        recordLocal(
          evidence,
          posStatement(payment.paymentId, {
            evidenceRef: 'pos-refund-1',
            factFamily: 'REFUND_EXECUTION',
            factKind: 'REFUND_CONFIRMED',
            operationId: refund.operationId,
            sourceOccurrenceId: 'pos-refund-1',
          }),
        ),
      );
      expect(refusal).toBe('payment_source_authority_forbidden');
      expect(yield* outcomeOf(evidence, payment.paymentId, refund.operationId)).toBe('PENDING');
    }),
  ),
);

it.live('#1150/#1152 a bank refund statement never confirms a REFUND requested through the POS route', () =>
  nativeEvidence(
    Effect.gen(function* bankStatementAgainstPosRoute() {
      const evidence = yield* scenario();
      const { collect, payment } = yield* confirmedPickupCollect(evidence);
      const pos = yield* configurePos(evidence, 'REFUND_EXECUTION');
      const refund = yield* requestPickupRefund(
        evidence,
        payment.paymentId,
        collect.operationId,
        pos.sourceAuthorityId,
      );
      yield* configureBankRefundRoute(evidence);
      const refusal = yield* failureCodeOf(
        evidence.accept({
          amount: czk(100_000),
          factFamily: 'REFUND_EXECUTION',
          factKind: 'REFUND_CONFIRMED',
          operationId: refund.operationId,
          paymentId: payment.paymentId,
          source: bankRefundRoute,
          sourceOccurrenceId: 'bank-refund-line-1',
          sourceRevision: 1,
        }),
      );
      expect(refusal).toBe('payment_source_authority_forbidden');
      expect(yield* outcomeOf(evidence, payment.paymentId, refund.operationId)).toBe('PENDING');
    }),
  ),
);
