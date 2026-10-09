import type { Effect as EffectType, Option } from 'effect';
import { DateTime, Schema } from 'effect';

import { CustomerConfigurationIdSchema } from '../inventory-launch-scope.ts';
import { ExternalStockCorrelationRefSchema } from '../resources/external-stock-correlation.ts';
import { StockItemRefSchema } from '../resources/stock-item.ts';
import { StockLocationRefSchema } from '../resources/stock-location.ts';
import { StockPositionRefSchema } from '../resources/stock-position.ts';
import { ExternalStockKeySchema, InventoryBackendOriginSchema } from './external-stock-correlation.ts';
import { InventoryBackendConfigurationSchema } from './inventory-backend-configuration.ts';
import { PhysicalStockEffectIdSchema } from './physical-stock-effect.ts';
import { StockQuantitySchema } from './stock-position.ts';
import type { InventorySourceAssertionRejected } from './inventory-source-assertion-rejected.ts';
import type { InventorySourceAssertionUnavailable } from './inventory-source-assertion-unavailable.ts';

const boundedText = Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(300));
const instant = Schema.toEncoded(Schema.DateTimeUtcFromString);
const uuid = Schema.String.check(Schema.isUUID());

export const InventorySourceAssertionIdSchema = uuid.pipe(Schema.brand('InventorySourceAssertionId'));
export type InventorySourceAssertionId = typeof InventorySourceAssertionIdSchema.Type;

export const sourceAssertionBusinessTimeAtOrAfterSelection = (
  businessObservedAt: string,
  selectedAt: string,
): boolean =>
  DateTime.toEpochMillis(DateTime.makeUnsafe(businessObservedAt)) >=
  DateTime.toEpochMillis(DateTime.makeUnsafe(selectedAt));

export const SourceRevisionOrderingEvidenceSchema = Schema.TaggedStruct('SOURCE_REVISION', {
  revision: boundedText,
});
export const OwnerOrderKeyEvidenceSchema = Schema.TaggedStruct('OWNER_ORDER_KEY', { key: boundedText });
export const InventorySourceOrderingEvidenceSchema = Schema.Union([
  SourceRevisionOrderingEvidenceSchema,
  OwnerOrderKeyEvidenceSchema,
]);
export type InventorySourceOrderingEvidence = typeof InventorySourceOrderingEvidenceSchema.Type;

export const SourceCoverageRelationSchema = Schema.Literals(['INCLUDES', 'EXCLUDES', 'PREDATES', 'UNKNOWN']);

/** Owner evidence binds one assertion to one already-known authoritative physical effect. */
export const SourceCoverageEvidenceSchema = Schema.Struct({
  assertionId: InventorySourceAssertionIdSchema,
  effectId: PhysicalStockEffectIdSchema,
  ownerEvidenceRef: boundedText,
  relation: SourceCoverageRelationSchema,
});
export type SourceCoverageEvidence = typeof SourceCoverageEvidenceSchema.Type;

const sourceAssertionCommon = {
  assertionId: InventorySourceAssertionIdSchema,
  businessObservedAt: instant,
  coverage: Schema.Array(SourceCoverageEvidenceSchema),
  customerConfigurationId: CustomerConfigurationIdSchema,
  factMeaning: Schema.Literal('ABSOLUTE_PHYSICAL_ON_HAND'),
  issuer: InventoryBackendOriginSchema,
  itemExternalKey: ExternalStockKeySchema,
  locationExternalKey: ExternalStockKeySchema,
  orderingEvidence: InventorySourceOrderingEvidenceSchema,
  ownerEvidenceRef: boundedText,
  positionRef: StockPositionRefSchema,
  quantity: StockQuantitySchema,
  receivedAt: instant,
  sourceReference: boundedText,
} as const;

const proposalInvariant = (proposal: {
  readonly assertionId: InventorySourceAssertionId;
  readonly coverage: readonly SourceCoverageEvidence[];
  readonly customerConfigurationId: string;
  readonly issuer: { readonly backendId: string; readonly backendKind: string };
  readonly itemExternalKey: typeof ExternalStockKeySchema.Type;
  readonly locationExternalKey: typeof ExternalStockKeySchema.Type;
  readonly positionRef: typeof StockPositionRefSchema.Type;
  readonly quantity: typeof StockQuantitySchema.Type;
}): string | undefined => {
  if (proposal.issuer.backendKind !== 'external_business_system') {
    return 'Inventory Source Assertions must retain an External Business System issuer';
  }
  if (
    proposal.itemExternalKey.identifierKind !== 'ITEM' ||
    proposal.locationExternalKey.identifierKind !== 'LOCATION'
  ) {
    return 'Source assertion correlations must use exact Item and Location identifier kinds';
  }
  const keys = [proposal.itemExternalKey, proposal.locationExternalKey];
  if (
    keys.some(
      (key) =>
        key.tenantId !== proposal.positionRef.tenantId ||
        key.tenantId !== proposal.quantity.unitRef.tenantId ||
        key.customerConfigurationId !== proposal.customerConfigurationId ||
        key.issuer.backendId !== proposal.issuer.backendId ||
        key.issuer.backendKind !== proposal.issuer.backendKind,
    )
  ) {
    return 'Source assertion issuer, Customer Configuration, Position, Unit, and correlation keys must share one exact scope';
  }
  let coverageError: string | undefined;
  if (proposal.coverage.some((coverage) => coverage.assertionId !== proposal.assertionId)) {
    coverageError = 'Source Coverage Evidence must bind the exact source assertion identity';
  } else if (new Set(proposal.coverage.map(({ effectId }) => effectId)).size !== proposal.coverage.length) {
    coverageError = 'Source Coverage Evidence must be unique for each exact physical effect';
  }
  return coverageError;
};

export const InventorySourceAssertionProposalSchema = Schema.Struct(sourceAssertionCommon).check(
  Schema.makeFilter(proposalInvariant),
);
export type InventorySourceAssertionProposal = typeof InventorySourceAssertionProposalSchema.Type;

export const InventorySourceAssertionSchema = Schema.Struct({
  ...sourceAssertionCommon,
  authorityConfiguration: InventoryBackendConfigurationSchema,
  issuerAuthority: Schema.Literals(['SELECTED_BACKEND', 'HISTORICAL_PRE_CUTOVER_ISSUER']),
  itemCorrelationRef: ExternalStockCorrelationRefSchema,
  locationCorrelationRef: ExternalStockCorrelationRefSchema,
  stockItemRef: StockItemRefSchema,
  stockLocationRef: StockLocationRefSchema,
}).check(
  Schema.makeFilter((assertion) => {
    const proposalError = proposalInvariant(assertion);
    if (proposalError !== undefined) {
      return proposalError;
    }
    if (
      assertion.authorityConfiguration.tenantId !== assertion.positionRef.tenantId ||
      assertion.authorityConfiguration.customerConfigurationId !== assertion.customerConfigurationId
    ) {
      return 'Source assertion authority configuration must belong to the exact Tenant and Customer Configuration';
    }
    const selectedIssuer =
      assertion.authorityConfiguration.selection.backend === assertion.issuer.backendKind &&
      assertion.authorityConfiguration.selection.backendId === assertion.issuer.backendId &&
      sourceAssertionBusinessTimeAtOrAfterSelection(
        assertion.businessObservedAt,
        assertion.authorityConfiguration.selectedAt,
      );
    if (
      (assertion.issuerAuthority === 'SELECTED_BACKEND' && !selectedIssuer) ||
      (assertion.issuerAuthority === 'HISTORICAL_PRE_CUTOVER_ISSUER' && selectedIssuer)
    ) {
      return 'Source assertion issuer authority must match the evaluated backend configuration evidence';
    }
    const { tenantId } = assertion.positionRef;
    return assertion.itemCorrelationRef.tenantId === tenantId &&
      assertion.locationCorrelationRef.tenantId === tenantId &&
      assertion.stockItemRef.tenantId === tenantId &&
      assertion.stockLocationRef.tenantId === tenantId
      ? undefined
      : 'Resolved assertion correlations and stock scope must share one Tenant';
  }),
);
export type InventorySourceAssertion = typeof InventorySourceAssertionSchema.Type;

const evaluationCommon = {
  assertion: InventorySourceAssertionSchema,
  postEffectOnHand: Schema.toEncoded(Schema.OptionFromNullOr(StockQuantitySchema)),
  reconciliationRequired: Schema.Boolean,
} as const;

export const DeterminateInventorySourceAssertionEvaluationSchema = Schema.TaggedStruct('DETERMINATE', {
  ...evaluationCommon,
  postEffectOnHand: StockQuantitySchema,
  reconciliationRequired: Schema.Literal(false),
});
export const HistoricalInventorySourceAssertionEvaluationSchema = Schema.TaggedStruct('HISTORICAL', {
  ...evaluationCommon,
  postEffectOnHand: Schema.Null,
  reason: Schema.Literals(['ISSUER_OUTSIDE_SELECTED_BACKEND', 'MATERIAL_EFFECT_EXCLUDED_OR_PREDATED']),
  reconciliationRequired: Schema.Literal(false),
});
export const IndeterminateInventorySourceAssertionEvaluationSchema = Schema.TaggedStruct('INDETERMINATE', {
  ...evaluationCommon,
  materialEffectIds: Schema.Array(PhysicalStockEffectIdSchema),
  postEffectOnHand: Schema.Null,
  reason: Schema.Literals(['MATERIAL_EFFECT_COVERAGE_MISSING', 'MATERIAL_EFFECT_COVERAGE_UNKNOWN']),
  reconciliationRequired: Schema.Literal(true),
});
export const InventorySourceAssertionEvaluationSchema = Schema.Union([
  DeterminateInventorySourceAssertionEvaluationSchema,
  HistoricalInventorySourceAssertionEvaluationSchema,
  IndeterminateInventorySourceAssertionEvaluationSchema,
]);
export type InventorySourceAssertionEvaluation = typeof InventorySourceAssertionEvaluationSchema.Type;

export type InventorySourceAssertionPersistenceError =
  | InventorySourceAssertionRejected
  | InventorySourceAssertionUnavailable;

export interface InventorySourceAssertionPersistence {
  readonly append: (
    assertion: InventorySourceAssertion,
  ) => EffectType.Effect<InventorySourceAssertion, InventorySourceAssertionPersistenceError>;
  readonly findById: (
    assertionId: InventorySourceAssertionId,
  ) => EffectType.Effect<Option.Option<InventorySourceAssertion>, InventorySourceAssertionPersistenceError>;
}

export { InventorySourceAssertionRejected } from './inventory-source-assertion-rejected.ts';
export { InventorySourceAssertionUnavailable } from './inventory-source-assertion-unavailable.ts';
