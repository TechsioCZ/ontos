import { Schema } from 'effect';
import { CatalogSourceCorrelationSchema } from '../domain/catalog-source-correlation.ts';
import { ProductEvidenceReferenceSchema, ProductReasonSchema } from '../domain/product.ts';

const Uuid = Schema.String.check(Schema.isUUID(), Schema.isTrimmed());
const TenantId = Uuid.pipe(Schema.brand('CatalogSkuTenantId'), Schema.decodeTo(Uuid));
const VariantId = Uuid.pipe(Schema.brand('CatalogSkuVariantId'), Schema.decodeTo(Uuid));
const PackageDefinitionId = Uuid.pipe(Schema.brand('CatalogSkuPackageDefinitionId'), Schema.decodeTo(Uuid));
export const SkuCodeSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(240));
export const SkuTargetSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('VARIANT'), tenantId: TenantId, variantId: VariantId }),
  Schema.Struct({
    kind: Schema.Literal('PACKAGE_OPTION'),
    packageDefinitionId: PackageDefinitionId,
    tenantId: TenantId,
  }),
]);
export const AssignSkuPayloadSchema = Schema.Struct({
  code: SkuCodeSchema,
  evidenceRefs: Schema.NonEmptyArray(ProductEvidenceReferenceSchema),
  expectedRevision: Schema.Literal(0),
  reason: ProductReasonSchema,
  /**
   * The source record of the Variant when the code comes from the source route that created it. Catalog then admits a
   * draft Variant and replaces the Variant's Current code with this one; without it the change is a staff assignment.
   */
  sourceCorrelation: Schema.optionalKey(CatalogSourceCorrelationSchema),
  target: SkuTargetSchema,
});
export type AssignSkuPayload = typeof AssignSkuPayloadSchema.Type;
export const AssignSkuResultSchema = Schema.Struct({
  /** Whether a source assignment changed the Variant's Current code; a staff assignment always does. */
  changed: Schema.optionalKey(Schema.Boolean),
  revision: Schema.Int,
});
