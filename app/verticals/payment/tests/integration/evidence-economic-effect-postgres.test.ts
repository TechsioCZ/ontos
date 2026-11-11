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
import { configurePaymentSourceAuthorityAction } from '../../src/actions/configure-payment-source-authority.action.ts';
import { paymentRegistration } from '../../vertical.registration.ts';

import { failureCodeOf, paymentTestRelations, randomUuid } from './database-fixture.ts';
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
  loadPaymentAggregate,
  refundRuntimeContextAccess,
  refundRuntimePermission,
  transitionOperation,
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

/** The GoPay refund execution account as a method-neutral refund route authority. */
const neutralRefundAuthority = {
  factFamily: 'REFUND_EXECUTION',
  reason: 'GoPay executes and reports refunds of this account',
  refundRoute: true,
  source: gopayRefundExecution,
  status: 'ACTIVE',
} as const;

/** The same GoPay account and source binding, configured for online gateway Payments specifically. */
const onlineGatewayRefundAuthority = { ...neutralRefundAuthority, method: 'ONLINE_GATEWAY' } as const;

/** Configures one refund route authority through the registered Action, bound to the case principal. */
const configureRefundAuthority = Effect.fn('EconomicEffectTest.configureRefundAuthority')(function* configure(
  refundCase: RefundCase,
  configuration: typeof neutralRefundAuthority | typeof onlineGatewayRefundAuthority,
) {
  const key = yield* randomUuid;
  return yield* refundCase.native.actionRuntime.runAction({
    payload: { ...configuration, submitterPrincipalIds: [refundCase.scope.principalId] },
    principal: refundCase.principal,
    registration: configurePaymentSourceAuthorityAction,
    transport: { correlationId: 'payment-economic-effect-authority', idempotencyKey: key },
  });
});

/** The GoPay confirmation of the one 100 CZK return `gopay:refund:1`, correlated to `operationId`. */
const refundConfirmation = (refundCase: RefundCase, operationId: string, sourceOccurrenceId: string) =>
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
          refundConfirmation(refundCase, operationId, sourceOccurrenceId);
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

it.live(
  '#1151 one economic effect confirms one refund across the method-neutral and method-specific authorities of one source binding',
  () =>
    native(
      Effect.gen(function* sameBindingAcrossAuthorities() {
        const refundCase = yield* refundCaseFor(yield* nativeRuntime, {
          amountMinor: 100_000,
          collected: true,
          gatewayRoute: false,
        });
        const neutral = yield* configureRefundAuthority(refundCase, neutralRefundAuthority);
        const A = refundItem('A', 10_000);
        const B = refundItem('B', 10_000);
        const owners = { items: [A, B] };
        const first = yield* requestRefund(refundCase, itemsRefund(refundCase, 'refund-a', [A]), owners);
        const confirmation = (operationId: string, sourceOccurrenceId: string) =>
          refundConfirmation(refundCase, operationId, sourceOccurrenceId);
        // The method-neutral authority confirms the 100 CZK return for the first refund.
        const confirmed = yield* confirmation(first.operation.operationId, 'gopay-callback-refund-1');
        expect(confirmed.acceptanceOutcome).toBe('ACCEPTED_OBSERVATION');
        expect(confirmed.sourceAuthorityId).toBe(neutral.sourceAuthorityId);
        // The same GoPay account is then also configured for online gateway Payments specifically.
        const specific = yield* configureRefundAuthority(refundCase, onlineGatewayRefundAuthority);
        expect(specific.sourceAuthorityId).not.toBe(neutral.sourceAuthorityId);
        const second = yield* requestRefund(refundCase, itemsRefund(refundCase, 'refund-b', [B]), owners);
        expect(first.executionRoute?.sourceAuthorityId).toBe(neutral.sourceAuthorityId);
        expect(second.executionRoute?.sourceAuthorityId).toBe(specific.sourceAuthorityId);
        // The same source's lookup of that return, now qualified by the method-specific authority,
        // is correlated to the second refund: one effect of one source binding cannot confirm it too.
        const reused = yield* confirmation(second.operation.operationId, 'gopay-lookup-refund-1');
        expect(reused.acceptanceOutcome).toBe('HELD_UNRESOLVED');
        expect(reused.sourceAuthorityId).toBe(specific.sourceAuthorityId);

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

it.live(
  '#1151 one economic effect confirms one refund: governed attachment never counts an effect of the same source binding twice across its authorities',
  () =>
    native(
      Effect.gen(function* attachAcrossAuthorities() {
        const refundCase = yield* refundCaseFor(yield* nativeRuntime, {
          amountMinor: 100_000,
          collected: true,
          gatewayRoute: false,
        });
        yield* configureRefundAuthority(refundCase, neutralRefundAuthority);
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
        // The method-neutral authority confirms the 100 CZK return for the first refund.
        const confirmed = yield* acceptObservation(refundCase, {
          ...statement,
          operationId: first.operation.operationId,
          sourceOccurrenceId: 'gopay-callback-refund-1',
        });
        expect(confirmed.acceptanceOutcome).toBe('ACCEPTED_OBSERVATION');
        yield* configureRefundAuthority(refundCase, onlineGatewayRefundAuthority);
        // The method-specific authority reports the same return without naming a refund: held.
        const uncorrelated = yield* acceptObservation(refundCase, {
          ...statement,
          sourceOccurrenceId: 'gopay-settlement-refund-1',
        });
        expect(uncorrelated.acceptanceOutcome).toBe('HELD_UNRESOLVED');
        // Governance cannot attach that already counted return to the second refund.
        const attachSecond = decideReconciliation(refundCase, {
          caseId: uncorrelated.reconciliationCaseId ?? '',
          decision: {
            _tag: 'ATTACH_EVIDENCE',
            observationId: uncorrelated.observationId,
            operationId: second.operation.operationId,
          },
          reason: 'The settlement line is the second refund',
        });
        expect(yield* failureCodeOf(attachSecond)).toBe('payment_reconciliation_evidence_not_qualified');

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

/** The GoPay gateway account as the configured collection outcome authority. */
const gatewayOutcomeAuthority = {
  factFamily: 'GATEWAY_OUTCOME',
  reason: 'GoPay reports collections of this account',
  refundRoute: false,
  source: gopayRefundExecution,
  status: 'ACTIVE',
} as const;

it.live(
  '#1151 a second charge confirmed for a collection established by governed attachment is held, not counted once',
  () =>
    native(
      Effect.gen(function* attachedCollectionSecondCharge() {
        const refundCase = yield* refundCaseFor(yield* nativeRuntime, { amountMinor: 100_000, collected: false });
        const key = yield* randomUuid;
        yield* refundCase.native.actionRuntime.runAction({
          payload: { ...gatewayOutcomeAuthority, submitterPrincipalIds: [refundCase.scope.principalId] },
          principal: refundCase.principal,
          registration: configurePaymentSourceAuthorityAction,
          transport: { correlationId: 'payment-economic-effect-authority', idempotencyKey: key },
        });
        const collectionStatement = {
          amount: { amountMinor: 100_000, currency: 'CZK' },
          factFamily: 'GATEWAY_OUTCOME',
          factKind: 'COLLECTION_CONFIRMED',
          paymentId: refundCase.payment.paymentId,
          source: gopayRefundExecution,
          sourceRevision: 0,
        } as const;
        // Contradictory signals left the collection in CONFLICT: a report of charge 1 waits as held debt.
        yield* transitionOperation(refundCase.native.database, refundCase.scope, {
          operationId: refundCase.payment.collectOperationId,
          paymentId: refundCase.payment.paymentId,
          to: 'CONFLICT',
        });
        const heldCharge = yield* acceptObservation(refundCase, {
          ...collectionStatement,
          economicEffectKey: 'gopay:charge:1',
          sourceOccurrenceId: 'gopay-settlement-charge-1',
        });
        expect(heldCharge.acceptanceOutcome).toBe('HELD_UNRESOLVED');
        // Governed reconciliation attaches charge 1 to the collection, which confirms it.
        const attached = yield* decideReconciliation(refundCase, {
          caseId: heldCharge.reconciliationCaseId ?? '',
          decision: {
            _tag: 'ATTACH_EVIDENCE',
            observationId: heldCharge.observationId,
            operationId: refundCase.payment.collectOperationId,
          },
          reason: 'The settlement line is the collection',
        });
        expect(Option.getOrUndefined(attached.outcomeChange)).toMatchObject({ toOutcome: 'EFFECT_CONFIRMED' });
        // A partial correction of the attached charge 1 reduces it; it must not erase charge 1's identity.
        const partialCorrection = yield* acceptObservation(refundCase, {
          amount: { amountMinor: 10_000, currency: 'CZK' },
          correctsObservationId: heldCharge.observationId,
          economicEffectKey: 'gopay:charge:1:correction',
          factFamily: 'GATEWAY_OUTCOME',
          factKind: 'SOURCE_CORRECTION',
          paymentId: refundCase.payment.paymentId,
          source: gopayRefundExecution,
          sourceOccurrenceId: 'gopay-settlement-charge-1-correction',
          sourceRevision: 0,
        });
        expect(partialCorrection).toMatchObject({
          acceptanceOutcome: 'ACCEPTED_OBSERVATION',
          interpretation: 'CORRECTION',
        });
        // A different charge 2 confirmed for the same collection is evidence of a second charge: debt.
        const secondCharge = yield* acceptObservation(refundCase, {
          ...collectionStatement,
          economicEffectKey: 'gopay:charge:2',
          operationId: refundCase.payment.collectOperationId,
          sourceOccurrenceId: 'gopay-callback-charge-2',
        });
        expect(secondCharge.acceptanceOutcome).toBe('HELD_UNRESOLVED');
        expect(secondCharge.reconciliationCaseId).toBeDefined();
      }),
    ),
);
