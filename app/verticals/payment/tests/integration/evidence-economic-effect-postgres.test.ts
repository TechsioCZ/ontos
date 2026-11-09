import { NodeCrypto } from '@effect/platform-node';
import { Array as Arr, Crypto, Effect, Option, Order } from 'effect';
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
import { paymentRegistration } from '../../vertical.registration.ts';

import { paymentTestRelations } from './database-fixture.ts';
import {
  acceptObservation,
  decideReconciliation,
  itemsRefund,
  refundCaseFor,
  refundItem,
  requestRefund,
} from '../support/refund-action-driver.ts';
import {
  loadPaymentAggregate,
  refundRuntimeContextAccess,
  refundRuntimePermission,
} from '../support/refund-native-runtime.ts';
import type { RefundNativeRuntime } from '../support/refund-native-runtime.ts';

/**
 * #1151 "Several observations proven to describe the same economic effect count once" through the
 * registered acceptance Action on native PostgreSQL: one source economic effect never confirms two
 * different Payment Operations.
 */

const native = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(effect).pipe(Effect.provide(NodeCrypto.layer));

const nativeRuntime = Effect.gen(function* acquireEvidenceNativeRuntime() {
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

const gopayRefundExecution = {
  accountRef: 'gopay-account-1',
  environment: 'production',
  sourceKind: 'PAYMENT_GATEWAY',
  sourceSystem: 'GOPAY',
} as const;

it.live(
  '#1151 one economic effect confirms one refund: a second occurrence of the same effect for another pending refund is held',
  () =>
    native(
      Effect.gen(function* oneEffectOneRefund() {
        const refundCase = yield* refundCaseFor(yield* nativeRuntime, { amountMinor: 100_000, collected: true });
        const A = refundItem('A', 10_000);
        const B = refundItem('B', 10_000);
        const owners = { items: [A, B] };
        const first = yield* requestRefund(refundCase, itemsRefund(refundCase, 'refund-a', [A]), owners);
        const second = yield* requestRefund(refundCase, itemsRefund(refundCase, 'refund-b', [B]), owners);
        const confirmation = (operationId: string, sourceOccurrenceId: string) =>
          acceptObservation(refundCase, {
            amount: { amountMinor: 10_000, currency: 'CZK' },
            economicEffectKey: 'gopay:refund:1',
            factFamily: 'REFUND_EXECUTION',
            factKind: 'REFUND_CONFIRMED',
            operationId,
            paymentId: refundCase.payment.paymentId,
            source: gopayRefundExecution,
            sourceOccurrenceId,
            sourceRevision: 0,
          });
        // The provider's callback confirms the 100 CZK return for the first refund.
        const confirmed = yield* confirmation(first.operation.operationId, 'gopay-callback-refund-1');
        expect(confirmed.acceptanceOutcome).toBe('ACCEPTED_OBSERVATION');
        // A lookup of the same 100 CZK return is correlated to the second refund: it cannot confirm it too.
        const reused = yield* confirmation(second.operation.operationId, 'gopay-lookup-refund-1');
        expect(reused.acceptanceOutcome).toBe('HELD_UNRESOLVED');
        expect(reused.reconciliationCaseId).toBeDefined();

        const aggregate = yield* loadPaymentAggregate(
          refundCase.native.database,
          refundCase.scope,
          refundCase.payment.paymentId,
        );
        const refunds = aggregate.operations.filter((operation) => operation.kind === 'REFUND');
        const outcomes = refunds.map((operation) => operation.outcome);
        expect(Arr.sort(outcomes, Order.String)).toEqual(['EFFECT_CONFIRMED', 'PENDING']);
        const returnedMinor = refunds
          .filter((operation) => operation.outcome === 'EFFECT_CONFIRMED')
          .reduce((total, operation) => total + operation.amount.amountMinor, 0);
        expect(returnedMinor).toBe(10_000);
      }),
    ),
);

it.live(
  '#1151 one economic effect confirms one refund: an effect attached to one refund by reconciliation never confirms another',
  () =>
    native(
      Effect.gen(function* attachedEffectOneRefund() {
        const refundCase = yield* refundCaseFor(yield* nativeRuntime, { amountMinor: 100_000, collected: true });
        const A = refundItem('A', 10_000);
        const B = refundItem('B', 10_000);
        const owners = { items: [A, B] };
        const first = yield* requestRefund(refundCase, itemsRefund(refundCase, 'refund-a', [A]), owners);
        const second = yield* requestRefund(refundCase, itemsRefund(refundCase, 'refund-b', [B]), owners);
        const statement = {
          amount: { amountMinor: 10_000, currency: 'CZK' },
          economicEffectKey: 'gopay:refund:1',
          factFamily: 'REFUND_EXECUTION',
          factKind: 'REFUND_CONFIRMED',
          paymentId: refundCase.payment.paymentId,
          source: gopayRefundExecution,
          sourceRevision: 0,
        } as const;
        // The provider reports the 100 CZK return without saying which refund it was: held.
        const uncorrelated = yield* acceptObservation(refundCase, {
          ...statement,
          sourceOccurrenceId: 'gopay-settlement-refund-1',
        });
        expect(uncorrelated.acceptanceOutcome).toBe('HELD_UNRESOLVED');
        // Governed reconciliation attaches that return to the first refund.
        const attached = yield* decideReconciliation(refundCase, {
          caseId: uncorrelated.reconciliationCaseId ?? '',
          decision: {
            _tag: 'ATTACH_EVIDENCE',
            observationId: uncorrelated.observationId,
            operationId: first.operation.operationId,
          },
          reason: 'The settlement line is the first refund',
        });
        expect(Option.getOrUndefined(attached.outcomeChange)).toMatchObject({ toOutcome: 'EFFECT_CONFIRMED' });
        // A lookup of the same 100 CZK return is correlated to the second refund: it cannot confirm it too.
        const reused = yield* acceptObservation(refundCase, {
          ...statement,
          operationId: second.operation.operationId,
          sourceOccurrenceId: 'gopay-lookup-refund-1',
        });
        expect(reused.acceptanceOutcome).toBe('HELD_UNRESOLVED');

        const aggregate = yield* loadPaymentAggregate(
          refundCase.native.database,
          refundCase.scope,
          refundCase.payment.paymentId,
        );
        const outcomeOf = (operationId: string) =>
          aggregate.operations.find((operation) => operation.operationId === operationId)?.outcome;
        expect(outcomeOf(first.operation.operationId)).toBe('EFFECT_CONFIRMED');
        expect(outcomeOf(second.operation.operationId)).toBe('PENDING');
      }),
    ),
);
