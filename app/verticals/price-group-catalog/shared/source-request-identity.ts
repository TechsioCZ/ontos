import { computeActionRequestHash } from '@app/core-runtime/access/enforcement';
import type { TrustedPrincipalContext } from '@app/core-runtime';
import { Effect, Schema } from 'effect';
import { CreatePriceGroupPayloadSchema } from './actions/create-price-group.ts';
import type { CreatePriceGroupPayload } from './actions/create-price-group.ts';
import { CreatePriceGroupDefinitionRevisionPayloadSchema } from './actions/create-price-group-definition-revision.ts';
import type { CreatePriceGroupDefinitionRevisionPayload } from './actions/create-price-group-definition-revision.ts';

export type OriginalRequestPrincipalIdentity = Pick<
  TrustedPrincipalContext,
  'tenantId' | 'principalId' | 'legalEntityId'
>;

export type OriginalGroupNormalizedPayload =
  | typeof CreatePriceGroupPayloadSchema.Encoded
  | typeof CreatePriceGroupDefinitionRevisionPayloadSchema.Encoded;

/** Pure original-request fingerprint projection, not an authorization or a commit receipt. */
const groupRequestIdentity = (
  actionKey:
    | 'pricing.price-group-catalog.create-price-group'
    | 'pricing.price-group-catalog.create-price-group-definition-revision',
  normalizedPayload: OriginalGroupNormalizedPayload,
  principal: OriginalRequestPrincipalIdentity,
) => {
  const { legalEntityId: _authenticatedLegalEntityId, ...tenantPrincipal } = principal;
  // Both descriptors prohibit SLE and have no access-target resolver. Core's actual hash target is
  // empty; neither the payload's Group ref nor a caller's pinned Symmy target supplies it.
  const target = Object.freeze({});
  const metadata = {
    actionKey,
    normalizedPayload,
    owningModuleKey: 'pricing.price-group-catalog',
    schemaVersion: '1',
    target,
  };
  return Object.freeze({
    ...metadata,
    legalEntityScope: 'forbidden' as const,
    requestHash: computeActionRequestHash({ ...metadata, principal: tenantPrincipal }),
  });
};

export const prepareCreatePriceGroupOriginalRequestIdentity = Effect.fn(
  'PriceGroup.prepareCreateOriginalRequestIdentity',
)(function* prepareCreate(payload: CreatePriceGroupPayload, principal: OriginalRequestPrincipalIdentity) {
  const decoded = yield* Schema.decodeUnknownEffect(CreatePriceGroupPayloadSchema, { onExcessProperty: 'error' })(
    payload,
  );
  const normalizedPayload = yield* Schema.encodeUnknownEffect(CreatePriceGroupPayloadSchema)(decoded);
  return groupRequestIdentity('pricing.price-group-catalog.create-price-group', normalizedPayload, principal);
});

export const prepareCreatePriceGroupDefinitionRevisionOriginalRequestIdentity = Effect.fn(
  'PriceGroup.prepareRevisionOriginalRequestIdentity',
)(function* prepareRevision(
  payload: CreatePriceGroupDefinitionRevisionPayload,
  principal: OriginalRequestPrincipalIdentity,
) {
  const decoded = yield* Schema.decodeUnknownEffect(CreatePriceGroupDefinitionRevisionPayloadSchema, {
    onExcessProperty: 'error',
  })(payload);
  const normalizedPayload = yield* Schema.encodeUnknownEffect(CreatePriceGroupDefinitionRevisionPayloadSchema)(decoded);
  return groupRequestIdentity(
    'pricing.price-group-catalog.create-price-group-definition-revision',
    normalizedPayload,
    principal,
  );
});
