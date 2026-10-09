import type { Effect as EffectType } from 'effect';
import { DateTime, Schema } from 'effect';

import { CustomerConfigurationIdSchema } from '../inventory-launch-scope.ts';
import { InventoryBackendConfigurationRefSchema } from '../resources/inventory-backend-configuration.ts';
import { StockItemRefSchema } from '../resources/stock-item.ts';
import { StockLocationRefSchema } from '../resources/stock-location.ts';
import { StockPositionRefSchema } from '../resources/stock-position.ts';
import {
  InventorySourceAssertionIdSchema,
  InventorySourceOrderingEvidenceSchema,
  SourceCoverageEvidenceSchema,
} from './inventory-source-assertion.ts';
import { InventoryBackendConfigurationSchema } from './inventory-backend-configuration.ts';
import { InventoryBackendIdSchema } from './inventory-backend-identifiers.ts';
import { InventoryBackendOriginSchema } from './external-stock-correlation.ts';
import { PhysicalStockBusinessReasonSchema, PhysicalStockEffectIdSchema } from './physical-stock-effect.ts';
import {
  StockPositionOnHandEvidenceSchema,
  StockPositionRevisionSchema,
  StockPositionSchema,
  StockQuantitySchema,
} from './stock-position.ts';
import type { ExactStockQuantityAmount } from './stock-position.ts';
import { StockCorrectionConflict } from './stock-correction-conflict.ts';
import { StockCorrectionIdSchema } from './stock-correction-identifiers.ts';
import { StockCorrectionRejected } from './stock-correction-rejected.ts';
import { StockCorrectionUnavailable } from './stock-correction-unavailable.ts';

const instant = Schema.toEncoded(Schema.DateTimeUtcFromString);
const signedCanonicalDecimal = /^(?:0|-?[1-9][0-9]*)(?:\.[0-9]*[1-9])?$/u;
const boundedEvidenceText = Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(300));

export const SignedStockQuantityDeltaSchema = Schema.String.check(
  Schema.makeFilter((value) =>
    signedCanonicalDecimal.test(value)
      ? undefined
      : 'Stock Correction delta must be a canonical signed decimal without exponent, leading zero, or trailing fractional zero',
  ),
).pipe(Schema.brand('SignedStockQuantityDelta'));

/**
 * External owners point at their immutable Source Assertion. OntOS WMS owns the correction
 * boundary directly, so it supplies only the absolute observation and bounded provenance; the
 * service derives observation time and material-effect coverage under the selected owner.
 */
export const ExternalSourceAssertionCorrectionEvidenceSchema = Schema.TaggedStruct('EXTERNAL_SOURCE_ASSERTION', {
  sourceAssertionId: InventorySourceAssertionIdSchema,
});
export const StockCorrectionSourceEvidenceIdSchema = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('StockCorrectionSourceEvidenceId'),
);
export type StockCorrectionSourceEvidenceId = typeof StockCorrectionSourceEvidenceIdSchema.Type;
export const OntosWmsCorrectionCoverageEvidenceSchema = Schema.Struct({
  effectId: PhysicalStockEffectIdSchema,
  evidenceId: StockCorrectionSourceEvidenceIdSchema,
  ownerEvidenceRef: boundedEvidenceText,
  relation: Schema.Literals(['INCLUDES', 'EXCLUDES', 'PREDATES', 'UNKNOWN']),
});
export const OntosWmsCorrectionEvidenceSchema = Schema.TaggedStruct('ONTOS_WMS_OWNER_EVIDENCE', {
  evidenceId: StockCorrectionSourceEvidenceIdSchema,
});
export const StockCorrectionEvidenceSchema = Schema.Union([
  ExternalSourceAssertionCorrectionEvidenceSchema,
  OntosWmsCorrectionEvidenceSchema,
]);

/** Trusted, append-only evidence authored behind the selected OntOS WMS owner boundary. */
export const OntosWmsStockCorrectionSourceEvidenceSchema = Schema.Struct({
  authorityConfiguration: InventoryBackendConfigurationSchema,
  businessObservedAt: instant,
  coverage: Schema.Array(OntosWmsCorrectionCoverageEvidenceSchema),
  customerConfigurationId: CustomerConfigurationIdSchema,
  evidenceId: StockCorrectionSourceEvidenceIdSchema,
  factMeaning: Schema.Literal('ABSOLUTE_PHYSICAL_ON_HAND'),
  issuer: Schema.Struct({ backendId: InventoryBackendIdSchema, backendKind: Schema.Literal('ontos_wms') }),
  orderingEvidence: InventorySourceOrderingEvidenceSchema,
  ownerEvidenceRef: boundedEvidenceText,
  positionRef: StockPositionRefSchema,
  quantity: StockQuantitySchema,
  receivedAt: instant,
  sourceReference: boundedEvidenceText,
  stockItemRef: StockItemRefSchema,
  stockLocationRef: StockLocationRefSchema,
}).check(
  Schema.makeFilter((evidence) => {
    const { tenantId } = evidence.positionRef;
    if (
      evidence.authorityConfiguration.tenantId !== tenantId ||
      evidence.authorityConfiguration.customerConfigurationId !== evidence.customerConfigurationId ||
      evidence.authorityConfiguration.selection.backend !== 'ontos_wms' ||
      evidence.authorityConfiguration.selection.backendId !== evidence.issuer.backendId ||
      evidence.issuer.backendKind !== 'ontos_wms' ||
      evidence.stockItemRef.tenantId !== tenantId ||
      evidence.stockLocationRef.tenantId !== tenantId ||
      evidence.quantity.unitRef.tenantId !== tenantId
    ) {
      return 'OntOS WMS correction evidence must match one exact selected owner and stock scope';
    }
    if (
      DateTime.toEpochMillis(DateTime.makeUnsafe(evidence.businessObservedAt)) <
      DateTime.toEpochMillis(DateTime.makeUnsafe(evidence.authorityConfiguration.selectedAt))
    ) {
      return 'OntOS WMS correction evidence must be observed at or after the selected owner cutover';
    }
    if (evidence.coverage.some((entry) => entry.evidenceId !== evidence.evidenceId)) {
      return 'OntOS WMS coverage must bind the exact correction source evidence identity';
    }
    return new Set(evidence.coverage.map(({ effectId }) => effectId)).size === evidence.coverage.length
      ? undefined
      : 'OntOS WMS coverage must be unique for each exact physical effect';
  }),
);
export type OntosWmsStockCorrectionSourceEvidence = typeof OntosWmsStockCorrectionSourceEvidenceSchema.Type;

export const StockCorrectionPayloadSchema = Schema.Struct({
  correctionId: StockCorrectionIdSchema,
  customerConfigurationId: CustomerConfigurationIdSchema,
  evidence: StockCorrectionEvidenceSchema,
  expectedPositionRevision: StockPositionRevisionSchema,
  positionRef: StockPositionRefSchema,
  reason: PhysicalStockBusinessReasonSchema,
  reconcilesCorrectionId: Schema.optionalKey(StockCorrectionIdSchema),
});
export type StockCorrectionPayload = typeof StockCorrectionPayloadSchema.Type;

const correctionCommon = {
  actionInvocationId: Schema.String.check(Schema.isUUID()),
  appliedAt: instant,
  authorityConfigurationRef: InventoryBackendConfigurationRefSchema,
  businessObservedAt: instant,
  correctionId: StockCorrectionIdSchema,
  coverageEvidence: Schema.Array(
    Schema.Union([SourceCoverageEvidenceSchema, OntosWmsCorrectionCoverageEvidenceSchema]),
  ),
  customerConfigurationId: CustomerConfigurationIdSchema,
  evaluatedMaterialEffectIds: Schema.Array(PhysicalStockEffectIdSchema),
  evidenceKind: Schema.Literals(['EXTERNAL_SOURCE_ASSERTION', 'ONTOS_WMS_OWNER_EVIDENCE']),
  expectedPositionRevision: StockPositionRevisionSchema,
  issuer: InventoryBackendOriginSchema,
  ownerEvidenceRef: boundedEvidenceText,
  positionRef: StockPositionRefSchema,
  positionRevisionAfter: StockPositionRevisionSchema,
  previousOnHand: StockPositionOnHandEvidenceSchema,
  principalId: Schema.String.check(Schema.isUUID()),
  reason: PhysicalStockBusinessReasonSchema,
  // oxlint-disable-next-line effect-native/no-nullable-schema-field -- Persisted Action evidence uses explicit JSON null for the absent reconciliation identity; expires: 2027-03-31.
  reconcilesCorrectionId: Schema.NullOr(StockCorrectionIdSchema),
  // oxlint-disable-next-line effect-native/no-nullable-schema-field -- The two evidence identity columns form a database-enforced JSON-null XOR; expires: 2027-03-31.
  sourceAssertionId: Schema.NullOr(InventorySourceAssertionIdSchema),
  // oxlint-disable-next-line effect-native/no-nullable-schema-field -- The two evidence identity columns form a database-enforced JSON-null XOR; expires: 2027-03-31.
  sourceEvidenceId: Schema.NullOr(StockCorrectionSourceEvidenceIdSchema),
  sourceOrderingEvidence: InventorySourceOrderingEvidenceSchema,
  sourceReference: boundedEvidenceText,
} as const;

export const AppliedStockCorrectionSchema = Schema.TaggedStruct('APPLIED', {
  ...correctionCommon,
  correctedQuantity: StockQuantitySchema,
  explanatoryDelta: Schema.toEncoded(Schema.OptionFromNullOr(SignedStockQuantityDeltaSchema)),
  materialChange: Schema.Literals(['DECREASE', 'INCREASE', 'UNCHANGED', 'UNRESOLVED_BASELINE']),
});

export const IndeterminateStockCorrectionSchema = Schema.TaggedStruct('INDETERMINATE', {
  ...correctionCommon,
  materialEffectIds: Schema.Array(PhysicalStockEffectIdSchema),
  reasonCode: Schema.Literals([
    'MATERIAL_EFFECT_COVERAGE_MISSING',
    'MATERIAL_EFFECT_COVERAGE_UNKNOWN',
    'MATERIAL_EFFECT_EXCLUDED_OR_PREDATED',
  ]),
});

export const StockCorrectionRecordSchema = Schema.Union([
  AppliedStockCorrectionSchema,
  IndeterminateStockCorrectionSchema,
]).check(
  Schema.makeFilter((record) => {
    const external =
      record.evidenceKind === 'EXTERNAL_SOURCE_ASSERTION' &&
      record.issuer.backendKind === 'external_business_system' &&
      record.sourceAssertionId !== null &&
      record.sourceEvidenceId === null;
    const wms =
      record.evidenceKind === 'ONTOS_WMS_OWNER_EVIDENCE' &&
      record.issuer.backendKind === 'ontos_wms' &&
      record.sourceAssertionId === null &&
      record.sourceEvidenceId !== null;
    return external || wms
      ? undefined
      : 'Stock Correction must bind exactly one owner-valid evidence identity for its issuer kind';
  }),
);
export type StockCorrectionRecord = typeof StockCorrectionRecordSchema.Type;

export const StockCorrectionResultSchema = Schema.Struct({
  correction: StockCorrectionRecordSchema,
  outcome: Schema.Literals(['APPLIED', 'EXACT_REPLAY', 'RECONCILIATION_REQUIRED']),
  position: StockPositionSchema,
});
export type StockCorrectionResult = typeof StockCorrectionResultSchema.Type;

export const StockCorrectionErrorSchema = Schema.Union([
  StockCorrectionConflict,
  StockCorrectionRejected,
  StockCorrectionUnavailable,
]);
export type StockCorrectionError = typeof StockCorrectionErrorSchema.Type;

interface DecimalParts {
  readonly coefficient: bigint;
  readonly scale: number;
}

const decimalParts = (amount: string): DecimalParts => {
  const negative = amount.startsWith('-');
  const unsigned = negative ? amount.slice(1) : amount;
  const [integer = '0', fraction = ''] = unsigned.split('.');
  const coefficient = BigInt(`${integer}${fraction}`) * (negative ? -1n : 1n);
  return { coefficient, scale: fraction.length };
};

const formatDecimal = (coefficient: bigint, scale: number): string => {
  const negative = coefficient < 0n;
  const unsigned = negative ? -coefficient : coefficient;
  if (scale === 0) {
    return coefficient.toString();
  }
  const padded = unsigned.toString().padStart(scale + 1, '0');
  const integer = padded.slice(0, -scale);
  const fraction = padded.slice(-scale).replace(/0+$/u, '');
  const value = fraction.length === 0 ? integer : `${integer}.${fraction}`;
  return value === '0' ? value : `${negative ? '-' : ''}${value}`;
};

/** The correction meaning is absolute; this signed delta is explanatory evidence only. */
export const deriveStockCorrectionDelta = (
  previous: ExactStockQuantityAmount,
  corrected: ExactStockQuantityAmount,
): EffectType.Effect<typeof SignedStockQuantityDeltaSchema.Type, Schema.SchemaError> => {
  const left = decimalParts(previous);
  const right = decimalParts(corrected);
  const scale = Math.max(left.scale, right.scale);
  const coefficient =
    right.coefficient * 10n ** BigInt(scale - right.scale) - left.coefficient * 10n ** BigInt(scale - left.scale);
  return Schema.decodeEffect(SignedStockQuantityDeltaSchema)(formatDecimal(coefficient, scale));
};

export { StockCorrectionConflict } from './stock-correction-conflict.ts';
export { StockCorrectionIdSchema } from './stock-correction-identifiers.ts';
export type { StockCorrectionId } from './stock-correction-identifiers.ts';
export { StockCorrectionRejected } from './stock-correction-rejected.ts';
export { StockCorrectionUnavailable } from './stock-correction-unavailable.ts';
