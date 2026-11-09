import { randomUUID } from 'node:crypto';

import { NodeCrypto } from '@effect/platform-node';
import { Crypto, Effect, Fiber, Option, Result, Schema } from 'effect';
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
import {
  computePaymentFunds,
  decidePrepaidCoverage,
  isPrepaidProofCurrent,
  PaymentFundsLedger,
  PrepaidCoverageDecision,
} from '../../src/domain/coverage.ts';
import type { PaymentFundsLedgerCase, PrepaidCoverageDecisionCase } from '../../src/domain/coverage.ts';
import { OutboxPayloadSchema as OutcomeChangedSchema } from '../../shared/outbox/payment-core-operation-outcome-changed-v1.ts';
import {
  interpretPaymentObservation,
  PaymentCorrectionEffect,
  PaymentEvidenceDecision,
} from '../../src/domain/evidence-interpretation.ts';
import type {
  PaymentEvidenceDecisionCase,
  QualifiedPaymentObservation,
} from '../../src/domain/evidence-interpretation.ts';
import { paymentFundsSnapshotOf } from '../../src/persistence/payment-aggregate-persistence.ts';
import { expectSqlFailure, failureCodeOf, makeTestScope } from './database-fixture.ts';
import {
  COMPOSITION_R1,
  COMPOSITION_R2,
  evidenceAllowedPermission,
  evidenceContextAccess,
  evidenceScenarioOf,
  OUTCOME_CHANGED,
  seedCoreScope,
} from './evidence-native-support.ts';
import type { EvidenceNativeDatabase, EvidenceScenario } from './evidence-native-support.ts';

const native = <A, E>(effect: Effect.Effect<A, E, Crypto.Crypto | Scope.Scope>) =>
  Effect.scoped(effect).pipe(Effect.provide(NodeCrypto.layer));

const nativeDatabase = Effect.gen(function* evidenceNativeDatabase() {
  const { admin, runtime } = yield* testDatabaseClients;
  const coreAdmin = yield* makeTestDatabaseFromClient(admin, coreRelations);
  const database = yield* makeTestDatabaseFromClient(runtime, coreRelations);
  return { coreAdmin, database, runtimeClient: runtime } satisfies EvidenceNativeDatabase;
});

/** The real Core Action and Read runtimes as they run under one approved Composition revision. */
const makeEvidenceRuntimes = Effect.fn('EvidenceNative.makeRuntimes')(function* makeEvidenceRuntimes(
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

const scenario = Effect.fn('EvidenceReconciliationTest.scenario')(function* scenario() {
  const database = yield* nativeDatabase;
  const scope = yield* makeTestScope;
  yield* seedCoreScope(database, scope);
  const r1 = yield* makeEvidenceRuntimes(database, COMPOSITION_R1);
  const r2 = yield* makeEvidenceRuntimes(database, COMPOSITION_R2);
  return evidenceScenarioOf({ native: database, r1, r2, scope });
});

const czk = (amountMinor: number) => ({ amountMinor, currency: 'CZK' as const });

const qualified = (overrides: Partial<QualifiedPaymentObservation>): QualifiedPaymentObservation => ({
  amount: overrides.amount,
  correctsObservationId: overrides.correctsObservationId,
  economicEffectKey: overrides.economicEffectKey,
  factKind: overrides.factKind ?? 'COLLECTION_CONFIRMED',
  operationId: overrides.operationId,
});

/** Interprets one qualified observation against the native aggregate loaded under the row lock. */
const interpret = (evidence: EvidenceScenario, paymentId: string, observation: QualifiedPaymentObservation) =>
  evidence.evidenceAggregate(paymentId).pipe(Effect.map((loaded) => interpretPaymentObservation(loaded, observation)));

/** A 1000 CZK gateway Payment whose collection is proven by one accepted provider observation. */
const confirmedCollection = Effect.fn('EvidenceReconciliationTest.confirmedCollection')(function* confirmed(
  evidence: EvidenceScenario,
) {
  const payment = yield* evidence.createPayment();
  const collect = yield* evidence.startOperation({
    amountMinor: 100_000,
    operationKey: 'collect-1',
    paymentId: payment.paymentId,
  });
  const authority = yield* evidence.configureAuthority();
  const receipt = yield* evidence.recordObservation({
    amountMinor: 100_000,
    economicEffectKey: 'gopay:payment:1',
    factKind: 'COLLECTION_CONFIRMED',
    occurrenceId: `callback-${randomUUID()}`,
    operationId: collect.operationId,
    paymentId: payment.paymentId,
    sourceAuthorityId: authority,
  });
  const decision = yield* interpret(
    evidence,
    payment.paymentId,
    qualified({ amount: czk(100_000), operationId: collect.operationId }),
  );
  expect(PaymentEvidenceDecision.$is('TRANSITION')(decision)).toBe(true);
  const settled = yield* evidence.settle(payment.paymentId, collect.operationId, 1, 'EFFECT_CONFIRMED');
  return { authority, collect: settled, payment, receipt };
});

/** Readable summaries of the shared calculators' decisions (exhaustive matches, no hand tag checks). */
const ledgerSummary = (ledger: PaymentFundsLedgerCase) =>
  PaymentFundsLedger.$match(ledger, {
    Established: ({ collected, confirmedReturned, remaining }) =>
      `Established collected=${collected.amountMinor} returned=${confirmedReturned.amountMinor} remaining=${remaining.amountMinor}`,
    Held: ({ reason }) => `Held ${reason}`,
    NotCollected: () => 'NotCollected',
  });
const coverageSummary = (decision: PrepaidCoverageDecisionCase) =>
  PrepaidCoverageDecision.$match(decision, {
    Covered: () => 'Covered',
    Held: ({ reason }) => `Held ${reason}`,
    NotCovered: ({ reason }) => `NotCovered ${reason}`,
    ZeroPayable: () => 'ZeroPayable',
  });

const fundsOf = (evidence: EvidenceScenario, paymentId: string) =>
  evidence.evidenceAggregate(paymentId).pipe(Effect.map((loaded) => paymentFundsSnapshotOf(loaded.current)));

const correctionEffectTag = (decision: PaymentEvidenceDecisionCase) =>
  PaymentEvidenceDecision.$match(decision, {
    CONFLICT: () => 'CONFLICT',
    CORRECTION: ({ effect }) =>
      PaymentCorrectionEffect.$match(effect, {
        RECORD_ONLY: () => 'RECORD_ONLY',
        REDUCE_ESTABLISHED_COLLECTION: () => 'REDUCE_ESTABLISHED_COLLECTION',
        REOPEN_TO_CONFLICT: () => 'REOPEN_TO_CONFLICT',
      }),
    HOLD: () => 'HOLD',
    NO_CHANGE: () => 'NO_CHANGE',
    TRANSITION: () => 'TRANSITION',
  });

it.live('#1151 Duplicate and corroborating observations describe one effect and count once', () =>
  native(
    Effect.gen(function* duplicateAndCorroborating() {
      const evidence = yield* scenario();
      const { authority, collect, payment } = yield* confirmedCollection(evidence);
      // The identical source occurrence is idempotent: the native occurrence identity refuses a second row.
      const occurrenceId = `callback-dup-${randomUUID()}`;
      const spec = {
        amountMinor: 100_000,
        factKind: 'COLLECTION_CONFIRMED' as const,
        occurrenceId,
        operationId: collect.operationId,
        paymentId: payment.paymentId,
        sourceAuthorityId: authority,
      };
      yield* evidence.recordObservation(spec);
      yield* expectSqlFailure(evidence.recordObservation(spec), '23505', 'payment_observations_occurrence_uk');
      // A different qualified observation of the same economic effect corroborates; it adds no money.
      const corroboration = yield* interpret(
        evidence,
        payment.paymentId,
        qualified({ amount: czk(100_000), economicEffectKey: 'gopay:payment:1', operationId: collect.operationId }),
      );
      expect(corroboration).toEqual(
        PaymentEvidenceDecision.NO_CHANGE({
          operationId: collect.operationId,
          reason: 'CORROBORATES_ESTABLISHED_OUTCOME',
        }),
      );
      const funds = computePaymentFunds(yield* fundsOf(evidence, payment.paymentId));
      expect(ledgerSummary(funds)).toBe('Established collected=100000 returned=0 remaining=100000');
      expect((yield* evidence.rows.transitions(collect.operationId)).map((row) => row.toOutcome)).toEqual([
        'PENDING',
        'EFFECT_CONFIRMED',
      ]);
    }),
  ),
);

it.live('#1151 Late refund does not erase collection or preserve a stale proof', () =>
  native(
    Effect.gen(function* lateRefund() {
      const evidence = yield* scenario();
      const { authority, collect, payment } = yield* confirmedCollection(evidence);
      const before = yield* fundsOf(evidence, payment.paymentId);
      expect(coverageSummary(decidePrepaidCoverage(before))).toBe('Covered');
      const loaded = yield* evidence.evidenceAggregate(payment.paymentId);
      const proofRevision = loaded.current.payment.coverageRevision;
      yield* evidence.issuePrepaidProof(payment.paymentId, proofRevision);

      const refund = yield* evidence.startOperation({
        amountMinor: 40_000,
        kind: 'REFUND',
        operationKey: 'refund-items-1',
        paymentId: payment.paymentId,
        refundBasis: {
          _tag: 'REFUNDABLE_ITEMS',
          items: [{ amountMinor: 40_000, currency: 'CZK', itemRef: 'line-1', sourceEvidenceRef: 'order-line-1' }],
        },
        targetOperationId: collect.operationId,
      });
      yield* evidence.recordObservation({
        amountMinor: 40_000,
        factKind: 'REFUND_CONFIRMED',
        operationId: refund.operationId,
        paymentId: payment.paymentId,
        sourceAuthorityId: authority,
      });
      const decision = yield* interpret(
        evidence,
        payment.paymentId,
        qualified({ amount: czk(40_000), factKind: 'REFUND_CONFIRMED', operationId: refund.operationId }),
      );
      expect(decision).toEqual(
        PaymentEvidenceDecision.TRANSITION({
          expectedOutcomeRevision: 1,
          from: 'PENDING',
          operationId: refund.operationId,
          to: 'EFFECT_CONFIRMED',
        }),
      );
      yield* evidence.settle(payment.paymentId, refund.operationId, 1, 'EFFECT_CONFIRMED');

      // The refund is a separate effect; the proven collection and its history stay intact.
      const operations = yield* evidence.rows.operations(payment.paymentId);
      expect(operations.map((row) => [row.kind, row.outcome])).toEqual([
        ['COLLECT', 'EFFECT_CONFIRMED'],
        ['REFUND', 'EFFECT_CONFIRMED'],
      ]);
      expect((yield* evidence.rows.transitions(collect.operationId)).map((row) => row.toOutcome)).toEqual([
        'PENDING',
        'EFFECT_CONFIRMED',
      ]);
      // The previous prepaid proof cannot validate against the reduced coverage.
      const after = yield* evidence.evidenceAggregate(payment.paymentId);
      const decisionAfter = decidePrepaidCoverage(paymentFundsSnapshotOf(after.current));
      expect(coverageSummary(decisionAfter)).toBe('NotCovered CONFIRMED_RETURN_REDUCED_COVERAGE');
      expect(
        isPrepaidProofCurrent({
          currentCoverageRevision: after.current.payment.coverageRevision,
          decision: decisionAfter,
          proofCoverageRevision: proofRevision,
        }),
      ).toBe(false);
      expect(ledgerSummary(computePaymentFunds(paymentFundsSnapshotOf(after.current)))).toBe(
        'Established collected=100000 returned=40000 remaining=60000',
      );
    }),
  ),
);

it.live('#1151 a return that no Payment operation explains is held debt and blocks the stale proof', () =>
  native(
    Effect.gen(function* unmatchedReturn() {
      const evidence = yield* scenario();
      const { collect, payment } = yield* confirmedCollection(evidence);
      const loaded = yield* evidence.evidenceAggregate(payment.paymentId);
      const proofRevision = loaded.current.payment.coverageRevision;
      const decision = yield* interpret(
        evidence,
        payment.paymentId,
        qualified({ amount: czk(40_000), factKind: 'REFUND_CONFIRMED', operationId: collect.operationId }),
      );
      expect(decision).toEqual(
        PaymentEvidenceDecision.HOLD({ operationId: collect.operationId, reason: 'UNMATCHED_RETURN_EFFECT' }),
      );
      yield* evidence.openCase('AMBIGUOUS_FUNDS', payment.paymentId, collect.operationId);
      const after = yield* evidence.evidenceAggregate(payment.paymentId);
      const snapshot = paymentFundsSnapshotOf(after.current);
      expect(ledgerSummary(computePaymentFunds(snapshot))).toBe('Held UNRESOLVED_EVIDENCE');
      expect(
        isPrepaidProofCurrent({
          currentCoverageRevision: after.current.payment.coverageRevision,
          decision: decidePrepaidCoverage(snapshot),
          proofCoverageRevision: proofRevision,
        }),
      ).toBe(false);
      // No refund operation was fabricated for the observed return.
      expect(yield* evidence.rows.operations(payment.paymentId)).toHaveLength(1);
    }),
  ),
);

it.live('#1151 A source corrects a statement rather than reversing money; history keeps the original evidence', () =>
  native(
    Effect.gen(function* sourceCorrection() {
      const evidence = yield* scenario();
      const { authority, collect, payment, receipt } = yield* confirmedCollection(evidence);
      const [receiptBefore] = yield* evidence.rows.observation(receipt);
      const proofRevision = (yield* evidence.evidenceAggregate(payment.paymentId)).current.payment.coverageRevision;
      yield* evidence.issuePrepaidProof(payment.paymentId, proofRevision);
      // The candidate is interpreted against the locked aggregate before it is recorded (source lane order).
      const decision = yield* interpret(
        evidence,
        payment.paymentId,
        qualified({ correctsObservationId: receipt, factKind: 'SOURCE_CORRECTION', operationId: collect.operationId }),
      );
      expect(correctionEffectTag(decision)).toBe('REOPEN_TO_CONFLICT');
      const correction = yield* evidence.recordObservation({
        correctsObservationId: receipt,
        factKind: 'SOURCE_CORRECTION',
        operationId: collect.operationId,
        paymentId: payment.paymentId,
        sourceAuthorityId: authority,
      });
      yield* evidence.settle(payment.paymentId, collect.operationId, 2, 'CONFLICT');
      yield* evidence.openCase('OPERATION_CONFLICT', payment.paymentId, collect.operationId);

      // The original observation and its acceptance audit are immutable.
      const [receiptAfter] = yield* evidence.rows.observation(receipt);
      expect(receiptAfter).toEqual(receiptBefore);
      // No fictitious refund or reversal effect exists; coverage is held and the proof is unusable.
      const after = yield* evidence.evidenceAggregate(payment.paymentId);
      expect(after.current.operations.map((operation) => operation.kind)).toEqual(['COLLECT']);
      const snapshot = paymentFundsSnapshotOf(after.current);
      expect(ledgerSummary(computePaymentFunds(snapshot))).toBe('Held UNRESOLVED_EVIDENCE');
      expect(
        isPrepaidProofCurrent({
          currentCoverageRevision: after.current.payment.coverageRevision,
          decision: decidePrepaidCoverage(snapshot),
          proofCoverageRevision: proofRevision,
        }),
      ).toBe(false);

      // The explicit historical projection shows the statement, its correction lineage and the proof as issued.
      const history = yield* evidence.history(payment.paymentId);
      expect(history.projection).toBe('HISTORICAL_IMMUTABLE');
      expect(history.currentValidityClaimed).toBe(false);
      expect(
        history.observations.map((observation) => [
          observation.observationId,
          observation.factKind,
          Option.getOrUndefined(observation.correctsObservationId),
        ]),
      ).toEqual([
        [receipt, 'COLLECTION_CONFIRMED', undefined],
        [correction, 'SOURCE_CORRECTION', receipt],
      ]);
      expect(history.transitions.map((transition) => transition.toOutcome)).toEqual([
        'PENDING',
        'EFFECT_CONFIRMED',
        'CONFLICT',
      ]);
      expect(history.authorizations).toHaveLength(1);
      expect(history.operations.map((operation) => operation.provenance.compositionRevision)).toEqual([COMPOSITION_R1]);
    }),
  ),
);

it.live('#1151 correction vs reversal: a full correction reopens the collection, a partial one reduces it', () =>
  native(
    Effect.gen(function* correctionDecision() {
      const evidence = yield* scenario();
      const { collect, payment, receipt } = yield* confirmedCollection(evidence);
      const full = yield* interpret(
        evidence,
        payment.paymentId,
        qualified({ correctsObservationId: receipt, factKind: 'SOURCE_CORRECTION', operationId: collect.operationId }),
      );
      expect(correctionEffectTag(full)).toBe('REOPEN_TO_CONFLICT');
      const partial = yield* interpret(
        evidence,
        payment.paymentId,
        qualified({
          amount: czk(30_000),
          correctsObservationId: receipt,
          factKind: 'SOURCE_CORRECTION',
          operationId: collect.operationId,
        }),
      );
      expect(correctionEffectTag(partial)).toBe('REDUCE_ESTABLISHED_COLLECTION');
    }),
  ),
);

it.live('#1151 a partial correction reduces Current coverage without a refund operation', () =>
  native(
    Effect.gen(function* partialCorrection() {
      const evidence = yield* scenario();
      const { authority, collect, payment, receipt } = yield* confirmedCollection(evidence);
      const proofRevision = (yield* evidence.evidenceAggregate(payment.paymentId)).current.payment.coverageRevision;
      yield* evidence.recordObservation({
        amountMinor: 30_000,
        correctionEffect: 'REDUCE_ESTABLISHED_COLLECTION',
        correctsObservationId: receipt,
        factKind: 'SOURCE_CORRECTION',
        operationId: collect.operationId,
        paymentId: payment.paymentId,
        sourceAuthorityId: authority,
      });
      yield* evidence.inTransaction((aggregate) => aggregate.bumpCoverageRevision(payment.paymentId));
      const after = yield* evidence.evidenceAggregate(payment.paymentId);
      const snapshot = paymentFundsSnapshotOf(after.current);
      expect(ledgerSummary(computePaymentFunds(snapshot))).toBe(
        'Established collected=70000 returned=0 remaining=70000',
      );
      expect(coverageSummary(decidePrepaidCoverage(snapshot))).toBe('NotCovered COLLECTION_REDUCED_BY_CORRECTION');
      expect(after.current.payment.coverageRevision).toBeGreaterThan(proofRevision);
      expect(after.current.operations).toHaveLength(1);
    }),
  ),
);

it.live('#1151 governed reconciliation attaches qualified evidence, closes the case and never fabricates money', () =>
  native(
    Effect.gen(function* governedReconciliation() {
      const evidence = yield* scenario();
      const payment = yield* evidence.createPayment();
      const collect = yield* evidence.startOperation({
        amountMinor: 100_000,
        operationKey: 'collect-conflict',
        paymentId: payment.paymentId,
      });
      yield* evidence.settle(payment.paymentId, collect.operationId, 1, 'CONFLICT');
      const caseId = yield* evidence.openCase('OPERATION_CONFLICT', payment.paymentId, collect.operationId);
      const active = yield* evidence.configureAuthority();
      const revoked = yield* evidence.configureAuthority('REVOKED');
      const statement = (sourceAuthorityId?: string) =>
        evidence.recordObservation({
          acceptanceOutcome: sourceAuthorityId === undefined ? 'UNAUTHORIZED_SOURCE' : 'HELD_UNRESOLVED',
          amountMinor: 100_000,
          factKind: 'COLLECTION_CONFIRMED',
          operationId: collect.operationId,
          paymentId: payment.paymentId,
          sourceAuthorityId,
        });
      const fromRevoked = yield* statement(revoked);
      const unauthorized = yield* statement();
      const qualifiedStatement = yield* statement(active);
      const attach = (observationId: string) =>
        evidence.decide({
          caseId,
          decision: { _tag: 'ATTACH_EVIDENCE', observationId },
          reason: 'Bank statement proves the collection',
        });
      expect(yield* failureCodeOf(attach(fromRevoked))).toBe('payment_reconciliation_evidence_not_qualified');
      expect(yield* failureCodeOf(attach(unauthorized))).toBe('payment_reconciliation_evidence_not_qualified');
      expect(yield* failureCodeOf(attach(randomUUID()))).toBe('payment_reconciliation_evidence_not_found');

      const attached = yield* attach(qualifiedStatement);
      expect(attached).toMatchObject({ caseStatus: 'OPEN', decision: { decisionKind: 'ATTACH_EVIDENCE' } });
      expect(Option.getOrUndefined(attached.outcomeChange)).toMatchObject({
        fromOutcome: 'CONFLICT',
        toOutcome: 'EFFECT_CONFIRMED',
      });
      const transitions = yield* evidence.rows.transitions(collect.operationId);
      expect(transitions.at(-1)).toMatchObject({
        causeId: attached.decision.decisionId,
        causeKind: 'RECONCILIATION',
        toOutcome: 'EFFECT_CONFIRMED',
      });
      const [changed] = yield* evidence
        .outbox(OUTCOME_CHANGED)
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(OutcomeChangedSchema))));
      expect(changed).toMatchObject({
        cause: { _tag: 'RECONCILIATION', decisionId: attached.decision.decisionId },
        fromOutcome: 'CONFLICT',
        toOutcome: 'EFFECT_CONFIRMED',
      });

      const coverageBefore = (yield* evidence.evidenceAggregate(payment.paymentId)).current.payment.coverageRevision;
      const closed = yield* evidence.decide({
        caseId,
        decision: { _tag: 'CLOSE_CASE', evidenceRef: 'bank-statement-2026-11-09' },
        reason: 'The conflict is resolved by the bank statement',
      });
      expect(closed).toMatchObject({ caseRevision: 2, caseStatus: 'CLOSED' });
      const coverageAfter = (yield* evidence.evidenceAggregate(payment.paymentId)).current.payment.coverageRevision;
      expect(coverageAfter).toBe(coverageBefore + 1);
      expect(
        yield* failureCodeOf(
          evidence.decide({ caseId, decision: { _tag: 'CLASSIFY_CONFLICT' }, reason: 'Late classification' }),
        ),
      ).toBe('payment_reconciliation_case_already_closed');
      expect(yield* evidence.rows.decisions(caseId)).toHaveLength(2);
      expect(yield* evidence.rows.operations(payment.paymentId)).toHaveLength(1);

      // A foreign scope cannot see or decide the case.
      const foreign = yield* scenario();
      expect(
        yield* failureCodeOf(
          foreign.decide({ caseId, decision: { _tag: 'CLASSIFY_CONFLICT' }, reason: 'Foreign decision' }),
        ),
      ).toBe('payment_reconciliation_case_not_found');
      expect(yield* failureCodeOf(foreign.history(payment.paymentId))).toBe('read_handler_not_found');
    }),
  ),
);

it.live('#1151 classifying a conflict moves an uncertain operation to CONFLICT and keeps the debt visible', () =>
  native(
    Effect.gen(function* classifyConflict() {
      const evidence = yield* scenario();
      const payment = yield* evidence.createPayment();
      const collect = yield* evidence.startOperation({
        amountMinor: 100_000,
        operationKey: 'collect-classify',
        paymentId: payment.paymentId,
      });
      const caseId = yield* evidence.openCase('UNRESOLVED_OPERATION', payment.paymentId, collect.operationId);
      const classified = yield* evidence.decide({
        caseId,
        decision: { _tag: 'CLASSIFY_CONFLICT' },
        reason: 'Contradictory provider and bank statements',
      });
      expect(Option.getOrUndefined(classified.outcomeChange)).toMatchObject({
        fromOutcome: 'PENDING',
        toOutcome: 'CONFLICT',
      });
      const debt = yield* evidence.debt({ paymentId: payment.paymentId });
      expect(debt.unresolvedOperations.map((operation) => operation.outcome)).toEqual(['CONFLICT']);
      expect(debt.openCases.map((open) => open.caseId)).toEqual([caseId]);
      const scopeWide = yield* evidence.debt();
      expect(scopeWide.openCases.map((open) => open.caseId)).toContain(caseId);
    }),
  ),
);

it.live('#1151 concurrent reconciliation decisions on one case serialize: one closes, the other conflicts', () =>
  native(
    Effect.gen(function* concurrentDecisions() {
      const evidence = yield* scenario();
      const payment = yield* evidence.createPayment();
      const collect = yield* evidence.startOperation({
        amountMinor: 100_000,
        operationKey: 'collect-race-close',
        paymentId: payment.paymentId,
      });
      yield* evidence.settle(payment.paymentId, collect.operationId, 1, 'NOT_EFFECTED_CONFIRMED');
      const caseId = yield* evidence.openCase('UNRESOLVED_OPERATION', payment.paymentId, collect.operationId);
      // Two distinct Core invocations (distinct idempotency keys) race on the same case.
      const close = () =>
        evidence.decide({
          caseId,
          decision: { _tag: 'CLOSE_CASE', evidenceRef: 'provider-lookup-404' },
          reason: 'Provider lookup proves non-execution',
        });
      const fibers = yield* Effect.forEach([0, 1], () => Effect.forkChild(Effect.result(close())));
      const results = yield* Fiber.joinAll(fibers);
      expect(results.filter(Result.isSuccess)).toHaveLength(1);
      const failures = results.flatMap((result) => (Result.isFailure(result) ? [result.failure] : []));
      expect(failures.map((failure) => failure.code)).toEqual(['payment_reconciliation_case_already_closed']);
      expect(yield* evidence.rows.decisions(caseId)).toHaveLength(1);
    }),
  ),
);

it.live('#1151 Same business identity changes meaning: the reused operation key is a CONFLICT', () =>
  native(
    Effect.gen(function* changedMeaning() {
      const evidence = yield* scenario();
      const payment = yield* evidence.createPayment(120_000);
      yield* evidence.startOperation({
        amountMinor: 100_000,
        operationKey: 'collect-1000',
        paymentId: payment.paymentId,
      });
      expect(
        yield* failureCodeOf(
          evidence.startOperation({ amountMinor: 120_000, operationKey: 'collect-1000', paymentId: payment.paymentId }),
        ),
      ).toBe('payment_operation_material_conflict');
      expect(yield* evidence.rows.operations(payment.paymentId)).toHaveLength(1);
    }),
  ),
);
