import { Schema } from 'effect';

import {
  CatalogRevisionNumberSchema,
  CatalogRevisionResourceIdSchema,
  CatalogRevisionTenantIdSchema,
} from '../domain/catalog-revision-reference.ts';
import { PackageDefinitionRefSchema } from '../resources/package-definition.ts';
import { ProductRefSchema } from '../resources/product.ts';
import { ProductUnitRefSchema } from '../resources/product-unit.ts';
import { VariantRefSchema } from '../resources/variant.ts';
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
  target: Schema.Struct({
    targetId: CatalogRevisionResourceIdSchema,
    targetType: Schema.Literals(['commerce.catalog.variant', 'commerce.catalog.package-definition']),
    tenantId: CatalogRevisionTenantIdSchema,
    unit: ProductUnitRefSchema,
  }),
});
export type SetProductUnitTargetDivisibilityPayload = typeof SetProductUnitTargetDivisibilityPayloadSchema.Type;
export const SetProductUnitTargetDivisibilityResultSchema = ProductUnitMutationResultSchema;
export type SetProductUnitTargetDivisibilityResult = typeof SetProductUnitTargetDivisibilityResultSchema.Type;
