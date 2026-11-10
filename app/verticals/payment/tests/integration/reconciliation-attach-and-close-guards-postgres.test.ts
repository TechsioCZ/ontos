import { randomUUID } from 'node:crypto';

import { NodeCrypto } from '@effect/platform-node';
import { Crypto, Effect, Exit, Option, Predicate, Result } from 'effect';
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
import { paymentRegistration } from '../../vertical.registration.ts';
import { requestPaymentCancellationAction } from '../../src/actions/request-payment-cancellation.action.ts';
import { makeTestScope, paymentTestRelations } from './database-fixture.ts';
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
import {
  acceptObservation,
  decideReconciliation,
  itemsRefund,
  refundCaseFor,
  refundItem,
  requestRefund,
} from '../support/refund-action-driver.ts';
import type { RefundCase } from '../support/refund-action-driver.ts';
import {
  refundRuntimeContextAccess,
  refundRuntimePermission,
  seedSourceAuthority,
} from '../support/refund-native-runtime.ts';
import type { RefundNativeRuntime } from '../support/refund-native-runtime.ts';

// Regression tests for the governed reconciliation guards (#1150 refunds/cancellation, #1151 evidence):
// attachments that overturn or complete a standing outcome, closing cases whose monetary obligation is
// accounted for, and held prior returns that the funds reader already counts.

const native = <A, E>(effect: Effect.Effect<A, E, Crypto.Crypto | Scope.Scope>) =>
  Effect.scoped(effect).pipe(Effect.provide(NodeCrypto.layer));

const nativeDatabase = Effect.gen(function* evidenceNativeDatabase() {
  const { admin, runtime } = yield* testDatabaseClients;
  const coreAdmin = yield* makeTestDatabaseFromClient(admin, coreRelations);
  const database = yield* makeTestDatabaseFromClient(runtime, coreRelations);
  return { coreAdmin, database, runtimeClient: runtime } satisfies EvidenceNativeDatabase;
});

const makeRuntimes = Effect.fn('ReconciliationGuards.makeRuntimes')(function* makeRuntimes(
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

const scenario = Effect.fn('ReconciliationGuards.scenario')(function* scenario() {
  const database = yield* nativeDatabase;
  const scope = yield* makeTestScope;
  yield* seedCoreScope(database, scope);
  const r1 = yield* makeRuntimes(database, COMPOSITION_R1);
  const r2 = yield* makeRuntimes(database, COMPOSITION_R2);
  const evidence = evidenceScenarioOf({ native: database, r1, r2, scope });
  return { evidence, r1, scope };
});
type EvidenceCtx = Effect.Success<ReturnType<typeof scenario>>;

const czk = (amountMinor: number) => ({ amountMinor, currency: 'CZK' as const });

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

/** A GoPay callback statement; the optional fields are only present when given. */
const gopayStatement = <
  Fields extends {
    readonly amount?: { readonly amountMinor: number; readonly currency: 'CZK' };
    readonly correctsObservationId?: string;
    readonly economicEffectKey?: string;
    readonly factKind: 'CANCEL_CONFIRMED' | 'COLLECTION_CONFIRMED' | 'COLLECTION_NOT_EFFECTED' | 'SOURCE_CORRECTION';
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

/** The refusal code of a failed Action, `ACCEPTED` when it succeeded (never a defect either way). */
const refusalOrAccepted = <A, E, R>(operation: Effect.Effect<A, E, R>) =>
  Effect.result(operation).pipe(
    Effect.map((result) => {
      if (Result.isSuccess(result)) {
        return 'ACCEPTED';
      }
      return Predicate.hasProperty(result.failure, 'code') ? String(result.failure.code) : 'unknown';
    }),
  );

/** Governed ATTACH_EVIDENCE of a held statement, summarized as the refusal code or the applied outcome. */
const attachOutcome = (evidence: EvidenceScenario, caseId: string, observationId: string, operationId: string) =>
  evidence
    .decide({
      caseId,
      decision: { _tag: 'ATTACH_EVIDENCE', observationId, operationId },
      reason: 'Operator attaches the held statement',
    })
    .pipe(
      Effect.match({
        onFailure: (failure) => (Predicate.hasProperty(failure, 'code') ? `refused:${failure.code}` : 'refused'),
        onSuccess: (result) => `applied:${Option.getOrUndefined(result.outcomeChange)?.toOutcome ?? 'none'}`,
      }),
    );

const outcomesOf = (evidence: EvidenceScenario, paymentId: string) =>
  evidence.rows.operations(paymentId).pipe(Effect.map((rows) => rows.map((row) => row.outcome)));

/** A 100 000 CZK GoPay Payment with one COLLECT whose confirmation arrived first and was accepted. */
const confirmedReceipt = Effect.fn('ReconciliationGuards.confirmedReceipt')(function* confirmedReceipt(
  evidence: EvidenceScenario,
) {
  const payment = yield* evidence.createPayment();
  const collect = yield* evidence.startOperation({
    amountMinor: 100_000,
    operationKey: 'collect-1',
    paymentId: payment.paymentId,
  });
  yield* configureGopay(evidence);
  const receipt = yield* evidence.accept(
    gopayStatement({
      amount: czk(100_000),
      economicEffectKey: 'gopay:charge:1',
      factKind: 'COLLECTION_CONFIRMED',
      operationId: collect.operationId,
      paymentId: payment.paymentId,
    }),
  );
  expect(receipt.acceptanceOutcome).toBe('ACCEPTED_OBSERVATION');
  return { collect, payment, receipt };
});

it.live('#1151 a NOT_EFFECTED attachment never overturns an uncorrected standing receipt of the same COLLECT', () =>
  native(
    Effect.gen(function* notEffectedNeverOverturnsReceipt() {
      const ctx = yield* scenario();
      const { collect, payment } = yield* confirmedReceipt(ctx.evidence);
      const contradicting = yield* ctx.evidence.accept(
        gopayStatement({
          amount: czk(100_000),
          economicEffectKey: 'gopay:charge:1:not-effected',
          factKind: 'COLLECTION_NOT_EFFECTED',
          operationId: collect.operationId,
          paymentId: payment.paymentId,
        }),
      );
      expect(contradicting.acceptanceOutcome).not.toBe('ACCEPTED_OBSERVATION');
      const attach = yield* attachOutcome(
        ctx.evidence,
        contradicting.reconciliationCaseId ?? '',
        contradicting.observationId,
        collect.operationId,
      );
      expect(attach).toBe('refused:payment_reconciliation_evidence_not_qualified');
      expect(yield* outcomesOf(ctx.evidence, payment.paymentId)).not.toContain('NOT_EFFECTED_CONFIRMED');
      // Receipt 1 still stands, so a second COLLECT of the Payment stays refused.
      const retry = yield* Effect.exit(
        ctx.evidence.startOperation({ amountMinor: 100_000, operationKey: 'collect-2', paymentId: payment.paymentId }),
      );
      expect(Exit.isFailure(retry)).toBe(true);
    }),
  ),
);

it.live('#1151 an EFFECT attachment never overturns an uncorrected standing not-effected statement', () =>
  native(
    Effect.gen(function* effectNeverOverturnsNotEffected() {
      const ctx = yield* scenario();
      const { evidence } = ctx;
      const payment = yield* evidence.createPayment();
      const collect = yield* evidence.startOperation({
        amountMinor: 100_000,
        operationKey: 'collect-1',
        paymentId: payment.paymentId,
      });
      yield* configureGopay(evidence);
      const notEffected = yield* evidence.accept(
        gopayStatement({
          amount: czk(100_000),
          economicEffectKey: 'gopay:charge:n1',
          factKind: 'COLLECTION_NOT_EFFECTED',
          operationId: collect.operationId,
          paymentId: payment.paymentId,
        }),
      );
      expect(notEffected.acceptanceOutcome).toBe('ACCEPTED_OBSERVATION');
      const held = yield* evidence.accept(
        gopayStatement({
          amount: czk(100_000),
          economicEffectKey: 'gopay:charge:n2',
          factKind: 'COLLECTION_CONFIRMED',
          operationId: collect.operationId,
          paymentId: payment.paymentId,
        }),
      );
      expect(held.acceptanceOutcome).not.toBe('ACCEPTED_OBSERVATION');
      const attach = yield* attachOutcome(
        evidence,
        held.reconciliationCaseId ?? '',
        held.observationId,
        collect.operationId,
      );
      expect(attach).toBe('refused:payment_reconciliation_evidence_not_qualified');
      expect(yield* outcomesOf(evidence, payment.paymentId)).not.toContain('EFFECT_CONFIRMED');
    }),
  ),
);

it.live('#1151 a receipt whose COLLECT no longer holds the attached outcome does not count as accounted', () =>
  native(
    Effect.gen(function* staleAttachmentNotAccounted() {
      const ctx = yield* scenario();
      const { evidence } = ctx;
      yield* configureGopay(evidence);
      const payment = yield* evidence.createPayment();
      // The receipt arrives before any COLLECT exists, so it is held as debt of this Payment.
      const held = yield* evidence.accept(
        gopayStatement({
          amount: czk(100_000),
          economicEffectKey: 'gopay:payment:stale-1',
          factKind: 'COLLECTION_CONFIRMED',
          paymentId: payment.paymentId,
        }),
      );
      expect(held).toMatchObject({ acceptanceOutcome: 'HELD_UNRESOLVED', paymentId: payment.paymentId });
      const collect = yield* evidence.startOperation({
        amountMinor: 100_000,
        operationKey: 'collect-1',
        paymentId: payment.paymentId,
      });
      yield* evidence.decide({
        caseId: held.reconciliationCaseId ?? '',
        decision: { _tag: 'ATTACH_EVIDENCE', observationId: held.observationId, operationId: collect.operationId },
        reason: 'Bank statement proves the collection',
      });
      expect(yield* outcomesOf(evidence, payment.paymentId)).toEqual(['EFFECT_CONFIRMED']);
      // The COLLECT is put in CONFLICT: the attached outcome no longer stands, so the receipt is unaccounted.
      const conflictCaseId = yield* evidence.openCase('UNRESOLVED_OPERATION', payment.paymentId, collect.operationId);
      yield* evidence.decide({
        caseId: conflictCaseId,
        decision: { _tag: 'CLASSIFY_CONFLICT' },
        reason: 'Provider and bank statements contradict',
      });
      expect(yield* outcomesOf(evidence, payment.paymentId)).toEqual(['CONFLICT']);
      const closed = yield* refusalOrAccepted(
        evidence.decide({
          caseId: held.reconciliationCaseId ?? '',
          decision: { _tag: 'CLOSE_CASE', evidenceRef: 'operator-note' },
          reason: 'Close the held receipt',
        }),
      );
      expect(closed).toBe('payment_reconciliation_obligation_unresolved');
    }),
  ),
);

it.live(
  '#1151 a misfiled correction of a statement of another Payment has a governed exit and leaves that statement intact',
  () =>
    native(
      Effect.gen(function* misfiledCorrectionCloses() {
        const ctx = yield* scenario();
        const { evidence } = ctx;
        yield* configureGopay(evidence);
        const payment = yield* evidence.createPayment();
        const held = yield* evidence.accept(
          gopayStatement({
            amount: czk(100_000),
            economicEffectKey: 'gopay:payment:misfiled-1',
            factKind: 'COLLECTION_CONFIRMED',
            paymentId: payment.paymentId,
          }),
        );
        const collect = yield* evidence.startOperation({
          amountMinor: 100_000,
          operationKey: 'collect-1',
          paymentId: payment.paymentId,
        });
        yield* evidence.decide({
          caseId: held.reconciliationCaseId ?? '',
          decision: { _tag: 'ATTACH_EVIDENCE', observationId: held.observationId, operationId: collect.operationId },
          reason: 'Bank statement proves the collection',
        });
        const other = yield* evidence.createPayment();
        expect(other.paymentId).not.toBe(payment.paymentId);
        const misfiled = yield* evidence.accept(
          gopayStatement({
            correctsObservationId: held.observationId,
            factKind: 'SOURCE_CORRECTION',
            paymentId: other.paymentId,
          }),
        );
        expect(misfiled.acceptanceOutcome).toBe('HELD_UNRESOLVED');
        const closed = yield* refusalOrAccepted(
          evidence.decide({
            caseId: misfiled.reconciliationCaseId ?? '',
            decision: { _tag: 'CLOSE_CASE', evidenceRef: 'misfiled-correction' },
            reason: 'Close the misfiled correction',
          }),
        );
        expect(closed).toBe('ACCEPTED');
        expect(yield* outcomesOf(evidence, payment.paymentId)).toEqual(['EFFECT_CONFIRMED']);
      }),
    ),
);

// --- #1150 cancellation against collection: a confirmed cancellation and a confirmed collection of one
// COLLECT contradict each other and the governed attach never completes that pair.

const requestCancel = (ctx: EvidenceCtx, paymentId: string, targetOperationId: string, operationKey: string) =>
  ctx.r1.actions
    .runAction({
      payload: {
        operationKey,
        paymentId,
        reason: 'Customer abandoned the checkout',
        targetOperationId,
      },
      principal: principalOf(ctx.scope),
      registration: requestPaymentCancellationAction,
      transport: { correlationId: 'reconciliation-guards-cancel', idempotencyKey: randomUUID() },
    })
    .pipe(Effect.map((result) => result.operation));

/** A 1000 CZK GoPay Payment with one COLLECT and one live CANCEL_OR_VOID of it. */
const cancelledCollect = Effect.fn('ReconciliationGuards.cancelledCollect')(function* cancelledCollect(
  ctx: EvidenceCtx,
) {
  const { evidence } = ctx;
  const payment = yield* evidence.createPayment();
  const collect = yield* evidence.startOperation({
    amountMinor: 100_000,
    operationKey: 'collect-1',
    paymentId: payment.paymentId,
  });
  yield* configureGopay(evidence);
  const cancel = yield* requestCancel(ctx, payment.paymentId, collect.operationId, 'cancel-1');
  return { cancel, collect, paymentId: payment.paymentId };
});

it.live('#1150 attaching a held cancellation confirmation never re-confirms it beside its confirmed collection', () =>
  native(
    Effect.gen(function* attachCancelBesideConfirmedCollection() {
      const ctx = yield* scenario();
      const { evidence } = ctx;
      const { cancel, collect, paymentId } = yield* cancelledCollect(ctx);
      yield* evidence.accept(
        gopayStatement({
          amount: czk(100_000),
          economicEffectKey: 'gopay:payment:f1-collect',
          factKind: 'COLLECTION_CONFIRMED',
          operationId: collect.operationId,
          paymentId,
        }),
      );
      const cancelled = yield* evidence.accept(
        gopayStatement({ factKind: 'CANCEL_CONFIRMED', operationId: cancel.operationId, paymentId }),
      );
      expect(cancelled).toMatchObject({ acceptanceOutcome: 'CONFLICT', interpretation: 'CONFLICT' });
      const outcome = yield* attachOutcome(
        evidence,
        cancelled.reconciliationCaseId ?? '',
        cancelled.observationId,
        cancel.operationId,
      );
      expect(outcome).toMatch(/^refused:/u);
      expect(yield* evidence.coverage(paymentId)).toMatch(/^Held/u);
    }),
  ),
);

it.live('#1150 attaching a held collection confirmation never re-confirms it beside its confirmed cancellation', () =>
  native(
    Effect.gen(function* attachCollectBesideConfirmedCancel() {
      const ctx = yield* scenario();
      const { evidence } = ctx;
      const { cancel, collect, paymentId } = yield* cancelledCollect(ctx);
      yield* evidence.accept(
        gopayStatement({ factKind: 'CANCEL_CONFIRMED', operationId: cancel.operationId, paymentId }),
      );
      const late = yield* evidence.accept(
        gopayStatement({
          amount: czk(100_000),
          economicEffectKey: 'gopay:payment:f2-late',
          factKind: 'COLLECTION_CONFIRMED',
          operationId: collect.operationId,
          paymentId,
        }),
      );
      expect(late).toMatchObject({ acceptanceOutcome: 'CONFLICT', interpretation: 'CONFLICT' });
      const outcome = yield* attachOutcome(
        evidence,
        late.reconciliationCaseId ?? '',
        late.observationId,
        collect.operationId,
      );
      expect(outcome).toMatch(/^refused:/u);
      expect(yield* evidence.coverage(paymentId)).toMatch(/^Held/u);
    }),
  ),
);

it.live('#1150 a contradictory cancellation pair never closes into Held coverage with no open case', () =>
  native(
    Effect.gen(function* attachThenCloseLeavesNoExit() {
      const ctx = yield* scenario();
      const { evidence } = ctx;
      const { cancel, collect, paymentId } = yield* cancelledCollect(ctx);
      yield* evidence.accept(
        gopayStatement({
          amount: czk(100_000),
          economicEffectKey: 'gopay:payment:f1b-collect',
          factKind: 'COLLECTION_CONFIRMED',
          operationId: collect.operationId,
          paymentId,
        }),
      );
      const cancelled = yield* evidence.accept(
        gopayStatement({ factKind: 'CANCEL_CONFIRMED', operationId: cancel.operationId, paymentId }),
      );
      const caseId = cancelled.reconciliationCaseId ?? '';
      const attach = yield* attachOutcome(evidence, caseId, cancelled.observationId, cancel.operationId);
      const closed = yield* refusalOrAccepted(
        evidence.decide({
          caseId,
          decision: { _tag: 'CLOSE_CASE', evidenceRef: 'operator-note' },
          reason: 'Operator closes the case after attaching',
        }),
      );
      const debt = yield* evidence.debt({ paymentId });
      const coverage = yield* evidence.coverage(paymentId);
      const heldWithoutCase = coverage.startsWith('Held') && debt.openCases.length === 0;
      expect(attach).toMatch(/^refused:/u);
      // The cancellation stays CONFLICT, so its case cannot close and Held coverage keeps its open case.
      expect(closed).toBe('payment_reconciliation_obligation_unresolved');
      expect(heldWithoutCase).toBe(false);
    }),
  ),
);

// --- #1150 held prior return on a COLLECT: the funds reader already counts it once, so its case closes.

const REFUND_GATEWAY_SOURCE = {
  accountRef: 'gopay-account-1',
  environment: 'production',
  sourceKind: 'PAYMENT_GATEWAY',
  sourceSystem: 'GOPAY',
} as const;

const refundNativeRuntime = Effect.gen(function* acquireRefundNativeRuntime() {
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

const newRefundCase = (options: Parameters<typeof refundCaseFor>[1]) =>
  refundNativeRuntime.pipe(Effect.flatMap((runtime) => refundCaseFor(runtime, options)));

const refundOutcomeOf = <A, E extends { readonly code?: unknown }, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.result(effect).pipe(
    Effect.map((result) => {
      if (Result.isSuccess(result)) {
        return 'committed';
      }
      return Predicate.hasProperty(result.failure, 'code') ? String(result.failure.code) : 'unknown';
    }),
  );

const refundA = refundItem('A', 30_000);
const refundB = refundItem('B', 30_000);
const refundC = refundItem('C', 40_000);
const refundP = refundItem('P', 70_000);
const refundOwners = { items: [refundA, refundB, refundC, refundP] } as const;

/** A qualified REFUND_CONFIRMED of 40 000 CZK naming the 100 000 CZK collection, with no REFUND operation. */
const priorReturnOnCollection = (refundCase: RefundCase, family: 'GATEWAY_OUTCOME' | 'REFUND_EXECUTION', key: string) =>
  Effect.gen(function* priorReturnStatement() {
    if (family === 'GATEWAY_OUTCOME') {
      yield* seedSourceAuthority(refundCase.native.database, refundCase.scope, {
        accountRef: REFUND_GATEWAY_SOURCE.accountRef,
        factFamily: 'GATEWAY_OUTCOME',
        method: 'ONLINE_GATEWAY',
        refundRoute: false,
        sourceKind: REFUND_GATEWAY_SOURCE.sourceKind,
        sourceSystem: REFUND_GATEWAY_SOURCE.sourceSystem,
      });
    }
    return yield* acceptObservation(refundCase, {
      amount: { amountMinor: 40_000, currency: 'CZK' },
      economicEffectKey: key,
      factFamily: family,
      factKind: 'REFUND_CONFIRMED',
      operationId: refundCase.payment.collectOperationId,
      paymentId: refundCase.payment.paymentId,
      source: REFUND_GATEWAY_SOURCE,
      sourceOccurrenceId: `occ-${key}`,
      sourceRevision: 0,
    });
  });

/**
 * The held prior return's case closes once the funds reader counts it: the Payment then refunds only what
 * is left (60 000 CZK), counting the return exactly once.
 */
const expectGovernedExit = (
  refundCase: RefundCase,
  held: { readonly observationId: string; readonly reconciliationCaseId?: string | undefined },
) =>
  Effect.gen(function* governedExit() {
    const closeOutcome = yield* refundOutcomeOf(
      decideReconciliation(refundCase, {
        caseId: held.reconciliationCaseId ?? '',
        decision: { _tag: 'CLOSE_CASE', evidenceRef: held.observationId },
        reason: 'Gateway confirmed the 40 000 CZK return',
      }),
    );
    expect(closeOutcome).toBe('committed');
    expect(
      yield* refundOutcomeOf(
        requestRefund(refundCase, itemsRefund(refundCase, 'refund-over', [refundP]), refundOwners),
      ),
    ).toBe('payment_refundable_funds_exceeded');
    expect(
      yield* refundOutcomeOf(requestRefund(refundCase, itemsRefund(refundCase, 'refund-c', [refundC]), refundOwners)),
    ).toBe('committed');
  });

it.live('#1150 an unattributed prior return held on the collection has a governed exit that counts it once', () =>
  native(
    Effect.gen(function* priorReturnExitRefundExecution() {
      const refundCase = yield* newRefundCase({ amountMinor: 100_000, collected: true });
      const held = yield* priorReturnOnCollection(refundCase, 'REFUND_EXECUTION', 'gopay:refund:9');
      expect(held.acceptanceOutcome).toBe('HELD_UNRESOLVED');
      yield* expectGovernedExit(refundCase, held);
    }),
  ),
);

it.live('#1150 the same held prior return on the GATEWAY_OUTCOME family has a governed exit too', () =>
  native(
    Effect.gen(function* priorReturnExitGatewayOutcome() {
      const refundCase = yield* newRefundCase({ amountMinor: 100_000, collected: true });
      const held = yield* priorReturnOnCollection(refundCase, 'GATEWAY_OUTCOME', 'gopay:refund:gw-40');
      expect(held.acceptanceOutcome).toBe('HELD_UNRESOLVED');
      yield* expectGovernedExit(refundCase, held);
    }),
  ),
);
