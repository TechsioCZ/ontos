import { Schema } from 'effect';

const sourcePart = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300), Schema.isTrimmed());

const sourceIssuerId = sourcePart.pipe(Schema.brand('CatalogSourceIssuerId'), Schema.decodeTo(sourcePart));
const sourceRecordId = sourcePart.pipe(Schema.brand('CatalogSourceRecordId'), Schema.decodeTo(sourcePart));
const sourceOccurrenceId = sourcePart.pipe(Schema.brand('CatalogSourceOccurrenceId'), Schema.decodeTo(sourcePart));

/** Literal EBS identity with route and namespace qualification. Revisions and occurrences are evidence, never business keys. */
export const CatalogSourceCorrelationSchema = Schema.Struct({
  issuerId: sourceIssuerId,
  mappingRevision: sourcePart,
  recordId: sourceRecordId,
  recordNamespace: sourcePart,
  routeScope: sourcePart,
  sourceOccurrenceId: Schema.optionalKey(sourceOccurrenceId),
});
export type CatalogSourceCorrelation = typeof CatalogSourceCorrelationSchema.Type;

/** Only an explicitly designated source initial Variant may bind the native create receipt. */
export const CatalogProductSourceCorrelationSchema = Schema.Struct({
  ...CatalogSourceCorrelationSchema.fields,
  initialVariantRecordId: Schema.optionalKey(sourceRecordId),
});
export type CatalogProductSourceCorrelation = typeof CatalogProductSourceCorrelationSchema.Type;
