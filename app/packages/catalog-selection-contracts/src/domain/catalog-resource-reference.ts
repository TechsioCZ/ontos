import { DateTime, Option, Schema, SchemaGetter } from 'effect';

const checkedUuid = Schema.String.check(Schema.isUUID(), Schema.isTrimmed());

/** Tenant identity carried by every Catalog historical reference. */
export const CatalogRevisionTenantIdSchema = checkedUuid.pipe(
  Schema.brand('CatalogRevisionTenantId'),
  Schema.decodeTo(checkedUuid),
);
export type CatalogRevisionTenantId = typeof CatalogRevisionTenantIdSchema.Type;

/** Resource identity used when a future Catalog resource has no public private-contract import here. */
export const CatalogRevisionResourceIdSchema = checkedUuid.pipe(
  Schema.brand('CatalogRevisionResourceId'),
  Schema.decodeTo(checkedUuid),
);
export type CatalogRevisionResourceId = typeof CatalogRevisionResourceIdSchema.Type;

export const CatalogRevisionIdSchema = checkedUuid.pipe(
  Schema.brand('CatalogRevisionId'),
  Schema.decodeTo(checkedUuid),
);
export type CatalogRevisionId = typeof CatalogRevisionIdSchema.Type;

/** Business revision sequence; this is deliberately distinct from an OntOS Build Revision. */
export const CatalogRevisionNumberSchema = Schema.Finite.check(
  Schema.isInt(),
  Schema.isBetween({ maximum: 2_147_483_647, minimum: 1 }),
).pipe(Schema.brand('CatalogRevisionNumber'));
export type CatalogRevisionNumber = typeof CatalogRevisionNumberSchema.Type;

const catalogResourceType = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(160),
  Schema.isPattern(/^commerce\.catalog\.[a-z0-9][a-z0-9.-]*$/u),
  Schema.isTrimmed(),
).pipe(Schema.brand('CatalogRevisionResourceType'), Schema.decodeTo(Schema.String));

/** Public, tenant-qualified identity for a Catalog-owned resource. */
export const CatalogResourceRefSchema = Schema.Struct({
  moduleId: Schema.Literal('commerce.catalog'),
  resourceId: CatalogRevisionResourceIdSchema,
  resourceType: catalogResourceType,
  tenantId: CatalogRevisionTenantIdSchema,
});
export type CatalogResourceRef = typeof CatalogResourceRefSchema.Type;

export interface CatalogResourceRefInput {
  readonly moduleId: 'commerce.catalog';
  readonly resourceId: string;
  readonly resourceType: string;
  readonly tenantId: string;
}

const instantDecoded = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u),
  Schema.makeFilter((value) => {
    const parsed = DateTime.make(value);
    const canonicalInput = value.length === 20 ? value.replace(/Z$/u, '.000Z') : value;
    return Option.isSome(parsed) && DateTime.formatIso(parsed.value) === canonicalInput
      ? undefined
      : 'Expected a canonical UTC timestamp';
  }),
).pipe(
  Schema.decodeTo(Schema.toType(Schema.DateTimeUtc), {
    decode: SchemaGetter.transform(DateTime.makeUnsafe),
    encode: SchemaGetter.transform(DateTime.formatIso),
  }),
);
/** Canonical UTC timestamp used for the observation of retained historical evidence. */
export const CatalogRevisionInstantSchema = Schema.toEncoded(instantDecoded);
export type CatalogRevisionInstant = typeof CatalogRevisionInstantSchema.Type;
