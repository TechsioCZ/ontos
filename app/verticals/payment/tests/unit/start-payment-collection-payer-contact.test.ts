import { Effect, Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { mapStartPaymentCollectionActionProblem } from '../../api/start-payment-collection-action-problems.ts';
import {
  PaymentPayerContactRefused,
  StartPaymentCollectionPayloadSchema,
} from '../../shared/actions/start-payment-collection.ts';
import { StartPaymentCollectionActionIneligibleProblemSchema } from '../../shared/apis/start-payment-collection-action.ts';
import type { PaymentExecutionBinding } from '../../shared/domain/payment-execution-binding.ts';
import type { PaymentPayerContact } from '../../shared/domain/payment-payer-contact.ts';
import {
  payerContactProblemForBinding,
  startPaymentCollectionAction,
} from '../../src/actions/start-payment-collection.action.ts';
import { collectionMaterialRequest } from '../../src/domain/lifecycle-intent.ts';
import { computePaymentMaterialHash } from '../../src/persistence/payment-aggregate-persistence.ts';

/** #1153 #1154 plan D-P3: which payer contact a COLLECT needs depends only on the original binding. */

const gateway = (providerFamily: 'COMGATE' | 'GOPAY' | 'STRIPE'): PaymentExecutionBinding => ({
  _tag: 'GATEWAY_ACCOUNT',
  environment: 'SANDBOX',
  providerAccountRef: `pab_${providerFamily.toLowerCase()}`,
  providerFamily,
});

const NON_GATEWAY_BINDINGS: readonly PaymentExecutionBinding[] = [
  { _tag: 'BANK_ACCOUNTING_RECEIPT' },
  {
    _tag: 'COD_DELIVERY_OFFER',
    capabilityEvidenceRef: 'delivery:capability:1',
    carrier: { accountRef: 'carrier-account-1', environment: 'production', sourceSystem: 'carrier-1' },
    deliveryOfferRef: 'delivery:offer:1',
  },
  { _tag: 'PICKUP_CAPABILITY', capabilityEvidenceRef: 'pickup:capability:1', pickupCapabilityRef: 'pickup:1' },
];

const EMAIL_ONLY: PaymentPayerContact = { email: 'payer@example.test' };
const FULL: PaymentPayerContact = { email: 'payer@example.test', fullName: 'Test Payer', phone: '+420700000000' };

const problem = (binding: PaymentExecutionBinding, contact?: PaymentPayerContact) =>
  payerContactProblemForBinding(binding, Option.fromUndefinedOr(contact));

describe('#1153 H1094-01=A payer contact by original binding', () => {
  it('#1153 H1094-01=A A Stripe collection needs no contact and refuses one', () => {
    expect(problem(gateway('STRIPE'))).toEqual(Option.none());
    expect(problem(gateway('STRIPE'), EMAIL_ONLY)).toEqual(Option.some('payment_payer_contact_not_applicable'));
  });

  it('#1153 H1094-01=A A GoPay collection needs no contact and refuses one', () => {
    expect(problem(gateway('GOPAY'))).toEqual(Option.none());
    expect(problem(gateway('GOPAY'), EMAIL_ONLY)).toEqual(Option.some('payment_payer_contact_not_applicable'));
    expect(problem(gateway('GOPAY'), FULL)).toEqual(Option.some('payment_payer_contact_not_applicable'));
  });

  it('#1154 A Comgate collection needs a full name and an email or a phone', () => {
    expect(problem(gateway('COMGATE'), FULL)).toEqual(Option.none());
    expect(problem(gateway('COMGATE'), { fullName: 'Test Payer', phone: '+420700000000' })).toEqual(Option.none());
    expect(problem(gateway('COMGATE'))).toEqual(Option.some('payment_payer_contact_required'));
    expect(problem(gateway('COMGATE'), EMAIL_ONLY)).toEqual(Option.some('payment_payer_contact_required'));
    expect(problem(gateway('COMGATE'), { fullName: 'Test Payer' })).toEqual(
      Option.some('payment_payer_contact_required'),
    );
  });

  it('#1153 A binding that sends nothing to a provider refuses any contact and needs none', () => {
    for (const binding of NON_GATEWAY_BINDINGS) {
      expect(problem(binding)).toEqual(Option.none());
      expect(problem(binding, EMAIL_ONLY)).toEqual(Option.some('payment_payer_contact_not_applicable'));
    }
  });
});

describe('#1153 payer contact is not operation material', () => {
  it.effect('#1153 The material hash of a COLLECT is the same with or without a contact', () =>
    Effect.gen(function* materialWithoutContact() {
      const decode = Schema.decodeUnknownSync(StartPaymentCollectionPayloadSchema);
      const base = {
        amount: { amountMinor: 10_000, currency: 'CZK' },
        method: 'ONLINE_GATEWAY',
        operationKey: 'collect-1',
        paymentId: '11111111-1111-4111-8111-111111111111',
      };
      const payload = decode(base);
      const contacted = decode({ ...base, payerContact: FULL });
      expect(contacted.payerContact).toEqual(FULL);
      const binding = gateway('COMGATE');
      const without = collectionMaterialRequest(payload.paymentId, payload, binding);
      const withContact = collectionMaterialRequest(contacted.paymentId, contacted, binding);
      expect(withContact).toEqual(without);
      expect(withContact).not.toHaveProperty('payerContact');
      expect(yield* computePaymentMaterialHash(withContact)).toBe(yield* computePaymentMaterialHash(without));
    }),
  );
});

describe('#1153 payer contact refusals are 422 domain problems', () => {
  it('#1153 Both refusals are declared domain errors of the Action and map to 422 ineligible', () => {
    const isDomainError = Schema.is(startPaymentCollectionAction.descriptor.domainErrorSchema);
    for (const code of ['payment_payer_contact_required', 'payment_payer_contact_not_applicable'] as const) {
      const refusal = new PaymentPayerContactRefused({ code, reason: 'fixture' });
      expect(isDomainError(refusal)).toBe(true);
      const mapped = mapStartPaymentCollectionActionProblem(refusal);
      expect(Schema.is(StartPaymentCollectionActionIneligibleProblemSchema)(mapped)).toBe(true);
      expect(mapped).toMatchObject({ code, status: 422 });
    }
  });
});
