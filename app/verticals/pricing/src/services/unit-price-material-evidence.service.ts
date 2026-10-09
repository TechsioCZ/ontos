import type { ExactPriceLookupRequest } from '@app/pricing-contracts/domain/exact-price-lookup';
import { PriceIdentityKeySchema } from '@app/pricing-contracts/domain/price-definition';
import {
  PricingUnitPriceBasisFailure,
  PricingUnitPriceCalculationReadyInputSchema,
  PricingUnitPriceConflictFailure,
  PricingUnitPriceInvalidFailure,
  PricingUnitPriceUnavailableFailure,
  PricingUnitPriceUnverifiableFailure,
} from '@app/pricing-contracts/domain/unit-price-calculation';
import type {
  PricingUnitPriceCalculationAttempt,
  PricingUnitPriceCalculationFailure,
  PricingUnitPriceCalculationReadyInput,
} from '@app/pricing-contracts/domain/unit-price-calculation';
import { OwnerVerifiableSetCompletenessEvidenceSchema } from '@app/shared-contracts';
import type { OwnerVerifiableSetCompletenessEvidence } from '@app/shared-contracts';
import { createHash } from 'node:crypto';
import { DateTime, Effect, Match, Option, Result, Schema } from 'effect';

const encodePriceIdentityKey = Schema.encodeUnknownResult(Schema.fromJsonString(PriceIdentityKeySchema));

/** Stable owner predicate for the complete Current set at one exact Group Price key. */
export const unitPriceGroupAbsencePredicateRef = (request: ExactPriceLookupRequest): string =>
  `commerce.pricing.current-exact-group-price:${createHash('sha256')
    .update(Result.getOrThrow(encodePriceIdentityKey(request.exactKey)))
    .digest('hex')}`;

/** The only safely broader scope accepted by this gate: the Tenant's complete Current Price set. */
export const unitPriceGroupAbsenceDeclaredScopeRef = (request: ExactPriceLookupRequest): string =>
  `commerce.pricing.current-price-set:tenant:${request.exactKey.catalogSelection.productRef.tenantId}`;

const sameCompletenessEvidence = Schema.toEquivalence(OwnerVerifiableSetCompletenessEvidenceSchema);

const tierSetIsCurrent = (input: PricingUnitPriceCalculationReadyInput): boolean => {
  const evaluatedAt = DateTime.make(input.tierSelection.evidence.input.attempt.evaluatedAt);
  if (Option.isNone(evaluatedAt)) {
    return false;
  }
  const completeness = input.tierSelection.evidence.input.tierSet.completenessEvidence;
  const evaluatedAtMillis = DateTime.toEpochMillis(evaluatedAt.value);
  return (
    DateTime.toEpochMillis(completeness.observedAt) >= evaluatedAtMillis &&
    (completeness.nextApplicabilityBoundary === undefined ||
      DateTime.toEpochMillis(completeness.nextApplicabilityBoundary) > evaluatedAtMillis)
  );
};

/** The compact #767 path must retain the material absence facts from the complete #763 path. */
const pricePathIsPreserved = (input: PricingUnitPriceCalculationReadyInput): boolean => {
  const resolutionPath = input.exactPrice.path;
  const tierPath = input.tierSelection.evidence.input.attempt.exactPrice.path;
  return Match.value(resolutionPath).pipe(
    Match.tag('NO_GROUP_AFTER_PROVEN_GROUP_ABSENCE', ({ groupAbsence }) => {
      if (tierPath.requiredAbsenceEvidence.length !== 1) {
        return false;
      }
      const [absence] = tierPath.requiredAbsenceEvidence;
      const lookupEvidence = groupAbsence.evidence;
      if (absence === undefined) {
        return false;
      }
      const expectedScope = Match.value(absence.scope).pipe(
        Match.when({ kind: 'EXACT_PREDICATE' }, () => ({
          kind: 'EXACT_PREDICATE' as const,
          predicateRef: unitPriceGroupAbsencePredicateRef(groupAbsence.request),
        })),
        Match.when({ kind: 'SAFELY_BROADER_SCOPE' }, () => ({
          declaredScopeRef: unitPriceGroupAbsenceDeclaredScopeRef(groupAbsence.request),
          kind: 'SAFELY_BROADER_SCOPE' as const,
          predicateRef: unitPriceGroupAbsencePredicateRef(groupAbsence.request),
        })),
        Match.exhaustive,
      );
      const expectedWithoutBoundary: OwnerVerifiableSetCompletenessEvidence = {
        observedAt: DateTime.makeUnsafe(lookupEvidence.observedAt),
        ownerRevision: lookupEvidence.ownerRevision,
        scope: expectedScope,
      };
      const expected: OwnerVerifiableSetCompletenessEvidence =
        lookupEvidence.nextApplicabilityBoundary === undefined
          ? expectedWithoutBoundary
          : {
              ...expectedWithoutBoundary,
              nextApplicabilityBoundary: DateTime.makeUnsafe(lookupEvidence.nextApplicabilityBoundary),
            };
      return sameCompletenessEvidence(absence, expected);
    }),
    Match.orElse(() => tierPath.requiredAbsenceEvidence.length === 0),
  );
};

const exactPriceFailure = (attempt: PricingUnitPriceCalculationAttempt): PricingUnitPriceCalculationFailure | null => {
  const { occurrenceId } = attempt.line;
  return Match.value(attempt.exactPrice).pipe(
    Match.when(
      { _tag: 'NO_APPLICABLE_PRICE' },
      () => new PricingUnitPriceInvalidFailure({ occurrenceId, reason: 'NO_APPLICABLE_PRICE' }),
    ),
    Match.when({ _tag: 'PRICE_FOUND' }, () => null),
    Match.when(
      { _tag: 'PRICING_CONFIGURATION_ERROR' },
      () => new PricingUnitPriceInvalidFailure({ occurrenceId, reason: 'INVALID_EXACT_PRICE' }),
    ),
    Match.when(
      { _tag: 'PRICING_CONFLICT' },
      () => new PricingUnitPriceConflictFailure({ occurrenceId, reason: 'EXACT_PRICE_CONFLICT' }),
    ),
    Match.when({ _tag: 'PRICING_INDETERMINATE' }, ({ path }) =>
      Match.value(path).pipe(
        Match.tag('INDETERMINATE', ({ reason }) =>
          Match.value(reason).pipe(
            Match.when(
              'OWNER_STATE_UNAVAILABLE',
              () =>
                new PricingUnitPriceUnavailableFailure({
                  occurrenceId,
                  reason: 'EXACT_PRICE_UNAVAILABLE',
                  retryable: true,
                }),
            ),
            Match.when(
              'OWNER_STATE_UNVERIFIABLE',
              () =>
                new PricingUnitPriceUnverifiableFailure({
                  occurrenceId,
                  reason: 'EXACT_PRICE_UNVERIFIABLE',
                }),
            ),
            Match.exhaustive,
          ),
        ),
        Match.orElse(
          () =>
            new PricingUnitPriceUnverifiableFailure({
              occurrenceId,
              reason: 'EXACT_PRICE_UNVERIFIABLE',
            }),
        ),
      ),
    ),
    Match.exhaustive,
  );
};

const tierFailure = (attempt: PricingUnitPriceCalculationAttempt): PricingUnitPriceCalculationFailure | null => {
  const { occurrenceId } = attempt.line;
  return Match.value(attempt.tierSelection).pipe(
    Match.when({ outcome: 'BASE_PRICE_RETAINED' }, () => null),
    Match.when({ outcome: 'QUANTITY_TIER_APPLIED' }, () => null),
    Match.when(
      { outcome: 'QUANTITY_TIER_SELECTION_FAILED', reason: 'AMBIGUOUS_THRESHOLD' },
      () => new PricingUnitPriceConflictFailure({ occurrenceId, reason: 'QUANTITY_TIER_CONFLICT' }),
    ),
    Match.when(
      { outcome: 'QUANTITY_TIER_SELECTION_FAILED', reason: 'CONFLICTING_CURRENT_TIERS' },
      () => new PricingUnitPriceConflictFailure({ occurrenceId, reason: 'QUANTITY_TIER_CONFLICT' }),
    ),
    Match.when(
      { outcome: 'QUANTITY_TIER_SELECTION_FAILED', reason: 'UNAVAILABLE_TIER_SET' },
      () =>
        new PricingUnitPriceUnavailableFailure({
          occurrenceId,
          reason: 'QUANTITY_TIER_UNAVAILABLE',
          retryable: true,
        }),
    ),
    Match.when(
      { outcome: 'QUANTITY_TIER_SELECTION_FAILED', reason: 'INCOMPATIBLE_QUANTITY_BASIS' },
      () => new PricingUnitPriceBasisFailure({ occurrenceId, reason: 'TIER_UNIT_BINDING_MISMATCH' }),
    ),
    Match.when(
      { outcome: 'QUANTITY_TIER_SELECTION_FAILED', reason: 'INCOMPLETE_TIER_SET' },
      () =>
        new PricingUnitPriceUnverifiableFailure({
          occurrenceId,
          reason: 'SET_COMPLETENESS_UNVERIFIABLE',
        }),
    ),
    Match.when(
      { outcome: 'QUANTITY_TIER_SELECTION_FAILED', reason: 'STALE_TIER_SET' },
      () =>
        new PricingUnitPriceUnverifiableFailure({
          occurrenceId,
          reason: 'QUANTITY_TIER_UNVERIFIABLE',
        }),
    ),
    Match.when(
      { outcome: 'QUANTITY_TIER_SELECTION_FAILED', reason: 'UNVERIFIABLE_TIER_SET' },
      () =>
        new PricingUnitPriceUnverifiableFailure({
          occurrenceId,
          reason: 'QUANTITY_TIER_UNVERIFIABLE',
        }),
    ),
    Match.when(
      { outcome: 'QUANTITY_TIER_SELECTION_FAILED', reason: 'CURRENCY_MISMATCH' },
      () => new PricingUnitPriceInvalidFailure({ occurrenceId, reason: 'INVALID_TIER_SELECTION' }),
    ),
    Match.when(
      { outcome: 'QUANTITY_TIER_SELECTION_FAILED', reason: 'PRICE_BINDING_MISMATCH' },
      () => new PricingUnitPriceInvalidFailure({ occurrenceId, reason: 'INVALID_TIER_SELECTION' }),
    ),
    Match.exhaustive,
  );
};

const quantityBasisFailure = (
  attempt: PricingUnitPriceCalculationAttempt,
): PricingUnitPriceCalculationFailure | null => {
  const { occurrenceId } = attempt.line;
  return Match.value(attempt.quantityBasis).pipe(
    Match.when({ outcome: 'COMPATIBLE_CONVERSION' }, () => null),
    Match.when({ outcome: 'NO_CONVERSION_REQUIRED' }, () => null),
    Match.when(
      { outcome: 'INCOMPATIBLE' },
      () => new PricingUnitPriceBasisFailure({ occurrenceId, reason: 'INCOMPATIBLE_QUANTITY_BASIS' }),
    ),
    Match.when(
      { outcome: 'INVALID' },
      () => new PricingUnitPriceInvalidFailure({ occurrenceId, reason: 'INVALID_QUANTITY_BASIS' }),
    ),
    Match.when(
      { outcome: 'UNAVAILABLE' },
      ({ retryable }) =>
        new PricingUnitPriceUnavailableFailure({
          occurrenceId,
          reason: 'QUANTITY_BASIS_UNAVAILABLE',
          retryable: retryable ?? true,
        }),
    ),
    Match.when(
      { outcome: 'UNVERIFIABLE' },
      () =>
        new PricingUnitPriceUnverifiableFailure({
          occurrenceId,
          reason: 'QUANTITY_BASIS_UNVERIFIABLE',
        }),
    ),
    Match.exhaustive,
  );
};

/** Narrows owner facts before arithmetic; it performs no arithmetic or Unit Price construction. */
export const validateUnitPriceMaterialEvidence = (
  attempt: PricingUnitPriceCalculationAttempt,
): Effect.Effect<PricingUnitPriceCalculationReadyInput, PricingUnitPriceCalculationFailure> => {
  const upstreamFailure = exactPriceFailure(attempt) ?? tierFailure(attempt) ?? quantityBasisFailure(attempt);
  if (upstreamFailure !== null) {
    return Effect.fail(upstreamFailure);
  }
  if (attempt.lineQuantity === undefined) {
    return Effect.fail(
      new PricingUnitPriceInvalidFailure({
        occurrenceId: attempt.line.occurrenceId,
        reason: 'LINE_BINDING_INVALID',
      }),
    );
  }

  const encodedReady = Schema.encodeUnknownOption(PricingUnitPriceCalculationReadyInputSchema, {
    onExcessProperty: 'error',
  })(attempt);
  if (Option.isNone(encodedReady)) {
    return Effect.fail(
      new PricingUnitPriceUnverifiableFailure({
        occurrenceId: attempt.line.occurrenceId,
        reason: 'CURRENTNESS_UNVERIFIABLE',
      }),
    );
  }
  const decodedReady = Schema.decodeResult(PricingUnitPriceCalculationReadyInputSchema, {
    onExcessProperty: 'error',
  })(encodedReady.value);
  if (Result.isFailure(decodedReady)) {
    return Effect.fail(
      new PricingUnitPriceUnverifiableFailure({
        occurrenceId: attempt.line.occurrenceId,
        reason: 'CURRENTNESS_UNVERIFIABLE',
      }),
    );
  }
  const ready = decodedReady.success;
  if (ready.exactPrice.currencySupport.currentnessEvidence.evaluationMode !== 'CURRENT_WITH_REVALIDATION') {
    return Effect.fail(
      new PricingUnitPriceUnverifiableFailure({
        occurrenceId: attempt.line.occurrenceId,
        reason: 'CURRENTNESS_UNVERIFIABLE',
      }),
    );
  }
  if (!tierSetIsCurrent(ready)) {
    return Effect.fail(
      new PricingUnitPriceUnverifiableFailure({
        occurrenceId: attempt.line.occurrenceId,
        reason: 'SET_COMPLETENESS_UNVERIFIABLE',
      }),
    );
  }
  return pricePathIsPreserved(ready)
    ? Effect.succeed(ready)
    : Effect.fail(
        new PricingUnitPriceUnverifiableFailure({
          occurrenceId: attempt.line.occurrenceId,
          reason: 'SET_COMPLETENESS_UNVERIFIABLE',
        }),
      );
};
