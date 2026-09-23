import { Schema } from 'effect';

import { CatalogResourceRefSchema } from './catalog-revision-reference.ts';

const qualifiedPart = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300), Schema.isTrimmed());
const issuerId = qualifiedPart.pipe(Schema.brand('CatalogExternalIssuerId'));
const recordId = qualifiedPart.pipe(Schema.brand('CatalogExternalRecordId'));

/** A source record's literal identifier, qualified by its issuer and Tenant. It is not a SKU,
 * GTIN, Product identity, or Connector Registry correlation. Its spelling is preserved. */
export const CatalogExternalSourceRecordRefSchema = Schema.Struct({
  issuerId,
  issuerKind: Schema.Literals(['EXTERNAL_BUSINESS_SYSTEM', 'EXTERNAL_EVIDENCE_PROVIDER']),
  recordId,
  recordNamespace: qualifiedPart,
  tenantId: CatalogResourceRefSchema.fields.tenantId,
});
export type CatalogExternalSourceRecordRef = typeof CatalogExternalSourceRecordRefSchema.Type;

/** Provenance attached to one *exact* Catalog Resource, not authority to change its facts.
 * The Connector Registry owner must independently establish any durable correlation. */
export const CatalogExternalSourceEvidenceSchema = Schema.Struct({
  observedTarget: CatalogResourceRefSchema,
  sourceRecord: CatalogExternalSourceRecordRefSchema,
}).check(
  Schema.makeFilter(({ observedTarget, sourceRecord }) =>
    sourceRecord.tenantId === observedTarget.tenantId
      ? undefined
      : 'External source and observed Catalog target must share one Tenant',
  ),
);

/** Equality of source references never crosses issuer, namespace, or Tenant boundaries. */
export const sameCatalogExternalSourceRecord = (
  left: CatalogExternalSourceRecordRef,
  right: CatalogExternalSourceRecordRef,
): boolean =>
  left.tenantId === right.tenantId &&
  left.issuerKind === right.issuerKind &&
  left.issuerId === right.issuerId &&
  left.recordNamespace === right.recordNamespace &&
  left.recordId === right.recordId;
