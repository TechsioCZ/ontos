import { Option } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import type { PaymentExecutionBinding } from '../../shared/domain/payment-execution-binding.ts';
import type { PaymentSourceBinding } from '../../shared/domain/source-statement.ts';
import { codCarrierBindingProblem } from '../../src/domain/cod-carrier.ts';
import type { PaymentCodDeliveryOfferBinding } from '../../src/domain/cod-carrier.ts';

/**
 * #1152 "Authority by fact family": COD customer collection is evidenced only by the "exact selected
 * carrier/shipping service for the corresponding COD capability". The COD execution binding carries the
 * carrier the Delivery owner confirmed for the selected offer; any other carrier binding is foreign.
 */

const dpdBinding = {
  _tag: 'COD_DELIVERY_OFFER',
  capabilityEvidenceRef: 'dpd-cod-capability-evidence',
  carrier: { accountRef: 'dpd-merchant-12', environment: 'production', sourceSystem: 'dpd' },
  deliveryOfferRef: 'dpd-home-delivery-offer-1',
} as const satisfies PaymentCodDeliveryOfferBinding & PaymentExecutionBinding;

const dpdSource: PaymentSourceBinding = {
  accountRef: 'dpd-merchant-12',
  environment: 'production',
  sourceKind: 'CARRIER',
  sourceSystem: 'dpd',
};

const problemOf = (source: PaymentSourceBinding, deliveryOfferRef?: string) =>
  Option.getOrElse(codCarrierBindingProblem({ deliveryOfferRef, source }, dpdBinding), () => 'MATCHED' as const);

describe('#1152 COD collection authority is the selected Delivery Offer carrier', () => {
  it('#1152 the selected offer carrier quoting the selected offer may confirm the COD collection', () => {
    expect(problemOf(dpdSource, 'dpd-home-delivery-offer-1')).toBe('MATCHED');
  });

  it('#1152 another configured carrier quoting the selected offer is foreign, not the selected carrier', () => {
    const ppl: PaymentSourceBinding = { ...dpdSource, accountRef: 'ppl-merchant-77', sourceSystem: 'ppl' };
    expect(problemOf(ppl, 'dpd-home-delivery-offer-1')).toBe('MISMATCH');
  });

  it('#1152 the same carrier system under another account or environment is not the selected carrier', () => {
    expect([
      problemOf({ ...dpdSource, accountRef: 'dpd-merchant-99' }, 'dpd-home-delivery-offer-1'),
      problemOf({ ...dpdSource, environment: 'sandbox' }, 'dpd-home-delivery-offer-1'),
    ]).toEqual(['MISMATCH', 'MISMATCH']);
  });

  it('#1152 a non-carrier source with the carrier coordinates is never the COD carrier', () => {
    expect(problemOf({ ...dpdSource, sourceKind: 'BANK_ACCOUNTING' }, 'dpd-home-delivery-offer-1')).toBe('MISMATCH');
  });

  it('#1152 the selected carrier naming another Delivery Offer is foreign; naming none is uncorrelated', () => {
    expect([problemOf(dpdSource, 'dpd-pickup-offer-2'), problemOf(dpdSource)]).toEqual(['MISMATCH', 'MISSING']);
  });

  it('#1152 a foreign carrier stays foreign even when it names no Delivery Offer', () => {
    expect(problemOf({ ...dpdSource, accountRef: 'ppl-merchant-77', sourceSystem: 'ppl' })).toBe('MISMATCH');
  });
});
