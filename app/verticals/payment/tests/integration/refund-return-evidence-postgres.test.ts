import { NodeCrypto } from '@effect/platform-node';
import { and, eq } from 'drizzle-orm';
import { Crypto, Effect, Option, Predicate, Result } from 'effect';
import { expect, it } from 'effect-rstest';

import { allowOwnerAuthorizationOverlay } from '../../../../packages/core-runtime/src/access/enforcement/owner-overlay.ts';
import { makeActionRepository } from '../../../../packages/core-runtime/src/actions/repository.ts';
import { makeActionRuntime } from '../../../../packages/core-runtime/src/actions/runtime.ts';
import { makeScriptedBoundAccessGate } from '../../../../packages/core-runtime/src/testing/access-gate.ts';
import { openActionRuntimeOptions } from '../../../../packages/core-runtime/tests/support/action-runtime-options.ts';
import {
  makeTestDatabaseFromClient,
  testDatabaseClients,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import { testOperationalScopeResolver } from '../../../../packages/core-runtime/tests/fixtures/operational-scope.ts';
import { observations, reconciliationCases } from '../../src/database/schema.ts';
import { paymentRegistration } from '../../vertical.registration.ts';
import { failureCodeOf, paymentTestRelations } from './database-fixture.ts';
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
  acceptReturnEvidence,
  refundRuntimeContextAccess,
  refundRuntimePermission,
  seedSourceAuthority,
} from '../support/refund-native-runtime.ts';
import type { RefundNativeRuntime } from '../support/refund-native-runtime.ts';

/**
 * Refund funds (#1150 prior returns, #1151 governed attachment): the refund funds guard
 * reads qualified return statements. A partial correction reduces a return; a governed attachment
 * assigns a return to its operation. Each probe refund asks the real funds guard what is refundable.
 */

const native = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(effect).pipe(Effect.provide(NodeCrypto.layer));

const nativeRuntime = Effect.gen(function* acquireRefundReturnEvidenceRuntime() {
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

const GATEWAY_SOURCE = {
  accountRef: 'gopay-account-1',
  environment: 'production',
  sourceKind: 'PAYMENT_GATEWAY',
  sourceSystem: 'GOPAY',
} as const;

const CZK = (amountMinor: number) => ({ amountMinor, currency: 'CZK' as const });

/** The stored id of the one gateway return with this economic effect key. */
const returnObservationIdOf = (refundCase: RefundCase, economicEffectKey: string) =>
  refundCase.native.coreAdmin
    .select({ observationId: observations.observationId })
    .from(observations)
    .where(
      and(
        eq(observations.paymentId, refundCase.payment.paymentId),
        eq(observations.factKind, 'REFUND_CONFIRMED'),
        eq(observations.economicEffectKey, economicEffectKey),
      ),
    )
    .pipe(Effect.map((rows) => rows[0]?.observationId ?? ''));

/** The outcome of a refund request: `committed`, or the typed refusal code. */
const refundOutcome = <A, E extends { readonly code?: unknown }, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.result(effect).pipe(
    Effect.map((result) => {
      if (Result.isSuccess(result)) {
        return 'committed';
      }
      return Predicate.hasProperty(result.failure, 'code') ? String(result.failure.code) : 'unknown';
    }),
  );

/** A GoPay REFUND_CONFIRMED statement with its economic effect key and occurrence. */
const refundConfirmed = (
  refundCase: Parameters<typeof acceptObservation>[0],
  input: { readonly economicEffectKey: string; readonly occurrence: string },
) =>
  acceptObservation(refundCase, {
    amount: CZK(10_000),
    economicEffectKey: input.economicEffectKey,
    factFamily: 'REFUND_EXECUTION',
    factKind: 'REFUND_CONFIRMED',
    paymentId: refundCase.payment.paymentId,
    source: GATEWAY_SOURCE,
    sourceOccurrenceId: input.occurrence,
    sourceRevision: 0,
  });

const A = refundItem('A', 10_000);
const P90 = refundItem('P90', 90_000);
const owners = {
  items: [
    A,
    P90,
    refundItem('B', 10_000),
    refundItem('C', 10_000),
    refundItem('P94', 94_000),
    refundItem('P95', 95_000),
  ],
};

it.live(
  '#1150 R1 a partial correction of a prior gateway return keeps the uncorrected part of that return counted',
  () =>
    native(
      Effect.gen(function* partialCorrectionOfPriorReturn() {
        const refundCase = yield* refundCaseFor(yield* nativeRuntime, { amountMinor: 100_000, collected: true });
        const authority = yield* seedSourceAuthority(refundCase.native.database, refundCase.scope, {
          accountRef: GATEWAY_SOURCE.accountRef,
          factFamily: 'GATEWAY_OUTCOME',
          method: 'ONLINE_GATEWAY',
          refundRoute: false,
          sourceKind: GATEWAY_SOURCE.sourceKind,
          sourceSystem: GATEWAY_SOURCE.sourceSystem,
        });
        yield* acceptReturnEvidence(refundCase.native.database, refundCase.scope, {
          amountMinor: 40_000,
          economicEffectKey: 'gopay:refund:prior-partial',
          operationId: refundCase.payment.collectOperationId,
          paymentId: refundCase.payment.paymentId,
          sourceAuthorityId: authority,
          sourceOccurrenceId: 'gopay-prior-return-1',
        });
        const returnId = yield* returnObservationIdOf(refundCase, 'gopay:refund:prior-partial');
        const over = [refundItem('A', 80_000)] satisfies readonly [unknown, ...unknown[]];
        // Control: before any correction the 400 CZK return is counted, so 800 CZK is refused.
        expect(
          yield* failureCodeOf(
            requestRefund(refundCase, itemsRefund(refundCase, 'over-before', over), { items: over }),
          ),
        ).toBe('payment_refundable_funds_exceeded');
        // 100 CZK of the 400 CZK return statement was erroneous: 300 CZK actually went back.
        const correctionOf = (sourceOccurrenceId: string) =>
          acceptObservation(refundCase, {
            amount: { amountMinor: 10_000, currency: 'CZK' },
            correctsObservationId: returnId,
            economicEffectKey: 'gopay:refund:prior-partial:correction',
            factFamily: 'GATEWAY_OUTCOME',
            factKind: 'SOURCE_CORRECTION',
            paymentId: refundCase.payment.paymentId,
            source: GATEWAY_SOURCE,
            sourceOccurrenceId,
            sourceRevision: 0,
          });
        const correction = yield* correctionOf('gopay-prior-return-correction-1');
        expect(correction.acceptanceOutcome).toBe('ACCEPTED_OBSERVATION');
        // Only 700 CZK may remain (1000 - 300); the same 800 CZK refund must still be refused.
        expect(
          yield* failureCodeOf(
            requestRefund(refundCase, itemsRefund(refundCase, 'over-remaining', over), { items: over }),
          ),
        ).toBe('payment_refundable_funds_exceeded');
        // The same correction re-issued under new occurrences is the same 100 CZK, never another one:
        // four re-issues must not eat the whole 400 CZK return.
        for (const occurrence of ['2', '3', '4', '5']) {
          const reissue = yield* correctionOf(`gopay-prior-return-correction-${occurrence}`);
          expect(reissue.acceptanceOutcome).toBe('ACCEPTED_OBSERVATION');
        }
        expect(
          yield* failureCodeOf(
            requestRefund(refundCase, itemsRefund(refundCase, 'over-after-reissues', over), { items: over }),
          ),
        ).toBe('payment_refundable_funds_exceeded');
      }),
    ),
);

it.live('#1150 R1 control: a full correction of the prior gateway return releases the whole return', () =>
  native(
    Effect.gen(function* fullCorrectionOfPriorReturn() {
      const refundCase = yield* refundCaseFor(yield* nativeRuntime, { amountMinor: 100_000, collected: true });
      const authority = yield* seedSourceAuthority(refundCase.native.database, refundCase.scope, {
        accountRef: GATEWAY_SOURCE.accountRef,
        factFamily: 'GATEWAY_OUTCOME',
        method: 'ONLINE_GATEWAY',
        refundRoute: false,
        sourceKind: GATEWAY_SOURCE.sourceKind,
        sourceSystem: GATEWAY_SOURCE.sourceSystem,
      });
      yield* acceptReturnEvidence(refundCase.native.database, refundCase.scope, {
        amountMinor: 40_000,
        economicEffectKey: 'gopay:refund:prior-full',
        operationId: refundCase.payment.collectOperationId,
        paymentId: refundCase.payment.paymentId,
        sourceAuthorityId: authority,
        sourceOccurrenceId: 'gopay-prior-full-return-1',
      });
      const returnId = yield* returnObservationIdOf(refundCase, 'gopay:refund:prior-full');
      const over = [refundItem('A', 80_000)] satisfies readonly [unknown, ...unknown[]];
      const correction = yield* acceptObservation(refundCase, {
        amount: CZK(40_000),
        correctsObservationId: returnId,
        factFamily: 'GATEWAY_OUTCOME',
        factKind: 'SOURCE_CORRECTION',
        paymentId: refundCase.payment.paymentId,
        source: GATEWAY_SOURCE,
        sourceOccurrenceId: 'gopay-prior-full-correction-1',
        sourceRevision: 0,
      });
      expect(correction.acceptanceOutcome).toBe('ACCEPTED_OBSERVATION');
      // The whole 400 CZK return was erroneous: 1000 CZK is refundable again, so 800 CZK is permitted.
      expect(
        yield* refundOutcome(
          requestRefund(refundCase, itemsRefund(refundCase, 'over-released', over), { items: over }),
        ),
      ).toBe('committed');
    }),
  ),
);

it.live(
  '#1151 governed attach then close of an uncorrelated REFUND_CONFIRMED releases the Payment: the attached return is counted once',
  () =>
    native(
      Effect.gen(function* attachedReturnThenClosed() {
        const refundCase = yield* refundCaseFor(yield* nativeRuntime, { amountMinor: 100_000, collected: true });
        const first = yield* requestRefund(refundCase, itemsRefund(refundCase, 'refund-a', [A]), owners);
        const uncorrelated = yield* refundConfirmed(refundCase, {
          economicEffectKey: 'gopay:refund:1',
          occurrence: 'gopay-settlement-refund-1',
        });
        expect(uncorrelated.acceptanceOutcome).toBe('HELD_UNRESOLVED');
        const caseId = uncorrelated.reconciliationCaseId ?? '';
        const attached = yield* decideReconciliation(refundCase, {
          caseId,
          decision: {
            _tag: 'ATTACH_EVIDENCE',
            observationId: uncorrelated.observationId,
            operationId: first.operation.operationId,
          },
          reason: 'The settlement line is the first refund',
        });
        expect(Option.getOrUndefined(attached.outcomeChange)).toMatchObject({ toOutcome: 'EFFECT_CONFIRMED' });
        const closed = yield* decideReconciliation(refundCase, {
          caseId,
          decision: { _tag: 'CLOSE_CASE', evidenceRef: uncorrelated.observationId },
          reason: 'The attached return is accounted for',
        });
        expect(closed.caseStatus).toBe('CLOSED');
        // No reconciliation case of this Payment is still open: nothing but the attached return is pending.
        const openCases = (yield* refundCase.native.coreAdmin
          .select()
          .from(reconciliationCases)
          .where(eq(reconciliationCases.paymentId, refundCase.payment.paymentId))).filter(
          (row) => row.status === 'OPEN',
        );
        expect(openCases).toHaveLength(0);
        // 90 000 CZK remains after the one 10 000 CZK return: a further 90 000 CZK refund is permitted.
        const next = yield* refundOutcome(
          requestRefund(refundCase, itemsRefund(refundCase, 'refund-p', [P90]), owners),
        );
        expect(next).toBe('committed');
      }),
    ),
);
