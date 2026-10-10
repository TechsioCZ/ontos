import { Array as Arr, Option, Order, Result, Schema, pipe } from 'effect';
import type { NonEmptyReadonlyArray } from 'effect/Array';

import { SellerVatRegimeNotDeclaredSchema, evaluateLaunchTaxCoverage } from './launch-coverage.ts';
import type { LaunchTaxCoverageFailure } from './launch-coverage.ts';
import type { PurchaseDemandOccurrence } from '../../shared/domain/tax-kernel/purchase-binding.ts';
import { SELLER_NOT_VAT_PAYER_LEGAL_BASIS, SellerVatRegimeDeclaredSchema } from './seller-vat-regime-timeline.ts';
import type { SellerVatRegimeDeclarationRevisionRef } from './seller-vat-regime-timeline.ts';
import type { SellerVatRegimeSelection } from '../../shared/domain/tax-kernel/seller-vat-regime.ts';
import { allocateShippingTaxableBasis } from './shipping-allocation.ts';
import type { ShippingAllocation, ShippingAllocationInput } from './shipping-allocation.ts';
import { classifyCatalogSelection, launchTaxClassificationInterpretation } from './tax-classification.ts';
import type { TaxClassification } from './tax-classification.ts';
import {
  TaxDecisionIdSchema,
  TaxDecisionSchema,
  TaxRuleIdSchema,
} from '../../shared/domain/tax-kernel/tax-decision.ts';
import type {
  SellerNotVatPayerDecisionUnit,
  TaxDecision,
  TaxDecisionUnit,
  TaxableDecisionUnit,
} from '../../shared/domain/tax-kernel/tax-decision.ts';
import type { TaxEvaluationRequest } from './tax-evaluation-request.ts';
import { determineTaxJurisdiction } from './tax-jurisdiction.ts';
import type { TaxJurisdictionDetermination } from './tax-jurisdiction.ts';
import { TaxCaseUnsupportedSchema, TaxStateIndeterminateSchema } from './tax-non-success-outcome.ts';
import type { TaxNonSuccessOutcome } from './tax-non-success-outcome.ts';
import { TaxOutcomeSuccessSchema } from './tax-outcome.ts';
import type { TaxOutcome, TaxOutcomeSuccess } from './tax-outcome.ts';
import { composeTaxResult } from './tax-result.ts';
import { LAUNCH_CZK_TAX_ROUNDING_POLICY } from './tax-rounding.ts';
import type { TaxEvaluationTime } from '../../shared/domain/tax-kernel/tax-time.ts';
import { lineTaxableBasisForOccurrence } from './taxable-basis.ts';
import { mapTaxableSupplyUnits } from './taxable-supply-unit.ts';
import type { OccurrenceSupplyMeaning, TaxableSupplyUnit, TaxableSupplyUnitId } from './taxable-supply-unit.ts';

/** Complete owner rule state for one decisive predicate as returned by the TAX applicable-rule-set read (#942 F9-F15). */
export interface TaxRuleSetObservation {
  readonly applicable: readonly Readonly<{
    ratePercent: string;
    revisionNumber: number;
    taxRuleId: string;
    treatmentCategory: 'TAXABLE';
  }>[];
  readonly outcome:
    | 'SELECTED'
    | 'TAX_RULE_MISSING'
    | 'TAX_RULE_OVERLAP'
    | 'TAX_RULE_CONFLICT'
    | 'TAX_STATE_INDETERMINATE';
}

/**
 * TAX's own state used by one evaluation attempt: Seller VAT Regime selection at the Tax-Relevant Time and the
 * complete applicable rule set per classification code at Tax-Relevant Time. `ruleSets` is empty for a NON_PAYER
 * seller, which makes no rule reads (#942 F5, F9-F21; Unit 10 A4).
 */
export interface TaxEvaluationOwnState {
  readonly ruleSets: ReadonlyMap<string, TaxRuleSetObservation>;
  readonly sellerVatRegime: SellerVatRegimeSelection;
}

/** Deterministic fingerprint of a canonical meaning; injected so this kernel stays free of platform hashing. */
export type TaxMeaningFingerprint = <Meaning extends object>(meaning: Meaning) => string;

type Evaluated<Value> = Result.Result<Value, TaxNonSuccessOutcome>;

const byOccurrenceId = Order.mapInput(Order.String, ({ occurrenceId }: PurchaseDemandOccurrence) => occurrenceId);
const indeterminate = (): Evaluated<never> => Result.fail(TaxStateIndeterminateSchema.make({}));
const isUnsupported = Schema.is(TaxCaseUnsupportedSchema);
const isDeclaredSellerVatRegime = Schema.is(SellerVatRegimeDeclaredSchema);

const supplyMeaningOf = (
  request: TaxEvaluationRequest,
  occurrence: PurchaseDemandOccurrence,
): OccurrenceSupplyMeaning =>
  pipe(
    Option.fromUndefinedOr(
      request.setSupplyMeanings?.find(({ occurrenceId }) => occurrenceId === occurrence.occurrenceId),
    ),
    Option.match({
      onNone: (): OccurrenceSupplyMeaning => ({ _tag: 'ORDINARY', occurrence }),
      onSome: ({ meaning }): OccurrenceSupplyMeaning => ({ _tag: meaning, occurrence }),
    }),
  );

/** Classification of one occurrence under the Launch interpretation (PO decision D9 default). */
const classifyOccurrence = (
  request: TaxEvaluationRequest,
  occurrence: PurchaseDemandOccurrence,
): Evaluated<TaxClassification> => {
  const entry = request.catalog.find(({ occurrenceId }) => occurrenceId === occurrence.occurrenceId);
  return entry === undefined
    ? indeterminate()
    : classifyCatalogSelection(entry.classificationInput, launchTaxClassificationInterpretation);
};

/**
 * Distinct classification codes whose complete rule sets the evaluation needs, in canonical order. Occurrences that
 * cannot be classified contribute nothing; the evaluation reports their non-success itself.
 */
export const requiredTaxClassificationCodes = (request: TaxEvaluationRequest): readonly string[] =>
  [
    ...new Set(
      request.purchase.purchaseDemandOccurrences.flatMap((occurrence) =>
        pipe(
          classifyOccurrence(request, occurrence),
          Result.match({ onFailure: () => [], onSuccess: ({ classificationCode }) => [classificationCode] }),
        ),
      ),
    ),
  ].toSorted(Order.String);

type ApplicableRule = TaxRuleSetObservation['applicable'][number];

/** The one applicable revision, or the rule set's own typed non-success; a read that was not made is indeterminate. */
const governingRule = (
  ownState: TaxEvaluationOwnState,
  classification: TaxClassification,
): Evaluated<ApplicableRule> => {
  const observation = ownState.ruleSets.get(classification.classificationCode);
  if (observation === undefined) {
    return indeterminate();
  }
  if (observation.outcome !== 'SELECTED') {
    return Result.fail({ _tag: observation.outcome });
  }
  const [only] = observation.applicable;
  return only === undefined || observation.applicable.length !== 1 ? indeterminate() : Result.succeed(only);
};

interface UnitMeaning {
  readonly classification: TaxClassification;
  readonly lineComponent: TaxDecisionUnit['taxableBasisInterpretation']['components'][number];
  readonly rule: ApplicableRule;
  readonly unit: TaxableSupplyUnit;
}

const classifiedUnitMeaning = (
  ownState: TaxEvaluationOwnState,
  unit: TaxableSupplyUnit,
  lineComponent: UnitMeaning['lineComponent'],
  classification: TaxClassification,
): Evaluated<UnitMeaning> =>
  pipe(
    governingRule(ownState, classification),
    Result.map((rule) => ({ classification, lineComponent, rule, unit })),
  );

/** Published line, classification and governing rule of one unit, in that order. */
const unitMeaning = (
  request: TaxEvaluationRequest,
  ownState: TaxEvaluationOwnState,
  unit: TaxableSupplyUnit,
): Evaluated<UnitMeaning> => {
  const occurrence = request.purchase.purchaseDemandOccurrences.find(
    ({ occurrenceId }) => occurrenceId === unit.mapping.occurrenceId,
  );
  if (occurrence === undefined) {
    return indeterminate();
  }
  return pipe(
    lineTaxableBasisForOccurrence(request.pricing.publishedLines, occurrence.occurrenceId),
    Result.flatMap(({ basisComponent }) =>
      pipe(
        classifyOccurrence(request, occurrence),
        Result.flatMap((classification) => classifiedUnitMeaning(ownState, unit, basisComponent, classification)),
      ),
    ),
  );
};

interface NonPayerUnitMeaning {
  readonly lineComponent: UnitMeaning['lineComponent'];
  readonly unit: TaxableSupplyUnit;
}

/**
 * Published line only, for a NON_PAYER seller: no classification and no governing rule are read; Catalog
 * classification evidence is ignored (Unit 10 A4, F14).
 */
const nonPayerUnitMeaning = (
  request: TaxEvaluationRequest,
  unit: TaxableSupplyUnit,
): Evaluated<NonPayerUnitMeaning> => {
  const occurrence = request.purchase.purchaseDemandOccurrences.find(
    ({ occurrenceId }) => occurrenceId === unit.mapping.occurrenceId,
  );
  if (occurrence === undefined) {
    return indeterminate();
  }
  return pipe(
    lineTaxableBasisForOccurrence(request.pricing.publishedLines, occurrence.occurrenceId),
    Result.map(({ basisComponent }) => ({ lineComponent: basisComponent, unit })),
  );
};

/** TAX's own unit identities of the given occurrences; the caller never mints them. */
const unitIdsOf = (
  units: NonEmptyReadonlyArray<TaxableSupplyUnit>,
  occurrenceIds: NonEmptyReadonlyArray<string>,
): Option.Option<NonEmptyReadonlyArray<TaxableSupplyUnitId>> => {
  const byOccurrence = new Map<string, TaxableSupplyUnitId>(
    units.map(({ mapping, unitId }) => [mapping.occurrenceId, unitId]),
  );
  return Option.all(
    pipe(
      occurrenceIds,
      Arr.map((occurrenceId) => Option.fromUndefinedOr(byOccurrence.get(occurrenceId))),
    ),
  );
};

/** Occurrence-keyed Shipping evidence restated in TAX unit identities (#933 F12-F18, PO decision D3 default). */
const shippingAllocationInput = (
  shipping: NonNullable<TaxEvaluationRequest['shipping']>,
  units: NonEmptyReadonlyArray<TaxableSupplyUnit>,
): Option.Option<ShippingAllocationInput> =>
  Option.flatMap(unitIdsOf(units, shipping.affectedOccurrenceIds), (affectedTaxableSupplyUnitIds) => {
    const weights = shipping.allocationWeights;
    if (weights === undefined) {
      return Option.some({ affectedTaxableSupplyUnitIds, shippingSource: shipping.source });
    }
    return Option.map(
      unitIdsOf(
        units,
        pipe(
          weights.weights,
          Arr.map(({ occurrenceId }) => occurrenceId),
        ),
      ),
      (weightedUnitIds) => ({
        affectedTaxableSupplyUnitIds,
        allocationWeights: {
          approvalEvidenceRef: weights.approvalEvidenceRef,
          weights: pipe(
            weightedUnitIds,
            Arr.zipWith(weights.weights, (taxableSupplyUnitId, { weight }) => ({ taxableSupplyUnitId, weight })),
          ),
        },
        shippingSource: shipping.source,
      }),
    );
  });

/** Owner-issued Shipping allocated into the Taxable Supply Units of the affected occurrences (#933 F12-F24). */
const shippingAllocationOf = (
  request: TaxEvaluationRequest,
  units: NonEmptyReadonlyArray<TaxableSupplyUnit>,
): Evaluated<Option.Option<ShippingAllocation>> => {
  const { shipping } = request;
  if (shipping === undefined) {
    return Result.succeed(Option.none());
  }
  return Option.match(shippingAllocationInput(shipping, units), {
    onNone: indeterminate,
    onSome: (input) => Result.map(allocateShippingTaxableBasis(input), Option.some),
  });
};

const taxableDecisionUnitOf = (
  meaning: UnitMeaning,
  jurisdiction: TaxJurisdictionDetermination,
  allocation: Option.Option<ShippingAllocation>,
): TaxableDecisionUnit => ({
  applicability: 'APPLICABLE',
  governingTaxRuleRevisionRef: {
    revision: meaning.rule.revisionNumber,
    taxRuleId: TaxRuleIdSchema.make(meaning.rule.taxRuleId),
  },
  jurisdiction,
  taxableBasisInterpretation: {
    components: [
      meaning.lineComponent,
      ...Option.match(allocation, {
        onNone: () => [],
        onSome: ({ unitAllocations }) =>
          unitAllocations.flatMap(({ basisComponent, taxableSupplyUnitId }) =>
            taxableSupplyUnitId === meaning.unit.unitId ? [basisComponent] : [],
          ),
      }),
    ],
  },
  taxableSupplyUnit: meaning.unit,
  taxClassification: meaning.classification,
  treatment: { _tag: 'TAXABLE', ratePercent: meaning.rule.ratePercent },
});

/**
 * NON_PAYER unit: the published line only, no classification, no governing rule, no shipping allocation (shipping
 * evidence is ignored for this treatment, not an error) (Unit 10 A4, F14).
 */
const nonPayerDecisionUnitOf = (
  meaning: NonPayerUnitMeaning,
  jurisdiction: TaxJurisdictionDetermination,
  declarationRevisionRef: SellerVatRegimeDeclarationRevisionRef,
): SellerNotVatPayerDecisionUnit => ({
  applicability: 'APPLICABLE',
  governingReference: {
    declarationRevisionRef,
    legalBasis: SELLER_NOT_VAT_PAYER_LEGAL_BASIS,
  },
  jurisdiction,
  taxableBasisInterpretation: { components: [meaning.lineComponent] },
  taxableSupplyUnit: meaning.unit,
  treatment: { _tag: 'SELLER_NOT_VAT_PAYER' },
});

const encodeDecision = Schema.encodeResult(TaxDecisionSchema);
/** Exact code-unit order: locale collation can rank distinct identifiers as equal, so it never orders identities. */
const byText = Order.String;

/**
 * Canonical material meaning of a Decision: purchase binding without traceability-only context, Tax-Relevant Time,
 * the Shipping allocation and every unit, each in identity order. Tax Evaluation Time is provenance and the Decision
 * identity is the output, so neither is part of it (#936 F58, #937 F7, F33-F38, #942 F23).
 */
export const taxDecisionMeaningFingerprint = (decision: TaxDecision, fingerprint: TaxMeaningFingerprint): string => {
  const { declarationRevisionRef, purchaseBinding, sellerVatRegime, shippingAllocation, taxRelevantTime, units } =
    Result.getOrThrow(encodeDecision(decision));
  const { traceabilityContext: _traceability, ...binding } = purchaseBinding;
  return fingerprint({
    declarationRevisionRef,
    purchaseBinding: {
      ...binding,
      purchaseDemandOccurrences: binding.purchaseDemandOccurrences.toSorted((left, right) =>
        byText(left.occurrenceId, right.occurrenceId),
      ),
    },
    sellerVatRegime,
    shippingAllocation:
      shippingAllocation === undefined
        ? null
        : {
            ...shippingAllocation,
            unitAllocations: shippingAllocation.unitAllocations.toSorted((left, right) =>
              byText(left.taxableSupplyUnitId, right.taxableSupplyUnitId),
            ),
          },
    taxRelevantTime,
    units: units
      .toSorted((left, right) => byText(left.taxableSupplyUnit.unitId, right.taxableSupplyUnit.unitId))
      .map((unit) =>
        'taxClassification' in unit
          ? {
              ...unit,
              taxClassification: {
                ...unit.taxClassification,
                // A set of owner facts: their array position is not part of the Decision identity (#937 F7).
                materialCatalogEvidence: unit.taxClassification.materialCatalogEvidence.toSorted((left, right) =>
                  byText(left.catalogFactRef, right.catalogFactRef),
                ),
              },
            }
          : unit,
      ),
  });
};

/** Deterministic Decision identity from its material meaning (#942 F23, #936 F58). */
export const taxDecisionIdFor = (decision: TaxDecision, fingerprint: TaxMeaningFingerprint) =>
  TaxDecisionIdSchema.make(`tax-decision:${taxDecisionMeaningFingerprint(decision, fingerprint)}`);

const isTaxDecision = Schema.is(TaxDecisionSchema);
const isTaxOutcomeSuccess = Schema.is(TaxOutcomeSuccessSchema);

interface EvaluationOptions {
  readonly fingerprint: TaxMeaningFingerprint;
  readonly taxEvaluationTime: TaxEvaluationTime;
}

/** Decision and Result published only when both satisfy every kernel invariant; otherwise nothing is guessed. */
const publish = (
  request: TaxEvaluationRequest,
  sellerVatRegime: SellerVatRegimeSelection & { readonly _tag: 'DECLARED' },
  units: NonEmptyReadonlyArray<TaxDecisionUnit>,
  allocation: Option.Option<ShippingAllocation>,
  options: EvaluationOptions,
): Evaluated<TaxOutcomeSuccess> => {
  const base = {
    decisionId: TaxDecisionIdSchema.make('tax-decision:pending'),
    declarationRevisionRef: sellerVatRegime.declarationRevisionRef,
    purchaseBinding: request.purchase,
    sellerVatRegime: sellerVatRegime.regime,
    taxEvaluationTime: options.taxEvaluationTime,
    taxRelevantTime: request.taxRelevantTime,
    units,
  };
  const draft: TaxDecision = Option.match(allocation, {
    onNone: () => base,
    onSome: (shippingAllocation) => ({ ...base, shippingAllocation }),
  });
  if (!isTaxDecision(draft)) {
    return indeterminate();
  }
  const decision = { ...draft, decisionId: taxDecisionIdFor(draft, options.fingerprint) };
  const success = {
    _tag: 'TAX_DETERMINED' as const,
    decision,
    result: composeTaxResult(decision, LAUNCH_CZK_TAX_ROUNDING_POLICY),
  };
  return isTaxOutcomeSuccess(success) ? Result.succeed(success) : indeterminate();
};

type EvaluationFailure = TaxNonSuccessOutcome | LaunchTaxCoverageFailure;
type AnyEvaluated = Result.Result<unknown, EvaluationFailure>;

const isSellerVatRegimeNotDeclared = Schema.is(SellerVatRegimeNotDeclaredSchema);

/** The published outcome never carries the internal `reason`; only `notDeterminedBecause` reports it. */
const strippedOutcome = (failure: EvaluationFailure): TaxNonSuccessOutcome =>
  isSellerVatRegimeNotDeclared(failure) ? { _tag: 'TAX_STATE_INDETERMINATE' } : failure;

/**
 * The reported non-success of a purchase: an unsupported requirement anywhere in it wins, because unsupported scope is
 * decided before prerequisites, configuration and input currentness (#938 F3, F7, F16); otherwise the first failure in
 * evaluation order. Every part is evaluated, so one unit's rule configuration never masks another unit's scope.
 */
const reportedFailure = (parts: readonly AnyEvaluated[]): Option.Option<EvaluationFailure> => {
  const failures = parts.flatMap((part) => (Result.isFailure(part) ? [part.failure] : []));
  return Option.fromUndefinedOr(failures.find(isUnsupported) ?? failures[0]);
};

/** The result of one evaluation attempt, carrying the internal indeterminate reason apart from the outcome. */
export interface TaxEvaluationVerdict {
  readonly notDeterminedBecause: Option.Option<'SELLER_VAT_REGIME_NOT_DECLARED'>;
  readonly outcome: TaxOutcome;
}

/**
 * Prospective Launch Tax evaluation of one structurally bound request over one coherent TAX own state (#942, #937,
 * #941 F6). Evaluated parts, in order: place jurisdiction (scope is decided before the seller prerequisite,
 * #938 F7), Launch coverage (currency, regime, supply mapping, seller declaration), then per unit in canonical order
 * the published line and, for a VAT_PAYER seller only, the classification and the complete applicable rule set, then
 * Shipping allocation (ignored, not an error, for a NON_PAYER seller). Any failure is the typed non-success chosen by
 * `reportedFailure`; success is a Decision with its Result under the Launch rounding policy (#936, #935; Unit 10 A4).
 */
export const evaluateProspectiveLaunchTax = (
  request: TaxEvaluationRequest,
  ownState: TaxEvaluationOwnState,
  options: EvaluationOptions,
): TaxEvaluationVerdict => {
  const supplyMeanings = pipe(
    Arr.sort(request.purchase.purchaseDemandOccurrences, byOccurrenceId),
    Arr.map((occurrence) => supplyMeaningOf(request, occurrence)),
  );
  const coverage = evaluateLaunchTaxCoverage({
    currency: request.purchase.currency,
    requiredTaxRegimes: ['ORDINARY_DOMESTIC'],
    requiredTaxTreatments: ['TAXABLE'],
    sellerVatRegime: ownState.sellerVatRegime,
    supplyMeanings,
  });
  const jurisdiction = determineTaxJurisdiction(request.places);
  const units = mapTaxableSupplyUnits(supplyMeanings);
  const declaredSellerVatRegime = isDeclaredSellerVatRegime(ownState.sellerVatRegime)
    ? ownState.sellerVatRegime
    : undefined;
  const isVatPayer = declaredSellerVatRegime?.regime === 'VAT_PAYER';
  const taxableMeanings: readonly Evaluated<UnitMeaning>[] =
    isVatPayer && Result.isSuccess(units)
      ? pipe(
          units.success,
          Arr.map((unit) => unitMeaning(request, ownState, unit)),
        )
      : [];
  const nonPayerMeanings: readonly Evaluated<NonPayerUnitMeaning>[] =
    !isVatPayer && Result.isSuccess(units)
      ? pipe(
          units.success,
          Arr.map((unit) => nonPayerUnitMeaning(request, unit)),
        )
      : [];
  // NON_PAYER ignores Shipping evidence entirely; it is never allocated and never an error (Unit 10 A2, F14).
  const allocation: Evaluated<Option.Option<ShippingAllocation>> =
    isVatPayer && Result.isSuccess(units)
      ? shippingAllocationOf(request, units.success)
      : Result.succeed(Option.none());
  const parts: readonly AnyEvaluated[] = [jurisdiction, coverage, ...taxableMeanings, ...nonPayerMeanings, allocation];
  const verdictOf = (outcome: TaxOutcome, failure: Option.Option<EvaluationFailure>): TaxEvaluationVerdict => ({
    notDeterminedBecause: Option.match(failure, {
      onNone: (): Option.Option<'SELLER_VAT_REGIME_NOT_DECLARED'> => Option.none(),
      onSome: (reported): Option.Option<'SELLER_VAT_REGIME_NOT_DECLARED'> =>
        isSellerVatRegimeNotDeclared(reported) ? Option.some('SELLER_VAT_REGIME_NOT_DECLARED') : Option.none(),
    }),
    outcome,
  });
  const reported = reportedFailure(parts);
  const evaluated: Evaluated<TaxOutcomeSuccess> = Option.match(reported, {
    onNone: (): Evaluated<TaxOutcomeSuccess> =>
      pipe(
        Result.all({
          allocation,
          determination: jurisdiction,
          nonPayerUnitMeanings: Result.all(nonPayerMeanings),
          unitMeanings: Result.all(taxableMeanings),
        }),
        Result.flatMap(({ allocation: shipping, determination, nonPayerUnitMeanings, unitMeanings }) => {
          if (declaredSellerVatRegime === undefined) {
            return indeterminate();
          }
          const sellerVatRegime = declaredSellerVatRegime;
          const decisionUnits: readonly TaxDecisionUnit[] = isVatPayer
            ? unitMeanings.map((meaning) => taxableDecisionUnitOf(meaning, determination, shipping))
            : nonPayerUnitMeanings.map((meaning) =>
                nonPayerDecisionUnitOf(meaning, determination, sellerVatRegime.declarationRevisionRef),
              );
          const [first, ...rest] = decisionUnits;
          return first === undefined
            ? indeterminate()
            : publish(request, sellerVatRegime, [first, ...rest] as const, shipping, options);
        }),
      ),
    onSome: (failure): Evaluated<TaxOutcomeSuccess> => Result.fail(failure),
  });
  return Result.match(evaluated, {
    onFailure: (failure) => verdictOf(strippedOutcome(failure), reported),
    onSuccess: (success) => verdictOf(success, Option.none()),
  });
};
