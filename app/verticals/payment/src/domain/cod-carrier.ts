import { Option } from 'effect';

import type { PaymentCodCarrier, PaymentExecutionBinding } from '../../shared/domain/payment-execution-binding.ts';
import type { PaymentSourceBinding } from '../../shared/domain/source-statement.ts';

/**
 * COD carrier authority (#1152 "Authority by fact family": COD customer collection is evidenced by the
 * "exact selected carrier/shipping service for the corresponding COD capability"). Pure.
 *
 * Being a configured COD_CUSTOMER_COLLECTION carrier is necessary but not sufficient: the statement must
 * come from the exact carrier binding the Delivery owner confirmed for the selected Delivery Offer (kept
 * in the immutable COD execution binding) and must name that exact offer.
 */

export type PaymentCodDeliveryOfferBinding = Extract<PaymentExecutionBinding, { readonly _tag: 'COD_DELIVERY_OFFER' }>;

/** The parts of a carrier statement that correlate it with a COD Payment. */
export interface PaymentCodCarrierStatement {
  readonly deliveryOfferRef?: string | undefined;
  readonly source: PaymentSourceBinding;
}

const isSelectedCarrier = (source: PaymentSourceBinding, carrier: PaymentCodCarrier) =>
  source.sourceKind === 'CARRIER' &&
  source.sourceSystem === carrier.sourceSystem &&
  source.accountRef === carrier.accountRef &&
  source.environment === carrier.environment;

/**
 * Whether a CARRIER-family statement may speak for (and so confirm a COD COLLECT of) the Payment with
 * this COD binding. `None` means it is the selected carrier naming the selected offer. `MISMATCH` (a
 * foreign carrier or a foreign offer) is unauthorized; `MISSING` (the offer is not named) is held. A
 * foreign carrier is a mismatch even when it names no offer, so it is never held as uncorrelated evidence.
 */
export const codCarrierBindingProblem = (
  statement: PaymentCodCarrierStatement,
  binding: PaymentCodDeliveryOfferBinding,
): Option.Option<'MISMATCH' | 'MISSING'> => {
  if (!isSelectedCarrier(statement.source, binding.carrier)) {
    return Option.some('MISMATCH');
  }
  if (statement.deliveryOfferRef === undefined) {
    return Option.some('MISSING');
  }
  return statement.deliveryOfferRef === binding.deliveryOfferRef ? Option.none() : Option.some('MISMATCH');
};
