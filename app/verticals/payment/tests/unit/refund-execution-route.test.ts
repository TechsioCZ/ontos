import { Option } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import type { PaymentExecutionBinding } from '../../shared/domain/payment-execution-binding.ts';
import { decideRefundExecutionRoute, RefundRouteDecision } from '../../src/domain/refund-execution-route.ts';
import type { PaymentRefundRouteCandidate, RefundRouteDecisionCase } from '../../src/domain/refund-execution-route.ts';

/** #1150 / #1152 refund execution authority by original collection method. */

const gateway: PaymentExecutionBinding = {
  _tag: 'GATEWAY_ACCOUNT',
  environment: 'production',
  providerAccountRef: 'gopay-account-1',
  providerFamily: 'GOPAY',
};
const bank: PaymentExecutionBinding = { _tag: 'BANK_ACCOUNTING_RECEIPT' };
const cod: PaymentExecutionBinding = {
  _tag: 'COD_DELIVERY_OFFER',
  capabilityEvidenceRef: 'cod-evidence',
  carrier: { accountRef: 'carrier-cod-account', environment: 'production', sourceSystem: 'ppl' },
  deliveryOfferRef: 'offer-1',
};
const pickup: PaymentExecutionBinding = {
  _tag: 'PICKUP_CAPABILITY',
  capabilityEvidenceRef: 'pickup-evidence',
  pickupCapabilityRef: 'store-1',
};

let sequence = 0;
const candidate = (overrides: Partial<PaymentRefundRouteCandidate>): PaymentRefundRouteCandidate => {
  sequence += 1;
  return {
    accountRef: 'merchant-bank',
    environment: 'production',
    factFamily: 'REFUND_EXECUTION',
    method: Option.none(),
    refundRoute: true,
    revision: 1,
    sourceAuthorityId: `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
    sourceKind: 'BANK_ACCOUNTING',
    sourceSystem: 'erp-primary',
    status: 'ACTIVE',
    ...overrides,
  };
};
const originalGateway = (overrides: Partial<PaymentRefundRouteCandidate> = {}) =>
  candidate({
    accountRef: 'gopay-account-1',
    method: Option.some('ONLINE_GATEWAY'),
    sourceKind: 'PAYMENT_GATEWAY',
    sourceSystem: 'GOPAY',
    ...overrides,
  });

const routeKindOf = (decision: RefundRouteDecisionCase): string =>
  RefundRouteDecision.$match(decision, {
    Ambiguous: () => 'Ambiguous',
    Resolved: ({ route }) => route.routeKind,
    Unavailable: () => 'Unavailable',
  });
const reasonOf = (decision: RefundRouteDecisionCase): string =>
  RefundRouteDecision.$match(decision, {
    Ambiguous: () => 'Ambiguous',
    Resolved: () => 'Resolved',
    Unavailable: ({ reason }) => reason,
  });
const authorityOf = (decision: RefundRouteDecisionCase): string =>
  RefundRouteDecision.$match(decision, {
    Ambiguous: () => 'Ambiguous',
    Resolved: ({ route }) => route.sourceAuthorityId,
    Unavailable: () => 'Unavailable',
  });

describe('#1150 refund execution route', () => {
  it('#1150 gateway refunds use only the exact original provider account and environment', () => {
    expect(
      routeKindOf(
        decideRefundExecutionRoute({ binding: gateway, candidates: [originalGateway()], method: 'ONLINE_GATEWAY' }),
      ),
    ).toBe('ORIGINAL_GATEWAY_BINDING');
    const foreign = [
      originalGateway({ accountRef: 'gopay-account-2' }),
      originalGateway({ environment: 'sandbox' }),
      originalGateway({ sourceSystem: 'STRIPE' }),
      originalGateway({ status: 'REVOKED' }),
      originalGateway({ refundRoute: false }),
      originalGateway({ factFamily: 'GATEWAY_OUTCOME' }),
    ];
    expect(
      reasonOf(decideRefundExecutionRoute({ binding: gateway, candidates: foreign, method: 'ONLINE_GATEWAY' })),
    ).toBe('ORIGINAL_BINDING_UNAVAILABLE');
  });

  it('#1150 a gateway Payment without a gateway binding is a binding mismatch, never a fallback', () => {
    expect(
      reasonOf(decideRefundExecutionRoute({ binding: bank, candidates: [candidate({})], method: 'ONLINE_GATEWAY' })),
    ).toBe('BINDING_METHOD_MISMATCH');
  });

  it('#1150 bank transfer, deferred invoice and COD use the merchant bank/accounting route', () => {
    for (const [method, binding] of [
      ['BANK_TRANSFER_ADVANCE', bank],
      ['DEFERRED_INVOICE', bank],
      ['CASH_ON_DELIVERY', cod],
    ] as const) {
      expect(routeKindOf(decideRefundExecutionRoute({ binding, candidates: [candidate({})], method }))).toBe(
        'BANK_ACCOUNTING',
      );
    }
  });

  it('#1150 a carrier is never assumed to be a reverse-refund rail for COD', () => {
    const carrier = candidate({ method: Option.some('CASH_ON_DELIVERY'), sourceKind: 'CARRIER', sourceSystem: 'ppl' });
    expect(
      reasonOf(decideRefundExecutionRoute({ binding: cod, candidates: [carrier], method: 'CASH_ON_DELIVERY' })),
    ).toBe('NO_CONFIGURED_ROUTE');
  });

  it('#1150 an exact-method route wins over a method-neutral one and two of a kind conflict', () => {
    const exact = candidate({ method: Option.some('BANK_TRANSFER_ADVANCE') });
    const neutral = candidate({ accountRef: 'neutral-bank' });
    const decision = decideRefundExecutionRoute({
      binding: bank,
      candidates: [neutral, exact],
      method: 'BANK_TRANSFER_ADVANCE',
    });
    expect(authorityOf(decision)).toBe(exact.sourceAuthorityId);
    const ambiguous = decideRefundExecutionRoute({
      binding: bank,
      candidates: [neutral, candidate({ accountRef: 'second-neutral-bank' })],
      method: 'DEFERRED_INVOICE',
    });
    expect(RefundRouteDecision.$is('Ambiguous')(ambiguous)).toBe(true);
  });

  it('#1150 pickup uses the POS route, else only an explicitly authorized bank/manual route', () => {
    const pos = candidate({ sourceKind: 'LOCAL_POS_OPERATOR', sourceSystem: 'store-pos' });
    const manualPickup = candidate({
      method: Option.some('PAY_ON_PICKUP_OR_ON_SITE'),
      sourceKind: 'MANUAL_EXTERNAL_REFUND',
      sourceSystem: 'finance-desk',
    });
    const manualNeutral = candidate({ sourceKind: 'MANUAL_EXTERNAL_REFUND', sourceSystem: 'finance-desk' });
    const method = 'PAY_ON_PICKUP_OR_ON_SITE';
    expect(routeKindOf(decideRefundExecutionRoute({ binding: pickup, candidates: [manualPickup, pos], method }))).toBe(
      'LOCAL_POS',
    );
    expect(routeKindOf(decideRefundExecutionRoute({ binding: pickup, candidates: [manualPickup], method }))).toBe(
      'MANUAL_EXTERNAL',
    );
    expect(reasonOf(decideRefundExecutionRoute({ binding: pickup, candidates: [manualNeutral], method }))).toBe(
      'NO_CONFIGURED_ROUTE',
    );
    expect(
      routeKindOf(
        decideRefundExecutionRoute({
          binding: pickup,
          candidates: [candidate({ method: Option.some(method) })],
          method,
        }),
      ),
    ).toBe('BANK_ACCOUNTING');
  });
});
