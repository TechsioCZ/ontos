import { ProductRefSchema } from '@app/catalog/resources/product';
import { VariantRefSchema } from '@app/catalog/resources/variant';
import { OwnerVerifiableSetCompletenessEvidenceSchema } from '@app/shared-contracts';
import { Schema } from 'effect';

import {
  CurrentSupportedCurrenciesSuccessSchema,
  PricingCurrencyCodeSchema,
  PricingInstantSchema,
  PricingTenantIdSchema,
} from '../apis/current-supported-currencies.ts';
import {
  PriceProductTargetIdSchema,
  PriceProductTargetSnapshotIdSchema,
  PriceProductTargetSnapshotSchema,
} from './catalog-price-target.ts';
import {
  PriceNonNegativeDecimalSchema,
  PricePositiveDecimalSchema,
  PriceRevisionIdSchema,
  PriceUnitBasisSchema,
  priceDecimalValuesEqual,
} from './price-definition.ts';
import { PricingCommercialScopeSchema } from './pricing-commercial-scope.ts';
import {
  PricingDecisionSchema,
  PricingNonNegativeDecimalSchema,
  PricingPurchaseDemandOccurrenceIdSchema,
} from './pricing-decision.ts';
import { QuantityTierRevisionIdSchema } from './quantity-tier.ts';
import { PriceRefSchema } from '../resources/price.ts';

const checkedUuid = Schema.String.check(Schema.isUUID(), Schema.isTrimmed());
const stableReference = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300), Schema.isTrimmed());
const sameCommercialScope = Schema.toEquivalence(PricingCommercialScopeSchema);

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

/** Pricing owns only these pre-Tax commercial-charge families at Launch. */
export const PricingCommercialFeeFamilySchema = Schema.Literals(['RECYCLING_FEE', 'COPYRIGHT_FEE']);
export type PricingCommercialFeeFamily = typeof PricingCommercialFeeFamilySchema.Type;

/** Fee identity targets only a Variant; Product remains Catalog/admin snapshot evidence. */
export const PricingCommercialFeeVariantTargetSchema = Schema.Struct({
  variantRef: VariantRefSchema,
});
export type PricingCommercialFeeVariantTarget = typeof PricingCommercialFeeVariantTargetSchema.Type;

/** Owner-resolved Product membership retained for management audit, never Fee identity. */
export const PricingCommercialFeeCatalogTargetEvidenceSchema = Schema.Struct({
  capturedAt: PricingInstantSchema,
  catalogOwnerRevision: stableReference,
  productRef: ProductRefSchema,
  snapshotId: PriceProductTargetSnapshotIdSchema,
  targetId: PriceProductTargetIdSchema,
  variantRef: VariantRefSchema,
}).check(
  Schema.makeFilter(({ productRef, variantRef }) =>
    productRef.tenantId === variantRef.tenantId
      ? undefined
      : 'Commercial Fee Product snapshot evidence and Variant must belong to the same Tenant',
  ),
);
export type PricingCommercialFeeCatalogTargetEvidence = typeof PricingCommercialFeeCatalogTargetEvidenceSchema.Type;

const PricingCommercialFeeFixedPerLineBasisSchema = Schema.Struct({ kind: Schema.Literal('FIXED_PER_LINE') });
const PricingCommercialFeeFixedPerUnitBasisSchema = Schema.Struct({
  kind: Schema.Literal('FIXED_PER_UNIT'),
  unitBasis: PriceUnitBasisSchema,
});

/** Calculation count is explicit and independent of family. */
export const PricingCommercialFeeCalculationBasisSchema = Schema.Union([
  PricingCommercialFeeFixedPerLineBasisSchema,
  PricingCommercialFeeFixedPerUnitBasisSchema,
]);
export type PricingCommercialFeeCalculationBasis = typeof PricingCommercialFeeCalculationBasisSchema.Type;

/** Stable logical key; configured amount and effectivity belong to immutable Revisions. */
export const PricingCommercialFeeIdentityKeySchema = Schema.Struct({
  calculationBasis: PricingCommercialFeeCalculationBasisSchema,
  commercialScope: PricingCommercialScopeSchema,
  currencyCode: PricingCurrencyCodeSchema,
  family: PricingCommercialFeeFamilySchema,
  monetaryBoundary: Schema.Literal('PRE_TAX'),
  target: PricingCommercialFeeVariantTargetSchema,
}).check(
  Schema.makeFilter(({ calculationBasis, target }) =>
    calculationBasis.kind === 'FIXED_PER_LINE' ||
    calculationBasis.unitBasis.unitRef.tenantId === target.variantRef.tenantId
      ? undefined
      : 'Per-Unit Commercial Fee Unit and Variant target must belong to the same Tenant',
  ),
);
export type PricingCommercialFeeIdentityKey = typeof PricingCommercialFeeIdentityKeySchema.Type;

/** Exact logical equality; lexical decimal aliases cannot create another per-Unit Fee. */
export const pricingCommercialFeeIdentityKeysEqual = (
  left: PricingCommercialFeeIdentityKey,
  right: PricingCommercialFeeIdentityKey,
): boolean => {
  if (
    left.family !== right.family ||
    left.currencyCode !== right.currencyCode ||
    left.monetaryBoundary !== right.monetaryBoundary ||
    left.calculationBasis.kind !== right.calculationBasis.kind ||
    !sameCommercialScope(left.commercialScope, right.commercialScope) ||
    !sameResourceRef(left.target.variantRef, right.target.variantRef)
  ) {
    return false;
  }
  if (left.calculationBasis.kind === 'FIXED_PER_LINE' || right.calculationBasis.kind === 'FIXED_PER_LINE') {
    return left.calculationBasis.kind === right.calculationBasis.kind;
  }
  return (
    sameResourceRef(left.calculationBasis.unitBasis.unitRef, right.calculationBasis.unitBasis.unitRef) &&
    priceDecimalValuesEqual(left.calculationBasis.unitBasis.quantity, right.calculationBasis.unitBasis.quantity)
  );
};

export const PricingCommercialFeeIdSchema = checkedUuid.pipe(
  Schema.brand('PricingCommercialFeeId'),
  Schema.decodeTo(checkedUuid),
);
export const PricingCommercialFeeRevisionIdSchema = checkedUuid.pipe(
  Schema.brand('PricingCommercialFeeRevisionId'),
  Schema.decodeTo(checkedUuid),
);
export type PricingCommercialFeeRevisionId = typeof PricingCommercialFeeRevisionIdSchema.Type;
export const PricingCommercialFeeRevisionNumberSchema = Schema.Int.check(Schema.isGreaterThan(0));

/** Tenant-qualified persistent Resource identity; Revision identity remains separate. */
export const PricingCommercialFeeRefSchema = Schema.Struct({
  moduleId: Schema.Literal('commerce.pricing'),
  resourceId: PricingCommercialFeeIdSchema,
  resourceType: Schema.Literal('commerce.pricing.commercial-fee'),
  tenantId: PricingTenantIdSchema,
});
export type PricingCommercialFeeRef = typeof PricingCommercialFeeRefSchema.Type;

export const PricingCommercialFeeConfiguredAmountSchema = Schema.Struct({
  amount: PriceNonNegativeDecimalSchema,
  currencyCode: PricingCurrencyCodeSchema,
});
export type PricingCommercialFeeConfiguredAmount = typeof PricingCommercialFeeConfiguredAmountSchema.Type;

export const PricingCommercialFeeRevisionSchema = Schema.Struct({
  configuredAmount: PricingCommercialFeeConfiguredAmountSchema,
  effectiveFrom: PricingInstantSchema,
  revision: PricingCommercialFeeRevisionNumberSchema,
  revisionId: PricingCommercialFeeRevisionIdSchema,
});
export type PricingCommercialFeeRevision = typeof PricingCommercialFeeRevisionSchema.Type;

export const PricingCommercialFeeDefinitionSchema = Schema.Struct({
  catalogTargetEvidence: PricingCommercialFeeCatalogTargetEvidenceSchema,
  feeRef: PricingCommercialFeeRefSchema,
  identityKey: PricingCommercialFeeIdentityKeySchema,
  revision: PricingCommercialFeeRevisionSchema,
}).check(
  Schema.makeFilter(({ catalogTargetEvidence, feeRef, identityKey, revision }) => {
    if (feeRef.tenantId !== identityKey.target.variantRef.tenantId) {
      return 'Commercial Fee Resource and exact Variant target must belong to the same Tenant';
    }
    if (
      !sameResourceRef(catalogTargetEvidence.variantRef, identityKey.target.variantRef) ||
      catalogTargetEvidence.productRef.tenantId !== feeRef.tenantId
    ) {
      return 'Commercial Fee Catalog snapshot evidence must bind the exact identity Variant and Tenant';
    }
    return revision.configuredAmount.currencyCode === identityKey.currencyCode
      ? undefined
      : 'Commercial Fee Revision currency must equal its stable logical key currency';
  }),
);
export type PricingCommercialFeeDefinition = typeof PricingCommercialFeeDefinitionSchema.Type;

export const PricingCommercialFeeEffectivePeriodSchema = Schema.Struct({
  effectiveFrom: PricingInstantSchema,
  effectiveTo: Schema.NullOr(PricingInstantSchema),
}).check(
  Schema.makeFilter(({ effectiveFrom, effectiveTo }) =>
    effectiveTo === null || effectiveFrom < effectiveTo
      ? undefined
      : 'Commercial Fee effective period must be a non-empty half-open interval',
  ),
);
export type PricingCommercialFeeEffectivePeriod = typeof PricingCommercialFeeEffectivePeriodSchema.Type;

export const PricingCommercialFeeRevisionLineageSchema = Schema.Struct({
  correctedRevisionId: Schema.NullOr(PricingCommercialFeeRevisionIdSchema),
  kind: Schema.Literals(['INITIAL', 'VALUE_ONLY_CURRENT', 'SCHEDULED', 'CORRECTION', 'RETIREMENT']),
  previousRevisionId: Schema.NullOr(PricingCommercialFeeRevisionIdSchema),
}).check(
  Schema.makeFilter(({ correctedRevisionId, kind, previousRevisionId }) => {
    if (kind === 'INITIAL') {
      return correctedRevisionId === null && previousRevisionId === null
        ? undefined
        : 'An initial Commercial Fee Revision cannot carry predecessor lineage';
    }
    if (previousRevisionId === null) {
      return 'A successor Commercial Fee Revision must name its predecessor';
    }
    if (kind === 'CORRECTION') {
      return correctedRevisionId === null
        ? 'A correction must identify the corrected Commercial Fee Revision'
        : undefined;
    }
    return correctedRevisionId === null
      ? undefined
      : 'Only a correction may identify a corrected Commercial Fee Revision';
  }),
);
export type PricingCommercialFeeRevisionLineage = typeof PricingCommercialFeeRevisionLineageSchema.Type;

export const ScheduledPricingCommercialFeeRevisionSchema = Schema.Struct({
  definition: PricingCommercialFeeDefinitionSchema,
  effectivePeriod: PricingCommercialFeeEffectivePeriodSchema,
  lineage: PricingCommercialFeeRevisionLineageSchema,
}).check(
  Schema.makeFilter(({ definition, effectivePeriod }) =>
    definition.revision.effectiveFrom === effectivePeriod.effectiveFrom
      ? undefined
      : 'Commercial Fee Revision effective start must match its scheduled period',
  ),
);
export type ScheduledPricingCommercialFeeRevision = typeof ScheduledPricingCommercialFeeRevisionSchema.Type;

export const PricingCommercialFeeScheduleRevisionSchema = Schema.Int.check(Schema.isGreaterThan(0));
export const PricingCommercialFeeScheduleFingerprintSchema = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
export const PricingCommercialFeeScheduleAcknowledgementPrincipalIdSchema = checkedUuid.pipe(
  Schema.brand('PricingCommercialFeeScheduleAcknowledgementPrincipalId'),
  Schema.decodeTo(checkedUuid),
);

interface PricingCommercialFeeRevisionIdentity {
  readonly revision: number;
  readonly revisionId: string;
}

const duplicateFeeRevisionIdentityReason = (
  revisions: readonly PricingCommercialFeeRevisionIdentity[],
): null | 'DUPLICATE_REVISION_ID' | 'DUPLICATE_REVISION_NUMBER' => {
  if (new Set(revisions.map(({ revisionId }) => revisionId)).size !== revisions.length) {
    return 'DUPLICATE_REVISION_ID';
  }
  return new Set(revisions.map(({ revision }) => revision)).size === revisions.length
    ? null
    : 'DUPLICATE_REVISION_NUMBER';
};

export const ExpectedPricingCommercialFeeCurrentSchema = Schema.Struct({
  effectivePeriod: PricingCommercialFeeEffectivePeriodSchema,
  feeRef: PricingCommercialFeeRefSchema,
  identityKey: PricingCommercialFeeIdentityKeySchema,
  revision: PricingCommercialFeeRevisionNumberSchema,
  revisionId: PricingCommercialFeeRevisionIdSchema,
  scheduleRevision: PricingCommercialFeeScheduleRevisionSchema,
});
export type ExpectedPricingCommercialFeeCurrent = typeof ExpectedPricingCommercialFeeCurrentSchema.Type;

export const PricingCommercialFeeScheduleAcknowledgementSchema = Schema.Struct({
  actingPrincipalId: PricingCommercialFeeScheduleAcknowledgementPrincipalIdSchema,
  feeRef: PricingCommercialFeeRefSchema,
  fingerprint: PricingCommercialFeeScheduleFingerprintSchema,
  identityKey: PricingCommercialFeeIdentityKeySchema,
  intendedConfiguredAmount: PricingCommercialFeeConfiguredAmountSchema,
  intendedEffectivePeriod: PricingCommercialFeeEffectivePeriodSchema,
  intent: Schema.Literals(['RETIRE_CURRENT', 'VALUE_ONLY_CURRENT']),
  presentedFuture: Schema.Array(ScheduledPricingCommercialFeeRevisionSchema),
  scheduleRevision: PricingCommercialFeeScheduleRevisionSchema,
  targetEffectivePeriod: PricingCommercialFeeEffectivePeriodSchema,
  targetRevisionId: PricingCommercialFeeRevisionIdSchema,
}).check(
  Schema.makeFilter(
    ({
      feeRef,
      identityKey,
      intendedConfiguredAmount,
      intendedEffectivePeriod,
      intent,
      presentedFuture,
      targetEffectivePeriod,
    }) => {
      const duplicateReason = duplicateFeeRevisionIdentityReason(
        presentedFuture.map(({ definition }) => definition.revision),
      );
      if (duplicateReason !== null) {
        return duplicateReason === 'DUPLICATE_REVISION_ID'
          ? 'Acknowledged future Commercial Fee Revisions must have unique Revision IDs'
          : 'Acknowledged future Commercial Fee Revisions must have unique Revision numbers';
      }
      if (intent === 'VALUE_ONLY_CURRENT') {
        if (
          intendedEffectivePeriod.effectiveFrom < targetEffectivePeriod.effectiveFrom ||
          intendedEffectivePeriod.effectiveTo !== targetEffectivePeriod.effectiveTo ||
          (targetEffectivePeriod.effectiveTo !== null &&
            intendedEffectivePeriod.effectiveFrom >= targetEffectivePeriod.effectiveTo)
        ) {
          return 'A Current Commercial Fee successor must begin inside the exact targeted interval and preserve its end';
        }
      } else if (
        intendedEffectivePeriod.effectiveFrom !== targetEffectivePeriod.effectiveFrom ||
        intendedEffectivePeriod.effectiveTo === null ||
        intendedEffectivePeriod.effectiveTo <= targetEffectivePeriod.effectiveFrom ||
        (targetEffectivePeriod.effectiveTo !== null &&
          intendedEffectivePeriod.effectiveTo >= targetEffectivePeriod.effectiveTo)
      ) {
        return 'A Current Commercial Fee retirement must end inside the exact targeted interval';
      }
      if (intendedConfiguredAmount.currencyCode !== identityKey.currencyCode) {
        return 'Acknowledged Commercial Fee amount must preserve the stable currency';
      }
      if (
        presentedFuture.some(
          ({ definition }) =>
            definition.feeRef.resourceId !== feeRef.resourceId ||
            !pricingCommercialFeeIdentityKeysEqual(definition.identityKey, identityKey),
        )
      ) {
        return 'Acknowledged future Revisions must belong to the exact logical Commercial Fee';
      }
      return presentedFuture.every(
        (revision, index) =>
          index === 0 ||
          (presentedFuture[index - 1]?.effectivePeriod.effectiveFrom ?? '') < revision.effectivePeriod.effectiveFrom,
      )
        ? undefined
        : 'Acknowledged future Commercial Fee Revisions must be ordered by effective start';
    },
  ),
);
export type PricingCommercialFeeScheduleAcknowledgement = typeof PricingCommercialFeeScheduleAcknowledgementSchema.Type;

const sameScheduledFeeRevision = Schema.toEquivalence(ScheduledPricingCommercialFeeRevisionSchema);

export const PricingCommercialFeeScheduleSnapshotSchema = Schema.Struct({
  current: Schema.optionalKey(ScheduledPricingCommercialFeeRevisionSchema),
  feeRef: PricingCommercialFeeRefSchema,
  future: Schema.Array(ScheduledPricingCommercialFeeRevisionSchema),
  identityKey: PricingCommercialFeeIdentityKeySchema,
  observedAt: PricingInstantSchema,
  revisions: Schema.Array(ScheduledPricingCommercialFeeRevisionSchema).check(Schema.isMinLength(1)),
  scheduleRevision: PricingCommercialFeeScheduleRevisionSchema,
}).check(
  Schema.makeFilter(({ current, feeRef, future, identityKey, observedAt, revisions }) => {
    const duplicateReason = duplicateFeeRevisionIdentityReason(revisions.map(({ definition }) => definition.revision));
    if (duplicateReason !== null) {
      return duplicateReason === 'DUPLICATE_REVISION_ID'
        ? 'A Commercial Fee Revision Schedule must have unique Revision IDs'
        : 'A Commercial Fee Revision Schedule must have unique Revision numbers';
    }
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
      return 'A Commercial Fee Revision Schedule cannot overlap';
    }
    if (
      revisions.some(
        ({ definition }) =>
          definition.feeRef.resourceId !== feeRef.resourceId ||
          !pricingCommercialFeeIdentityKeysEqual(definition.identityKey, identityKey),
      )
    ) {
      return 'All scheduled Revisions must belong to the exact logical Commercial Fee';
    }
    const selected = revisions.filter(
      ({ effectivePeriod }) =>
        effectivePeriod.effectiveFrom <= observedAt &&
        (effectivePeriod.effectiveTo === null || observedAt < effectivePeriod.effectiveTo),
    );
    if ((current === undefined && selected.length !== 0) || selected.length > 1) {
      return 'Commercial Fee Current selection must use exact half-open effectivity';
    }
    if (
      current !== undefined &&
      (selected.length !== 1 || selected[0] === undefined || !sameScheduledFeeRevision(selected[0], current))
    ) {
      return 'Commercial Fee Current evidence must bind the exact effective Revision';
    }
    if (future.some(({ effectivePeriod }) => effectivePeriod.effectiveFrom <= observedAt)) {
      return 'Future Commercial Fee Revisions must start after the trusted observation instant';
    }
    const expectedFuture = ordered.filter(({ effectivePeriod }) => effectivePeriod.effectiveFrom > observedAt);
    return future.length === expectedFuture.length &&
      future.every((revision, index) => {
        const expected = expectedFuture[index];
        return expected !== undefined && sameScheduledFeeRevision(revision, expected);
      })
      ? undefined
      : 'Future Commercial Fee evidence must be the complete ordered future schedule';
  }),
);
export type PricingCommercialFeeScheduleSnapshot = typeof PricingCommercialFeeScheduleSnapshotSchema.Type;

/** Explicit 0/1/>1 Current result; ID, ordering, and recency never select a winner. */
export const PricingCommercialFeeCurrentResolutionSchema = Schema.Union([
  Schema.Struct({
    identityKey: PricingCommercialFeeIdentityKeySchema,
    observedAt: PricingInstantSchema,
    outcome: Schema.Literal('COMMERCIAL_FEE_CURRENT_ABSENT'),
  }),
  Schema.Struct({
    observedAt: PricingInstantSchema,
    outcome: Schema.Literal('COMMERCIAL_FEE_CURRENT'),
    revision: ScheduledPricingCommercialFeeRevisionSchema,
  }).check(
    Schema.makeFilter(({ observedAt, revision }) =>
      revision.effectivePeriod.effectiveFrom <= observedAt &&
      (revision.effectivePeriod.effectiveTo === null || observedAt < revision.effectivePeriod.effectiveTo)
        ? undefined
        : 'Current Commercial Fee Revision must be effective at the trusted observation instant',
    ),
  ),
  Schema.Struct({
    candidateRevisionIds: Schema.Array(PricingCommercialFeeRevisionIdSchema).check(
      Schema.isMinLength(2),
      Schema.makeFilter((ids) =>
        new Set(ids).size === ids.length ? undefined : 'Conflicting Commercial Fee Revision IDs must be unique',
      ),
    ),
    identityKey: PricingCommercialFeeIdentityKeySchema,
    observedAt: PricingInstantSchema,
    outcome: Schema.Literal('COMMERCIAL_FEE_CURRENT_CONFLICT'),
  }),
  Schema.Struct({
    claimants: Schema.Array(
      Schema.Struct({
        revision: PricingCommercialFeeRevisionNumberSchema,
        revisionId: PricingCommercialFeeRevisionIdSchema,
      }),
    ).check(Schema.isMinLength(2)),
    identityKey: PricingCommercialFeeIdentityKeySchema,
    observedAt: PricingInstantSchema,
    outcome: Schema.Literal('COMMERCIAL_FEE_REVISION_INVARIANT_VIOLATION'),
    reason: Schema.Literals(['DUPLICATE_REVISION_ID', 'DUPLICATE_REVISION_NUMBER']),
  }).check(
    Schema.makeFilter(({ claimants, reason }) =>
      duplicateFeeRevisionIdentityReason(claimants) === reason
        ? undefined
        : 'Commercial Fee invariant outcome reason must match the duplicate Revision identity',
    ),
  ),
]);
export type PricingCommercialFeeCurrentResolution = typeof PricingCommercialFeeCurrentResolutionSchema.Type;

const feeCurrentSetPredicateReference = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(2000),
  Schema.isTrimmed(),
);

/** Canonical owner predicate for one exact Variant/scope/currency Current Fee set. */
export const pricingCommercialFeeCurrentSetPredicateRef = ({
  commercialScope,
  currencyCode,
  target,
}: {
  readonly commercialScope: typeof PricingCommercialScopeSchema.Type;
  readonly currencyCode: string;
  readonly target: PricingCommercialFeeVariantTarget;
}): string => {
  const variant = target.variantRef;
  const values = [
    variant.tenantId,
    variant.moduleId,
    variant.resourceType,
    variant.resourceId,
    commercialScope.sellingLegalEntityId,
    commercialScope.channelId,
    commercialScope.marketId,
    currencyCode,
  ];
  return `pricing-commercial-fee-current-set:v1:${values.map(encodeURIComponent).join(':')}`;
};

export const PricingCommercialFeeCurrentSetCurrentnessEvidenceSchema = Schema.Struct({
  observedAt: PricingInstantSchema,
  ownerRevision: stableReference,
  predicateRef: feeCurrentSetPredicateReference,
  revalidatedAt: PricingInstantSchema,
  verificationMode: Schema.Literal('OWNER_CURRENT_SET_REVALIDATED'),
}).check(
  Schema.makeFilter(({ observedAt, revalidatedAt }) =>
    observedAt <= revalidatedAt
      ? undefined
      : 'Commercial Fee Current-set revalidation cannot precede its observation instant',
  ),
);
export type PricingCommercialFeeCurrentSetCurrentnessEvidence =
  typeof PricingCommercialFeeCurrentSetCurrentnessEvidenceSchema.Type;

/** Complete Current Fee set for one exact Variant/scope/currency predicate; an empty set is proven absence. */
export const PricingCommercialFeeCurrentSetSchema = Schema.Struct({
  commercialScope: PricingCommercialScopeSchema,
  completenessEvidence: Schema.toEncoded(OwnerVerifiableSetCompletenessEvidenceSchema),
  currencyCode: PricingCurrencyCodeSchema,
  currentnessEvidence: PricingCommercialFeeCurrentSetCurrentnessEvidenceSchema,
  fees: Schema.Array(ScheduledPricingCommercialFeeRevisionSchema),
  observedAt: PricingInstantSchema,
  target: PricingCommercialFeeVariantTargetSchema,
}).check(
  Schema.makeFilter(
    ({ commercialScope, completenessEvidence, currencyCode, currentnessEvidence, fees, observedAt, target }) => {
      const expectedPredicate = pricingCommercialFeeCurrentSetPredicateRef({ commercialScope, currencyCode, target });
      if (
        completenessEvidence.observedAt !== observedAt ||
        currentnessEvidence.observedAt !== observedAt ||
        completenessEvidence.ownerRevision !== currentnessEvidence.ownerRevision ||
        completenessEvidence.scope.kind !== 'EXACT_PREDICATE' ||
        completenessEvidence.scope.predicateRef !== expectedPredicate ||
        currentnessEvidence.predicateRef !== expectedPredicate
      ) {
        return 'Commercial Fee completeness/currentness evidence must bind the exact Variant, scope, currency, and owner Revision predicate';
      }
      if (
        completenessEvidence.nextApplicabilityBoundary !== undefined &&
        currentnessEvidence.revalidatedAt >= completenessEvidence.nextApplicabilityBoundary
      ) {
        return 'Commercial Fee Current-set evidence must be revalidated before its next applicability boundary';
      }
      if (
        fees.some(
          ({ definition, effectivePeriod }) =>
            !sameCommercialScope(definition.identityKey.commercialScope, commercialScope) ||
            definition.identityKey.currencyCode !== currencyCode ||
            !sameResourceRef(definition.identityKey.target.variantRef, target.variantRef) ||
            effectivePeriod.effectiveFrom > observedAt ||
            (effectivePeriod.effectiveTo !== null && observedAt >= effectivePeriod.effectiveTo),
        )
      ) {
        return 'Complete Current Commercial Fee set must contain only exact effective predicate matches';
      }
      return [];
    },
  ),
);
export type PricingCommercialFeeCurrentSet = typeof PricingCommercialFeeCurrentSetSchema.Type;

export const PricingCommercialFeeExactPricePathSchema = Schema.Struct({
  priceRef: PriceRefSchema,
  priceRevisionId: PriceRevisionIdSchema,
  source: Schema.Literals(['NO_GROUP_PRICE', 'PRICE_GROUP_PRICE']),
});
export type PricingCommercialFeeExactPricePath = typeof PricingCommercialFeeExactPricePathSchema.Type;

export const PricingCommercialFeeCalculationInputSchema = Schema.Struct({
  baseLineValue: Schema.Struct({
    amount: PricingNonNegativeDecimalSchema,
    currencyCode: PricingCurrencyCodeSchema,
  }),
  currencySupport: CurrentSupportedCurrenciesSuccessSchema,
  decision: PricingDecisionSchema,
  feeSet: PricingCommercialFeeCurrentSetSchema,
  occurrenceId: PricingPurchaseDemandOccurrenceIdSchema,
  pricePath: PricingCommercialFeeExactPricePathSchema,
  quantityTierRevisionId: Schema.optionalKey(QuantityTierRevisionIdSchema),
}).check(
  Schema.makeFilter(({ baseLineValue, currencySupport, decision, feeSet, occurrenceId, pricePath }) => {
    const line = decision.lines.find((candidate) => candidate.occurrenceId === occurrenceId);
    if (line === undefined) {
      return 'Commercial Fee calculation must identify one original Pricing Line';
    }
    if (
      baseLineValue.currencyCode !== decision.currencyCode ||
      feeSet.currencyCode !== decision.currencyCode ||
      pricePath.priceRef.tenantId !== decision.tenantId
    ) {
      return 'Commercial Fee calculation monetary facts must use the exact Decision currency and Tenant';
    }
    if (
      currencySupport.tenantId !== decision.tenantId ||
      currencySupport.effectiveAt !== decision.operationTime ||
      !currencySupport.supportedCurrencies.includes(decision.currencyCode)
    ) {
      return 'Commercial Fee calculation requires Current Tenant currency-support evidence';
    }
    if (
      feeSet.observedAt !== decision.operationTime ||
      !sameCommercialScope(feeSet.commercialScope, decision.commercialScope) ||
      !sameResourceRef(feeSet.target.variantRef, line.catalog.selection.variantRef)
    ) {
      return 'Commercial Fee set must bind the exact original Variant line, scope, and operation time';
    }
    return [];
  }),
);
export type PricingCommercialFeeCalculationInput = typeof PricingCommercialFeeCalculationInputSchema.Type;

const decimalParts = (value: string): readonly [bigint, number] => {
  const [whole = '0', fractional = ''] = value.split('.');
  return [BigInt(`${whole}${fractional}`), fractional.length];
};
const decimalProductQuotientEquals = (
  result: string,
  multiplicand: string,
  quantity: string,
  divisor: string,
): boolean => {
  const [resultInteger, resultPlaces] = decimalParts(result);
  const [multiplicandInteger, multiplicandPlaces] = decimalParts(multiplicand);
  const [quantityInteger, quantityPlaces] = decimalParts(quantity);
  const [divisorInteger, divisorPlaces] = decimalParts(divisor);
  return (
    resultInteger * divisorInteger * 10n ** BigInt(multiplicandPlaces + quantityPlaces) ===
    multiplicandInteger * quantityInteger * 10n ** BigInt(resultPlaces + divisorPlaces)
  );
};

export const PricingCommercialFeeContributionSchema = Schema.Struct({
  amount: Schema.Struct({
    amount: PricePositiveDecimalSchema,
    currencyCode: PricingCurrencyCodeSchema,
  }),
  appliedQuantity: Schema.Union([
    Schema.Struct({ count: Schema.Literal('1'), kind: Schema.Literal('LINE') }),
    Schema.Struct({
      kind: Schema.Literal('QUANTITY'),
      quantity: PricePositiveDecimalSchema,
      unitRef: PriceUnitBasisSchema.fields.unitRef,
    }),
  ]),
  fee: ScheduledPricingCommercialFeeRevisionSchema,
  monetaryBoundary: Schema.Literal('PRE_TAX'),
  occurrenceId: PricingPurchaseDemandOccurrenceIdSchema,
}).check(
  Schema.makeFilter(({ amount, appliedQuantity, fee }) => {
    const { calculationBasis, currencyCode } = fee.definition.identityKey;
    if (amount.currencyCode !== currencyCode) {
      return 'Applied Commercial Fee contribution must use the logical Fee currency';
    }
    if (calculationBasis.kind === 'FIXED_PER_LINE') {
      return appliedQuantity.kind === 'LINE' &&
        priceDecimalValuesEqual(amount.amount, fee.definition.revision.configuredAmount.amount)
        ? undefined
        : 'Fixed-per-line Fee must apply its configured amount exactly once';
    }
    return appliedQuantity.kind === 'QUANTITY' &&
      sameResourceRef(appliedQuantity.unitRef, calculationBasis.unitBasis.unitRef) &&
      decimalProductQuotientEquals(
        amount.amount,
        fee.definition.revision.configuredAmount.amount,
        appliedQuantity.quantity,
        calculationBasis.unitBasis.quantity,
      )
      ? undefined
      : 'Fixed-per-unit Fee must preserve exact compatible Quantity/Unit evidence and contribution arithmetic';
  }),
);
export type PricingCommercialFeeContribution = typeof PricingCommercialFeeContributionSchema.Type;

const decimalEqualsSum = (total: string, parts: readonly string[]): boolean => {
  const parsed = [total, ...parts].map(decimalParts);
  const scale = Math.max(...parsed.map(([, places]) => places));
  const scaled = parsed.map(([integer, places]) => integer * 10n ** BigInt(scale - places));
  return scaled[0] === scaled.slice(1).reduce((sum, value) => sum + value, 0n);
};

export const PricingCommercialFeeCalculationResultSchema = Schema.Union([
  Schema.Struct({
    contributions: Schema.Array(PricingCommercialFeeContributionSchema),
    contributionTotal: Schema.Struct({
      amount: PricingNonNegativeDecimalSchema,
      currencyCode: PricingCurrencyCodeSchema,
    }),
    discountableLineBasis: Schema.Struct({
      amount: PricingNonNegativeDecimalSchema,
      currencyCode: PricingCurrencyCodeSchema,
    }),
    input: PricingCommercialFeeCalculationInputSchema,
    outcome: Schema.Literal('COMMERCIAL_FEES_APPLIED'),
  }).check(
    Schema.makeFilter(({ contributions, contributionTotal, discountableLineBasis, input }) => {
      const line = input.decision.lines.find(({ occurrenceId }) => occurrenceId === input.occurrenceId);
      if (line === undefined) {
        return 'Commercial Fee result must retain its original Pricing Line';
      }
      if (
        contributionTotal.currencyCode !== input.decision.currencyCode ||
        discountableLineBasis.currencyCode !== input.decision.currencyCode ||
        contributions.some(
          (contribution) =>
            contribution.amount.currencyCode !== input.decision.currencyCode ||
            contribution.occurrenceId !== input.occurrenceId,
        )
      ) {
        return 'Commercial Fee result must preserve the exact Decision currency and original line';
      }
      if (
        contributions.some((contribution) => {
          const matchingCurrent = input.feeSet.fees.some((fee) => sameScheduledFeeRevision(fee, contribution.fee));
          const { calculationBasis } = contribution.fee.definition.identityKey;
          if (!matchingCurrent) {
            return true;
          }
          if (calculationBasis.kind === 'FIXED_PER_LINE') {
            return (
              contribution.appliedQuantity.kind !== 'LINE' ||
              !priceDecimalValuesEqual(
                contribution.amount.amount,
                contribution.fee.definition.revision.configuredAmount.amount,
              )
            );
          }
          return (
            contribution.appliedQuantity.kind !== 'QUANTITY' ||
            !sameResourceRef(contribution.appliedQuantity.unitRef, line.catalog.unitRef) ||
            !priceDecimalValuesEqual(contribution.appliedQuantity.quantity, line.catalog.quantity.resulting) ||
            !sameResourceRef(calculationBasis.unitBasis.unitRef, line.catalog.unitRef) ||
            !decimalProductQuotientEquals(
              contribution.amount.amount,
              contribution.fee.definition.revision.configuredAmount.amount,
              line.catalog.quantity.resulting,
              calculationBasis.unitBasis.quantity,
            )
          );
        })
      ) {
        return 'Every Commercial Fee contribution must be calculated from an exact Current Fee and line Quantity basis';
      }
      const positiveCurrentFees = input.feeSet.fees.filter(
        ({ definition }) => !/^0(?:\.0+)?$/u.test(definition.revision.configuredAmount.amount),
      );
      if (
        positiveCurrentFees.length !== contributions.length ||
        positiveCurrentFees.some(
          (fee) => !contributions.some((contribution) => sameScheduledFeeRevision(fee, contribution.fee)),
        )
      ) {
        return 'Every positive Current Commercial Fee must contribute exactly once; configured zero contributes nothing';
      }
      if (
        contributions.some((contribution, index) =>
          contributions
            .slice(index + 1)
            .some((later) =>
              pricingCommercialFeeIdentityKeysEqual(
                contribution.fee.definition.identityKey,
                later.fee.definition.identityKey,
              ),
            ),
        )
      ) {
        return 'At most one Current contribution may exist for each exact Commercial Fee logical key';
      }
      if (
        !decimalEqualsSum(
          contributionTotal.amount,
          contributions.map(({ amount }) => amount.amount),
        )
      ) {
        return 'Commercial Fee Total must equal the exact contribution sum';
      }
      return decimalEqualsSum(discountableLineBasis.amount, [input.baseLineValue.amount, contributionTotal.amount])
        ? undefined
        : 'Discountable Line Basis must equal Base Line Value plus Commercial Fees exactly once';
    }),
  ),
  Schema.Struct({
    candidateRevisionIds: Schema.Array(PricingCommercialFeeRevisionIdSchema).check(Schema.isMinLength(2)),
    identityKey: PricingCommercialFeeIdentityKeySchema,
    occurrenceId: PricingPurchaseDemandOccurrenceIdSchema,
    outcome: Schema.Literal('COMMERCIAL_FEE_CALCULATION_CONFLICT'),
  }),
  Schema.Struct({
    occurrenceId: PricingPurchaseDemandOccurrenceIdSchema,
    outcome: Schema.Literal('COMMERCIAL_FEE_CALCULATION_FAILED'),
    reason: Schema.Literals([
      'INCOMPLETE_CURRENT_SET',
      'UNAVAILABLE_CURRENT_SET',
      'UNVERIFIABLE_CURRENT_SET',
      'STALE_CURRENT_SET',
      'CURRENCY_UNSUPPORTED',
      'CURRENCY_MISMATCH',
      'QUANTITY_BASIS_MISMATCH',
    ]),
  }),
]);
export type PricingCommercialFeeCalculationResult = typeof PricingCommercialFeeCalculationResultSchema.Type;

/** Product administration may expand only to plain explicit Variants, never package/configuration selectors. */
export const PricingCommercialFeeProductTargetSnapshotSchema = PriceProductTargetSnapshotSchema.check(
  Schema.makeFilter(({ targets }) =>
    targets.every(
      ({ target }) =>
        target.configuration === undefined && target.packageOption === undefined && target.setComposition === undefined,
    )
      ? undefined
      : 'Product Commercial Fee administration expands only to explicit Variant targets',
  ),
);
export type PricingCommercialFeeProductTargetSnapshot = typeof PricingCommercialFeeProductTargetSnapshotSchema.Type;

export const PricingCommercialFeeProductBulkOperationIdSchema = stableReference.pipe(
  Schema.brand('PricingCommercialFeeProductBulkOperationId'),
  Schema.decodeTo(Schema.String),
);
const PricingCommercialFeeProductTargetOutcomeIdentitySchema = Schema.Struct({
  operationId: PricingCommercialFeeProductBulkOperationIdSchema,
  snapshotId: PriceProductTargetSnapshotIdSchema,
  targetId: PriceProductTargetIdSchema,
  variantTarget: PricingCommercialFeeVariantTargetSchema,
});
const pricingCommercialFeeProductTargetOutcomeBaseFields = {
  feeIdentityKey: PricingCommercialFeeIdentityKeySchema,
  identity: PricingCommercialFeeProductTargetOutcomeIdentitySchema,
};

export const PricingCommercialFeeProductTargetOutcomeSchema = Schema.Union([
  Schema.Struct({
    ...pricingCommercialFeeProductTargetOutcomeBaseFields,
    feeRef: PricingCommercialFeeRefSchema,
    outcome: Schema.Literal('COMMERCIAL_FEE_TARGET_APPLIED'),
    revisionId: PricingCommercialFeeRevisionIdSchema,
  }),
  Schema.Struct({
    ...pricingCommercialFeeProductTargetOutcomeBaseFields,
    feeRef: PricingCommercialFeeRefSchema,
    outcome: Schema.Literal('COMMERCIAL_FEE_TARGET_UNCHANGED'),
    revisionId: PricingCommercialFeeRevisionIdSchema,
  }),
  Schema.Struct({
    ...pricingCommercialFeeProductTargetOutcomeBaseFields,
    outcome: Schema.Literal('COMMERCIAL_FEE_TARGET_RETRYABLE_FAILURE'),
    reason: Schema.Literals(['CONCURRENT_CHANGE', 'OWNER_UNAVAILABLE', 'UNKNOWN_COMMIT']),
  }),
  Schema.Struct({
    ...pricingCommercialFeeProductTargetOutcomeBaseFields,
    outcome: Schema.Literal('COMMERCIAL_FEE_TARGET_REJECTED'),
    reason: Schema.Literals(['CATALOG_TARGET_CHANGED', 'IDENTITY_INVALID', 'PERMISSION_DENIED']),
  }),
]).check(
  Schema.makeFilter(({ feeIdentityKey, identity }) =>
    sameResourceRef(feeIdentityKey.target.variantRef, identity.variantTarget.variantRef)
      ? undefined
      : 'Product Commercial Fee outcome must bind its exact expanded Variant identity',
  ),
);
export type PricingCommercialFeeProductTargetOutcome = typeof PricingCommercialFeeProductTargetOutcomeSchema.Type;

/** Complete per-snapshot reconciliation; successful targets never repeat and future Variants cannot appear. */
export const PricingCommercialFeeProductBulkResultSchema = Schema.Struct({
  operationId: PricingCommercialFeeProductBulkOperationIdSchema,
  outcomes: Schema.Array(PricingCommercialFeeProductTargetOutcomeSchema).check(Schema.isMinLength(1)),
  snapshot: PricingCommercialFeeProductTargetSnapshotSchema,
}).check(
  Schema.makeFilter(({ operationId, outcomes, snapshot }) => {
    if (
      outcomes.some(
        ({ identity }) => identity.operationId !== operationId || identity.snapshotId !== snapshot.snapshotId,
      )
    ) {
      return 'Every Product Commercial Fee outcome must bind the exact bulk operation and snapshot';
    }
    if (new Set(outcomes.map(({ identity }) => identity.targetId)).size !== outcomes.length) {
      return 'Product Commercial Fee outcomes must contain each snapshot target at most once';
    }
    return snapshot.targets.length === outcomes.length &&
      snapshot.targets.every(({ target, targetId }) =>
        outcomes.some(
          ({ identity }) =>
            identity.targetId === targetId && sameResourceRef(identity.variantTarget.variantRef, target.variantRef),
        ),
      )
      ? undefined
      : 'Product Commercial Fee reconciliation must cover exactly the immutable snapshot Variants';
  }),
);
export type PricingCommercialFeeProductBulkResult = typeof PricingCommercialFeeProductBulkResultSchema.Type;

/** Retry selects only unresolved retryable targets from the original immutable snapshot. */
export const PricingCommercialFeeProductBulkRetrySchema = Schema.Struct({
  priorResult: PricingCommercialFeeProductBulkResultSchema,
  retryOperationId: PricingCommercialFeeProductBulkOperationIdSchema,
  retryTargetIds: Schema.Array(PriceProductTargetIdSchema).check(
    Schema.isMinLength(1),
    Schema.makeFilter((ids) => (new Set(ids).size === ids.length ? undefined : 'Retry target IDs must be unique')),
  ),
}).check(
  Schema.makeFilter(({ priorResult, retryOperationId, retryTargetIds }) => {
    if (retryOperationId === priorResult.operationId) {
      return 'A Product Commercial Fee retry must use a distinct operation identity';
    }
    return retryTargetIds.every((targetId) =>
      priorResult.outcomes.some(
        (outcome) =>
          outcome.identity.targetId === targetId && outcome.outcome === 'COMMERCIAL_FEE_TARGET_RETRYABLE_FAILURE',
      ),
    )
      ? undefined
      : 'Only retryable unresolved Product Commercial Fee targets may be retried';
  }),
);
export type PricingCommercialFeeProductBulkRetry = typeof PricingCommercialFeeProductBulkRetrySchema.Type;
