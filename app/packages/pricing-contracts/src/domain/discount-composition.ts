import { Schema } from 'effect';

import {
  CurrentSupportedCurrenciesSuccessSchema,
  PricingCurrencyCodeSchema,
} from '../apis/current-supported-currencies.ts';
import {
  PricingDiscountAudienceEvidenceBindingSchema,
  PricingDiscountDefinitionSchema,
  PricingWholePurchaseContractualApplicabilitySchema,
  PricingWholePurchaseContractualEligibleBasisSchema,
  pricingDiscountIdentityKeysEqual,
} from './discount.ts';
import type { PricingDiscountDefinition } from './discount.ts';
import {
  PricingDecisionSchema,
  PricingNonNegativeDecimalSchema,
  PricingNonPositiveDecimalSchema,
  PricingPurchaseDemandOccurrenceIdSchema,
} from './pricing-decision.ts';

const PricingCompositionNonNegativeMoneySchema = Schema.Struct({
  amount: PricingNonNegativeDecimalSchema,
  currencyCode: PricingCurrencyCodeSchema,
});
const PricingCompositionNonPositiveMoneySchema = Schema.Struct({
  amount: PricingNonPositiveDecimalSchema,
  currencyCode: PricingCurrencyCodeSchema,
});

interface DecimalParts {
  readonly coefficient: bigint;
  readonly scale: number;
}

const decimalParts = (value: string): DecimalParts => {
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [integer = '0', fraction = ''] = unsigned.split('.');
  const coefficient = BigInt(`${integer}${fraction}`);
  return { coefficient: negative ? -coefficient : coefficient, scale: fraction.length };
};

const formatDecimal = (coefficient: bigint, scale: number): string => {
  if (coefficient === 0n) {
    return '0';
  }
  const negative = coefficient < 0n;
  const digits = (negative ? -coefficient : coefficient).toString().padStart(scale + 1, '0');
  const integer = scale === 0 ? digits : digits.slice(0, -scale);
  const fraction = scale === 0 ? '' : digits.slice(-scale).replace(/0+$/u, '');
  const fractionalSuffix = fraction.length === 0 ? '' : `.${fraction}`;
  return `${negative ? '-' : ''}${integer}${fractionalSuffix}`;
};

const alignedCoefficient = (parts: DecimalParts, scale: number): bigint =>
  parts.coefficient * 10n ** BigInt(scale - parts.scale);

const addDecimals = (left: string, right: string): string => {
  const leftParts = decimalParts(left);
  const rightParts = decimalParts(right);
  const scale = Math.max(leftParts.scale, rightParts.scale);
  return formatDecimal(alignedCoefficient(leftParts, scale) + alignedCoefficient(rightParts, scale), scale);
};

const decimalsEqual = (left: string, right: string): boolean => {
  const leftParts = decimalParts(left);
  const rightParts = decimalParts(right);
  const scale = Math.max(leftParts.scale, rightParts.scale);
  return alignedCoefficient(leftParts, scale) === alignedCoefficient(rightParts, scale);
};

const percentageContribution = (basis: string, percentage: string): string => {
  const basisParts = decimalParts(basis);
  const percentageParts = decimalParts(percentage);
  return formatDecimal(
    -(basisParts.coefficient * percentageParts.coefficient),
    basisParts.scale + percentageParts.scale + 2,
  );
};

/** Every percentage layer uses this same fee-inclusive amount; it is not a running net subtotal. */
export const PricingDiscountableLineBasisSchema = Schema.Struct({
  amount: PricingCompositionNonNegativeMoneySchema,
  applicablePricingFeeTotal: PricingCompositionNonNegativeMoneySchema,
  baseLineValue: PricingCompositionNonNegativeMoneySchema,
  occurrenceId: PricingPurchaseDemandOccurrenceIdSchema,
}).check(
  Schema.makeFilter(({ amount, applicablePricingFeeTotal, baseLineValue }) => {
    if (
      amount.currencyCode !== baseLineValue.currencyCode ||
      amount.currencyCode !== applicablePricingFeeTotal.currencyCode
    ) {
      return 'Base line value, Pricing Fees, and Discountable Line Basis must use one exact currency';
    }
    return decimalsEqual(amount.amount, addDecimals(baseLineValue.amount, applicablePricingFeeTotal.amount))
      ? undefined
      : 'Discountable Line Basis must equal Base Line Value plus all applicable Pricing Fees';
  }),
);
export type PricingDiscountableLineBasis = typeof PricingDiscountableLineBasisSchema.Type;

export const PricingDiscountLineLayerSchema = Schema.Literals([
  'CATALOG',
  'PRICE_GROUP_CONTRACTUAL',
  'COUNTERPARTY_CONTRACTUAL',
]);
export type PricingDiscountLineLayer = typeof PricingDiscountLineLayerSchema.Type;

export const PricingDiscountCompositionLayerSchema = Schema.Union([
  PricingDiscountLineLayerSchema,
  Schema.Literal('COUNTERPARTY_WHOLE_PURCHASE'),
]);
export type PricingDiscountCompositionLayer = typeof PricingDiscountCompositionLayerSchema.Type;

const lineLayerFor = (definition: PricingDiscountDefinition): null | PricingDiscountLineLayer => {
  const { audience, family, scope } = definition.identityKey;
  if (scope !== 'VARIANT_LINE') {
    return null;
  }
  if (family === 'CATALOG_DISCOUNT' && audience.kind === 'CATALOG_PATH') {
    return 'CATALOG';
  }
  if (family === 'CONTRACTUAL_DISCOUNT' && audience.kind === 'PRICE_GROUP') {
    return 'PRICE_GROUP_CONTRACTUAL';
  }
  return family === 'CONTRACTUAL_DISCOUNT' && audience.kind === 'COUNTERPARTY' ? 'COUNTERPARTY_CONTRACTUAL' : null;
};

const commonApplicableFields = {
  audienceBinding: PricingDiscountAudienceEvidenceBindingSchema,
  definition: PricingDiscountDefinitionSchema,
  outcome: Schema.Literal('DISCOUNT_APPLICABLE'),
};

const samePricingDecision = Schema.toEquivalence(PricingDecisionSchema);
const sameWholePurchaseBasis = Schema.toEquivalence(PricingWholePurchaseContractualEligibleBasisSchema);

const PricingApplicableLineDiscountSchema = Schema.Struct({
  ...commonApplicableFields,
  applicationCount: Schema.Literal('ONCE_PER_STABLE_LINE'),
  kind: Schema.Literal('VARIANT_LINE'),
  layer: PricingDiscountLineLayerSchema,
  occurrenceId: PricingPurchaseDemandOccurrenceIdSchema,
}).check(
  Schema.makeFilter(({ audienceBinding, definition, layer }) => {
    if (!pricingDiscountIdentityKeysEqual(audienceBinding.identityKey, definition.identityKey)) {
      return 'Applicable line Discount evidence must bind the exact Current logical Discount';
    }
    return lineLayerFor(definition) === layer
      ? undefined
      : 'Applicable line Discount layer must follow its family, audience, and scope';
  }),
);

const PricingApplicableWholePurchaseDiscountSchema = Schema.Struct({
  ...commonApplicableFields,
  applicability: PricingWholePurchaseContractualApplicabilitySchema,
  applicationCount: Schema.Literal('ONCE_PER_PRICING_DECISION'),
  decision: PricingDecisionSchema,
  kind: Schema.Literal('WHOLE_PURCHASE'),
  layer: Schema.Literal('COUNTERPARTY_WHOLE_PURCHASE'),
}).check(
  Schema.makeFilter(({ applicability, audienceBinding, decision, definition }) => {
    if (!pricingDiscountIdentityKeysEqual(audienceBinding.identityKey, definition.identityKey)) {
      return 'Applicable whole-purchase Discount evidence must bind the exact Current logical Discount';
    }
    if (
      definition.identityKey.scope !== 'WHOLE_PURCHASE' ||
      definition.identityKey.family !== 'CONTRACTUAL_DISCOUNT' ||
      definition.identityKey.audience.kind !== 'COUNTERPARTY'
    ) {
      return 'Whole-purchase layer requires one exact Counterparty contractual Discount';
    }
    if (applicability.outcome !== 'WHOLE_PURCHASE_DISCOUNT_APPLICABLE') {
      return 'Only an already-applicable whole-purchase Discount can enter composition';
    }
    if (
      applicability.basis.currencyCode !== decision.currencyCode ||
      applicability.basis.recipients.some(
        ({ occurrenceId }) => !decision.lines.some((line) => line.occurrenceId === occurrenceId),
      )
    ) {
      return 'Whole-purchase applicability basis must preserve eligible original occurrences from its exact Decision';
    }
    return applicability.definition.discountId === definition.discountId &&
      pricingDiscountIdentityKeysEqual(applicability.definition.identityKey, definition.identityKey) &&
      applicability.definition.revision.revisionId === definition.revision.revisionId
      ? undefined
      : 'Whole-purchase threshold evidence must bind the exact Discount Revision';
  }),
);

/** A candidate is already owner-proven and applicable under #771; composition never fabricates applicability. */
export const PricingDiscountCompositionCandidateSchema = Schema.Union([
  PricingApplicableLineDiscountSchema,
  PricingApplicableWholePurchaseDiscountSchema,
]);
export type PricingDiscountCompositionCandidate = typeof PricingDiscountCompositionCandidateSchema.Type;

const applicationPathKey = (candidate: PricingDiscountCompositionCandidate): string =>
  candidate.kind === 'VARIANT_LINE'
    ? `${candidate.kind}:${candidate.occurrenceId}:${candidate.layer}`
    : `${candidate.kind}:${candidate.layer}`;

const sameCatalogRef = (
  left: {
    readonly moduleId: string;
    readonly resourceId: string;
    readonly resourceType: string;
    readonly tenantId: string;
  },
  right: {
    readonly moduleId: string;
    readonly resourceId: string;
    readonly resourceType: string;
    readonly tenantId: string;
  },
): boolean =>
  left.moduleId === right.moduleId &&
  left.resourceId === right.resourceId &&
  left.resourceType === right.resourceType &&
  left.tenantId === right.tenantId;

const discountAudienceTenantId = (definition: PricingDiscountDefinition): string => {
  const { audience } = definition.identityKey;
  if (audience.kind === 'CATALOG_PATH') {
    return audience.selection.productRef.tenantId;
  }
  if (audience.kind === 'PRICE_GROUP') {
    return audience.priceGroupRef.tenantId;
  }
  return audience.counterpartyRef.tenantId;
};

const candidateDecisionMismatch = (
  candidate: typeof PricingDiscountCompositionCandidateSchema.Type,
  decision: typeof PricingDecisionSchema.Type,
): string | undefined => {
  const { identityKey } = candidate.definition;
  if (
    identityKey.currencyCode !== decision.currencyCode ||
    identityKey.monetaryBoundary !== decision.monetaryBoundary ||
    discountAudienceTenantId(candidate.definition) !== decision.tenantId
  ) {
    return 'Every applicable Discount must bind the exact Decision currency, boundary, and Tenant';
  }
  if (
    identityKey.commercialScope.channelId !== decision.commercialScope.channelId ||
    identityKey.commercialScope.marketId !== decision.commercialScope.marketId ||
    identityKey.commercialScope.sellingLegalEntityId !== decision.commercialScope.sellingLegalEntityId
  ) {
    return 'Every applicable Discount must bind the exact Decision commercial scope';
  }
  if (candidate.kind !== 'VARIANT_LINE') {
    return undefined;
  }
  const line = decision.lines.find(({ occurrenceId }) => occurrenceId === candidate.occurrenceId);
  if (
    line === undefined ||
    identityKey.basis.kind !== 'VARIANT_LINE' ||
    !sameCatalogRef(identityKey.basis.catalogSelection.productRef, line.catalog.selection.productRef) ||
    !sameCatalogRef(identityKey.basis.catalogSelection.variantRef, line.catalog.selection.variantRef) ||
    !sameCatalogRef(identityKey.basis.unitBasis.unitRef, line.pricingBasis.unitRef) ||
    !decimalsEqual(identityKey.basis.unitBasis.quantity, line.pricingBasis.quantity)
  ) {
    return 'Applicable line Discount must bind the exact original Pricing Line path and Unit basis';
  }
  return undefined;
};

export const PricingDiscountCompositionRequestSchema = Schema.Struct({
  candidates: Schema.Array(PricingDiscountCompositionCandidateSchema),
  currencySupport: CurrentSupportedCurrenciesSuccessSchema,
  decision: PricingDecisionSchema,
  lineBases: Schema.Array(PricingDiscountableLineBasisSchema).check(Schema.isMinLength(1)),
  wholePurchaseBasis: Schema.optionalKey(PricingWholePurchaseContractualEligibleBasisSchema),
}).check(
  Schema.makeFilter(({ candidates, currencySupport, decision, lineBases, wholePurchaseBasis }) => {
    if (
      currencySupport.tenantId !== decision.tenantId ||
      currencySupport.effectiveAt !== decision.operationTime ||
      currencySupport.currentnessEvidence.evaluatedAt !== decision.operationTime ||
      currencySupport.currentnessEvidence.evaluationMode !== 'CURRENT_WITH_REVALIDATION'
    ) {
      return 'Currency Support must be Current for the exact Pricing Decision Tenant and operation instant';
    }
    if (!currencySupport.supportedCurrencies.includes(decision.currencyCode)) {
      return 'The exact Pricing Decision currency must be enabled by Current Tenant Currency Support';
    }
    if (
      lineBases.length !== decision.lines.length ||
      new Set(lineBases.map(({ occurrenceId }) => occurrenceId)).size !== lineBases.length ||
      !decision.lines.every(({ occurrenceId }) => lineBases.some((basis) => basis.occurrenceId === occurrenceId))
    ) {
      return 'Discount composition must preserve exactly one basis for every original Pricing Line';
    }
    if (lineBases.some(({ amount }) => amount.currencyCode !== decision.currencyCode)) {
      return 'Every Discountable Line Basis must use the exact Pricing Decision currency';
    }
    if (
      wholePurchaseBasis !== undefined &&
      (wholePurchaseBasis.currencyCode !== decision.currencyCode ||
        wholePurchaseBasis.recipients.some(
          ({ occurrenceId }) => !decision.lines.some((line) => line.occurrenceId === occurrenceId),
        ))
    ) {
      return 'Whole-purchase basis must preserve eligible original occurrences from the exact Pricing Decision';
    }
    for (const candidate of candidates) {
      const mismatch = candidateDecisionMismatch(candidate, decision);
      if (mismatch !== undefined) {
        return mismatch;
      }
      if (candidate.kind === 'WHOLE_PURCHASE') {
        if (!samePricingDecision(candidate.decision, decision)) {
          return 'Whole-purchase applicability proof must bind the exact Pricing Decision';
        }
        if (
          wholePurchaseBasis === undefined ||
          candidate.applicability.outcome !== 'WHOLE_PURCHASE_DISCOUNT_APPLICABLE' ||
          !sameWholePurchaseBasis(candidate.applicability.basis, wholePurchaseBasis)
        ) {
          return 'Whole-purchase applicability proof must bind the exact declared post-line eligible basis';
        }
      }
    }
    return [];
  }),
);
export type PricingDiscountCompositionRequest = typeof PricingDiscountCompositionRequestSchema.Type;

export const PricingDiscountLineContributionSchema = Schema.Struct({
  amount: PricingCompositionNonPositiveMoneySchema,
  applicationCount: Schema.Literal('ONCE_PER_STABLE_LINE'),
  basis: PricingDiscountableLineBasisSchema,
  candidate: PricingApplicableLineDiscountSchema,
  contributionDirection: Schema.Literal('NON_POSITIVE_REDUCTION'),
}).check(
  Schema.makeFilter(({ amount, basis, candidate }) => {
    if (basis.occurrenceId !== candidate.occurrenceId || amount.currencyCode !== basis.amount.currencyCode) {
      return 'Line Discount contribution must bind its original line and Discountable Line Basis currency';
    }
    const effect = candidate.definition.revision.configuredEffect;
    if (effect.kind === 'PERCENTAGE') {
      return decimalsEqual(amount.amount, percentageContribution(basis.amount.amount, effect.level))
        ? undefined
        : 'Every percentage contribution must be calculated independently from the common Discountable Line Basis';
    }
    if (effect.level.currencyCode !== amount.currencyCode) {
      return 'Fixed line Discount must use the exact Decision currency';
    }
    const expected = /^0(?:\.0+)?$/u.test(effect.level.amount) ? '0' : `-${effect.level.amount}`;
    return decimalsEqual(amount.amount, expected)
      ? undefined
      : 'Fixed line Discount must be applied exactly once, never multiplied by Quantity';
  }),
);
export type PricingDiscountLineContribution = typeof PricingDiscountLineContributionSchema.Type;

export const PricingDiscountWholePurchaseContributionSchema = Schema.Struct({
  amount: PricingCompositionNonPositiveMoneySchema,
  applicationCount: Schema.Literal('ONCE_PER_PRICING_DECISION'),
  candidate: PricingApplicableWholePurchaseDiscountSchema,
  contributionDirection: Schema.Literal('NON_POSITIVE_REDUCTION'),
}).check(
  Schema.makeFilter(({ amount, candidate }) => {
    if (candidate.applicability.outcome !== 'WHOLE_PURCHASE_DISCOUNT_APPLICABLE') {
      return 'Whole-purchase composition requires prior applicable threshold evidence';
    }
    const expected = candidate.applicability.contribution;
    return amount.currencyCode === expected.currencyCode && decimalsEqual(amount.amount, expected.amount)
      ? undefined
      : 'Whole-purchase contribution must preserve the single already-proven -D contribution';
  }),
);
export type PricingDiscountWholePurchaseContribution = typeof PricingDiscountWholePurchaseContributionSchema.Type;

export const PricingDiscountCardinalityPathSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal('VARIANT_LINE_LAYER'),
    layer: PricingDiscountLineLayerSchema,
    occurrenceId: PricingPurchaseDemandOccurrenceIdSchema,
  }),
  Schema.Struct({
    kind: Schema.Literal('WHOLE_PURCHASE_LAYER'),
    layer: Schema.Literal('COUNTERPARTY_WHOLE_PURCHASE'),
  }),
]);
export type PricingDiscountCardinalityPath = typeof PricingDiscountCardinalityPathSchema.Type;

const candidateMatchesPath = (
  candidate: PricingDiscountCompositionCandidate,
  path: PricingDiscountCardinalityPath,
): boolean =>
  path.kind === 'VARIANT_LINE_LAYER'
    ? candidate.kind === 'VARIANT_LINE' &&
      candidate.layer === path.layer &&
      candidate.occurrenceId === path.occurrenceId
    : candidate.kind === 'WHOLE_PURCHASE' && candidate.layer === path.layer;

/** Typed family-layer collision; this is deliberately not a Revision conflict or winner selection. */
export const PricingDiscountCardinalityConflictSchema = Schema.Struct({
  claimants: Schema.Array(PricingDiscountCompositionCandidateSchema).check(Schema.isMinLength(2)),
  conflictKind: Schema.Literal('DISCOUNT_LAYER_CARDINALITY'),
  path: PricingDiscountCardinalityPathSchema,
}).check(
  Schema.makeFilter(({ claimants, path }) => {
    if (!claimants.every((candidate) => candidateMatchesPath(candidate, path))) {
      return 'Every cardinality claimant must compete for the exact same Discount layer and path';
    }
    return [];
  }),
);
export type PricingDiscountCardinalityConflict = typeof PricingDiscountCardinalityConflictSchema.Type;

const duplicateCandidateKey = (candidates: readonly PricingDiscountCompositionCandidate[]): null | string => {
  const counts = new Map<string, number>();
  for (const candidate of candidates) {
    const key = applicationPathKey(candidate);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].find(([, count]) => count > 1)?.[0] ?? null;
};

const sameCompositionCandidate = Schema.toEquivalence(PricingDiscountCompositionCandidateSchema);

const candidateCollectionsEqualOneToOne = (
  expected: readonly PricingDiscountCompositionCandidate[],
  actual: readonly PricingDiscountCompositionCandidate[],
): boolean => {
  if (expected.length !== actual.length) {
    return false;
  }
  const unmatched = [...actual];
  for (const candidate of expected) {
    const matchingIndex = unmatched.findIndex((other) => sameCompositionCandidate(candidate, other));
    if (matchingIndex === -1) {
      return false;
    }
    unmatched.splice(matchingIndex, 1);
  }
  return unmatched.length === 0;
};

export const PricingDiscountCompositionReadySchema = Schema.Struct({
  lineContributions: Schema.Array(PricingDiscountLineContributionSchema),
  outcome: Schema.Literal('DISCOUNT_COMPOSITION_READY'),
  request: PricingDiscountCompositionRequestSchema,
  wholePurchaseContribution: Schema.optionalKey(PricingDiscountWholePurchaseContributionSchema),
}).check(
  Schema.makeFilter(({ lineContributions, request, wholePurchaseContribution }) => {
    if (duplicateCandidateKey(request.candidates) !== null) {
      return 'A cardinality collision must produce the typed conflict outcome, never a composed winner';
    }
    const lineCandidates = request.candidates.filter(
      (candidate): candidate is typeof PricingApplicableLineDiscountSchema.Type => candidate.kind === 'VARIANT_LINE',
    );
    if (
      !candidateCollectionsEqualOneToOne(
        lineCandidates,
        lineContributions.map(({ candidate }) => candidate),
      )
    ) {
      return 'Ready composition must preserve exactly one contribution for every applicable line Discount';
    }
    const wholeCandidates = request.candidates.filter((candidate) => candidate.kind === 'WHOLE_PURCHASE');
    if (wholeCandidates.length === 0) {
      return wholePurchaseContribution === undefined
        ? undefined
        : 'Whole-purchase evidence cannot appear without an applicable whole-purchase Discount';
    }
    const [wholeCandidate] = wholeCandidates;
    return wholePurchaseContribution !== undefined &&
      wholeCandidates.length === 1 &&
      wholeCandidate !== undefined &&
      sameCompositionCandidate(wholeCandidate, wholePurchaseContribution.candidate)
      ? undefined
      : 'Ready composition must apply the one whole-purchase contribution exactly once per Decision';
  }),
);

export const PricingDiscountCompositionConflictResultSchema = Schema.Struct({
  conflict: PricingDiscountCardinalityConflictSchema,
  outcome: Schema.Literal('DISCOUNT_CARDINALITY_CONFLICT'),
  request: PricingDiscountCompositionRequestSchema,
}).check(
  Schema.makeFilter(({ conflict, request }) => {
    const matching = request.candidates.filter((candidate) => candidateMatchesPath(candidate, conflict.path));
    if (matching.length < 2) {
      return 'Cardinality conflict must be proven by competing applicable facts in the exact request';
    }
    return candidateCollectionsEqualOneToOne(matching, conflict.claimants)
      ? undefined
      : 'Cardinality conflict claimants must preserve the complete exact candidate evidence one-to-one';
  }),
);

export type PricingDiscountCompositionReady = typeof PricingDiscountCompositionReadySchema.Type;
export type PricingDiscountCompositionConflictResult = typeof PricingDiscountCompositionConflictResultSchema.Type;
export const PricingDiscountCompositionResultSchema: Schema.Union<
  readonly [typeof PricingDiscountCompositionReadySchema, typeof PricingDiscountCompositionConflictResultSchema]
> = Schema.Union([PricingDiscountCompositionReadySchema, PricingDiscountCompositionConflictResultSchema]);
export type PricingDiscountCompositionResult = typeof PricingDiscountCompositionResultSchema.Type;
