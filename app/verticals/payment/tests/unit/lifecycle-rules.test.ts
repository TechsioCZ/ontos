import { Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { mapCreatePaymentActionProblem } from '../../api/create-payment-action-problems.ts';
import { mapStartPaymentCollectionActionProblem } from '../../api/start-payment-collection-action-problems.ts';
import { CreatePaymentPayloadSchema } from '../../shared/actions/create-payment.ts';
import { paymentCollectionRefused } from '../../shared/domain/lifecycle-collection-refused.ts';
import { paymentLifecycleConflict } from '../../shared/domain/lifecycle-conflict.ts';
import { paymentMethodNotApplicable } from '../../shared/domain/lifecycle-method-not-applicable.ts';
import type { PaymentNotAvailableApplicabilityOutcome } from '../../shared/domain/applicability-contract.ts';
import { paymentConflict } from '../../shared/domain/payment-conflict.ts';
import { paymentRejected } from '../../shared/domain/payment-rejected.ts';
import type { PaymentFundsOperation, PaymentFundsSnapshot } from '../../src/domain/coverage.ts';
import {
  PaymentCoverageEstablishedSchema,
  PaymentCoverageHeldSchema,
  PaymentCoverageNotCollectedSchema,
  PaymentCoverageZeroPayableSchema,
} from '../../shared/domain/lifecycle-views.ts';
import {
  PredecessorReleaseDecision,
  collectionMaterialRequest,
  collectionMatchesPayment,
  coverageSummaryOf,
  decidePredecessorRelease,
  decidePurchaseRelease,
  isSameIntentMaterial,
  selectionMatchesBinding,
} from '../../src/domain/lifecycle-intent.ts';
import type { PersistedPaymentIntent, PredecessorBlockReason } from '../../src/domain/lifecycle-intent.ts';

const COLLECT_ID = '77777777-7777-4777-8777-777777777777';
const REFUND_ID = '88888888-8888-4888-8888-888888888888';
const czk = (amountMinor: number) => ({ amountMinor, currency: 'CZK' as const });
const gateway = {
  _tag: 'GATEWAY_ACCOUNT' as const,
  environment: 'production',
  providerAccountRef: 'gopay-1',
  providerFamily: 'GOPAY' as const,
};
const termRef = {
  moduleId: 'payment.term-catalog' as const,
  resourceId: '33333333-3333-4333-8333-333333333333',
  resourceType: 'payment.term-catalog.payment-term' as const,
  tenantId: '11111111-1111-4111-8111-111111111111',
};
const persisted: PersistedPaymentIntent = {
  amount: czk(100_000),
  customerConfigurationId: 'cfg',
  executionBinding: gateway,
  method: 'ONLINE_GATEWAY',
  paymentTermRef: termRef,
  purchaseCorrelationId: 'purchase-1',
};
const request = {
  customerConfigurationId: 'cfg',
  payableAmount: czk(100_000),
  paymentTermRef: termRef,
  predecessorPaymentId: Option.none<string>(),
  purchaseCorrelationId: 'purchase-1',
  selection: { method: 'ONLINE_GATEWAY' as const, selectedBinding: gateway },
};
const snapshot = (operations: readonly PaymentFundsOperation[], required = czk(100_000)): PaymentFundsSnapshot => ({
  collectionCorrections: [],
  operations,
  required,
  unresolvedEvidence: false,
});
const collect = (outcome: PaymentFundsOperation['outcome']): PaymentFundsOperation => ({
  amount: czk(100_000),
  kind: 'COLLECT',
  operationId: COLLECT_ID,
  outcome,
  targetOperationId: Option.getOrUndefined(Option.none<string>()),
});
const refund = (outcome: PaymentFundsOperation['outcome'], amountMinor = 100_000): PaymentFundsOperation => ({
  amount: czk(amountMinor),
  kind: 'REFUND',
  operationId: REFUND_ID,
  outcome,
  targetOperationId: COLLECT_ID,
});
const payloadWith = (payableAmount: { readonly amountMinor: number; readonly currency: string }) => ({
  customerConfigurationId: 'cfg',
  intentKey: 'intent-1',
  payableAmount,
  paymentTermRef: termRef,
  purchaseCorrelationId: 'purchase-1',
  purchasingContext: {
    channelId: 'web-cz',
    contextRef: 'purchasing-context-1',
    contextRevision: '1',
    marketId: 'market-cz',
    subject: { guestEvidenceRef: 'guest-evidence-1', guestSessionRef: 'guest-session-1', kind: 'GUEST' },
  },
  selection: { method: 'BANK_TRANSFER_ADVANCE' },
});
const blocked = (reason: PredecessorBlockReason, blockingOperationId = Option.none<string>()) =>
  PredecessorReleaseDecision.Blocked({ blockingOperationId, reason });
const released = PredecessorReleaseDecision.Released({ predecessorPaymentId: 'payment-1' });
const sibling = (paymentId: string, operations: readonly PaymentFundsOperation[]) => ({
  funds: snapshot(operations),
  operations,
  paymentId,
});
const predecessor = (operations: readonly PaymentFundsOperation[], successor = Option.none<string>()) =>
  decidePredecessorRelease({
    funds: snapshot(operations),
    operations,
    predecessorPaymentId: 'payment-1',
    successorPaymentId: successor,
  });

describe('#1148 lifecycle rules', () => {
  it('#1148 332.00 CZK is accepted only as the exact integer 33200 minor units', () => {
    const decode = Schema.decodeUnknownOption(CreatePaymentPayloadSchema);
    expect(
      Option.map(decode(payloadWith({ amountMinor: 33_200, currency: 'CZK' })), (value) => value.payableAmount),
    ).toStrictEqual(Option.some({ amountMinor: 33_200, currency: 'CZK' }));
    expect(Option.isNone(decode(payloadWith({ amountMinor: 332.0001, currency: 'CZK' })))).toBe(true);
    expect(Option.isNone(decode(payloadWith({ amountMinor: 33_200, currency: 'EUR' })))).toBe(true);
    expect(Option.isNone(decode(payloadWith({ amountMinor: -100, currency: 'CZK' })))).toBe(true);
  });

  it('#1148 the same intent material is a replay; every material change is a different intent', () => {
    expect(isSameIntentMaterial(persisted, request)).toBe(true);
    expect(isSameIntentMaterial(persisted, { ...request, payableAmount: czk(120_000) })).toBe(false);
    expect(isSameIntentMaterial(persisted, { ...request, purchaseCorrelationId: 'purchase-2' })).toBe(false);
    expect(isSameIntentMaterial(persisted, { ...request, predecessorPaymentId: Option.some('payment-0') })).toBe(false);
    expect(
      isSameIntentMaterial(persisted, {
        ...request,
        paymentTermRef: { ...termRef, resourceId: '44444444-4444-4444-8444-444444444444' },
      }),
    ).toBe(false);
    expect(isSameIntentMaterial(persisted, { ...request, selection: { method: 'BANK_TRANSFER_ADVANCE' } })).toBe(false);
  });

  it('#1148 a selection matches only the exact binding it created: account, environment, offer or capability', () => {
    expect(selectionMatchesBinding({ method: 'ONLINE_GATEWAY', selectedBinding: gateway }, gateway)).toBe(true);
    expect(
      selectionMatchesBinding(
        { method: 'ONLINE_GATEWAY', selectedBinding: { ...gateway, environment: 'sandbox' } },
        gateway,
      ),
    ).toBe(false);
    expect(selectionMatchesBinding({ method: 'ONLINE_GATEWAY' }, gateway)).toBe(false);
    const cod = {
      _tag: 'COD_DELIVERY_OFFER' as const,
      capabilityEvidenceRef: 'cap-1',
      carrier: { accountRef: 'carrier-account-1', environment: 'production', sourceSystem: 'ppl' },
      deliveryOfferRef: 'offer-1',
    };
    expect(selectionMatchesBinding({ deliveryOfferRef: 'offer-1', method: 'CASH_ON_DELIVERY' }, cod)).toBe(true);
    expect(selectionMatchesBinding({ deliveryOfferRef: 'offer-2', method: 'CASH_ON_DELIVERY' }, cod)).toBe(false);
    const pickup = {
      _tag: 'PICKUP_CAPABILITY' as const,
      capabilityEvidenceRef: 'cap-1',
      pickupCapabilityRef: 'desk-1',
    };
    expect(selectionMatchesBinding({ method: 'PAY_ON_PICKUP_OR_ON_SITE', pickupCapabilityRef: 'desk-1' }, pickup)).toBe(
      true,
    );
    const bank = { _tag: 'BANK_ACCOUNTING_RECEIPT' as const };
    expect(selectionMatchesBinding({ method: 'BANK_TRANSFER_ADVANCE' }, bank)).toBe(true);
    expect(selectionMatchesBinding({ method: 'DEFERRED_INVOICE' }, bank)).toBe(true);
    expect(selectionMatchesBinding({ method: 'BANK_TRANSFER_ADVANCE' }, gateway)).toBe(false);
  });

  it('#1148 predecessor release: unresolved, held, superseded and unreturned effects block a successor', () => {
    expect(predecessor([])).toStrictEqual(released);
    expect(predecessor([collect('NOT_EFFECTED_CONFIRMED')])).toStrictEqual(released);
    for (const outcome of ['PENDING', 'INDETERMINATE', 'CONFLICT'] as const) {
      expect(predecessor([collect(outcome)])).toStrictEqual(blocked('UNRESOLVED_OPERATION', Option.some(COLLECT_ID)));
    }
    expect(predecessor([collect('EFFECT_CONFIRMED')])).toStrictEqual(
      blocked('UNRETURNED_COLLECTION', Option.some(COLLECT_ID)),
    );
    expect(predecessor([collect('EFFECT_CONFIRMED'), refund('PENDING')])).toStrictEqual(
      blocked('UNRESOLVED_OPERATION', Option.some(REFUND_ID)),
    );
    expect(predecessor([collect('EFFECT_CONFIRMED'), refund('EFFECT_CONFIRMED', 40_000)])).toStrictEqual(
      blocked('UNRETURNED_COLLECTION', Option.some(COLLECT_ID)),
    );
    expect(predecessor([collect('EFFECT_CONFIRMED'), refund('EFFECT_CONFIRMED')])).toStrictEqual(released);
    expect(predecessor([], Option.some('payment-2'))).toStrictEqual(blocked('SUPERSEDED'));
    expect(
      decidePredecessorRelease({
        funds: { ...snapshot([]), unresolvedEvidence: true },
        operations: [],
        predecessorPaymentId: 'payment-1',
        successorPaymentId: Option.none(),
      }),
    ).toStrictEqual(blocked('HELD_EVIDENCE'));
  });

  it('#1145 every other intent of the purchase is an implicit predecessor; only superseding needs a name', () => {
    expect(decidePurchaseRelease([])).toStrictEqual(Option.none());
    expect(
      decidePurchaseRelease([sibling('payment-1', []), sibling('payment-2', [collect('NOT_EFFECTED_CONFIRMED')])]),
    ).toStrictEqual(Option.none());
    expect(
      decidePurchaseRelease([sibling('payment-1', []), sibling('payment-2', [collect('INDETERMINATE')])]),
    ).toStrictEqual(Option.some({ paymentId: 'payment-2', reason: 'UNRESOLVED_OPERATION' }));
    expect(decidePurchaseRelease([sibling('payment-1', [collect('EFFECT_CONFIRMED')])])).toStrictEqual(
      Option.some({ paymentId: 'payment-1', reason: 'UNRETURNED_COLLECTION' }),
    );
    expect(
      decidePurchaseRelease([sibling('payment-1', [collect('EFFECT_CONFIRMED'), refund('EFFECT_CONFIRMED')])]),
    ).toStrictEqual(Option.none());
  });

  it('#1148 partial or over-payment never matches the exact collection meaning', () => {
    const payment = { amount: czk(100_000), method: 'ONLINE_GATEWAY' as const };
    expect(collectionMatchesPayment(payment, { amount: czk(100_000), method: 'ONLINE_GATEWAY' })).toBe(true);
    expect(collectionMatchesPayment(payment, { amount: czk(99_999), method: 'ONLINE_GATEWAY' })).toBe(false);
    expect(collectionMatchesPayment(payment, { amount: czk(100_001), method: 'ONLINE_GATEWAY' })).toBe(false);
    expect(collectionMatchesPayment(payment, { amount: czk(100_000), method: 'CASH_ON_DELIVERY' })).toBe(false);
  });

  it('#1148 the COLLECT material request is independent of invocation, time and Composition revision', () => {
    const material = collectionMaterialRequest(
      'payment-1',
      { amount: czk(100_000), method: 'ONLINE_GATEWAY' },
      gateway,
    );
    expect(material).toStrictEqual({
      amountMinor: 100_000,
      binding: ['GATEWAY_ACCOUNT', 'GOPAY', 'gopay-1', 'production'],
      currency: 'CZK',
      kind: 'COLLECT',
      method: 'ONLINE_GATEWAY',
      paymentId: 'payment-1',
    });
  });

  it('#1148 coverage summary: zero payable, live collection, established and held states', () => {
    expect(coverageSummaryOf(snapshot([], czk(0)))).toStrictEqual(PaymentCoverageZeroPayableSchema.make({}));
    expect(coverageSummaryOf(snapshot([collect('PENDING')]))).toStrictEqual(
      PaymentCoverageNotCollectedSchema.make({ liveCollectOperationId: Option.some(COLLECT_ID) }),
    );
    expect(
      coverageSummaryOf(snapshot([collect('EFFECT_CONFIRMED'), refund('EFFECT_CONFIRMED', 40_000)])),
    ).toStrictEqual(
      PaymentCoverageEstablishedSchema.make({
        collected: czk(100_000),
        collectOperationId: COLLECT_ID,
        confirmedReturned: czk(40_000),
        remaining: czk(60_000),
        reserved: czk(0),
      }),
    );
    expect(coverageSummaryOf(snapshot([collect('CONFLICT')]))).toStrictEqual(
      PaymentCoverageHeldSchema.make({ reason: 'COLLECTION_IN_CONFLICT' }),
    );
  });
});

describe('#1148 lifecycle HTTP problems', () => {
  const outcomes: readonly (readonly [PaymentNotAvailableApplicabilityOutcome, string, number])[] = [
    ['NOT_ENABLED', 'payment_method_not_enabled', 422],
    ['INCOMPATIBLE_TERM', 'payment_method_term_incompatible', 422],
    ['UNSUPPORTED_CAPABILITY', 'payment_method_capability_unsupported', 422],
    ['MISSING_REQUIRED_INPUT', 'payment_method_input_required', 422],
    ['UNAVAILABLE_TO_VERIFY', 'payment_method_evidence_unavailable', 503],
    ['CONFLICTING_CONFIGURATION', 'payment_method_configuration_conflict', 409],
  ];
  it('#1147/#1148 every non-AVAILABLE applicability outcome maps to its own exact Problem code', () => {
    for (const [outcome, code, status] of outcomes) {
      const problem = mapCreatePaymentActionProblem(
        paymentMethodNotApplicable(outcome, [{ check: 'METHOD_ENABLEMENT', outcome, reason: 'NOT_CONFIGURED' }]),
      );
      expect(problem).toMatchObject({ code, status });
    }
  });

  it('#1148 lineage, meaning, zero payable, binding and scope refusals map to typed Problems', () => {
    expect(
      mapCreatePaymentActionProblem(paymentLifecycleConflict('payment_predecessor_unresolved_conflict', 'blocked')),
    ).toMatchObject({ code: 'payment_predecessor_unresolved_conflict', status: 409 });
    expect(mapCreatePaymentActionProblem(paymentConflict('payment_intent_material_conflict', 'changed'))).toMatchObject(
      {
        code: 'payment_intent_material_conflict',
        status: 409,
      },
    );
    expect(
      mapStartPaymentCollectionActionProblem(paymentConflict('payment_collect_lineage_conflict', 'competing')),
    ).toMatchObject({ code: 'payment_collect_lineage_conflict', status: 409 });
    expect(
      mapStartPaymentCollectionActionProblem(
        paymentLifecycleConflict('payment_collection_meaning_conflict', 'partial'),
      ),
    ).toMatchObject({ code: 'payment_collection_meaning_conflict', status: 409 });
    expect(
      mapStartPaymentCollectionActionProblem(paymentCollectionRefused('payment_zero_payable_no_collection', 'zero')),
    ).toMatchObject({ code: 'payment_zero_payable_no_collection', status: 422 });
    expect(
      mapStartPaymentCollectionActionProblem(paymentCollectionRefused('payment_binding_not_enabled', 'disabled')),
    ).toMatchObject({ code: 'payment_binding_not_enabled', status: 422 });
    expect(mapStartPaymentCollectionActionProblem(paymentRejected('payment_not_found', 'foreign'))).toMatchObject({
      code: 'payment_not_found',
      status: 404,
    });
  });
});
