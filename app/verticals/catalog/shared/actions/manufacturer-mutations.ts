import { Schema } from 'effect';

import {
  ManufacturerEffectivePeriodSchema,
  ManufacturerSubjectSchema,
  ManufacturerTargetSchema,
} from '../domain/manufacturer-relation.ts';
import { ProductEvidenceReferenceSchema, ProductReasonSchema } from '../domain/product.ts';

const RelationIdSchema = Schema.String.check(Schema.isUUID(), Schema.isTrimmed()).pipe(
  Schema.brand('CatalogManufacturerRelationId'),
);
const RevisionSchema = Schema.Int.check(Schema.isGreaterThan(0));
const EvidenceRefsSchema = Schema.NonEmptyArray(ProductEvidenceReferenceSchema);

const MutationBasisSchema = Schema.Struct({
  evidenceRefs: EvidenceRefsSchema,
  reason: ProductReasonSchema,
});

export const SetProductManufacturerPayloadSchema = Schema.Struct({
  ...MutationBasisSchema.fields,
  effectivePeriod: ManufacturerEffectivePeriodSchema,
  relationId: RelationIdSchema,
  subject: ManufacturerSubjectSchema,
  target: ManufacturerTargetSchema,
}).check(
  Schema.makeFilter(({ subject, target }) =>
    subject.tenantId === (target.kind === 'PARTY' ? target.partyRef.tenantId : target.legalEntityRef.tenantId)
      ? undefined
      : 'Manufacturer and Product must share one Tenant',
  ),
);
export type SetProductManufacturerPayload = typeof SetProductManufacturerPayloadSchema.Type;

export const ChangeProductManufacturerPayloadSchema = Schema.Struct({
  ...MutationBasisSchema.fields,
  effectivePeriod: ManufacturerEffectivePeriodSchema,
  expectedRevision: RevisionSchema,
  relationId: RelationIdSchema,
  subject: ManufacturerSubjectSchema,
  target: ManufacturerTargetSchema,
}).check(
  Schema.makeFilter(({ subject, target }) =>
    subject.tenantId === (target.kind === 'PARTY' ? target.partyRef.tenantId : target.legalEntityRef.tenantId)
      ? undefined
      : 'Manufacturer and Product must share one Tenant',
  ),
);
export type ChangeProductManufacturerPayload = typeof ChangeProductManufacturerPayloadSchema.Type;

export const RemoveProductManufacturerPayloadSchema = Schema.Struct({
  ...MutationBasisSchema.fields,
  expectedRevision: RevisionSchema,
  relationId: RelationIdSchema,
  subject: ManufacturerSubjectSchema,
});
export type RemoveProductManufacturerPayload = typeof RemoveProductManufacturerPayloadSchema.Type;

export const ProductManufacturerMutationResultSchema = Schema.Struct({
  relationId: RelationIdSchema,
  revision: RevisionSchema,
  subject: ManufacturerSubjectSchema,
});

export class ManufacturerActionError extends Schema.TaggedError<ManufacturerActionError>()('ManufacturerActionError', {
  code: Schema.Literals([
    'manufacturer_invalid',
    'manufacturer_not_found',
    'manufacturer_conflict',
    'manufacturer_reference_unavailable',
  ]),
  reason: Schema.String,
}) {}
