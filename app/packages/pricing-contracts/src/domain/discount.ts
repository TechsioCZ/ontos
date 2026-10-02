import { PriceGroupRefSchema } from '@app/price-group-catalog-contracts/resources/price-group';
import { CounterpartyRefSchema } from '@app/party-registry/resources/counterparty';
import { CatalogSelectionValidEvidenceSchema } from '@app/catalog/domain/catalog-selection-evidence';
import { Match, Schema } from 'effect';

import { PricingCurrencyCodeSchema, PricingInstantSchema } from '../apis/current-supported-currencies.ts';
import {
  PriceCatalogTargetSchema,
  PriceProductTargetIdSchema,
  PriceProductTargetSnapshotIdSchema,
  PriceProductTargetSnapshotSchema,
  priceCatalogTargetsEqual,
} from './catalog-price-target.ts';
import { PriceRevisionIdSchema, PriceUnitBasisSchema, priceDecimalValuesEqual } from './price-definition.ts';
import { PriceGroupInterpretationSchema } from './price-group-interpretation.ts';
import type { PriceGroupInterpretation } from './price-group-interpretation.ts';
import { PricingCommercialScopeSchema } from './pricing-commercial-scope.ts';
import { PriceRefSchema } from '../resources/price.ts';
import {
  PricingDecisionSchema,
  PricingNonNegativeDecimalSchema,
  PricingNonPositiveDecimalSchema,
  PricingPercentageSchema,
  PricingPurchaseDemandOccurrenceIdSchema,
} from './pricing-decision.ts';

/** Pricing owns exactly these pre-Tax Discount families; Promotion remains a different owner. */
export const PricingDiscountFamilySchema = Schema.Literals(['CATALOG_DISCOUNT', 'CONTRACTUAL_DISCOUNT']);
export type PricingDiscountFamily = typeof PricingDiscountFamilySchema.Type;

const PricingCatalogDiscountAudienceSchema = Schema.Struct({
  kind: Schema.Literal('CATALOG_PATH'),
  selection: PriceCatalogTargetSchema,
});
const PricingPriceGroupDiscountAudienceSchema = Schema.Struct({
  kind: Schema.Literal('PRICE_GROUP'),
  priceGroupRef: PriceGroupRefSchema,
});
const PricingCounterpartyDiscountAudienceSchema = Schema.Struct({
  counterpartyRef: CounterpartyRefSchema,
  kind: Schema.Literal('COUNTERPARTY'),
});

/** Catalog path, Price Group, and exact Counterparty are distinct audience meanings. */
export const PricingDiscountAudienceSchema = Schema.Union([
  PricingCatalogDiscountAudienceSchema,
  PricingPriceGroupDiscountAudienceSchema,
  PricingCounterpartyDiscountAudienceSchema,
]);
export type PricingDiscountAudience = typeof PricingDiscountAudienceSchema.Type;

/** Scope declares application count independently of the configured effect. */
export const PricingDiscountScopeSchema = Schema.Literals(['VARIANT_LINE', 'WHOLE_PURCHASE']);
export type PricingDiscountScope = typeof PricingDiscountScopeSchema.Type;

const PricingPercentageDiscountEffectSchema = Schema.Struct({
  kind: Schema.Literal('PERCENTAGE'),
  level: PricingPercentageSchema,
});
const PricingFixedMonetaryDiscountEffectSchema = Schema.Struct({
  kind: Schema.Literal('FIXED_MONETARY_AMOUNT'),
  level: Schema.Struct({
    amount: PricingNonNegativeDecimalSchema,
    currencyCode: PricingCurrencyCodeSchema,
  }),
});

/** Configured levels are non-negative; they are not the signed applied contribution. */
export const PricingDiscountEffectSchema = Schema.Union([
  PricingPercentageDiscountEffectSchema,
  PricingFixedMonetaryDiscountEffectSchema,
]);
export type PricingDiscountEffect = typeof PricingDiscountEffectSchema.Type;

const supportedDiscountCombination = ({
  audience,
  effect,
  family,
  scope,
}: {
  readonly audience: PricingDiscountAudience;
  readonly effect: { readonly kind: PricingDiscountEffect['kind'] };
  readonly family: PricingDiscountFamily;
  readonly scope: PricingDiscountScope;
}): boolean => {
  if (family === 'CATALOG_DISCOUNT') {
    return audience.kind === 'CATALOG_PATH' && scope === 'VARIANT_LINE';
  }
  if (audience.kind === 'CATALOG_PATH') {
    return false;
  }
  if (scope === 'VARIANT_LINE') {
    return true;
  }
  return audience.kind === 'COUNTERPARTY' && effect.kind === 'FIXED_MONETARY_AMOUNT';
};

/**
 * Closed Launch vocabulary. This is not a stable Discount identity or Revision; those contracts
 * add their own lifecycle around one supported semantic combination.
 */
export const PricingDiscountTypeSchema = Schema.Struct({
  audience: PricingDiscountAudienceSchema,
  effect: PricingDiscountEffectSchema,
  family: PricingDiscountFamilySchema,
  scope: PricingDiscountScopeSchema,
}).check(
  Schema.makeFilter((discountType) =>
    supportedDiscountCombination(discountType)
      ? undefined
      : 'Discount family, audience, scope, and effect combination is not supported at Launch',
  ),
);
export type PricingDiscountType = typeof PricingDiscountTypeSchema.Type;

/** One original Pricing Line inside one exact Decision; the occurrence must already exist. */
export const PricingDiscountLineTargetSchema = Schema.Struct({
  decision: PricingDecisionSchema,
  kind: Schema.Literal('VARIANT_LINE'),
  occurrenceId: PricingPurchaseDemandOccurrenceIdSchema,
}).check(
  Schema.makeFilter(({ decision, occurrenceId }) =>
    decision.lines.some((line) => line.occurrenceId === occurrenceId)
      ? undefined
      : 'Variant-line Discount target must identify one line in the exact Pricing Decision',
  ),
);
export type PricingDiscountLineTarget = typeof PricingDiscountLineTargetSchema.Type;

/** Whole-purchase scope binds the complete exact Pricing Decision, not a synthetic line. */
export const PricingDiscountWholePurchaseTargetSchema = Schema.Struct({
  decision: PricingDecisionSchema,
  kind: Schema.Literal('WHOLE_PURCHASE'),
});
export type PricingDiscountWholePurchaseTarget = typeof PricingDiscountWholePurchaseTargetSchema.Type;

export const PricingDiscountApplicationTargetSchema = Schema.Union([
  PricingDiscountLineTargetSchema,
  PricingDiscountWholePurchaseTargetSchema,
]);
export type PricingDiscountApplicationTarget = typeof PricingDiscountApplicationTargetSchema.Type;

const selectedTargetLine = (target: PricingDiscountApplicationTarget) =>
  target.kind === 'VARIANT_LINE'
    ? target.decision.lines.find((line) => line.occurrenceId === target.occurrenceId)
    : undefined;

const discountAudienceTenantId = (audience: PricingDiscountAudience): string =>
  Match.value(audience).pipe(
    Match.discriminator('kind')('CATALOG_PATH', ({ selection }) => selection.productRef.tenantId),
    Match.discriminator('kind')('COUNTERPARTY', ({ counterpartyRef }) => counterpartyRef.tenantId),
    Match.discriminator('kind')('PRICE_GROUP', ({ priceGroupRef }) => priceGroupRef.tenantId),
    Match.exhaustive,
  );

/**
 * One signed applied reduction. Zero is a valid contribution; a positive value is never a Discount.
 * Computation, layer cardinality, and whole-purchase allocation are deliberately separate contracts.
 */
export const PricingDiscountContributionSchema = Schema.Struct({
  amount: Schema.Struct({
    amount: PricingNonPositiveDecimalSchema,
    currencyCode: PricingCurrencyCodeSchema,
  }),
  discountType: PricingDiscountTypeSchema,
  monetaryBoundary: Schema.Literal('PRE_TAX'),
  target: PricingDiscountApplicationTargetSchema,
}).check(
  Schema.makeFilter(({ amount, discountType, target }) => {
    if (discountType.scope !== target.kind) {
      return 'Discount scope must equal its exact application target kind';
    }
    if (amount.currencyCode !== target.decision.currencyCode) {
      return 'Applied Discount contribution currency must equal the exact Pricing Decision currency';
    }
    if (discountAudienceTenantId(discountType.audience) !== target.decision.tenantId) {
      return 'Discount audience must belong to the exact Pricing Decision Tenant';
    }
    if (
      discountType.effect.kind === 'FIXED_MONETARY_AMOUNT' &&
      discountType.effect.level.currencyCode !== target.decision.currencyCode
    ) {
      return 'Fixed Discount currency must equal the exact Pricing Decision currency';
    }
    if (discountType.audience.kind === 'CATALOG_PATH') {
      const line = selectedTargetLine(target);
      return line !== undefined && priceCatalogTargetsEqual(discountType.audience.selection, line.catalog.selection)
        ? undefined
        : 'Catalog Discount audience must equal the exact targeted Variant line path';
    }
    return [];
  }),
);
export type PricingDiscountContribution = typeof PricingDiscountContributionSchema.Type;

const checkedUuid = Schema.String.check(Schema.isUUID(), Schema.isTrimmed());
const stableReference = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300), Schema.isTrimmed());
const sameAudience = Schema.toEquivalence(PricingDiscountAudienceSchema);
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

const PricingDiscountVariantLineIdentityBasisSchema = Schema.Struct({
  catalogSelection: PriceCatalogTargetSchema,
  kind: Schema.Literal('VARIANT_LINE'),
  unitBasis: PriceUnitBasisSchema,
}).check(
  Schema.makeFilter(({ catalogSelection, unitBasis }) =>
    catalogSelection.productRef.tenantId === unitBasis.unitRef.tenantId
      ? undefined
      : 'Discount Variant and Unit basis must belong to the same Tenant',
  ),
);
const PricingDiscountWholePurchaseIdentityBasisSchema = Schema.Struct({ kind: Schema.Literal('WHOLE_PURCHASE') });

/** Exact runtime target meaning. Product administration expands into these concrete Variant identities. */
export const PricingDiscountIdentityBasisSchema = Schema.Union([
  PricingDiscountVariantLineIdentityBasisSchema,
  PricingDiscountWholePurchaseIdentityBasisSchema,
]);
export type PricingDiscountIdentityBasis = typeof PricingDiscountIdentityBasisSchema.Type;

export const PricingDiscountEffectKindSchema = Schema.Literals(['PERCENTAGE', 'FIXED_MONETARY_AMOUNT']);
export type PricingDiscountEffectKind = typeof PricingDiscountEffectKindSchema.Type;

/** Stable logical Discount key; configured value and effectivity belong to immutable Revisions. */
export const PricingDiscountIdentityKeySchema = Schema.Struct({
  audience: PricingDiscountAudienceSchema,
  basis: PricingDiscountIdentityBasisSchema,
  commercialScope: PricingCommercialScopeSchema,
  currencyCode: PricingCurrencyCodeSchema,
  effectKind: PricingDiscountEffectKindSchema,
  family: PricingDiscountFamilySchema,
  monetaryBoundary: Schema.Literal('PRE_TAX'),
  scope: PricingDiscountScopeSchema,
}).check(
  Schema.makeFilter((key) => {
    if (
      !supportedDiscountCombination({
        audience: key.audience,
        effect: { kind: key.effectKind },
        family: key.family,
        scope: key.scope,
      })
    ) {
      return 'Discount logical key must use one supported Launch family/audience/scope/effect combination';
    }
    if (key.scope !== key.basis.kind) {
      return 'Discount scope must equal its exact identity basis kind';
    }
    const tenantId = discountAudienceTenantId(key.audience);
    if (key.basis.kind === 'VARIANT_LINE') {
      if (key.basis.catalogSelection.productRef.tenantId !== tenantId) {
        return 'Discount audience and exact Variant target must belong to the same Tenant';
      }
      if (
        key.audience.kind === 'CATALOG_PATH' &&
        !priceCatalogTargetsEqual(key.audience.selection, key.basis.catalogSelection)
      ) {
        return 'Catalog Discount audience must equal its exact Variant identity target';
      }
    }
    return [];
  }),
);
export type PricingDiscountIdentityKey = typeof PricingDiscountIdentityKeySchema.Type;

/** Exact equality for one logical Discount; decimal lexical aliases do not create another key. */
export const pricingDiscountIdentityKeysEqual = (
  left: PricingDiscountIdentityKey,
  right: PricingDiscountIdentityKey,
): boolean => {
  if (
    left.family !== right.family ||
    left.scope !== right.scope ||
    left.effectKind !== right.effectKind ||
    left.currencyCode !== right.currencyCode ||
    left.monetaryBoundary !== right.monetaryBoundary ||
    !sameAudience(left.audience, right.audience) ||
    !sameCommercialScope(left.commercialScope, right.commercialScope) ||
    left.basis.kind !== right.basis.kind
  ) {
    return false;
  }
  if (left.basis.kind === 'WHOLE_PURCHASE' || right.basis.kind === 'WHOLE_PURCHASE') {
    return left.basis.kind === right.basis.kind;
  }
  return (
    priceCatalogTargetsEqual(left.basis.catalogSelection, right.basis.catalogSelection) &&
    priceDecimalValuesEqual(left.basis.unitBasis.quantity, right.basis.unitBasis.quantity) &&
    sameResourceRef(left.basis.unitBasis.unitRef, right.basis.unitBasis.unitRef)
  );
};

export const PricingDiscountIdSchema = checkedUuid.pipe(
  Schema.brand('PricingDiscountId'),
  Schema.decodeTo(checkedUuid),
);
export const PricingDiscountRevisionIdSchema = checkedUuid.pipe(
  Schema.brand('PricingDiscountRevisionId'),
  Schema.decodeTo(checkedUuid),
);
export const PricingDiscountRevisionNumberSchema = Schema.Int.check(Schema.isGreaterThan(0));

export const PricingDiscountRevisionSchema = Schema.Struct({
  configuredEffect: PricingDiscountEffectSchema,
  effectiveFrom: PricingInstantSchema,
  revision: PricingDiscountRevisionNumberSchema,
  revisionId: PricingDiscountRevisionIdSchema,
});
export type PricingDiscountRevision = typeof PricingDiscountRevisionSchema.Type;

export const PricingDiscountDefinitionSchema = Schema.Struct({
  discountId: PricingDiscountIdSchema,
  identityKey: PricingDiscountIdentityKeySchema,
  revision: PricingDiscountRevisionSchema,
}).check(
  Schema.makeFilter(({ identityKey, revision }) => {
    if (revision.configuredEffect.kind !== identityKey.effectKind) {
      return 'Discount Revision effect kind must equal its stable logical key effect kind';
    }
    return revision.configuredEffect.kind === 'FIXED_MONETARY_AMOUNT' &&
      revision.configuredEffect.level.currencyCode !== identityKey.currencyCode
      ? 'Fixed Discount Revision currency must equal its stable logical key currency'
      : undefined;
  }),
);
export type PricingDiscountDefinition = typeof PricingDiscountDefinitionSchema.Type;

export const PricingDiscountEffectivePeriodSchema = Schema.Struct({
  effectiveFrom: PricingInstantSchema,
  effectiveTo: Schema.NullOr(PricingInstantSchema),
}).check(
  Schema.makeFilter(({ effectiveFrom, effectiveTo }) =>
    effectiveTo === null || effectiveFrom < effectiveTo
      ? undefined
      : 'Discount effective period must be a non-empty half-open interval',
  ),
);
export type PricingDiscountEffectivePeriod = typeof PricingDiscountEffectivePeriodSchema.Type;

export const PricingDiscountRevisionLineageSchema = Schema.Struct({
  correctedRevisionId: Schema.NullOr(PricingDiscountRevisionIdSchema),
  kind: Schema.Literals(['INITIAL', 'VALUE_ONLY_CURRENT', 'SCHEDULED', 'CORRECTION', 'RETIREMENT']),
  previousRevisionId: Schema.NullOr(PricingDiscountRevisionIdSchema),
}).check(
  Schema.makeFilter(({ correctedRevisionId, kind, previousRevisionId }) => {
    if (kind === 'INITIAL') {
      return correctedRevisionId === null && previousRevisionId === null
        ? undefined
        : 'An initial Discount Revision cannot carry predecessor lineage';
    }
    if (previousRevisionId === null) {
      return 'A successor Discount Revision must name its predecessor';
    }
    if (kind === 'CORRECTION') {
      return correctedRevisionId === null ? 'A correction must identify the corrected Discount Revision' : undefined;
    }
    return correctedRevisionId === null ? undefined : 'Only a correction may identify a corrected Discount Revision';
  }),
);
export type PricingDiscountRevisionLineage = typeof PricingDiscountRevisionLineageSchema.Type;

export const ScheduledPricingDiscountRevisionSchema = Schema.Struct({
  definition: PricingDiscountDefinitionSchema,
  effectivePeriod: PricingDiscountEffectivePeriodSchema,
  lineage: PricingDiscountRevisionLineageSchema,
}).check(
  Schema.makeFilter(({ definition, effectivePeriod }) =>
    definition.revision.effectiveFrom === effectivePeriod.effectiveFrom
      ? undefined
      : 'Discount Revision effective start must match its scheduled period',
  ),
);
export type ScheduledPricingDiscountRevision = typeof ScheduledPricingDiscountRevisionSchema.Type;

export const PricingDiscountScheduleRevisionSchema = Schema.Int.check(Schema.isGreaterThan(0));
export const PricingDiscountScheduleFingerprintSchema = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
export const PricingDiscountScheduleAcknowledgementPrincipalIdSchema = checkedUuid.pipe(
  Schema.brand('PricingDiscountScheduleAcknowledgementPrincipalId'),
  Schema.decodeTo(checkedUuid),
);

interface PricingDiscountRevisionIdentity {
  readonly revision: number;
  readonly revisionId: string;
}

const duplicateDiscountRevisionIdentityReason = (
  revisions: readonly PricingDiscountRevisionIdentity[],
): null | 'DUPLICATE_REVISION_ID' | 'DUPLICATE_REVISION_NUMBER' => {
  if (new Set(revisions.map(({ revisionId }) => revisionId)).size !== revisions.length) {
    return 'DUPLICATE_REVISION_ID';
  }
  return new Set(revisions.map(({ revision }) => revision)).size === revisions.length
    ? null
    : 'DUPLICATE_REVISION_NUMBER';
};

export const ExpectedPricingDiscountCurrentSchema = Schema.Struct({
  discountId: PricingDiscountIdSchema,
  effectivePeriod: PricingDiscountEffectivePeriodSchema,
  identityKey: PricingDiscountIdentityKeySchema,
  revision: PricingDiscountRevisionNumberSchema,
  revisionId: PricingDiscountRevisionIdSchema,
  scheduleRevision: PricingDiscountScheduleRevisionSchema,
});
export type ExpectedPricingDiscountCurrent = typeof ExpectedPricingDiscountCurrentSchema.Type;

export const PricingDiscountScheduleAcknowledgementSchema = Schema.Struct({
  actingPrincipalId: PricingDiscountScheduleAcknowledgementPrincipalIdSchema,
  discountId: PricingDiscountIdSchema,
  fingerprint: PricingDiscountScheduleFingerprintSchema,
  identityKey: PricingDiscountIdentityKeySchema,
  intendedConfiguredEffect: PricingDiscountEffectSchema,
  intendedEffectivePeriod: PricingDiscountEffectivePeriodSchema,
  intent: Schema.Literals(['RETIRE_CURRENT', 'VALUE_ONLY_CURRENT']),
  presentedFuture: Schema.Array(ScheduledPricingDiscountRevisionSchema),
  scheduleRevision: PricingDiscountScheduleRevisionSchema,
  targetEffectivePeriod: PricingDiscountEffectivePeriodSchema,
  targetRevisionId: PricingDiscountRevisionIdSchema,
}).check(
  Schema.makeFilter(
    ({
      discountId,
      identityKey,
      intendedConfiguredEffect,
      intendedEffectivePeriod,
      intent,
      presentedFuture,
      targetEffectivePeriod,
    }) => {
      const duplicateReason = duplicateDiscountRevisionIdentityReason(
        presentedFuture.map(({ definition }) => definition.revision),
      );
      if (duplicateReason !== null) {
        return duplicateReason === 'DUPLICATE_REVISION_ID'
          ? 'Acknowledged future Discount Revisions must have unique Revision IDs'
          : 'Acknowledged future Discount Revisions must have unique Revision numbers';
      }
      const valueSuccessorIsExact =
        intendedEffectivePeriod.effectiveFrom >= targetEffectivePeriod.effectiveFrom &&
        (targetEffectivePeriod.effectiveTo === null ||
          intendedEffectivePeriod.effectiveFrom < targetEffectivePeriod.effectiveTo) &&
        intendedEffectivePeriod.effectiveTo === targetEffectivePeriod.effectiveTo;
      const retirementSuccessorIsExact =
        intendedEffectivePeriod.effectiveFrom === targetEffectivePeriod.effectiveFrom &&
        intendedEffectivePeriod.effectiveTo !== null &&
        (targetEffectivePeriod.effectiveTo === null ||
          intendedEffectivePeriod.effectiveTo < targetEffectivePeriod.effectiveTo);
      if (
        (intent === 'VALUE_ONLY_CURRENT' && !valueSuccessorIsExact) ||
        (intent === 'RETIRE_CURRENT' && !retirementSuccessorIsExact)
      ) {
        return 'A Current Discount acknowledgement must bind the exact resulting successor or no-op interval';
      }
      if (intendedConfiguredEffect.kind !== identityKey.effectKind) {
        return 'Acknowledged Discount value must preserve the stable effect kind';
      }
      if (
        intendedConfiguredEffect.kind === 'FIXED_MONETARY_AMOUNT' &&
        intendedConfiguredEffect.level.currencyCode !== identityKey.currencyCode
      ) {
        return 'Acknowledged fixed Discount value must preserve the stable currency';
      }
      if (
        presentedFuture.some(
          ({ definition }) =>
            definition.discountId !== discountId ||
            !pricingDiscountIdentityKeysEqual(definition.identityKey, identityKey),
        )
      ) {
        return 'Acknowledged future Revisions must belong to the exact logical Discount';
      }
      return presentedFuture.every(
        (revision, index) =>
          index === 0 ||
          (presentedFuture[index - 1]?.effectivePeriod.effectiveFrom ?? '') < revision.effectivePeriod.effectiveFrom,
      )
        ? undefined
        : 'Acknowledged future Discount Revisions must be ordered by effective start';
    },
  ),
);
export type PricingDiscountScheduleAcknowledgement = typeof PricingDiscountScheduleAcknowledgementSchema.Type;

const sameScheduledDiscountRevision = Schema.toEquivalence(ScheduledPricingDiscountRevisionSchema);

export const PricingDiscountScheduleSnapshotSchema = Schema.Struct({
  current: Schema.optionalKey(ScheduledPricingDiscountRevisionSchema),
  discountId: PricingDiscountIdSchema,
  future: Schema.Array(ScheduledPricingDiscountRevisionSchema),
  identityKey: PricingDiscountIdentityKeySchema,
  observedAt: PricingInstantSchema,
  revisions: Schema.Array(ScheduledPricingDiscountRevisionSchema).check(Schema.isMinLength(1)),
  scheduleRevision: PricingDiscountScheduleRevisionSchema,
}).check(
  Schema.makeFilter(({ current, discountId, future, identityKey, observedAt, revisions }) => {
    const duplicateReason = duplicateDiscountRevisionIdentityReason(
      revisions.map(({ definition }) => definition.revision),
    );
    if (duplicateReason !== null) {
      return duplicateReason === 'DUPLICATE_REVISION_ID'
        ? 'A Discount Revision Schedule must have unique Revision IDs'
        : 'A Discount Revision Schedule must have unique Revision numbers';
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
      return 'A Discount Revision Schedule cannot overlap';
    }
    if (
      revisions.some(
        ({ definition }) =>
          definition.discountId !== discountId ||
          !pricingDiscountIdentityKeysEqual(definition.identityKey, identityKey),
      )
    ) {
      return 'All scheduled Revisions must belong to the exact logical Discount';
    }
    const selected = revisions.filter(
      ({ effectivePeriod }) =>
        effectivePeriod.effectiveFrom <= observedAt &&
        (effectivePeriod.effectiveTo === null || observedAt < effectivePeriod.effectiveTo),
    );
    if ((current === undefined && selected.length !== 0) || selected.length > 1) {
      return 'Discount Current selection must use exact half-open effectivity';
    }
    if (
      current !== undefined &&
      (selected.length !== 1 || selected[0] === undefined || !sameScheduledDiscountRevision(selected[0], current))
    ) {
      return 'Discount Current evidence must bind the exact effective Revision';
    }
    if (future.some(({ effectivePeriod }) => effectivePeriod.effectiveFrom <= observedAt)) {
      return 'Future Discount Revisions must start after the trusted observation instant';
    }
    const expectedFuture = ordered.filter(({ effectivePeriod }) => effectivePeriod.effectiveFrom > observedAt);
    return future.length === expectedFuture.length &&
      future.every((revision, index) => {
        const expected = expectedFuture[index];
        return expected !== undefined && sameScheduledDiscountRevision(revision, expected);
      })
      ? undefined
      : 'Future Discount evidence must be the complete ordered future schedule';
  }),
);
export type PricingDiscountScheduleSnapshot = typeof PricingDiscountScheduleSnapshotSchema.Type;

/** Explicit 0/1/>1 Current result; conflicts are never collapsed to absence or a winner. */
export const PricingDiscountCurrentResolutionSchema = Schema.Union([
  Schema.Struct({
    identityKey: PricingDiscountIdentityKeySchema,
    observedAt: PricingInstantSchema,
    outcome: Schema.Literal('DISCOUNT_CURRENT_ABSENT'),
  }),
  Schema.Struct({
    observedAt: PricingInstantSchema,
    outcome: Schema.Literal('DISCOUNT_CURRENT'),
    revision: ScheduledPricingDiscountRevisionSchema,
  }).check(
    Schema.makeFilter(({ observedAt, revision }) =>
      revision.effectivePeriod.effectiveFrom <= observedAt &&
      (revision.effectivePeriod.effectiveTo === null || observedAt < revision.effectivePeriod.effectiveTo)
        ? undefined
        : 'Current Discount Revision must be effective at the trusted observation instant',
    ),
  ),
  Schema.Struct({
    candidateRevisionIds: Schema.Array(PricingDiscountRevisionIdSchema).check(
      Schema.isMinLength(2),
      Schema.makeFilter((ids) =>
        new Set(ids).size === ids.length ? undefined : 'Conflicting Revision IDs must be unique',
      ),
    ),
    identityKey: PricingDiscountIdentityKeySchema,
    observedAt: PricingInstantSchema,
    outcome: Schema.Literal('DISCOUNT_CURRENT_CONFLICT'),
  }),
  Schema.Struct({
    claimants: Schema.Array(
      Schema.Struct({
        revision: PricingDiscountRevisionNumberSchema,
        revisionId: PricingDiscountRevisionIdSchema,
      }),
    ).check(Schema.isMinLength(2)),
    identityKey: PricingDiscountIdentityKeySchema,
    observedAt: PricingInstantSchema,
    outcome: Schema.Literal('DISCOUNT_REVISION_INVARIANT_VIOLATION'),
    reason: Schema.Literals(['DUPLICATE_REVISION_ID', 'DUPLICATE_REVISION_NUMBER']),
  }).check(
    Schema.makeFilter(({ claimants, reason }) =>
      duplicateDiscountRevisionIdentityReason(claimants) === reason
        ? undefined
        : 'Discount invariant outcome reason must match the duplicate Revision identity',
    ),
  ),
]);
export type PricingDiscountCurrentResolution = typeof PricingDiscountCurrentResolutionSchema.Type;

const PricingDiscountCatalogAudienceEvidenceSchema = Schema.Struct({
  audience: PricingCatalogDiscountAudienceSchema,
  catalogEvidence: CatalogSelectionValidEvidenceSchema,
  kind: Schema.Literal('CATALOG_OWNER_EVIDENCE'),
}).check(
  Schema.makeFilter(({ audience, catalogEvidence }) =>
    priceCatalogTargetsEqual(audience.selection, catalogEvidence.selection)
      ? undefined
      : 'Catalog audience evidence must bind the exact Discount selection',
  ),
);
const assignedPriceGroupInterpretation = (interpretation: PriceGroupInterpretation) =>
  Match.value(interpretation).pipe(
    Match.tag('ASSIGNED', (assigned) => assigned),
    Match.orElse(() => null),
  );
const PricingDiscountPriceGroupAudienceEvidenceSchema = Schema.Struct({
  audience: PricingPriceGroupDiscountAudienceSchema,
  interpretation: PriceGroupInterpretationSchema,
  kind: Schema.Literal('PRICE_GROUP_OWNER_EVIDENCE'),
}).check(
  Schema.makeFilter(({ audience, interpretation }) => {
    const assigned = assignedPriceGroupInterpretation(interpretation);
    return assigned !== null && sameResourceRef(audience.priceGroupRef, assigned.priceGroupRef)
      ? undefined
      : 'Price Group Discount requires exact owner-proven ASSIGNED evidence';
  }),
);
const PricingDiscountCounterpartyAudienceEvidenceSchema = Schema.Struct({
  audience: PricingCounterpartyDiscountAudienceSchema,
  kind: Schema.Literal('COUNTERPARTY_OWNER_EVIDENCE'),
  observedAt: PricingInstantSchema,
  ownerRevision: stableReference,
  source: Schema.Literal('PARTY_REGISTRY'),
});

/** Owner-issued proof for the exact configured audience; principal, email and order history are not alternatives. */
export const PricingDiscountAudienceEvidenceSchema = Schema.Union([
  PricingDiscountCatalogAudienceEvidenceSchema,
  PricingDiscountPriceGroupAudienceEvidenceSchema,
  PricingDiscountCounterpartyAudienceEvidenceSchema,
]);
export type PricingDiscountAudienceEvidence = typeof PricingDiscountAudienceEvidenceSchema.Type;

/** The base Price actually used is separate evidence from the contractual Discount audience. */
export const PricingDiscountBasePricePathSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal('NO_GROUP_PRICE'),
    priceRef: PriceRefSchema,
    priceRevisionId: PriceRevisionIdSchema,
  }),
  Schema.Struct({
    kind: Schema.Literal('PRICE_GROUP_PRICE'),
    priceGroupRef: PriceGroupRefSchema,
    priceRef: PriceRefSchema,
    priceRevisionId: PriceRevisionIdSchema,
  }).check(
    Schema.makeFilter(({ priceGroupRef, priceRef }) =>
      priceGroupRef.tenantId === priceRef.tenantId
        ? undefined
        : 'Group-specific Price path references must belong to the same Tenant',
    ),
  ),
]);
export type PricingDiscountBasePricePath = typeof PricingDiscountBasePricePathSchema.Type;

const PricingDiscountApplicabilityBasisSchema = Schema.Struct({
  basis: PricingDiscountIdentityBasisSchema,
  commercialScope: PricingCommercialScopeSchema,
  currencyCode: PricingCurrencyCodeSchema,
  observedAt: PricingInstantSchema,
});

export const PricingDiscountAudienceEvidenceBindingSchema = Schema.Struct({
  applicabilityBasis: PricingDiscountApplicabilityBasisSchema,
  basePricePath: PricingDiscountBasePricePathSchema,
  evidence: PricingDiscountAudienceEvidenceSchema,
  identityKey: PricingDiscountIdentityKeySchema,
}).check(
  Schema.makeFilter(({ applicabilityBasis, basePricePath, evidence, identityKey }) => {
    if (!sameAudience(evidence.audience, identityKey.audience)) {
      return 'Discount audience evidence must bind the exact logical key audience';
    }
    if (
      applicabilityBasis.currencyCode !== identityKey.currencyCode ||
      !sameCommercialScope(applicabilityBasis.commercialScope, identityKey.commercialScope) ||
      applicabilityBasis.basis.kind !== identityKey.basis.kind ||
      (applicabilityBasis.basis.kind === 'VARIANT_LINE' &&
        identityKey.basis.kind === 'VARIANT_LINE' &&
        (!priceCatalogTargetsEqual(applicabilityBasis.basis.catalogSelection, identityKey.basis.catalogSelection) ||
          !priceDecimalValuesEqual(applicabilityBasis.basis.unitBasis.quantity, identityKey.basis.unitBasis.quantity) ||
          !sameResourceRef(applicabilityBasis.basis.unitBasis.unitRef, identityKey.basis.unitBasis.unitRef)))
    ) {
      return 'Discount audience evidence must bind the exact applicability basis';
    }
    if (basePricePath.priceRef.tenantId !== discountAudienceTenantId(identityKey.audience)) {
      return 'Base Price path and Discount audience must belong to the same Tenant';
    }
    if (evidence.kind === 'PRICE_GROUP_OWNER_EVIDENCE') {
      const { interpretation } = evidence;
      const assigned = assignedPriceGroupInterpretation(interpretation);
      if (assigned === null) {
        return 'Price Group Discount requires ASSIGNED owner evidence';
      }
      if (
        !sameCommercialScope(assigned.basis.commercialScope, identityKey.commercialScope) ||
        assigned.basis.currencyCode !== identityKey.currencyCode ||
        identityKey.basis.kind !== 'VARIANT_LINE' ||
        !priceCatalogTargetsEqual(assigned.basis.catalogSelection, identityKey.basis.catalogSelection) ||
        !priceDecimalValuesEqual(assigned.basis.unitBasis.quantity, identityKey.basis.unitBasis.quantity) ||
        !sameResourceRef(assigned.basis.unitBasis.unitRef, identityKey.basis.unitBasis.unitRef)
      ) {
        return 'Price Group owner evidence must bind the exact Discount applicability basis';
      }
    }
    return [];
  }),
);
export type PricingDiscountAudienceEvidenceBinding = typeof PricingDiscountAudienceEvidenceBindingSchema.Type;

interface CanonicalDecimalParts {
  readonly digits: bigint;
  readonly scale: number;
}
const canonicalDecimalParts = (value: string) => {
  const [integer = '0', fraction = ''] = value.split('.');
  return { digits: BigInt(`${integer}${fraction}`), scale: fraction.length } satisfies CanonicalDecimalParts;
};
const compareNonNegativeDecimals = (left: string, right: string): number => {
  const leftParts = canonicalDecimalParts(left);
  const rightParts = canonicalDecimalParts(right);
  const scale = Math.max(leftParts.scale, rightParts.scale);
  const leftDigits = leftParts.digits * 10n ** BigInt(scale - leftParts.scale);
  const rightDigits = rightParts.digits * 10n ** BigInt(scale - rightParts.scale);
  if (leftDigits < rightDigits) {
    return -1;
  }
  return leftDigits > rightDigits ? 1 : 0;
};
const sumNonNegativeDecimals = (values: readonly string[]): string => {
  const parts = values.map(canonicalDecimalParts);
  const scale = Math.max(0, ...parts.map((part) => part.scale));
  const digits = parts.reduce((sum, part) => sum + part.digits * 10n ** BigInt(scale - part.scale), 0n);
  if (scale === 0) {
    return digits.toString();
  }
  const padded = digits.toString().padStart(scale + 1, '0');
  const integer = padded.slice(0, -scale);
  const fraction = padded.slice(-scale).replace(/0+$/u, '');
  return fraction.length === 0 ? integer : `${integer}.${fraction}`;
};

export const PricingWholePurchaseEligibleRecipientSchema = Schema.Struct({
  intermediateValue: Schema.Struct({
    amount: PricingNonNegativeDecimalSchema.check(
      Schema.makeFilter((amount) =>
        /^0(?:\.0+)?$/u.test(amount) ? 'Eligible recipient must be strictly positive' : undefined,
      ),
    ),
    currencyCode: PricingCurrencyCodeSchema,
  }),
  occurrenceId: PricingPurchaseDemandOccurrenceIdSchema,
  recipientKind: Schema.Literal('MERCHANDISE'),
});

/** Exact positive merchandise basis after line Discounts; allocation remains #774's responsibility. */
export const PricingWholePurchaseContractualEligibleBasisSchema = Schema.Struct({
  currencyCode: PricingCurrencyCodeSchema,
  eligibleAmount: PricingNonNegativeDecimalSchema,
  recipients: Schema.Array(PricingWholePurchaseEligibleRecipientSchema),
}).check(
  Schema.makeFilter(({ currencyCode, eligibleAmount, recipients }) => {
    if (new Set(recipients.map(({ occurrenceId }) => occurrenceId)).size !== recipients.length) {
      return 'Whole-purchase eligible recipients must preserve distinct original line identities';
    }
    if (recipients.some(({ intermediateValue }) => intermediateValue.currencyCode !== currencyCode)) {
      return 'Every eligible recipient must use the whole-purchase basis currency';
    }
    return compareNonNegativeDecimals(
      eligibleAmount,
      sumNonNegativeDecimals(recipients.map(({ intermediateValue }) => intermediateValue.amount)),
    ) === 0
      ? undefined
      : 'Whole-purchase eligible basis must equal the exact sum of positive merchandise recipients';
  }),
);
export type PricingWholePurchaseContractualEligibleBasis =
  typeof PricingWholePurchaseContractualEligibleBasisSchema.Type;

const PricingWholePurchaseApplicabilityBaseSchema = Schema.Struct({
  basis: PricingWholePurchaseContractualEligibleBasisSchema,
  definition: PricingDiscountDefinitionSchema,
});

export const PricingWholePurchaseContractualApplicabilitySchema = Schema.Union([
  Schema.Struct({
    ...PricingWholePurchaseApplicabilityBaseSchema.fields,
    contribution: Schema.Struct({ amount: PricingNonPositiveDecimalSchema, currencyCode: PricingCurrencyCodeSchema }),
    outcome: Schema.Literal('WHOLE_PURCHASE_DISCOUNT_APPLICABLE'),
  }).check(
    Schema.makeFilter(({ basis, contribution, definition }) => {
      const { identityKey, revision } = definition;
      if (
        identityKey.family !== 'CONTRACTUAL_DISCOUNT' ||
        identityKey.scope !== 'WHOLE_PURCHASE' ||
        identityKey.audience.kind !== 'COUNTERPARTY' ||
        revision.configuredEffect.kind !== 'FIXED_MONETARY_AMOUNT'
      ) {
        return 'Whole-purchase applicability requires an exact Counterparty fixed contractual Discount';
      }
      const configured = revision.configuredEffect.level;
      if (basis.currencyCode !== identityKey.currencyCode || contribution.currencyCode !== identityKey.currencyCode) {
        return 'Whole-purchase basis and contribution must use the logical Discount currency';
      }
      if (compareNonNegativeDecimals(basis.eligibleAmount, configured.amount) <= 0) {
        return 'Whole-purchase contractual Discount applies only when eligible basis is strictly greater than D';
      }
      const expectedContribution = /^0(?:\.0+)?$/u.test(configured.amount) ? '0' : `-${configured.amount}`;
      const actualMagnitude = contribution.amount.startsWith('-') ? contribution.amount.slice(1) : contribution.amount;
      return compareNonNegativeDecimals(
        actualMagnitude,
        expectedContribution.startsWith('-') ? expectedContribution.slice(1) : expectedContribution,
      ) === 0
        ? undefined
        : 'Applicable whole-purchase contribution must equal exactly -D';
    }),
  ),
  Schema.Struct({
    ...PricingWholePurchaseApplicabilityBaseSchema.fields,
    outcome: Schema.Literal('WHOLE_PURCHASE_DISCOUNT_NOT_APPLICABLE'),
    reason: Schema.Literals(['EMPTY_ELIGIBLE_SET', 'BASIS_NOT_GREATER_THAN_DISCOUNT']),
  }).check(
    Schema.makeFilter(({ basis, definition, reason }) => {
      const effect = definition.revision.configuredEffect;
      if (
        definition.identityKey.scope !== 'WHOLE_PURCHASE' ||
        definition.identityKey.audience.kind !== 'COUNTERPARTY' ||
        effect.kind !== 'FIXED_MONETARY_AMOUNT'
      ) {
        return 'Whole-purchase non-applicability requires an exact Counterparty fixed Discount';
      }
      if (basis.currencyCode !== definition.identityKey.currencyCode) {
        return 'Whole-purchase basis must use the logical Discount currency';
      }
      if (basis.recipients.length === 0) {
        return reason === 'EMPTY_ELIGIBLE_SET' ? undefined : 'An empty eligible set must use its explicit reason';
      }
      return compareNonNegativeDecimals(basis.eligibleAmount, effect.level.amount) <= 0 &&
        reason === 'BASIS_NOT_GREATER_THAN_DISCOUNT'
        ? undefined
        : 'A non-empty whole-purchase basis is non-applicable exactly when B <= D';
    }),
  ),
]);
export type PricingWholePurchaseContractualApplicability =
  typeof PricingWholePurchaseContractualApplicabilitySchema.Type;

/** Discount-specific name for the immutable Catalog-owner Product-to-Variant expansion contract. */
export const PricingDiscountProductTargetSnapshotSchema = PriceProductTargetSnapshotSchema;
export type PricingDiscountProductTargetSnapshot = typeof PricingDiscountProductTargetSnapshotSchema.Type;

export const PricingDiscountProductBulkOperationIdSchema = stableReference.pipe(
  Schema.brand('PricingDiscountProductBulkOperationId'),
  Schema.decodeTo(Schema.String),
);
const PricingDiscountProductTargetOutcomeIdentitySchema = Schema.Struct({
  operationId: PricingDiscountProductBulkOperationIdSchema,
  snapshotId: PriceProductTargetSnapshotIdSchema,
  target: PriceCatalogTargetSchema,
  targetId: PriceProductTargetIdSchema,
});

const pricingDiscountProductTargetOutcomeBaseFields = {
  discountIdentityKey: PricingDiscountIdentityKeySchema,
  identity: PricingDiscountProductTargetOutcomeIdentitySchema,
};

export const PricingDiscountProductTargetOutcomeSchema = Schema.Union([
  Schema.Struct({
    ...pricingDiscountProductTargetOutcomeBaseFields,
    discountId: PricingDiscountIdSchema,
    outcome: Schema.Literal('DISCOUNT_TARGET_APPLIED'),
    revisionId: PricingDiscountRevisionIdSchema,
  }),
  Schema.Struct({
    ...pricingDiscountProductTargetOutcomeBaseFields,
    discountId: PricingDiscountIdSchema,
    outcome: Schema.Literal('DISCOUNT_TARGET_UNCHANGED'),
    revisionId: PricingDiscountRevisionIdSchema,
  }),
  Schema.Struct({
    ...pricingDiscountProductTargetOutcomeBaseFields,
    outcome: Schema.Literal('DISCOUNT_TARGET_RETRYABLE_FAILURE'),
    reason: Schema.Literals(['CONCURRENT_CHANGE', 'OWNER_UNAVAILABLE', 'UNKNOWN_COMMIT']),
  }),
  Schema.Struct({
    ...pricingDiscountProductTargetOutcomeBaseFields,
    outcome: Schema.Literal('DISCOUNT_TARGET_REJECTED'),
    reason: Schema.Literals(['CATALOG_TARGET_CHANGED', 'IDENTITY_INVALID', 'PERMISSION_DENIED']),
  }),
]).check(
  Schema.makeFilter(({ discountIdentityKey, identity }) =>
    discountIdentityKey.basis.kind === 'VARIANT_LINE' &&
    priceCatalogTargetsEqual(discountIdentityKey.basis.catalogSelection, identity.target)
      ? undefined
      : 'Product Discount outcome must bind its exact expanded Variant identity',
  ),
);
export type PricingDiscountProductTargetOutcome = typeof PricingDiscountProductTargetOutcomeSchema.Type;

/** Complete per-snapshot reconciliation: every captured target has one outcome and no future Variant can appear. */
export const PricingDiscountProductBulkResultSchema = Schema.Struct({
  operationId: PricingDiscountProductBulkOperationIdSchema,
  outcomes: Schema.Array(PricingDiscountProductTargetOutcomeSchema).check(Schema.isMinLength(1)),
  snapshot: PricingDiscountProductTargetSnapshotSchema,
}).check(
  Schema.makeFilter(({ operationId, outcomes, snapshot }) => {
    if (
      outcomes.some(
        ({ identity }) => identity.operationId !== operationId || identity.snapshotId !== snapshot.snapshotId,
      )
    ) {
      return 'Every Product Discount outcome must bind the exact bulk operation and snapshot';
    }
    if (new Set(outcomes.map(({ identity }) => identity.targetId)).size !== outcomes.length) {
      return 'Product Discount outcomes must contain each snapshot target at most once';
    }
    return snapshot.targets.length === outcomes.length &&
      snapshot.targets.every(({ target, targetId }) =>
        outcomes.some(
          ({ identity }) => identity.targetId === targetId && priceCatalogTargetsEqual(identity.target, target),
        ),
      )
      ? undefined
      : 'Product Discount reconciliation must cover exactly the immutable snapshot targets';
  }),
);
export type PricingDiscountProductBulkResult = typeof PricingDiscountProductBulkResultSchema.Type;

/** Retry selects only unresolved retryable targets; successful and terminal targets never repeat. */
export const PricingDiscountProductBulkRetrySchema = Schema.Struct({
  priorResult: PricingDiscountProductBulkResultSchema,
  retryOperationId: PricingDiscountProductBulkOperationIdSchema,
  retryTargetIds: Schema.Array(PriceProductTargetIdSchema).check(
    Schema.isMinLength(1),
    Schema.makeFilter((ids) => (new Set(ids).size === ids.length ? undefined : 'Retry target IDs must be unique')),
  ),
}).check(
  Schema.makeFilter(({ priorResult, retryOperationId, retryTargetIds }) => {
    if (retryOperationId === priorResult.operationId) {
      return 'A retry must use a distinct operation identity';
    }
    return retryTargetIds.every((targetId) =>
      priorResult.outcomes.some(
        (outcome) => outcome.identity.targetId === targetId && outcome.outcome === 'DISCOUNT_TARGET_RETRYABLE_FAILURE',
      ),
    )
      ? undefined
      : 'Only retryable unresolved Product Discount targets may be retried';
  }),
);
export type PricingDiscountProductBulkRetry = typeof PricingDiscountProductBulkRetrySchema.Type;
