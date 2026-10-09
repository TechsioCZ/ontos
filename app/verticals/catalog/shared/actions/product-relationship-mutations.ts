import { Schema } from 'effect';

import { ProductRelationshipSchema } from '../domain/product-relationship.ts';
import {
  ProductEvidenceReferenceSchema,
  ProductInstantSchema,
  ProductReasonSchema,
  ProductRevisionSchema,
} from '../domain/product.ts';

const checkedRelationshipId = Schema.String.check(Schema.isUUID(), Schema.isTrimmed());
const RelationshipIdSchema = checkedRelationshipId.pipe(
  Schema.brand('CatalogProductRelationshipId'),
  Schema.decodeTo(checkedRelationshipId),
);

export const CreateProductRelationshipPayloadSchema = Schema.Struct({
  relationship: ProductRelationshipSchema,
  relationshipId: RelationshipIdSchema,
});
export type CreateProductRelationshipPayload = typeof CreateProductRelationshipPayloadSchema.Type;

export const ChangeProductRelationshipPayloadSchema = Schema.Struct({
  classification: Schema.Literals(['EVIDENCED_CORRECTION', 'MATERIAL_CHANGE']),
  expectedRevision: ProductRevisionSchema,
  relationship: ProductRelationshipSchema,
  relationshipId: RelationshipIdSchema,
});
export type ChangeProductRelationshipPayload = typeof ChangeProductRelationshipPayloadSchema.Type;

export const RemoveProductRelationshipPayloadSchema = Schema.Struct({
  effectiveTo: ProductInstantSchema,
  evidenceRefs: Schema.NonEmptyArray(ProductEvidenceReferenceSchema),
  expectedRevision: ProductRevisionSchema,
  reason: ProductReasonSchema,
  relationshipId: RelationshipIdSchema,
});
export type RemoveProductRelationshipPayload = typeof RemoveProductRelationshipPayloadSchema.Type;

export const ProductRelationshipMutationResultSchema = Schema.Struct({
  relationship: ProductRelationshipSchema,
  relationshipId: RelationshipIdSchema,
  revision: ProductRevisionSchema,
});
