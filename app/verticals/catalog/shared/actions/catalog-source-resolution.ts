import { Schema } from 'effect';

import { CatalogExternalSourceRecordRefSchema } from '../domain/external-identifier-boundary.ts';
import {
  CosmeticProductCorrectionSchema,
  ProductChangeClassificationSchema,
} from '../domain/product-change-classification.ts';

const checkedUuid = Schema.String.check(Schema.isUUID(), Schema.isTrimmed());
const boundedText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000), Schema.isTrimmed());
const positiveDecimal = Schema.String.check(Schema.isPattern(/^(?:0|[1-9]\d*)(?:\.\d+)?$/u), Schema.isMaxLength(100));
const sourceRevision = Schema.BigIntFromString.check(Schema.isGreaterThanOrEqualToBigInt(0n));
const overrideRevision = Schema.BigIntFromString.check(Schema.isGreaterThanOrEqualToBigInt(1n));

export const CatalogSourceFactKeySchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(200),
  Schema.isTrimmed(),
).pipe(Schema.brand('CatalogSourceFactKey'), Schema.decodeTo(Schema.String));
export const CatalogSourceTargetIdSchema = checkedUuid.pipe(
  Schema.brand('CatalogSourceTargetId'),
  Schema.decodeTo(checkedUuid),
);
export const CatalogSourceTargetKindSchema = Schema.Literals(['PRODUCT', 'VARIANT', 'PACKAGE_DEFINITION']);
export const CatalogSourceTenantIdSchema = checkedUuid.pipe(
  Schema.brand('CatalogSourceTenantId'),
  Schema.decodeTo(checkedUuid),
);
export const CatalogSourceAssertionIdSchema = checkedUuid.pipe(
  Schema.brand('CatalogSourceAssertionId'),
  Schema.decodeTo(checkedUuid),
);
export const CatalogSourceIssuerSystemIdSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(300),
  Schema.isTrimmed(),
).pipe(Schema.brand('CatalogSourceIssuerSystemId'), Schema.decodeTo(Schema.String));
export const CatalogSourceRecordIdSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(300),
  Schema.isTrimmed(),
).pipe(Schema.brand('CatalogSourceRecordId'), Schema.decodeTo(Schema.String));
const CatalogSourceUnitIdSchema = checkedUuid.pipe(Schema.brand('CatalogSourceUnitId'), Schema.decodeTo(checkedUuid));
const CatalogSourceMeasurementSchema = Schema.Struct({ amount: positiveDecimal, unitId: CatalogSourceUnitIdSchema });
export const CatalogSourceFactValueSchema = Schema.Union([boundedText, CatalogSourceMeasurementSchema]);
export type CatalogSourceFactValue = typeof CatalogSourceFactValueSchema.Type;

export const CatalogSourceFactScopeSchema = Schema.Struct({
  factKey: CatalogSourceFactKeySchema,
  targetId: CatalogSourceTargetIdSchema,
  targetKind: CatalogSourceTargetKindSchema,
  tenantId: CatalogSourceTenantIdSchema,
});

export const CatalogSourceAssertionSchema = Schema.Struct({
  assertionId: CatalogSourceAssertionIdSchema,
  effectiveFrom: Schema.DateFromString,
  effectiveTo: Schema.optionalKey(Schema.DateFromString),
  evidencedAt: Schema.DateFromString,
  issuerSystemId: CatalogSourceIssuerSystemIdSchema,
  scope: CatalogSourceFactScopeSchema,
  sourceRecordId: CatalogSourceRecordIdSchema,
  sourceRevision,
  value: CatalogSourceFactValueSchema,
  valueFingerprint: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
});

const CatalogImportDeliveredItemSchema = Schema.Struct({
  assertion: CatalogSourceAssertionSchema,
  captureConfirmed: Schema.Boolean,
  classification: Schema.optionalKey(ProductChangeClassificationSchema),
  recordMeaning: CatalogSourceTargetKindSchema,
  sourceRecord: CatalogExternalSourceRecordRefSchema,
}).check(
  Schema.makeFilter(({ assertion, sourceRecord }) =>
    assertion.scope.tenantId === sourceRecord.tenantId &&
    assertion.issuerSystemId === sourceRecord.issuerId &&
    assertion.sourceRecordId === sourceRecord.recordId
      ? undefined
      : 'Assertion issuer, source record, and Tenant must match the exact source identity',
  ),
);

export const ImportSourceAssertionPayloadSchema = Schema.Struct({
  items: Schema.Array(CatalogImportDeliveredItemSchema).check(Schema.isMinLength(1), Schema.isMaxLength(100)),
});
export type ImportSourceAssertionPayload = typeof ImportSourceAssertionPayloadSchema.Type;

const ImportAcceptedSchema = Schema.Struct({
  assertionId: CatalogSourceAssertionIdSchema,
  classification: Schema.optionalKey(CosmeticProductCorrectionSchema),
  resolvedCurrentChanged: Schema.Boolean,
  sourceRevision,
  status: Schema.Literal('ACCEPTED_BASE'),
});
const ImportRejectedSchema = Schema.Struct({
  reason: boundedText,
  status: Schema.Literals([
    'DUPLICATE',
    'STALE',
    'NO_AUTHORITY',
    'INVALID_TARGET',
    'INVALID_VALUE',
    'HELD',
    'RECONCILIATION_REQUIRED',
    'UNVERIFIABLE',
  ]),
});
export const ImportSourceAssertionResultSchema = Schema.Struct({
  items: Schema.Array(Schema.Union([ImportAcceptedSchema, ImportRejectedSchema])),
  summary: Schema.Struct({
    acceptedBases: Schema.Int,
    allItemsResolved: Schema.Boolean,
    duplicates: Schema.Int,
    held: Schema.Int,
    reconciliationRequired: Schema.Int,
    rejected: Schema.Int,
    resolvedCurrentChanged: Schema.Int,
    stale: Schema.Int,
    unverifiable: Schema.Int,
  }),
});
export type ImportSourceAssertionResult = typeof ImportSourceAssertionResultSchema.Type;

const OverrideCommonSchema = {
  evidenceRef: boundedText,
  reason: boundedText,
  scope: CatalogSourceFactScopeSchema,
};

export const ActivateLocalOverridePayloadSchema = Schema.Struct({
  ...OverrideCommonSchema,
  classification: Schema.optionalKey(ProductChangeClassificationSchema),
  value: CatalogSourceFactValueSchema,
});
export type ActivateLocalOverridePayload = typeof ActivateLocalOverridePayloadSchema.Type;

export const ChangeLocalOverridePayloadSchema = Schema.Struct({
  ...OverrideCommonSchema,
  classification: Schema.optionalKey(ProductChangeClassificationSchema),
  expectedRevision: overrideRevision,
  value: CatalogSourceFactValueSchema,
});
export type ChangeLocalOverridePayload = typeof ChangeLocalOverridePayloadSchema.Type;

export const ReleaseLocalOverridePayloadSchema = Schema.Struct({
  ...OverrideCommonSchema,
  expectedRevision: overrideRevision,
});
export type ReleaseLocalOverridePayload = typeof ReleaseLocalOverridePayloadSchema.Type;

const CurrentResolutionSchema = Schema.Union([
  Schema.Struct({ source: Schema.Literals(['BASE', 'LOCAL_OVERRIDE']), status: Schema.Literal('CURRENT') }),
  Schema.Struct({
    reason: boundedText,
    status: Schema.Literals(['ABSENT', 'INVALID', 'NO_AUTHORITY', 'INDETERMINATE']),
  }),
]);
const AppliedOverrideResultSchema = Schema.Struct({
  classification: Schema.optionalKey(CosmeticProductCorrectionSchema),
  lifecycle: Schema.Literals(['ACTIVE', 'RELEASED']),
  resolved: CurrentResolutionSchema,
  resolvedCurrentChanged: Schema.Boolean,
  revision: overrideRevision,
  status: Schema.Literal('APPLIED'),
});
const RejectedOverrideResultSchema = Schema.Struct({
  reason: boundedText,
  status: Schema.Literals([
    'PERMISSION_REQUIRED',
    'FORBIDDEN_FACT',
    'NO_AUTHORITY',
    'NO_ACTIVE_OVERRIDE',
    'ALREADY_ACTIVE',
    'ALREADY_RELEASED',
    'STALE_EDITOR',
    'INVALID',
    'CONFLICT',
    'UNAVAILABLE',
    'INDETERMINATE',
  ]),
});
export const CatalogLocalOverrideResultSchema = Schema.Union([
  AppliedOverrideResultSchema,
  RejectedOverrideResultSchema,
]);
export type CatalogLocalOverrideResult = typeof CatalogLocalOverrideResultSchema.Type;
