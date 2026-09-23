import { Schema } from 'effect';
import { ProductEvidenceReferenceSchema, ProductInstantSchema, ProductReasonSchema } from '../domain/product.ts';

const Uuid = Schema.String.check(Schema.isUUID(), Schema.isTrimmed());
const TenantId = Uuid.pipe(Schema.brand('CatalogGtinTenantId'), Schema.decodeTo(Uuid));
const VariantId = Uuid.pipe(Schema.brand('CatalogGtinVariantId'), Schema.decodeTo(Uuid));
const PackageDefinitionId = Uuid.pipe(Schema.brand('CatalogGtinPackageDefinitionId'), Schema.decodeTo(Uuid));
export const GtinCodeSchema = Schema.String.check(Schema.isPattern(/^(?:\d{8}|\d{12}|\d{13}|\d{14})$/u));
export const GtinTargetSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('VARIANT'), tenantId: TenantId, variantId: VariantId }),
  Schema.Struct({
    kind: Schema.Literal('PACKAGE_LEVEL'),
    packageDefinitionId: PackageDefinitionId,
    tenantId: TenantId,
  }),
]);
export const ConfirmGtinPayloadSchema = Schema.Struct({
  attributionEvidenceRef: ProductEvidenceReferenceSchema,
  code: GtinCodeSchema,
  effectiveAt: ProductInstantSchema,
  expectedRevision: Schema.Literal(0),
  reason: ProductReasonSchema,
  target: GtinTargetSchema,
});
export type ConfirmGtinPayload = typeof ConfirmGtinPayloadSchema.Type;
export const ConfirmGtinResultSchema = Schema.Struct({ revision: Schema.Int });
