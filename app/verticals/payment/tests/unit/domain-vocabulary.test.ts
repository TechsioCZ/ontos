import { describe, expect, it } from 'effect-rstest';
import { Effect, Schema } from 'effect';

import { paymentUnavailableOwnerPortsLive } from '../support/unavailable-owner-ports.fixture.ts';
import {
  PaymentBankAccountingReceiptBindingSchema,
  PaymentExecutionBindingSchema,
  PaymentGatewayAccountBindingSchema,
} from '../../shared/domain/payment-execution-binding.ts';
import {
  PaymentOperationKeySchema,
  PaymentPurchaseCorrelationIdSchema,
} from '../../shared/domain/payment-identifiers.ts';
import {
  PaymentFailedCommitmentCompensationBasisSchema,
  PaymentRefundBasisSchema,
} from '../../shared/domain/payment-refund-basis.ts';
import {
  PAYMENT_APPLICABILITY_OUTCOMES,
  PAYMENT_METHODS,
  PAYMENT_OPERATION_KINDS,
  PAYMENT_OPERATION_OUTCOMES,
} from '../../shared/domain/payment-vocabulary.ts';
import { CommitmentOutcomePort } from '../../src/ports/commitment-outcome-port.ts';
import { PaymentOwnerEvidenceUnavailable } from '../../src/ports/owner-evidence-unavailable.ts';
import { DeliveryCapabilityPort } from '../../src/ports/delivery-capability-port.ts';
import { PaymentTermEvidencePort } from '../../src/ports/payment-term-evidence-port.ts';
import { PickupCapabilityPort } from '../../src/ports/pickup-capability-port.ts';
import { RefundableItemsPort } from '../../src/ports/refundable-items-port.ts';

const scope = {
  legalEntityId: '22222222-2222-4222-8222-222222222222',
  tenantId: '11111111-1111-4111-8111-111111111111',
};
const czk = { amountMinor: 1000, currency: 'CZK' } as const;

describe('#1145 canonical Payment vocabulary', () => {
  it('keeps the accepted Launch methods, operation kinds, outcomes and applicability outcomes', () => {
    expect(PAYMENT_METHODS).toEqual([
      'ONLINE_GATEWAY',
      'BANK_TRANSFER_ADVANCE',
      'CASH_ON_DELIVERY',
      'DEFERRED_INVOICE',
      'PAY_ON_PICKUP_OR_ON_SITE',
    ]);
    expect(PAYMENT_OPERATION_KINDS).toEqual(['COLLECT', 'CANCEL_OR_VOID', 'REFUND']);
    expect(PAYMENT_OPERATION_OUTCOMES).toEqual([
      'PENDING',
      'EFFECT_CONFIRMED',
      'NOT_EFFECTED_CONFIRMED',
      'INDETERMINATE',
      'CONFLICT',
    ]);
    expect(PAYMENT_APPLICABILITY_OUTCOMES).toHaveLength(7);
  });

  it('#1148 Exactly one refund basis: mixed or incomplete compensation bases do not decode', () => {
    const decode = Schema.decodeUnknownSync(PaymentRefundBasisSchema);
    const compensation = {
      _tag: 'FAILED_COMMITMENT_COMPENSATION',
      attemptRef: 'attempt-1',
      closedAgainstLateCommit: true,
      terminalNonCommitEvidenceRef: 'commitment:closure:1',
    } as const;

    expect(Schema.is(PaymentFailedCommitmentCompensationBasisSchema)(decode(compensation))).toBe(true);
    expect(() => decode({ ...compensation, closedAgainstLateCommit: false })).toThrow();
    expect(() => decode({ _tag: 'REFUNDABLE_ITEMS' })).toThrow();
    expect(() => decode({ ...compensation, _tag: 'MIXED' })).toThrow();
  });

  it('#1148 bindings are exact and method-specific', () => {
    const decode = Schema.decodeUnknownSync(PaymentExecutionBindingSchema);

    const gateway = decode({
      _tag: 'GATEWAY_ACCOUNT',
      environment: 'production',
      providerAccountRef: 'acct-1',
      providerFamily: 'GOPAY',
    });
    expect(Schema.is(PaymentGatewayAccountBindingSchema)(gateway)).toBe(true);
    expect(() =>
      decode({
        _tag: 'GATEWAY_ACCOUNT',
        environment: 'production',
        providerAccountRef: 'acct-1',
        providerFamily: 'PAYPAL',
      }),
    ).toThrow();
    expect(Schema.is(PaymentBankAccountingReceiptBindingSchema)(decode({ _tag: 'BANK_ACCOUNTING_RECEIPT' }))).toBe(
      true,
    );
  });

  it('keeps caller business keys printable and foreign references trimmed and bounded', () => {
    expect(() => Schema.decodeUnknownSync(PaymentOperationKeySchema)('has space')).toThrow();
    expect(Schema.decodeUnknownSync(PaymentOperationKeySchema)('collect-1')).toBe('collect-1');
    expect(() => Schema.decodeUnknownSync(PaymentPurchaseCorrelationIdSchema)(' padded ')).toThrow();
    expect(() => Schema.decodeUnknownSync(PaymentPurchaseCorrelationIdSchema)('x'.repeat(201))).toThrow();
  });
});

describe('H1094-01=A owner ports fail closed by default', () => {
  it.effect('every production-default port is explicitly unavailable, never absence', () =>
    Effect.gen(function* unavailablePorts() {
      const termEvidence = yield* PaymentTermEvidencePort;
      const delivery = yield* DeliveryCapabilityPort;
      const pickup = yield* PickupCapabilityPort;
      const commitment = yield* CommitmentOutcomePort;
      const refundableItems = yield* RefundableItemsPort;
      const failures = yield* Effect.all(
        [
          termEvidence
            .verifyTermUse({
              customerConfigurationId: 'configuration-1',
              method: 'DEFERRED_INVOICE',
              paymentTermRef: {
                moduleId: 'payment.term-catalog',
                resourceId: '33333333-3333-4333-8333-333333333333',
                resourceType: 'payment.term-catalog.payment-term',
                tenantId: scope.tenantId,
              },
              purchase: {
                _tag: 'PURCHASING_CONTEXT',
                purchasingContext: {
                  channelId: 'web-cz',
                  contextRef: 'purchasing-context-1',
                  contextRevision: '1',
                  marketId: 'market-cz',
                  subject: { guestEvidenceRef: 'guest-evidence-1', guestSessionRef: 'guest-session-1', kind: 'GUEST' },
                },
              },
              scope,
            })
            .pipe(Effect.flip),
          delivery.verifyCashOnDelivery({ amount: czk, deliveryOfferRef: 'offer-1', scope }).pipe(Effect.flip),
          pickup.verifyPickupCollection({ amount: czk, pickupCapabilityRef: 'pickup-1', scope }).pipe(Effect.flip),
          commitment
            .verifyTerminalNonCommit({
              attemptRef: 'attempt-1',
              purchaseCorrelationId: 'purchase-1',
              scope,
              terminalNonCommitEvidenceRef: 'closure-1',
            })
            .pipe(Effect.flip),
          refundableItems
            .verifyRefundableItems({ itemRefs: ['A'], purchaseCorrelationId: 'purchase-1', scope })
            .pipe(Effect.flip),
        ],
        { concurrency: 1 },
      );

      expect(failures.every((failure) => Schema.is(PaymentOwnerEvidenceUnavailable)(failure))).toBe(true);
      expect(failures.map((failure) => failure.port)).toEqual([
        'PAYMENT_TERM_EVIDENCE',
        'DELIVERY_CAPABILITY',
        'PICKUP_CAPABILITY',
        'COMMITMENT_OUTCOME',
        'REFUNDABLE_ITEMS',
      ]);
    }).pipe(Effect.provide(paymentUnavailableOwnerPortsLive)),
  );
});
