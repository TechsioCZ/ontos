import { PricingQuotationIssuedSchema } from '@app/pricing-contracts/domain/quotation';
import type { PricingQuotationIssued } from '@app/pricing-contracts/domain/quotation';
import { Schema } from 'effect';

import { orderCandidateQuotation, otherCandidateQuotation } from './pricing-candidate-evidence.ts';

const pricedCandidates = { order: orderCandidateQuotation, other: otherCandidateQuotation };
/** The Order unit's final Cart candidate, or another candidate Pricing priced the same way. */
export type PricedCandidate = keyof typeof pricedCandidates;

/** Pricing's frozen evaluation instant and the end of the Quotation interval its policy grants from it. */
export const pricedOperationTime = orderCandidateQuotation.validity.validFrom;
export const pricedQuotationValidUntil = orderCandidateQuotation.validity.validUntil;

const decodeQuotation = Schema.decodeUnknownSync(Schema.toCodecJson(PricingQuotationIssuedSchema));

/**
 * Pricing's immutable Quotation of that exact candidate, bound to the buyer's authenticated profile, as
 * issued at the given instant under the given reference and decoded by Pricing's published wire contract.
 */
export const pricedQuotation = (
  candidate: PricedCandidate,
  issue: { readonly issuedAt: string; readonly quotationRef: string },
): PricingQuotationIssued => decodeQuotation({ ...pricedCandidates[candidate], ...issue });
