import { Schema } from 'effect';

import {
  CatalogFenceRevisionSchema,
  PriceGroupCodeSchema,
  PriceGroupCompatibilityContractSchema,
  PriceGroupDescriptionSchema,
  PriceGroupInstantSchema,
  PriceGroupNameSchema,
  PriceGroupPurposeSchema,
  PriceGroupReasonSchema,
} from '../domain/price-group.ts';
import { PriceGroupCatalogRootRefSchema } from '../resources/price-group-catalog-root.ts';
import { PriceGroupRefSchema } from '../resources/price-group.ts';

export { PriceGroupCreatedResultSchema as CreatePriceGroupResultSchema } from '../domain/price-group.ts';

const compatibilityContractsSchema = Schema.Array(PriceGroupCompatibilityContractSchema).check(
  Schema.isMinLength(1),
  Schema.makeFilter((contracts) => {
    const hasDuplicate = contracts.some((candidate, index) =>
      contracts
        .slice(0, index)
        .some(({ contractId, version }) => contractId === candidate.contractId && version === candidate.version),
    );
    return hasDuplicate
      ? 'Compatibility Contract support must not contain duplicate identity/version pairs'
      : undefined;
  }),
);
export const CreatePriceGroupPayloadSchema = Schema.Struct({
  businessCode: PriceGroupCodeSchema,
  classificationPurpose: PriceGroupPurposeSchema,
  compatibilityContracts: compatibilityContractsSchema,
  description: PriceGroupDescriptionSchema,
  displayName: PriceGroupNameSchema,
  effectiveFrom: PriceGroupInstantSchema,
  effectiveTo: Schema.Null,
  expectedCatalogRevision: CatalogFenceRevisionSchema,
  reason: PriceGroupReasonSchema,
});
export type CreatePriceGroupPayload = typeof CreatePriceGroupPayloadSchema.Type;

export const PriceGroupAuthorizationTopologyMutationIdSchema = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('PriceGroupAuthorizationTopologyMutationId'),
  Schema.decodeTo(Schema.String),
);

export const PriceGroupContainmentProjectionReconciliationSchema = Schema.Struct({
  mutationId: PriceGroupAuthorizationTopologyMutationIdSchema,
  operation: Schema.Literal('touch_containment'),
  staged: Schema.Literal(true),
});

export const PriceGroupContainmentProjectionRequestedPayloadSchema = Schema.Struct({
  catalogVersion: Schema.Literal('1'),
  mutationId: PriceGroupAuthorizationTopologyMutationIdSchema,
  operation: Schema.Literal('touch_containment'),
  priceGroupRef: PriceGroupRefSchema,
  pricingCatalogRef: PriceGroupCatalogRootRefSchema,
  schemaVersion: Schema.Literal('1'),
}).check(
  Schema.makeFilter(({ priceGroupRef, pricingCatalogRef }) =>
    priceGroupRef.tenantId === pricingCatalogRef.tenantId
      ? undefined
      : 'Price Group containment projection references must share one Tenant',
  ),
);
