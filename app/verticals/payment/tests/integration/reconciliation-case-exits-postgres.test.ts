import { defineDatabaseIdentityEnrollment } from '@app/core-runtime';
import { randomUUID } from 'node:crypto';

import { NodeCrypto } from '@effect/platform-node';
import { Crypto, Effect, Option, Predicate, Schema } from 'effect';
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
import { recordPaymentLocalEvidenceAction } from '../../src/actions/record-payment-local-evidence.action.ts';
import { paymentRegistration } from '../../vertical.registration.ts';
import { acceptObservation, decideReconciliation, refundCaseFor } from '../support/refund-action-driver.ts';
import type { RefundCase } from '../support/refund-action-driver.ts';
import { refundRuntimeContextAccess, refundRuntimePermission, seedPayment } from '../support/refund-native-runtime.ts';
import type { RefundNativeRuntime, SeedPaymentOptions } from '../support/refund-native-runtime.ts';
import { failureCodeOf, makeTestScope, paymentTestRelations } from './database-fixture.ts';
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
 * #1150/#1151/#1152 reconciliation regressions: repeated disproof of an attached
 * statement, unassigned held copies of an already counted economic effect, a POS refund attached to a
 * bank-routed REFUND.
 */

const native = <A, E>(effect: Effect.Effect<A, E, Crypto.Crypto | Scope.Scope>) =>
  Effect.scoped(effect).pipe(Effect.provide(NodeCrypto.layer));

const nativeDatabase = Effect.gen(function* caseExitsNativeDatabase() {
  const { admin, runtime } = yield* testDatabaseClients;
  const coreAdmin = yield* makeTestDatabaseFromClient(admin, coreRelations);
  const database = yield* makeTestDatabaseFromClient(runtime, coreRelations);
  return { coreAdmin, database, runtimeClient: runtime } satisfies EvidenceNativeDatabase;
});

const makeEvidenceRuntimes = Effect.fn('ReconciliationCaseExits.makeRuntimes')(function* makeEvidenceRuntimes(
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
      databaseIdentities: defineDatabaseIdentityEnrollment([]),
      ownerAuthorizationOverlay: allowOwnerAuthorizationOverlay,
      ownerRegistration: paymentRegistration,
    },
  );
  return { actions, reads };
});

const scenario = Effect.fn('ReconciliationCaseExits.scenario')(function* scenario() {
  const database = yield* nativeDatabase;
  const scope = yield* makeTestScope;
  yield* seedCoreScope(database, scope);
  const r1 = yield* makeEvidenceRuntimes(database, COMPOSITION_R1);
  const r2 = yield* makeEvidenceRuntimes(database, COMPOSITION_R2);
  return evidenceScenarioOf({ native: database, r1, r2, scope });
});

const GOPAY_SOURCE = {
  accountRef: 'gopay-account-1',
  environment: 'production',
  sourceKind: 'PAYMENT_GATEWAY',
  sourceSystem: 'GOPAY',
} as const;

const configureGopay = (evidence: EvidenceScenario) =>
  evidence.configureSource({
    factFamily: 'GATEWAY_OUTCOME',
    reason: 'GoPay callbacks are the gateway outcome authority',
    refundRoute: false,
    source: GOPAY_SOURCE,
    status: 'ACTIVE',
    submitterPrincipalIds: [evidence.scope.principalId],
  });

const gopayStatement = <
  Fields extends {
    readonly amount?: { readonly amountMinor: number; readonly currency: 'CZK' };
    readonly correctsObservationId?: string;
    readonly economicEffectKey?: string;
    readonly factKind: 'COLLECTION_CONFIRMED' | 'SOURCE_CORRECTION';
    readonly operationId?: string;
    readonly paymentId?: string;
  },
>(
  fields: Fields,
) => ({
  factFamily: 'GATEWAY_OUTCOME' as const,
  source: GOPAY_SOURCE,
  sourceOccurrenceId: `gopay-callback-${randomUUID()}`,
  sourceRevision: 0,
  ...fields,
});

const czk = (amountMinor: number) => ({ amountMinor, currency: 'CZK' as const });

/** The held statement and the case it opened; the case is what governance decides on. */
interface HeldStatement {
  readonly observationId: string;
  readonly reconciliationCaseId?: string | undefined;
}

/**
 * A 1000 CZK gateway COLLECT driven into CONFLICT first, so the only collection statement is held
 * (the template's route to a held collection statement), with its OPERATION_CONFLICT case open.
 */
const heldCollectionInConflict = Effect.fn('ReconciliationCaseExits.heldCollectionInConflict')(
  function* heldCollectionInConflict(evidence: EvidenceScenario) {
    const payment = yield* evidence.createPayment();
    const collect = yield* evidence.startOperation({
      amountMinor: 100_000,
      operationKey: 'collect-1',
      paymentId: payment.paymentId,
    });
    yield* evidence.settle(payment.paymentId, collect.operationId, 1, 'CONFLICT');
    const conflictCaseId = yield* evidence.openCase('OPERATION_CONFLICT', payment.paymentId, collect.operationId);
    yield* configureGopay(evidence);
    const statement = yield* evidence.accept(
      gopayStatement({
        amount: czk(100_000),
        economicEffectKey: 'gopay:payment:1',
        factKind: 'COLLECTION_CONFIRMED',
        operationId: collect.operationId,
        paymentId: payment.paymentId,
      }),
    );
    expect(statement).toMatchObject({ acceptanceOutcome: 'HELD_UNRESOLVED' });
    return { collect, conflictCaseId, payment, statement };
  },
);

const attachStatement = (evidence: EvidenceScenario, held: HeldStatement, operationId: string) =>
  evidence.decide({
    caseId: held.reconciliationCaseId ?? '',
    decision: { _tag: 'ATTACH_EVIDENCE', observationId: held.observationId, operationId },
    reason: 'Operator attaches the held collection statement',
  });

/** CLOSE_CASE result as a readable string: the closed status, or the refusal code. */
const closeOutcome = (evidence: EvidenceScenario, caseId: string, note: string) =>
  evidence.decide({ caseId, decision: { _tag: 'CLOSE_CASE', evidenceRef: note }, reason: note }).pipe(
    Effect.match({
      onFailure: (failure) => (Predicate.hasProperty(failure, 'code') ? failure.code : 'unknown'),
      onSuccess: (result) => result.caseStatus,
    }),
  );

/** The collection with its only confirmation governance-attached: EFFECT_CONFIRMED, every case closed. */
const attachedCollection = Effect.fn('ReconciliationCaseExits.attachedCollection')(function* attachedCollection(
  evidence: EvidenceScenario,
) {
  const held = yield* heldCollectionInConflict(evidence);
  const attached = yield* attachStatement(evidence, held.statement, held.collect.operationId);
  expect(Option.getOrUndefined(attached.outcomeChange)).toMatchObject({
    fromOutcome: 'CONFLICT',
    toOutcome: 'EFFECT_CONFIRMED',
  });
  expect(yield* closeOutcome(evidence, held.conflictCaseId, 'conflict-resolved-by-attachment')).toBe('CLOSED');
  return held;
});

/** A GoPay source correction of a statement; `fields` names the amount, operation or key it carries. */
const correct = (
  evidence: EvidenceScenario,
  paymentId: string,
  correctsObservationId: string,
  fields: {
    readonly amount?: { readonly amountMinor: number; readonly currency: 'CZK' };
    readonly economicEffectKey?: string;
    readonly operationId?: string;
  } = {},
) =>
  evidence.accept(
    gopayStatement({
      ...fields,
      correctsObservationId,
      factKind: 'SOURCE_CORRECTION',
      paymentId,
    }),
  );

type AcceptPayload = Parameters<EvidenceScenario['accept']>[0];

const gopay = (fields: Omit<AcceptPayload, 'factFamily' | 'source'>): AcceptPayload => ({
  factFamily: 'GATEWAY_OUTCOME',
  source: GOPAY_SOURCE,
  ...fields,
});

/** The refusal code of a failed Action, or `unknown` (no hand tag checks). */
const codeOf = <F>(failure: F) => (Predicate.hasProperty(failure, 'code') ? String(failure.code) : 'unknown');

/** `<acceptanceOutcome>/<interpretation>` of an accepted statement, or the refusal code. */
const acceptedAs = <R extends { readonly acceptanceOutcome: string; readonly interpretation: string }, E>(
  effect: Effect.Effect<R, E>,
) =>
  Effect.match(effect, {
    onFailure: codeOf,
    onSuccess: (result) => `${result.acceptanceOutcome}/${result.interpretation}`,
  });

/** `OK` when a governed decision succeeded, otherwise its refusal code. */
const reasonOf = <E>(effect: Effect.Effect<unknown, E>) =>
  Effect.match(effect, { onFailure: codeOf, onSuccess: () => 'OK' });

const operationOutcome = (evidence: EvidenceScenario, paymentId: string, operationId: string) =>
  evidence.rows
    .operations(paymentId)
    .pipe(Effect.map((rows) => rows.find((row) => row.operationId === operationId)?.outcome));

it.live('#1151 a repeated full correction of an already disproven attached statement cannot leave a stuck case', () =>
  native(
    Effect.gen(function* repeatedDisproofStuck() {
      const evidence = yield* scenario();
      const { payment, statement } = yield* attachedCollection(evidence);
      expect(yield* closeOutcome(evidence, statement.reconciliationCaseId ?? '', 'attached-callback')).toBe('CLOSED');
      const first = yield* correct(evidence, payment.paymentId, statement.observationId);
      expect(first).toMatchObject({ interpretation: 'CORRECTION' });
      // The source re-sends the same disproof under a new key: no new money, only lineage.
      const repeated = yield* correct(evidence, payment.paymentId, statement.observationId, {
        economicEffectKey: 'gopay:payment:1:correction:resent',
      });
      expect(repeated).toMatchObject({ acceptanceOutcome: 'HELD_UNRESOLVED' });
      expect(yield* closeOutcome(evidence, repeated.reconciliationCaseId ?? '', 'resent-disproof')).toBe('CLOSED');
    }),
  ),
);

it.live(
  '#1151 E7 lower held revision of an effect a higher revision already established is resolvable by governance',
  () =>
    native(
      Effect.gen(function* orphanLowerRevision() {
        const evidence = yield* scenario();
        const payment = yield* evidence.createPayment();
        const collect = yield* evidence.startOperation({
          amountMinor: 100_000,
          operationKey: 'collect-1',
          paymentId: payment.paymentId,
        });
        yield* configureGopay(evidence);
        const occurrence = `gopay-orphan-rev-${randomUUID()}`;
        // Revision 1 arrives without a Payment correlation: held, unassigned.
        const held = yield* evidence.accept(
          gopay({
            amount: czk(100_000),
            economicEffectKey: 'gopay:payment:1',
            factKind: 'COLLECTION_CONFIRMED',
            sourceOccurrenceId: occurrence,
            sourceRevision: 1,
          }),
        );
        expect(held).toMatchObject({ acceptanceOutcome: 'HELD_UNRESOLVED' });
        const caseId = held.reconciliationCaseId ?? '';
        expect(
          yield* reasonOf(
            evidence.decide({
              caseId,
              decision: {
                _tag: 'ATTACH_EVIDENCE',
                observationId: held.observationId,
                operationId: collect.operationId,
              },
              reason: 'Proposed correlation without an updated source statement',
            }),
          ),
        ).toBe('payment_reconciliation_decision_not_applicable');
        // Revision 2 of the same occurrence proves the same effect for the Payment.
        expect(
          yield* acceptedAs(
            evidence.accept(
              gopay({
                amount: czk(100_000),
                economicEffectKey: 'gopay:payment:1',
                factKind: 'COLLECTION_CONFIRMED',
                paymentId: payment.paymentId,
                sourceOccurrenceId: occurrence,
                sourceRevision: 2,
              }),
            ),
          ),
        ).toBe('ACCEPTED_OBSERVATION/TRANSITION');
        expect(yield* operationOutcome(evidence, payment.paymentId, collect.operationId)).toBe('EFFECT_CONFIRMED');
        const close = yield* reasonOf(
          evidence.decide({
            caseId,
            decision: { _tag: 'CLOSE_CASE', evidenceRef: 'gopay-occurrence-revision-2' },
            reason: 'Same economic effect is already accounted for',
          }),
        );
        // Invariant 4: an OPEN case must be closable through some governed sequence.
        expect(close).toBe('OK');
      }),
    ),
);

// ---- Refund route (#1150/#1152) harness ----
const nativeRoutes = <A, E>(effect: Effect.Effect<A, E, Crypto.Crypto | Scope.Scope>) =>
  Effect.scoped(effect).pipe(Effect.provide(NodeCrypto.layer));

const nativeRoutesDatabase = Effect.gen(function* caseExitsNativeDatabase() {
  const { admin, runtime } = yield* testDatabaseClients;
  const coreAdmin = yield* makeTestDatabaseFromClient(admin, coreRelations);
  const database = yield* makeTestDatabaseFromClient(runtime, coreRelations);
  return { coreAdmin, database, runtimeClient: runtime } satisfies EvidenceNativeDatabase;
});

const makeRouteRuntimes = Effect.fn('RefundRouteAttach.makeRouteRuntimes')(function* makeRouteRuntimes(
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
      databaseIdentities: defineDatabaseIdentityEnrollment([]),
      ownerAuthorizationOverlay: allowOwnerAuthorizationOverlay,
      ownerRegistration: paymentRegistration,
    },
  );
  return { actions, reads };
});

const routeScenario = Effect.fn('RefundRouteAttach.routeScenario')(function* routeScenario() {
  const database = yield* nativeRoutesDatabase;
  const scope = yield* makeTestScope;
  yield* seedCoreScope(database, scope);
  const r1 = yield* makeRouteRuntimes(database, COMPOSITION_R1);
  const r2 = yield* makeRouteRuntimes(database, COMPOSITION_R2);
  return evidenceScenarioOf({ native: database, r1, r2, scope });
});

const routeCzk = (amountMinor: number) => ({ amountMinor, currency: 'CZK' as const });

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
    transport: { correlationId: 'payment-local', idempotencyKey: randomUUID() },
  });

const posStatement = (
  paymentId: string,
  overrides: Partial<LocalPayload> & Pick<LocalPayload, 'factFamily' | 'factKind'>,
): LocalPayload => ({
  amount: routeCzk(100_000),
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
    pickupCapabilityRef: pickupBinding.pickupCapabilityRef,
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
const confirmedPickupCollect = Effect.fn('RefundRouteAttach.confirmedPickupCollect')(function* confirmedPickupCollect(
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

// Finding 1 (acceptance path): REFUND requested through the bank route; a POS statement from a later-configured POS refund route
// must not confirm it, because the REFUND keeps the executor it was requested through.
// Finding 3 (attach path): a POS refund held without its operation (capability proven, no REFUND named) is attached to a REFUND
// that was requested through the bank route. The attachment must be refused as a foreign executor.
it.live(
  '#1150/#1152 a POS refund held without its operation cannot be attached to a REFUND requested through the bank route',
  () =>
    nativeRoutes(
      Effect.gen(function* posHeldAttachToBankRoute() {
        const evidence = yield* routeScenario();
        const { collect, payment } = yield* confirmedPickupCollect(evidence);
        const bank = yield* configureBankRefundRoute(evidence);
        const refund = yield* requestPickupRefund(
          evidence,
          payment.paymentId,
          collect.operationId,
          bank.sourceAuthorityId,
        );
        yield* configurePos(evidence, 'REFUND_EXECUTION');
        const held = yield* recordLocal(
          evidence,
          posStatement(payment.paymentId, {
            evidenceRef: 'pos-refund-unnamed-1',
            factFamily: 'REFUND_EXECUTION',
            factKind: 'REFUND_CONFIRMED',
            sourceOccurrenceId: 'pos-refund-unnamed-1',
          }),
        );
        expect(held.acceptanceOutcome).toBe('HELD_UNRESOLVED');
        const refusal = yield* failureCodeOf(
          evidence.decide({
            caseId: held.reconciliationCaseId ?? '',
            decision: { _tag: 'ATTACH_EVIDENCE', observationId: held.observationId, operationId: refund.operationId },
            reason: 'Operator attaches the POS refund to the bank-routed REFUND',
          }),
        );
        expect(refusal).toBe('payment_reconciliation_evidence_not_qualified');
        expect(yield* outcomeOf(evidence, payment.paymentId, refund.operationId)).toBe('PENDING');
      }),
    ),
);

// A POS return that never proved the selected pickup capability is no counted prior return: its case stays open.
it.live('#1152 a POS return stated without the selected pickup capability never counts as a prior return', () =>
  nativeRoutes(
    Effect.gen(function* uncorrelatedPosReturn() {
      const evidence = yield* routeScenario();
      const { collect, payment } = yield* confirmedPickupCollect(evidence);
      yield* configurePos(evidence, 'REFUND_EXECUTION');
      const { pickupCapabilityRef: _unproven, ...withoutCapability } = posStatement(payment.paymentId, {
        amount: routeCzk(40_000),
        evidenceRef: 'pos-return-unproven-1',
        factFamily: 'REFUND_EXECUTION',
        factKind: 'REFUND_CONFIRMED',
        operationId: collect.operationId,
        sourceOccurrenceId: 'pos-return-unproven-1',
      });
      const held = yield* recordLocal(evidence, withoutCapability);
      expect(held.acceptanceOutcome).toBe('HELD_UNRESOLVED');
      expect(
        yield* failureCodeOf(
          evidence.decide({
            caseId: held.reconciliationCaseId ?? '',
            decision: { _tag: 'CLOSE_CASE', evidenceRef: 'pos-return-unproven-1' },
            reason: 'Close the POS return as an already counted prior return',
          }),
        ),
      ).toBe('payment_reconciliation_obligation_unresolved');
    }),
  ),
);

// ---- Economic effect ledger (#1151) harness ----
const nativeLedger = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(effect).pipe(Effect.provide(NodeCrypto.layer));

const nativeLedgerRuntime = Effect.gen(function* acquireLedgerNativeRuntime() {
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

/** A second, independently configured bank account of the same Tenant (a different source binding). */
const backupBank = {
  accountRef: 'CZ6508000000192000999999',
  environment: 'production',
  sourceKind: 'BANK_ACCOUNTING',
  sourceSystem: 'erp-backup',
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

/** Two pending bank-transfer Payments of one Tenant / Selling Legal Entity and the ERP receipt authority. */
const twoBankTransferPayments = Effect.fn('EffectLedger.twoPayments')(function* twoPayments() {
  const refundCase = yield* refundCaseFor(yield* nativeLedgerRuntime, {
    ...bankTransferPayment,
    gatewayRoute: false,
    receiptSource: {
      ...erpBank,
      factFamily: 'BANK_ACCOUNTING_RECEIPT',
      method: 'BANK_TRANSFER_ADVANCE',
      refundRoute: false,
    },
  });
  const second = yield* seedPayment(refundCase.native.database, refundCase.scope, bankTransferPayment);
  return { first: refundCase.payment, refundCase, second } satisfies TwoPayments;
});

type AcceptEncoded = typeof AcceptPaymentObservationPayloadSchema.Encoded;

/** The ERP receipt of the one bank transaction, reported as `sourceOccurrenceId` for one Payment. */
const receiptOf = (
  payment: { readonly collectOperationId: string; readonly paymentId: string },
  sourceOccurrenceId: string,
  source: typeof erpBank | typeof backupBank = erpBank,
): AcceptEncoded => ({
  amount: { amountMinor: 100_000, currency: 'CZK' },
  economicEffectKey: BANK_TRANSACTION,
  factFamily: 'BANK_ACCOUNTING_RECEIPT',
  factKind: 'COLLECTION_CONFIRMED',
  operationId: payment.collectOperationId,
  paymentId: payment.paymentId,
  source,
  sourceOccurrenceId,
  sourceRevision: 0,
});

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

// Scenario 4: an unassigned receipt of the key is recorded first; the key then confirms the first Payment.
it.live('#1151 e6 ledger: an unassigned receipt carrying a key already counted for a Payment can be closed', () =>
  nativeLedger(
    Effect.gen(function* unassignedBeforeAttribution() {
      const { first, refundCase } = yield* twoBankTransferPayments();
      const unassigned = yield* acceptObservation(refundCase, unassignedReceiptOf('bank-statement-line-17-unassigned'));
      expect(unassigned.acceptanceOutcome).toBe('HELD_UNRESOLVED');
      expect(unassigned.paymentId).toBeUndefined();
      const confirmed = yield* acceptObservation(refundCase, receiptOf(first, 'erp-receipt-voucher-17'));
      expect(confirmed.outcomeChange?.to).toBe('EFFECT_CONFIRMED');
      // The same bank transaction is already counted once for the first Payment: the orphan report is accounted for.
      const closed = yield* decideReconciliation(refundCase, {
        caseId: unassigned.reconciliationCaseId ?? '',
        decision: { _tag: 'CLOSE_CASE', evidenceRef: 'erp-receipt-voucher-17' },
        reason: 'The transaction is already counted for the first Payment',
      });
      expect(closed.caseStatus).toBe('CLOSED');
    }),
  ),
);

// Scenario 5: the key confirms the first Payment; a later unassigned report of the same transaction is closed.
it.live('#1151 e6 ledger: an unassigned duplicate report of a key already counted for a Payment can be closed', () =>
  nativeLedger(
    Effect.gen(function* unassignedAfterAttribution() {
      const { first, refundCase } = yield* twoBankTransferPayments();
      const confirmed = yield* acceptObservation(refundCase, receiptOf(first, 'bank-statement-line-17'));
      expect(confirmed.outcomeChange?.to).toBe('EFFECT_CONFIRMED');
      const unassigned = yield* acceptObservation(refundCase, unassignedReceiptOf('erp-orphan-copy-17'));
      expect(unassigned.acceptanceOutcome).toBe('HELD_UNRESOLVED');
      const closed = yield* decideReconciliation(refundCase, {
        caseId: unassigned.reconciliationCaseId ?? '',
        decision: { _tag: 'CLOSE_CASE', evidenceRef: 'erp-orphan-copy-17' },
        reason: 'The same transaction is already counted once for the first Payment',
      });
      expect(closed.caseStatus).toBe('CLOSED');
    }),
  ),
);

// Guard: the same key with different money is contradictory evidence, never an accounted copy.
it.live('#1151 an unassigned report of a counted key that states different money cannot be closed', () =>
  nativeLedger(
    Effect.gen(function* unassignedCopyWithOtherMoney() {
      const { first, refundCase } = yield* twoBankTransferPayments();
      const confirmed = yield* acceptObservation(refundCase, receiptOf(first, 'bank-statement-line-17'));
      expect(confirmed.outcomeChange?.to).toBe('EFFECT_CONFIRMED');
      const contradicting = yield* acceptObservation(refundCase, {
        ...unassignedReceiptOf('erp-orphan-copy-17-other-money'),
        amount: { amountMinor: 80_000, currency: 'CZK' },
      });
      expect(contradicting.acceptanceOutcome).toBe('HELD_UNRESOLVED');
      expect(
        yield* failureCodeOf(
          decideReconciliation(refundCase, {
            caseId: contradicting.reconciliationCaseId ?? '',
            decision: { _tag: 'CLOSE_CASE', evidenceRef: 'erp-orphan-copy-17-other-money' },
            reason: 'Close the report as a copy of the counted transaction',
          }),
        ),
      ).toBe('payment_reconciliation_obligation_unresolved');
    }),
  ),
);

// Guard: a held copy of an effect counted only for ANOTHER Payment is not accounted for and cannot be closed.
it.live('#1151 e6 ledger: a held copy of an effect counted only for another Payment cannot be closed', () =>
  nativeLedger(
    Effect.gen(function* heldCopyOfOtherPaymentsEffect() {
      const { first, refundCase, second } = yield* twoBankTransferPayments();
      const confirmed = yield* acceptObservation(refundCase, receiptOf(first, 'bank-statement-line-17'));
      expect(confirmed.outcomeChange?.to).toBe('EFFECT_CONFIRMED');
      // The second Payment's copy names no operation: held debt of the second Payment alone.
      const held = yield* acceptObservation(refundCase, {
        amount: { amountMinor: 100_000, currency: 'CZK' },
        economicEffectKey: BANK_TRANSACTION,
        factFamily: 'BANK_ACCOUNTING_RECEIPT',
        factKind: 'COLLECTION_CONFIRMED',
        paymentId: second.paymentId,
        source: erpBank,
        sourceOccurrenceId: 'erp-receipt-voucher-17',
        sourceRevision: 0,
      });
      expect(held.acceptanceOutcome).toBe('HELD_UNRESOLVED');
      expect(held.paymentId).toBe(second.paymentId);
      const refusal = yield* failureCodeOf(
        decideReconciliation(refundCase, {
          caseId: held.reconciliationCaseId ?? '',
          decision: { _tag: 'CLOSE_CASE', evidenceRef: 'erp-receipt-voucher-17' },
          reason: 'The transaction is counted for the first Payment only',
        }),
      );
      expect(refusal).toBe('payment_reconciliation_obligation_unresolved');
    }),
  ),
);
