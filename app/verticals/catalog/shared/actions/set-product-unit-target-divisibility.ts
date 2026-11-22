import { Schema } from 'effect';
import { CreateProductPayloadSchema } from './create-product.ts';

import {
  CatalogRevisionNumberSchema,
  CatalogRevisionResourceIdSchema,
  CatalogRevisionTenantIdSchema,
} from '@app/catalog-selection-contracts/catalog-resource-reference';
import { PackageDefinitionRefSchema } from '../resources/package-definition.ts';
import { ProductRefSchema } from '@app/catalog-selection-contracts/resources/product';
import { ProductUnitRefSchema } from '@app/catalog-selection-contracts/resources/product-unit';
import { VariantRefSchema } from '@app/catalog-selection-contracts/resources/variant';
import {
  ProductUnitEvidenceRefsSchema,
  ProductUnitMutationResultSchema,
  ProductUnitReasonSchema,
} from './product-unit-contract.ts';

export const SetProductUnitTargetDivisibilityPayloadSchema = Schema.Struct({
  divisible: Schema.Boolean,
  evidenceRefs: ProductUnitEvidenceRefsSchema,
  expectedCurrentRevision: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
  expectedSources: Schema.Struct({
    packageDefinition: Schema.optionalKey(
      Schema.Struct({ resourceRef: PackageDefinitionRefSchema, revision: CatalogRevisionNumberSchema }),
    ),
    product: Schema.Struct({ resourceRef: ProductRefSchema, revision: CatalogRevisionNumberSchema }),
    variant: Schema.Struct({ resourceRef: VariantRefSchema, revision: CatalogRevisionNumberSchema }),
  }),
  reason: ProductUnitReasonSchema,
  sourceProduct: Schema.optionalKey(CreateProductPayloadSchema),
  target: Schema.Struct({
    targetId: CatalogRevisionResourceIdSchema,
    targetType: Schema.Literals(['commerce.catalog.variant', 'commerce.catalog.package-definition']),
    tenantId: CatalogRevisionTenantIdSchema,
    unit: ProductUnitRefSchema,
  }),
});
export type SetProductUnitTargetDivisibilityPayload = typeof SetProductUnitTargetDivisibilityPayloadSchema.Type;
export const SetProductUnitTargetDivisibilityResultSchema = Schema.Struct({
  ...ProductUnitMutationResultSchema.fields,
  changed: Schema.Boolean,
});
export type SetProductUnitTargetDivisibilityResult = typeof SetProductUnitTargetDivisibilityResultSchema.Type;
