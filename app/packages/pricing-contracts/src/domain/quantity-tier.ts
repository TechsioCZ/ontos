import { CatalogQuantityBasisSchema } from '@app/catalog/domain/catalog-quantity-handoff';
import { OwnerVerifiableSetCompletenessEvidenceSchema } from '@app/shared-contracts';
import { DateTime, Schema } from 'effect';

import { PricingCurrencyCodeSchema, PricingInstantSchema } from '../apis/current-supported-currencies.ts';
import { PriceRefSchema } from '../resources/price.ts';
import {
  priceDecimalValuesEqual,
  PriceNonNegativeDecimalSchema,
  PricePositiveDecimalSchema,
  PriceGroupSelectorSchema,
  PriceUnitBasisSchema,
} from './price-definition.ts';
import { PriceScheduleRevisionSchema, ScheduledPriceRevisionSchema } from './price-schedule.ts';

const checkedUuid = Schema.String.check(Schema.isUUID(), Schema.isTrimmed());

const sameResourceRef = (
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

/** Exact ordering for already-validated non-negative Pricing decimals without binary floating point. */
export const compareQuantityTierDecimalValues = (left: string, right: string): -1 | 0 | 1 => {
  const [leftWhole = '0', leftFraction = ''] = left.split('.');
  const [rightWhole = '0', rightFraction = ''] = right.split('.');
  const scale = Math.max(leftFraction.length, rightFraction.length);
  const leftCoefficient = BigInt(`${leftWhole}${leftFraction.padEnd(scale, '0')}`);
  const rightCoefficient = BigInt(`${rightWhole}${rightFraction.padEnd(scale, '0')}`);
  if (leftCoefficient < rightCoefficient) {
    return -1;
  }
  return leftCoefficient > rightCoefficient ? 1 : 0;
};

/** Exact owner-issued evidence that the threshold Quantity uses the owning Price's Unit basis. */
export const QuantityTierQuantityBasisSchema = Schema.Struct({
  catalogQuantityBasis: CatalogQuantityBasisSchema,
  priceUnitBasis: PriceUnitBasisSchema,
}).check(
  Schema.makeFilter(({ catalogQuantityBasis, priceUnitBasis }) =>
    sameResourceRef(catalogQuantityBasis.unitRef, priceUnitBasis.unitRef)
      ? undefined
      : 'Quantity Tier Catalog and Price Unit bases must identify the exact same Unit',
  ),
);
export type QuantityTierQuantityBasis = typeof QuantityTierQuantityBasisSchema.Type;

/** Stable Tier identity. A Tier deliberately is not an independently addressable Resource. */
export const QuantityTierIdentityKeySchema = Schema.Struct({
  priceRef: PriceRefSchema,
  quantityBasis: QuantityTierQuantityBasisSchema,
  thresholdQuantity: PricePositiveDecimalSchema,
}).check(
  Schema.makeFilter(({ priceRef, quantityBasis }) =>
    priceRef.tenantId === quantityBasis.catalogQuantityBasis.targetRef.tenantId
      ? undefined
      : 'Quantity Tier, owning Price, Quantity target, and Unit must belong to the same Tenant',
  ),
);
export type QuantityTierIdentityKey = typeof QuantityTierIdentityKeySchema.Type;

/** Numeric decimal equality plus exact owner references and revisions for one stable Tier identity. */
export const quantityTierIdentityKeysEqual = (left: QuantityTierIdentityKey, right: QuantityTierIdentityKey): boolean =>
  sameResourceRef(left.priceRef, right.priceRef) &&
  priceDecimalValuesEqual(left.thresholdQuantity, right.thresholdQuantity) &&
  priceDecimalValuesEqual(left.quantityBasis.priceUnitBasis.quantity, right.quantityBasis.priceUnitBasis.quantity) &&
  sameResourceRef(left.quantityBasis.priceUnitBasis.unitRef, right.quantityBasis.priceUnitBasis.unitRef) &&
  sameResourceRef(
    left.quantityBasis.catalogQuantityBasis.targetRef,
    right.quantityBasis.catalogQuantityBasis.targetRef,
  ) &&
  sameResourceRef(left.quantityBasis.catalogQuantityBasis.unitRef, right.quantityBasis.catalogQuantityBasis.unitRef) &&
  left.quantityBasis.catalogQuantityBasis.targetDivisibilityRevision ===
    right.quantityBasis.catalogQuantityBasis.targetDivisibilityRevision &&
  left.quantityBasis.catalogQuantityBasis.unitRuleRevision ===
    right.quantityBasis.catalogQuantityBasis.unitRuleRevision;

export const QuantityTierResultingUnitPriceSchema = Schema.Struct({
  amount: PriceNonNegativeDecimalSchema,
  currencyCode: PricingCurrencyCodeSchema,
});
export type QuantityTierResultingUnitPrice = typeof QuantityTierResultingUnitPriceSchema.Type;

export const QuantityTierRevisionIdSchema = checkedUuid.pipe(
  Schema.brand('PricingQuantityTierRevisionId'),
  Schema.decodeTo(checkedUuid),
);
export const QuantityTierRevisionNumberSchema = Schema.Int.check(Schema.isGreaterThan(0));

export const QuantityTierRevisionSchema = Schema.Struct({
  effectiveFrom: PricingInstantSchema,
  monetaryBoundary: Schema.Literal('PRE_TAX'),
  resultingUnitPrice: QuantityTierResultingUnitPriceSchema,
  revision: QuantityTierRevisionNumberSchema,
  revisionId: QuantityTierRevisionIdSchema,
});
export type QuantityTierRevision = typeof QuantityTierRevisionSchema.Type;

export const QuantityTierDefinitionSchema = Schema.Struct({
  identityKey: QuantityTierIdentityKeySchema,
  revision: QuantityTierRevisionSchema,
});
export type QuantityTierDefinition = typeof QuantityTierDefinitionSchema.Type;

export const QuantityTierEffectivePeriodSchema = Schema.Struct({
  effectiveFrom: PricingInstantSchema,
  effectiveTo: Schema.NullOr(PricingInstantSchema),
}).check(
  Schema.makeFilter(({ effectiveFrom, effectiveTo }) =>
    effectiveTo === null || effectiveFrom < effectiveTo
      ? undefined
      : 'Quantity Tier effective period must be a non-empty half-open interval',
  ),
);
export type QuantityTierEffectivePeriod = typeof QuantityTierEffectivePeriodSchema.Type;

export const QuantityTierRevisionLineageSchema = Schema.Struct({
  correctedRevisionId: Schema.NullOr(QuantityTierRevisionIdSchema),
  kind: Schema.Literals(['INITIAL', 'VALUE_ONLY_CURRENT', 'SCHEDULED', 'CORRECTION', 'RETIREMENT']),
  previousRevisionId: Schema.NullOr(QuantityTierRevisionIdSchema),
}).check(
  Schema.makeFilter(({ correctedRevisionId, kind, previousRevisionId }) => {
    if (kind === 'INITIAL') {
      return correctedRevisionId === null && previousRevisionId === null
        ? undefined
        : 'An initial Quantity Tier Revision cannot carry predecessor lineage';
    }
    if (kind === 'CORRECTION') {
      return correctedRevisionId !== null && previousRevisionId === correctedRevisionId
        ? undefined
        : 'A correction must identify the same targeted Quantity Tier Revision as its predecessor and corrected Revision';
    }
    if (previousRevisionId === null) {
      return 'A successor Quantity Tier Revision must name its predecessor';
    }
    return correctedRevisionId === null
      ? undefined
      : 'Only a correction may identify a corrected Quantity Tier Revision';
  }),
);
export type QuantityTierRevisionLineage = typeof QuantityTierRevisionLineageSchema.Type;

export const ScheduledQuantityTierRevisionSchema = Schema.Struct({
  definition: QuantityTierDefinitionSchema,
  effectivePeriod: QuantityTierEffectivePeriodSchema,
  lineage: QuantityTierRevisionLineageSchema,
}).check(
  Schema.makeFilter(({ definition, effectivePeriod }) =>
    definition.revision.effectiveFrom === effectivePeriod.effectiveFrom
      ? undefined
      : 'Quantity Tier Revision effective start must match its scheduled period',
  ),
);
export type ScheduledQuantityTierRevision = typeof ScheduledQuantityTierRevisionSchema.Type;

export const QuantityTierScheduleRevisionSchema = Schema.Int.check(Schema.isGreaterThan(0));
export const QuantityTierScheduleFingerprintSchema = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
export const QuantityTierScheduleAcknowledgementPrincipalIdSchema = checkedUuid.pipe(
  Schema.brand('PricingQuantityTierScheduleAcknowledgementPrincipalId'),
  Schema.decodeTo(checkedUuid),
);

export const ExpectedQuantityTierCurrentSchema = Schema.Struct({
  effectivePeriod: QuantityTierEffectivePeriodSchema,
  identityKey: QuantityTierIdentityKeySchema,
  revision: QuantityTierRevisionNumberSchema,
  revisionId: QuantityTierRevisionIdSchema,
  scheduleRevision: QuantityTierScheduleRevisionSchema,
});
export type ExpectedQuantityTierCurrent = typeof ExpectedQuantityTierCurrentSchema.Type;

const sameScheduledRevision = Schema.toEquivalence(ScheduledQuantityTierRevisionSchema);

const quantityTierScheduleAcknowledgementFields = {
  actingPrincipalId: QuantityTierScheduleAcknowledgementPrincipalIdSchema,
  fingerprint: QuantityTierScheduleFingerprintSchema,
  identityKey: QuantityTierIdentityKeySchema,
  intendedEffectivePeriod: QuantityTierEffectivePeriodSchema,
  intendedResultingUnitPrice: QuantityTierResultingUnitPriceSchema,
  presentedFuture: Schema.Array(ScheduledQuantityTierRevisionSchema),
  scheduleRevision: QuantityTierScheduleRevisionSchema,
  targetEffectivePeriod: QuantityTierEffectivePeriodSchema,
  targetRevisionId: QuantityTierRevisionIdSchema,
};

const ValueOnlyCurrentQuantityTierScheduleAcknowledgementSchema = Schema.Struct({
  ...quantityTierScheduleAcknowledgementFields,
  intent: Schema.Literal('VALUE_ONLY_CURRENT'),
}).check(
  Schema.makeFilter(({ identityKey, intendedEffectivePeriod, presentedFuture, targetEffectivePeriod }) => {
    if (
      intendedEffectivePeriod.effectiveFrom < targetEffectivePeriod.effectiveFrom ||
      (targetEffectivePeriod.effectiveTo !== null &&
        intendedEffectivePeriod.effectiveFrom >= targetEffectivePeriod.effectiveTo) ||
      intendedEffectivePeriod.effectiveTo !== targetEffectivePeriod.effectiveTo
    ) {
      return 'A value-only Quantity Tier successor must start within the targeted Current interval and preserve its end';
    }
    if (presentedFuture.some(({ definition }) => !quantityTierIdentityKeysEqual(definition.identityKey, identityKey))) {
      return 'Acknowledged future Revisions must belong to the exact Quantity Tier';
    }
    return presentedFuture.every(
      (revision, index) =>
        index === 0 ||
        (presentedFuture[index - 1]?.effectivePeriod.effectiveFrom ?? '') < revision.effectivePeriod.effectiveFrom,
    )
      ? undefined
      : 'Acknowledged future Quantity Tier Revisions must be ordered by effective start';
  }),
);

const RetireCurrentQuantityTierScheduleAcknowledgementSchema = Schema.Struct({
  ...quantityTierScheduleAcknowledgementFields,
  intent: Schema.Literal('RETIRE_CURRENT'),
}).check(
  Schema.makeFilter(({ identityKey, intendedEffectivePeriod, presentedFuture, targetEffectivePeriod }) => {
    if (
      intendedEffectivePeriod.effectiveFrom !== targetEffectivePeriod.effectiveFrom ||
      intendedEffectivePeriod.effectiveTo === null ||
      intendedEffectivePeriod.effectiveTo <= targetEffectivePeriod.effectiveFrom ||
      (targetEffectivePeriod.effectiveTo !== null &&
        intendedEffectivePeriod.effectiveTo >= targetEffectivePeriod.effectiveTo)
    ) {
      return 'A retired Quantity Tier Current interval must preserve its start and end strictly inside the targeted interval';
    }
    if (presentedFuture.some(({ definition }) => !quantityTierIdentityKeysEqual(definition.identityKey, identityKey))) {
      return 'Acknowledged future Revisions must belong to the exact Quantity Tier';
    }
    return presentedFuture.every(
      (revision, index) =>
        index === 0 ||
        (presentedFuture[index - 1]?.effectivePeriod.effectiveFrom ?? '') < revision.effectivePeriod.effectiveFrom,
    )
      ? undefined
      : 'Acknowledged future Quantity Tier Revisions must be ordered by effective start';
  }),
);

export const QuantityTierScheduleAcknowledgementSchema = Schema.Union([
  ValueOnlyCurrentQuantityTierScheduleAcknowledgementSchema,
  RetireCurrentQuantityTierScheduleAcknowledgementSchema,
] as const);
export type QuantityTierScheduleAcknowledgement = typeof QuantityTierScheduleAcknowledgementSchema.Type;

export const QuantityTierScheduleSnapshotSchema = Schema.Struct({
  current: Schema.optionalKey(ScheduledQuantityTierRevisionSchema),
  future: Schema.Array(ScheduledQuantityTierRevisionSchema),
  identityKey: QuantityTierIdentityKeySchema,
  observedAt: PricingInstantSchema,
  revisions: Schema.Array(ScheduledQuantityTierRevisionSchema).check(Schema.isMinLength(1)),
  scheduleRevision: QuantityTierScheduleRevisionSchema,
}).check(
  Schema.makeFilter(({ current, future, identityKey, observedAt, revisions }) => {
    const ordered = revisions.toSorted((left, right) =>
      left.effectivePeriod.effectiveFrom.localeCompare(right.effectivePeriod.effectiveFrom),
    );
    const overlaps = ordered.some((revision, index) => {
      const previous = ordered[index - 1];
      return (
        previous !== undefined &&
        (previous.effectivePeriod.effectiveTo === null ||
          revision.effectivePeriod.effectiveFrom < previous.effectivePeriod.effectiveTo)
      );
    });
    if (overlaps) {
      return 'A Quantity Tier Revision Schedule cannot overlap';
    }
    if (revisions.some(({ definition }) => !quantityTierIdentityKeysEqual(definition.identityKey, identityKey))) {
      return 'All scheduled Revisions must belong to the exact Quantity Tier';
    }
    const selected = revisions.filter(
      ({ effectivePeriod }) =>
        effectivePeriod.effectiveFrom <= observedAt &&
        (effectivePeriod.effectiveTo === null || observedAt < effectivePeriod.effectiveTo),
    );
    if ((current === undefined && selected.length !== 0) || selected.length > 1) {
      return 'Quantity Tier Current selection must use exact half-open effectivity';
    }
    if (
      current !== undefined &&
      (selected.length !== 1 || selected[0] === undefined || !sameScheduledRevision(selected[0], current))
    ) {
      return 'Quantity Tier Current evidence must bind the exact effective Revision';
    }
    if (future.some(({ effectivePeriod }) => effectivePeriod.effectiveFrom <= observedAt)) {
      return 'Future Quantity Tier Revisions must start after the trusted observation instant';
    }
    const expectedFuture = ordered.filter(({ effectivePeriod }) => effectivePeriod.effectiveFrom > observedAt);
    return future.length === expectedFuture.length &&
      future.every((revision, index) => {
        const expected = expectedFuture[index];
        return expected !== undefined && sameScheduledRevision(revision, expected);
      })
      ? undefined
      : 'Future Quantity Tier evidence must be the complete ordered future schedule';
  }),
);
export type QuantityTierScheduleSnapshot = typeof QuantityTierScheduleSnapshotSchema.Type;

export const QuantityTierScheduleReadResultSchema = Schema.Union([
  Schema.Struct({
    outcome: Schema.Literal('QUANTITY_TIER_SCHEDULE_CURRENT'),
    schedule: QuantityTierScheduleSnapshotSchema,
  }),
  Schema.Struct({
    outcome: Schema.Literal('QUANTITY_TIER_SCHEDULE_GAP'),
    schedule: QuantityTierScheduleSnapshotSchema,
  }),
  Schema.Struct({
    identityKey: QuantityTierIdentityKeySchema,
    outcome: Schema.Literal('QUANTITY_TIER_SCHEDULE_ABSENT'),
  }),
  Schema.Struct({
    candidateRevisionIds: Schema.Array(QuantityTierRevisionIdSchema).check(Schema.isMinLength(2)),
    identityKey: QuantityTierIdentityKeySchema,
    outcome: Schema.Literal('QUANTITY_TIER_SCHEDULE_CONFLICT'),
  }),
]);
export type QuantityTierScheduleReadResult = typeof QuantityTierScheduleReadResultSchema.Type;

/** Exact Price path already resolved before Quantity Tier selection; this contract performs no Price lookup. */
export const QuantityTierPricePathSchema = Schema.Struct({
  priceGroupSelector: PriceGroupSelectorSchema,
  requiredAbsenceEvidence: Schema.Array(OwnerVerifiableSetCompletenessEvidenceSchema),
});
export type QuantityTierPricePath = typeof QuantityTierPricePathSchema.Type;

const samePriceGroupSelector = Schema.toEquivalence(PriceGroupSelectorSchema);

/** One already-exact, effective Price and the path evidence that selected it. */
export const QuantityTierExactPriceEffectSchema = Schema.Struct({
  path: QuantityTierPricePathSchema,
  price: ScheduledPriceRevisionSchema,
  scheduleRevision: PriceScheduleRevisionSchema,
}).check(
  Schema.makeFilter(({ path, price }) =>
    samePriceGroupSelector(path.priceGroupSelector, price.definition.identityKey.priceGroupSelector)
      ? undefined
      : 'Quantity Tier selection must preserve the exact Price group/no-group path',
  ),
);
export type QuantityTierExactPriceEffect = typeof QuantityTierExactPriceEffectSchema.Type;

/** Quantity already aggregated and normalized by its owner before this selection boundary. */
export const QuantityTierNormalizedQuantitySchema = Schema.Struct({
  quantity: PricePositiveDecimalSchema,
  quantityBasis: QuantityTierQuantityBasisSchema,
});
export type QuantityTierNormalizedQuantity = typeof QuantityTierNormalizedQuantitySchema.Type;

/** Pricing-owner proof that `currentTiers` is the complete Current Tier set for exactly one Price. */
const stableQuantityTierOwnerReference = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(1000),
  Schema.isTrimmed(),
);

export const QuantityTierSetAuthoritySchema = Schema.Struct({
  generation: Schema.Int.check(Schema.isGreaterThan(0)),
  observedAt: PricingInstantSchema,
  ownerRevision: stableQuantityTierOwnerReference,
  ownerRootRef: stableQuantityTierOwnerReference,
  predicateRef: stableQuantityTierOwnerReference,
  verificationRef: stableQuantityTierOwnerReference,
});
export type QuantityTierSetAuthority = typeof QuantityTierSetAuthoritySchema.Type;

export const QuantityTierSetFactProofSchema = Schema.Struct({
  factRef: stableQuantityTierOwnerReference,
  factRevisionRef: QuantityTierRevisionIdSchema,
  verificationRef: stableQuantityTierOwnerReference,
});
export type QuantityTierSetFactProof = typeof QuantityTierSetFactProofSchema.Type;

export const OwnerProvenCurrentQuantityTierSetSchema = Schema.Struct({
  authority: QuantityTierSetAuthoritySchema,
  completenessEvidence: OwnerVerifiableSetCompletenessEvidenceSchema,
  currentTiers: Schema.Array(ScheduledQuantityTierRevisionSchema),
  factProofs: Schema.Array(QuantityTierSetFactProofSchema),
  priceRef: PriceRefSchema,
}).check(
  Schema.makeFilter(({ authority, completenessEvidence, currentTiers, factProofs }) => {
    if (
      authority.ownerRevision !== completenessEvidence.ownerRevision ||
      authority.predicateRef !== completenessEvidence.scope.predicateRef ||
      authority.observedAt !== DateTime.formatIso(completenessEvidence.observedAt)
    ) {
      return 'Quantity Tier proof authority must bind the exact completeness evidence';
    }
    return factProofs.length !== currentTiers.length ||
      factProofs.some(
        (proof) =>
          proof.verificationRef !== authority.verificationRef ||
          !currentTiers.some(({ definition }) => definition.revision.revisionId === proof.factRevisionRef),
      ) ||
      currentTiers.some(
        ({ definition }) =>
          factProofs.filter(({ factRevisionRef }) => factRevisionRef === definition.revision.revisionId).length !== 1,
      )
      ? 'Quantity Tier fact proofs must bind every Current Tier exactly once to the owner set proof'
      : undefined;
  }),
);
export type OwnerProvenCurrentQuantityTierSet = typeof OwnerProvenCurrentQuantityTierSetSchema.Type;

/** Evidence available even when the Tier owner cannot prove a usable Current set. */
export const QuantityTierSelectionAttemptSchema = Schema.Struct({
  evaluatedAt: PricingInstantSchema,
  exactPrice: QuantityTierExactPriceEffectSchema,
  normalizedQuantity: QuantityTierNormalizedQuantitySchema,
  tierSetPriceRef: PriceRefSchema,
});
export type QuantityTierSelectionAttempt = typeof QuantityTierSelectionAttemptSchema.Type;

/** Selection-ready input. Failure to obtain this exact owner proof is a typed selection failure, never baseline. */
export const QuantityTierSelectionInputSchema = Schema.Struct({
  attempt: QuantityTierSelectionAttemptSchema,
  tierSet: OwnerProvenCurrentQuantityTierSetSchema,
}).check(
  Schema.makeFilter(({ attempt, tierSet }) => {
    const { evaluatedAt, exactPrice, normalizedQuantity, tierSetPriceRef } = attempt;
    const { definition, effectivePeriod } = exactPrice.price;
    if (
      !sameResourceRef(tierSetPriceRef, definition.priceRef) ||
      !sameResourceRef(tierSet.priceRef, definition.priceRef)
    ) {
      return 'Quantity Tier set proof must bind the exact selected Price';
    }
    if (
      effectivePeriod.effectiveFrom > evaluatedAt ||
      (effectivePeriod.effectiveTo !== null && evaluatedAt >= effectivePeriod.effectiveTo)
    ) {
      return 'Quantity Tier selection requires an effective exact Price Revision';
    }
    const priceBasis = definition.identityKey.unitBasis;
    const quantityBasis = normalizedQuantity.quantityBasis.priceUnitBasis;
    const priceCatalogTarget =
      definition.identityKey.catalogSelection.packageOption?.optionRef ??
      definition.identityKey.catalogSelection.variantRef;
    if (!sameResourceRef(normalizedQuantity.quantityBasis.catalogQuantityBasis.targetRef, priceCatalogTarget)) {
      return 'Normalized Quantity must preserve the owning Price canonical Catalog target';
    }
    return sameResourceRef(priceBasis.unitRef, quantityBasis.unitRef) &&
      priceDecimalValuesEqual(priceBasis.quantity, quantityBasis.quantity)
      ? undefined
      : 'Normalized Quantity must preserve the exact Price Unit basis';
  }),
);
export type QuantityTierSelectionInput = typeof QuantityTierSelectionInputSchema.Type;

export const QuantityTierSelectionDecisionEvidenceSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('NO_THRESHOLD_REACHED') }),
  Schema.Struct({
    kind: Schema.Literal('HIGHEST_REACHED_THRESHOLD'),
    winningTier: ScheduledQuantityTierRevisionSchema,
  }),
]);
export type QuantityTierSelectionDecisionEvidence = typeof QuantityTierSelectionDecisionEvidenceSchema.Type;

/** Full replayable evidence: exact Price/path, proven-complete Tier set, Quantity/basis, and winner or proven none. */
export const QuantityTierSelectionEvidenceSchema = Schema.Struct({
  decision: QuantityTierSelectionDecisionEvidenceSchema,
  input: QuantityTierSelectionInputSchema,
});
export type QuantityTierSelectionEvidence = typeof QuantityTierSelectionEvidenceSchema.Type;

const sameNormalizedQuantity = Schema.toEquivalence(QuantityTierNormalizedQuantitySchema);
const sameResultingUnitPrice = Schema.toEquivalence(QuantityTierResultingUnitPriceSchema);

const tierIsCompatibleWithSelection = (
  tier: ScheduledQuantityTierRevision,
  input: QuantityTierSelectionInput,
): boolean => {
  const { evaluatedAt, exactPrice, normalizedQuantity } = input.attempt;
  const price = exactPrice.price.definition;
  const tierIdentity = tier.definition.identityKey;
  const tierBasis = tierIdentity.quantityBasis;
  const normalizedBasis = normalizedQuantity.quantityBasis;
  const priceCatalogTarget =
    price.identityKey.catalogSelection.packageOption?.optionRef ?? price.identityKey.catalogSelection.variantRef;
  return (
    sameResourceRef(tierIdentity.priceRef, price.priceRef) &&
    sameResourceRef(tierBasis.catalogQuantityBasis.targetRef, priceCatalogTarget) &&
    sameResourceRef(tierBasis.catalogQuantityBasis.targetRef, normalizedBasis.catalogQuantityBasis.targetRef) &&
    sameResourceRef(tierBasis.catalogQuantityBasis.unitRef, normalizedBasis.catalogQuantityBasis.unitRef) &&
    tierBasis.catalogQuantityBasis.targetDivisibilityRevision ===
      normalizedBasis.catalogQuantityBasis.targetDivisibilityRevision &&
    tierBasis.catalogQuantityBasis.unitRuleRevision === normalizedBasis.catalogQuantityBasis.unitRuleRevision &&
    sameResourceRef(tierBasis.priceUnitBasis.unitRef, normalizedBasis.priceUnitBasis.unitRef) &&
    priceDecimalValuesEqual(tierBasis.priceUnitBasis.quantity, normalizedBasis.priceUnitBasis.quantity) &&
    tier.definition.revision.resultingUnitPrice.currencyCode === price.identityKey.currencyCode &&
    tier.effectivePeriod.effectiveFrom <= evaluatedAt &&
    (tier.effectivePeriod.effectiveTo === null || evaluatedAt < tier.effectivePeriod.effectiveTo)
  );
};

const completeTierSetIsUnambiguousAndCompatible = (input: QuantityTierSelectionInput): boolean => {
  const { currentTiers } = input.tierSet;
  return (
    currentTiers.every((tier) => tierIsCompatibleWithSelection(tier, input)) &&
    currentTiers.every(
      (tier, index) =>
        !currentTiers.some(
          (candidate, candidateIndex) =>
            candidateIndex !== index &&
            compareQuantityTierDecimalValues(
              candidate.definition.identityKey.thresholdQuantity,
              tier.definition.identityKey.thresholdQuantity,
            ) === 0,
        ),
    )
  );
};

const BasePriceRetainedSchema = Schema.Struct({
  appliesToQuantity: QuantityTierNormalizedQuantitySchema,
  evidence: QuantityTierSelectionEvidenceSchema,
  monetaryBoundary: Schema.Literal('PRE_TAX'),
  outcome: Schema.Literal('BASE_PRICE_RETAINED'),
  resultingUnitPrice: QuantityTierResultingUnitPriceSchema,
}).check(
  Schema.makeFilter(({ appliesToQuantity, evidence, resultingUnitPrice }) => {
    if (evidence.decision.kind !== 'NO_THRESHOLD_REACHED') {
      return 'Base Price retention requires proof that no Tier threshold was reached';
    }
    const input = evidence.input.attempt;
    const noReachedTier = evidence.input.tierSet.currentTiers.every(
      ({ definition }) =>
        compareQuantityTierDecimalValues(input.normalizedQuantity.quantity, definition.identityKey.thresholdQuantity) <
        0,
    );
    return sameNormalizedQuantity(appliesToQuantity, input.normalizedQuantity) &&
      completeTierSetIsUnambiguousAndCompatible(evidence.input) &&
      noReachedTier &&
      sameResultingUnitPrice(resultingUnitPrice, input.exactPrice.price.definition.revision.monetaryAmount)
      ? undefined
      : 'Base Price retention must apply the same exact Price amount to the whole aggregated Quantity';
  }),
);

const QuantityTierAppliedSchema = Schema.Struct({
  appliesToQuantity: QuantityTierNormalizedQuantitySchema,
  evidence: QuantityTierSelectionEvidenceSchema,
  monetaryBoundary: Schema.Literal('PRE_TAX'),
  outcome: Schema.Literal('QUANTITY_TIER_APPLIED'),
  resultingUnitPrice: QuantityTierResultingUnitPriceSchema,
}).check(
  Schema.makeFilter(({ appliesToQuantity, evidence, resultingUnitPrice }) => {
    if (evidence.decision.kind !== 'HIGHEST_REACHED_THRESHOLD') {
      return 'Applied Quantity Tier requires exact winning Tier evidence';
    }
    const { input } = evidence;
    const winner = evidence.decision.winningTier;
    const winnerIsInCompleteSet = input.tierSet.currentTiers.some((tier) => sameScheduledRevision(tier, winner));
    const { quantity } = input.attempt.normalizedQuantity;
    const winnerThreshold = winner.definition.identityKey.thresholdQuantity;
    const winnerIsReached = compareQuantityTierDecimalValues(quantity, winnerThreshold) >= 0;
    const noHigherReachedTier = input.tierSet.currentTiers.every(({ definition }) => {
      const threshold = definition.identityKey.thresholdQuantity;
      return (
        compareQuantityTierDecimalValues(quantity, threshold) < 0 ||
        compareQuantityTierDecimalValues(threshold, winnerThreshold) <= 0
      );
    });
    return sameNormalizedQuantity(appliesToQuantity, input.attempt.normalizedQuantity) &&
      completeTierSetIsUnambiguousAndCompatible(input) &&
      winnerIsInCompleteSet &&
      winnerIsReached &&
      noHigherReachedTier &&
      sameResultingUnitPrice(resultingUnitPrice, winner.definition.revision.resultingUnitPrice)
      ? undefined
      : 'Applied Quantity Tier must use one winner from the proven-complete set for the whole aggregated Quantity';
  }),
);

export const QuantityTierSelectionSuccessSchema = Schema.Union([BasePriceRetainedSchema, QuantityTierAppliedSchema]);
export type QuantityTierSelectionSuccess = typeof QuantityTierSelectionSuccessSchema.Type;

export const QuantityTierSelectionFailureReasonSchema = Schema.Literals([
  'INCOMPLETE_TIER_SET',
  'UNAVAILABLE_TIER_SET',
  'UNVERIFIABLE_TIER_SET',
  'STALE_TIER_SET',
  'PRICE_BINDING_MISMATCH',
  'INCOMPATIBLE_QUANTITY_BASIS',
  'CURRENCY_MISMATCH',
  'AMBIGUOUS_THRESHOLD',
  'CONFLICTING_CURRENT_TIERS',
]);
export type QuantityTierSelectionFailureReason = typeof QuantityTierSelectionFailureReasonSchema.Type;

export const QuantityTierSelectionFailureSchema = Schema.Struct({
  attempt: QuantityTierSelectionAttemptSchema,
  candidateTierRevisionIds: Schema.Array(QuantityTierRevisionIdSchema),
  input: Schema.optionalKey(QuantityTierSelectionInputSchema),
  outcome: Schema.Literal('QUANTITY_TIER_SELECTION_FAILED'),
  reason: QuantityTierSelectionFailureReasonSchema,
});
export type QuantityTierSelectionFailure = typeof QuantityTierSelectionFailureSchema.Type;

export const QuantityTierSelectionResultSchema = Schema.Union([
  QuantityTierSelectionSuccessSchema,
  QuantityTierSelectionFailureSchema,
]);
export type QuantityTierSelectionResult = typeof QuantityTierSelectionResultSchema.Type;
