import { PricingInstantSchema } from '@app/pricing-contracts/current-supported-currencies';
import { Schema } from 'effect';

import {
  ExternalPriceSourcePolicyIdSchema,
  ExternalPriceSourcePolicyTermsSchema,
} from '../domain/external-price-source-policy.ts';

const boundedReason = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000), Schema.isTrimmed());
const stableReference = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300), Schema.isTrimmed());

/**
 * Establishes one standing source policy in the trusted Selling Legal Entity. Pricing stamps the verification
 * time itself; a caller cannot date it, and the policy never comes from a Price row.
 */
const EstablishExternalPriceSourcePolicyPayloadSchema = Schema.Struct({
  intent: Schema.Literal('ESTABLISH'),
  policy: ExternalPriceSourcePolicyTermsSchema,
  reason: boundedReason,
  verificationRef: stableReference,
});

/** Ends one policy from `effectiveTo`, which may not lie in the past; Prices already accepted keep their evidence. */
const EndExternalPriceSourcePolicyPayloadSchema = Schema.Struct({
  effectiveTo: PricingInstantSchema,
  intent: Schema.Literal('END'),
  policyId: ExternalPriceSourcePolicyIdSchema,
  reason: boundedReason,
  verificationRef: stableReference,
});

export const ManageExternalPriceSourcePolicyPayloadSchema = Schema.Union([
  EndExternalPriceSourcePolicyPayloadSchema,
  EstablishExternalPriceSourcePolicyPayloadSchema,
]);
export type ManageExternalPriceSourcePolicyPayload = typeof ManageExternalPriceSourcePolicyPayloadSchema.Type;

export const ManageExternalPriceSourcePolicyResultSchema = Schema.Union([
  Schema.Struct({
    intent: Schema.Literal('ESTABLISH'),
    outcome: Schema.Literals(['STORED', 'REUSED']),
    policyId: ExternalPriceSourcePolicyIdSchema,
    verifiedAt: PricingInstantSchema,
  }),
  Schema.Struct({
    effectiveTo: PricingInstantSchema,
    intent: Schema.Literal('END'),
    outcome: Schema.Literals(['ENDED', 'REUSED']),
    policyId: ExternalPriceSourcePolicyIdSchema,
  }),
]);
export type ManageExternalPriceSourcePolicyResult = typeof ManageExternalPriceSourcePolicyResultSchema.Type;
