import { computeActionRequestHash } from '@app/core-runtime/access/enforcement';
import type { TrustedPrincipalContext } from '@app/core-runtime';
import { PricingSellingLegalEntityIdSchema } from '@app/pricing-contracts/current-supported-currencies';
import { Effect, Schema } from 'effect';
import { DefinePricePayloadSchema } from './actions/define-price.ts';
import type { DefinePricePayload } from './actions/define-price.ts';
import { RevisePricePayloadSchema } from './actions/revise-price.ts';
import type { RevisePricePayload } from './actions/revise-price.ts';

export type OriginalRequestPrincipalIdentity = Pick<
  TrustedPrincipalContext,
  'tenantId' | 'principalId' | 'legalEntityId'
>;

export type OriginalPriceNormalizedPayload =
  | typeof DefinePricePayloadSchema.Encoded
  | typeof RevisePricePayloadSchema.Encoded;

/** Fingerprint only: this projects no authentication, permission, target, or commit authority. */
const priceRequestIdentity = (
  actionKey: 'commerce.pricing.define-price' | 'commerce.pricing.revise-price',
  normalizedPayload: OriginalPriceNormalizedPayload,
  principal: OriginalRequestPrincipalIdentity,
  operationLegalEntityId: string,
) => {
  const { legalEntityId: _authenticatedLegalEntityId, ...tenantPrincipal } = principal;
  // Both native descriptors have scope-wide declarations and no access-target resolver. Core hashes
  // the empty resolved target, independently of payload PriceRef and any transport target hints.
  const target = Object.freeze({});
  const metadata = { actionKey, normalizedPayload, owningModuleKey: 'commerce.pricing', schemaVersion: '2', target };
  return Object.freeze({
    ...metadata,
    legalEntityScope: 'required' as const,
    operationLegalEntityId,
    requestHash: computeActionRequestHash({
      ...metadata,
      principal: { ...tenantPrincipal, legalEntityId: operationLegalEntityId },
    }),
  });
};

/** Use the persisted original native payload and Core-resolved operation SLE, never a current remap. */
export const prepareDefinePriceOriginalRequestIdentity = Effect.fn('Pricing.prepareDefinePriceOriginalRequestIdentity')(
  function* prepareDefinePrice(
    payload: DefinePricePayload,
    principal: OriginalRequestPrincipalIdentity,
    operationLegalEntityId: string,
  ) {
    const legalEntityId = yield* Schema.decodeUnknownEffect(PricingSellingLegalEntityIdSchema)(operationLegalEntityId);
    const decoded = yield* Schema.decodeUnknownEffect(DefinePricePayloadSchema, { onExcessProperty: 'error' })(payload);
    const normalizedPayload = yield* Schema.encodeUnknownEffect(DefinePricePayloadSchema)(decoded);
    return priceRequestIdentity('commerce.pricing.define-price', normalizedPayload, principal, legalEntityId);
  },
);

export const prepareRevisePriceOriginalRequestIdentity = Effect.fn('Pricing.prepareRevisePriceOriginalRequestIdentity')(
  function* prepareRevisePrice(
    payload: RevisePricePayload,
    principal: OriginalRequestPrincipalIdentity,
    operationLegalEntityId: string,
  ) {
    const legalEntityId = yield* Schema.decodeUnknownEffect(PricingSellingLegalEntityIdSchema)(operationLegalEntityId);
    const decoded = yield* Schema.decodeUnknownEffect(RevisePricePayloadSchema, { onExcessProperty: 'error' })(payload);
    const normalizedPayload = yield* Schema.encodeUnknownEffect(RevisePricePayloadSchema)(decoded);
    return priceRequestIdentity('commerce.pricing.revise-price', normalizedPayload, principal, legalEntityId);
  },
);
