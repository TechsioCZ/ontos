import { Schema } from 'effect';

import {
  CatalogDocumentResourceRefSchema,
  CatalogMediaAssignmentIdSchema,
  CatalogMediaOrderSchema,
  CatalogMediaPurposeSchema,
} from '../domain/catalog-media-assignment.ts';
import { ProductEvidenceReferenceSchema, ProductReasonSchema } from '../domain/product.ts';
import { ProductRefSchema } from '../resources/product.ts';
import { VariantRefSchema } from '../resources/variant.ts';

const CatalogMediaSubjectRefSchema = Schema.Union([ProductRefSchema, VariantRefSchema]);
export type CatalogMediaSubjectRef = typeof CatalogMediaSubjectRefSchema.Type;
const CatalogMediaResourceKindSchema = Schema.Literals(['MEDIA', 'DOCUMENT']);
const SetRevisionSchema = Schema.Finite.check(Schema.isInt(), Schema.isBetween({ maximum: 2_147_483_646, minimum: 0 }));
const ChangeFields = {
  evidenceRefs: Schema.Array(ProductEvidenceReferenceSchema),
  expectedSetRevision: SetRevisionSchema,
  reason: ProductReasonSchema,
  subjectRef: CatalogMediaSubjectRefSchema,
};

export const AssignCatalogMediaPayloadSchema = Schema.Struct({
  ...ChangeFields,
  assignmentId: CatalogMediaAssignmentIdSchema,
  order: CatalogMediaOrderSchema,
  purpose: CatalogMediaPurposeSchema,
  resourceKind: CatalogMediaResourceKindSchema,
  resourceRef: CatalogDocumentResourceRefSchema,
}).check(
  Schema.makeFilter(({ resourceRef, subjectRef }) =>
    subjectRef.tenantId === resourceRef.tenantId
      ? undefined
      : 'Catalog subject and owner Resource must share one Tenant',
  ),
);
export type AssignCatalogMediaPayload = typeof AssignCatalogMediaPayloadSchema.Type;

export const ReorderCatalogMediaPayloadSchema = Schema.Struct({
  ...ChangeFields,
  assignmentId: CatalogMediaAssignmentIdSchema,
  order: CatalogMediaOrderSchema,
});
export type ReorderCatalogMediaPayload = typeof ReorderCatalogMediaPayloadSchema.Type;

export const RemoveCatalogMediaPayloadSchema = Schema.Struct({
  ...ChangeFields,
  assignmentId: CatalogMediaAssignmentIdSchema,
});
export type RemoveCatalogMediaPayload = typeof RemoveCatalogMediaPayloadSchema.Type;

export const CatalogMediaChangeResultSchema = Schema.Struct({
  assignmentId: CatalogMediaAssignmentIdSchema,
  setRevision: Schema.Finite.check(Schema.isInt(), Schema.isBetween({ maximum: 2_147_483_647, minimum: 1 })),
});
