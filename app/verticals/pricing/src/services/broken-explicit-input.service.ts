import type { CurrentSupportedCurrenciesSuccess } from '@app/pricing-contracts/current-supported-currencies';
import { CurrentSupportedCurrenciesSuccessSchema } from '@app/pricing-contracts/current-supported-currencies';
import type {
  PricingExplicitConfigurationReason,
  PricingExplicitIndeterminateReason,
  PricingExplicitInputContext,
  PricingExplicitInputDependencyOwner,
  PricingExplicitInputEvaluationRequest,
  PricingExplicitInputEvaluationResult,
  PricingExplicitInputSubject,
} from '@app/pricing-contracts/domain/broken-explicit-input';
import { PricingExplicitInputContextSchema } from '@app/pricing-contracts/domain/broken-explicit-input';
import type { ExactPriceResolutionInput } from '@app/pricing-contracts/domain/exact-price-resolution';
import { ExactPriceResolutionInputSchema } from '@app/pricing-contracts/domain/exact-price-resolution';
import type { PriceIdentityKey } from '@app/pricing-contracts/domain/price-definition';
import { PriceIdentityKeySchema } from '@app/pricing-contracts/domain/price-definition';
import type { PriceGroupFallbackResolutionInput } from '@app/pricing-contracts/domain/price-group-fallback';
import type { PriceSourceAssertionAssessment } from '@app/pricing-contracts/domain/price-source-provenance';
import type { PricingQuantityBasisAssessment } from '@app/pricing-contracts/domain/quantity-unit-package-basis';
import { Context, DateTime, Effect, Match, Option, Schema } from 'effect';

export interface BrokenExplicitInputTrustedContext {
  readonly legalEntityId: string;
  readonly tenantId: string;
  readonly trustedOperationAt: DateTime.Utc;
}

/**
 * Owner-local acquisition only. Implementations resolve observations from trusted owner clients and
 * scoped persistence; caller-supplied evidence must never implement this port.
 */
export interface BrokenExplicitInputObservationPort {
  readonly acquire: (
    context: PricingExplicitInputContext,
    trusted: BrokenExplicitInputTrustedContext,
  ) => Effect.Effect<PricingExplicitInputEvaluationRequest>;
}

class BrokenExplicitInputObservations extends Context.Service<
  BrokenExplicitInputObservations,
  BrokenExplicitInputObservationPort
>()('@app/pricing/services/broken-explicit-input.service/BrokenExplicitInputObservations') {}

export interface BrokenExplicitInputValidationService {
  readonly evaluate: (
    context: PricingExplicitInputContext,
    trusted: BrokenExplicitInputTrustedContext,
  ) => Effect.Effect<PricingExplicitInputEvaluationResult>;
}

class BrokenExplicitInputValidator extends Context.Service<
  BrokenExplicitInputValidator,
  BrokenExplicitInputValidationService
>()('@app/pricing/services/broken-explicit-input.service/BrokenExplicitInputValidator') {}

const exactKeyEquivalence = Schema.toEquivalence(PriceIdentityKeySchema);
const contextEquivalence = Schema.toEquivalence(PricingExplicitInputContextSchema);

interface Terminal {
  readonly kind: 'RESULT';
  readonly result: PricingExplicitInputEvaluationResult;
}
type Checked<A> =
  | Terminal
  | {
      readonly kind: 'VALUE';
      readonly value: A;
    };

const checkedResult = (result: PricingExplicitInputEvaluationResult): Terminal => ({
  kind: 'RESULT',
  result,
});
const checkedValue = <A>(value: A): Checked<A> => ({ kind: 'VALUE', value });

const uniqueRefs = (references: readonly (string | undefined)[]): readonly string[] => [
  ...new Set(references.filter((reference): reference is string => reference !== undefined)),
];

const knownInvalid = (
  context: PricingExplicitInputContext,
  subject: PricingExplicitInputSubject,
  reason: PricingExplicitConfigurationReason,
  evidenceRefs: readonly (string | undefined)[] = [],
): PricingExplicitInputEvaluationResult => ({
  _tag: 'KNOWN_INVALID',
  context,
  evidenceRefs: uniqueRefs(evidenceRefs),
  outcome: 'PRICING_CONFIGURATION_ERROR',
  reason,
  retryable: false,
  subject,
});

const indeterminate = (
  context: PricingExplicitInputContext,
  subject: PricingExplicitInputSubject,
  reason: PricingExplicitIndeterminateReason,
  requiredOwners: readonly PricingExplicitInputDependencyOwner[],
  evidenceRefs: readonly (string | undefined)[] = [],
): PricingExplicitInputEvaluationResult => ({
  _tag: 'INDETERMINATE',
  context,
  inabilityEvidence: {
    attempts: 1,
    evidenceRefs: uniqueRefs(evidenceRefs),
    requiredOwners: [...new Set(requiredOwners)],
  },
  outcome: 'PRICING_INDETERMINATE',
  reason,
  retryable: true,
  subject,
});

const canonicalCurrencySupport = (
  support: PricingExplicitInputEvaluationRequest['currencySupport'],
): CurrentSupportedCurrenciesSuccess | undefined => {
  const decoded = Schema.decodeUnknownOption(CurrentSupportedCurrenciesSuccessSchema, {
    onExcessProperty: 'error',
  })(support);
  return Option.isSome(decoded) ? decoded.value : undefined;
};

const currencySupportEvidenceRefs = (support: CurrentSupportedCurrenciesSuccess): readonly string[] =>
  uniqueRefs([
    support.supportRootRef.resourceId,
    support.supportRevisionRef.resourceId,
    support.pricingRevision,
    support.completenessEvidence.ownerRevision,
  ]);

const classifyNonCurrentCurrencySupport = (request: PricingExplicitInputEvaluationRequest): Terminal | undefined => {
  const { context, currencySupport } = request;
  if (currencySupport === undefined) {
    return checkedResult(
      indeterminate(context, 'CURRENCY_SUPPORT', 'CURRENCY_SUPPORT_UNVERIFIABLE', ['PRICING_CURRENCY_SUPPORT']),
    );
  }
  if (currencySupport.outcome === 'SUPPORTED_CURRENCIES_INVALID') {
    if (currencySupport.code === 'pricing_currency_support_revision_conflict') {
      const refs = request.currencySupportConflictRefs;
      return checkedResult(
        refs === undefined
          ? indeterminate(
              context,
              'CURRENCY_SUPPORT',
              'SET_COMPLETENESS_UNVERIFIABLE',
              ['PRICING_CURRENCY_SUPPORT'],
              [currencySupport.code],
            )
          : {
              _tag: 'CONFLICT',
              context,
              currentTruthRefs: refs,
              outcome: 'PRICING_CONFLICT',
              reason: 'COMPETING_CURRENT_CURRENCY_SUPPORT',
              retryable: false,
              subject: 'CURRENCY_SUPPORT',
            },
      );
    }
    return checkedResult(
      knownInvalid(context, 'CURRENCY_SUPPORT', 'INVALID_CANONICAL_CONFIGURATION', [currencySupport.code]),
    );
  }
  if (currencySupport.outcome === 'SUPPORTED_CURRENCIES_UNAVAILABLE') {
    return checkedResult(
      indeterminate(
        context,
        'CURRENCY_SUPPORT',
        'CURRENCY_SUPPORT_UNAVAILABLE',
        ['PRICING_CURRENCY_SUPPORT'],
        [currencySupport.code],
      ),
    );
  }
  if (currencySupport.outcome === 'SUPPORTED_CURRENCIES_UNVERIFIABLE') {
    return checkedResult(
      indeterminate(
        context,
        'CURRENCY_SUPPORT',
        'CURRENCY_SUPPORT_UNVERIFIABLE',
        ['PRICING_CURRENCY_SUPPORT'],
        [currencySupport.code],
      ),
    );
  }
  if (currencySupport.outcome === 'SUPPORTED_CURRENCIES_STALE') {
    if (currencySupport.observedAt > context.effectiveAt) {
      return checkedResult({
        _tag: 'STALE',
        context,
        outcome: 'PRICING_STALE',
        reason: 'APPLICABILITY_BOUNDARY_CROSSED',
        retryable: true,
        staleEvidence: {
          assessedAt: context.effectiveAt,
          invalidatedAt: currencySupport.observedAt,
          invalidatedRevision: currencySupport.pricingRevision ?? currencySupport.code,
        },
        subject: 'CURRENCY_SUPPORT',
      });
    }
    return checkedResult(
      indeterminate(
        context,
        'CURRENCY_SUPPORT',
        'CURRENTNESS_UNVERIFIABLE',
        ['PRICING_CURRENCY_SUPPORT'],
        [currencySupport.code, currencySupport.pricingRevision],
      ),
    );
  }
  return undefined;
};

const classifyCurrencySupport = (
  request: PricingExplicitInputEvaluationRequest,
): Checked<CurrentSupportedCurrenciesSuccess> => {
  const terminal = classifyNonCurrentCurrencySupport(request);
  if (terminal !== undefined) {
    return terminal;
  }
  const { context, currencySupport } = request;

  const current = canonicalCurrencySupport(currencySupport);
  if (current === undefined) {
    return checkedResult(
      indeterminate(context, 'CURRENCY_SUPPORT', 'CURRENCY_SUPPORT_UNVERIFIABLE', ['PRICING_CURRENCY_SUPPORT'], []),
    );
  }
  const references = currencySupportEvidenceRefs(current);
  if (current.tenantId !== context.tenantId) {
    return checkedResult(
      indeterminate(
        context,
        'CURRENCY_SUPPORT',
        'CURRENCY_SUPPORT_UNVERIFIABLE',
        ['PRICING_CURRENCY_SUPPORT'],
        references,
      ),
    );
  }
  if (current.effectiveAt !== context.effectiveAt) {
    const crossedBoundary =
      (current.effectivePeriod.effectiveTo !== null &&
        current.effectivePeriod.effectiveTo <= context.effectiveAt &&
        current.effectivePeriod.effectiveTo > current.effectiveAt) ||
      (current.nextApplicabilityBoundary !== undefined &&
        current.nextApplicabilityBoundary <= context.effectiveAt &&
        current.nextApplicabilityBoundary > current.effectiveAt);
    const invalidatedAt = current.effectivePeriod.effectiveTo ?? current.nextApplicabilityBoundary;
    return checkedResult(
      crossedBoundary && invalidatedAt !== undefined
        ? {
            _tag: 'STALE',
            context,
            outcome: 'PRICING_STALE',
            reason: 'APPLICABILITY_BOUNDARY_CROSSED',
            retryable: true,
            staleEvidence: {
              assessedAt: current.effectiveAt,
              invalidatedAt,
              invalidatedRevision: current.pricingRevision,
            },
            subject: 'CURRENCY_SUPPORT',
          }
        : indeterminate(
            context,
            'CURRENCY_SUPPORT',
            'CURRENTNESS_UNVERIFIABLE',
            ['PRICING_CURRENCY_SUPPORT'],
            references,
          ),
    );
  }
  return current.supportedCurrencies.includes(context.requestedCurrencyCode)
    ? checkedValue(current)
    : checkedResult(knownInvalid(context, 'CURRENCY_SUPPORT', 'UNSUPPORTED_CURRENCY', references));
};

const groupBasis = (input: PriceGroupFallbackResolutionInput) =>
  Match.value(input).pipe(
    Match.tag('GUEST', ({ basis }) => basis),
    Match.tag('ASSIGNED', ({ interpretation }) => interpretation.basis),
    Match.tag('BLOCKED', ({ interpretation }) => interpretation.basis),
    Match.tag('OWNER_NONE', ({ interpretation }) => interpretation.basis),
    Match.exhaustive,
  );

export const exactPriceIdentityKeyFromResolutionInput = (
  input: Exclude<PriceGroupFallbackResolutionInput, { readonly _tag: 'BLOCKED' }>,
): PriceIdentityKey => {
  const basis = groupBasis(input);
  const priceGroupSelector = Match.value(input).pipe(
    Match.tag('ASSIGNED', ({ interpretation }) => ({
      kind: 'PRICE_GROUP' as const,
      priceGroupRef: interpretation.priceGroupRef,
    })),
    Match.tag('GUEST', () => ({ kind: 'NO_GROUP' as const })),
    Match.tag('OWNER_NONE', () => ({ kind: 'NO_GROUP' as const })),
    Match.exhaustive,
  );
  return { ...basis, priceGroupSelector };
};

const classifyBlockedGroup = (
  request: PricingExplicitInputEvaluationRequest,
  input: Extract<PriceGroupFallbackResolutionInput, { readonly _tag: 'BLOCKED' }>,
): PricingExplicitInputEvaluationResult =>
  Match.value(input.interpretation).pipe(
    Match.tag('BROKEN', ({ assignmentResolution }) =>
      knownInvalid(request.context, 'PRICE_GROUP_ASSIGNMENT', 'BROKEN_PRICE_GROUP_ASSIGNMENT', [
        assignmentResolution.assignmentRef.resourceId,
        assignmentResolution.priceGroupRef.resourceId,
      ]),
    ),
    Match.tag('INCONSISTENT', () => {
      const refs = request.priceGroupConflictRefs;
      return refs === undefined
        ? indeterminate(request.context, 'PRICE_GROUP_ASSIGNMENT', 'SET_COMPLETENESS_UNVERIFIABLE', [
            'COMMERCE_CUSTOMER_CONTEXT',
          ])
        : {
            _tag: 'CONFLICT' as const,
            context: request.context,
            currentTruthRefs: refs,
            outcome: 'PRICING_CONFLICT' as const,
            reason: 'INCONSISTENT_PRICE_GROUP_ASSIGNMENT' as const,
            retryable: false as const,
            subject: 'PRICE_GROUP_ASSIGNMENT' as const,
          };
    }),
    Match.tag('UNAVAILABLE', ({ owner }) =>
      indeterminate(
        request.context,
        owner === 'COMMERCE_ASSIGNMENT' ? 'PRICE_GROUP_ASSIGNMENT' : 'PRICE_GROUP_DEFINITION',
        'PRICE_GROUP_OWNER_UNAVAILABLE',
        [owner === 'COMMERCE_ASSIGNMENT' ? 'COMMERCE_CUSTOMER_CONTEXT' : 'PRICE_GROUP_CATALOG'],
        [],
      ),
    ),
    Match.tag('UNVERIFIABLE', ({ owner }) =>
      indeterminate(
        request.context,
        owner === 'COMMERCE_ASSIGNMENT' ? 'PRICE_GROUP_ASSIGNMENT' : 'PRICE_GROUP_DEFINITION',
        'PRICE_GROUP_OWNER_UNVERIFIABLE',
        [owner === 'COMMERCE_ASSIGNMENT' ? 'COMMERCE_CUSTOMER_CONTEXT' : 'PRICE_GROUP_CATALOG'],
        [],
      ),
    ),
    Match.exhaustive,
  );

const classifyPriceGroup = (
  request: PricingExplicitInputEvaluationRequest,
): Checked<PriceGroupFallbackResolutionInput> => {
  const { context, priceGroupResolutionInput } = request;
  if (priceGroupResolutionInput === undefined) {
    return checkedResult(
      indeterminate(context, 'PRICE_GROUP_ASSIGNMENT', 'PRICE_GROUP_OWNER_UNVERIFIABLE', [
        'COMMERCE_CUSTOMER_CONTEXT',
        'PRICE_GROUP_CATALOG',
      ]),
    );
  }

  return Match.value(priceGroupResolutionInput).pipe(
    Match.tag('BLOCKED', (input) => checkedResult(classifyBlockedGroup(request, input))),
    Match.tag('OWNER_NONE', (input) => {
      if (context.exactKey === undefined) {
        return checkedResult({
          _tag: 'LEGITIMATE_GROUP_ABSENCE',
          context,
          continuation: 'TRY_EXACT_NO_GROUP_PRICE',
          ownerResolution: input.ownerResolution,
        });
      }
      return input.effectiveAt === context.effectiveAt &&
        exactKeyEquivalence(context.exactKey, exactPriceIdentityKeyFromResolutionInput(input))
        ? checkedValue(input)
        : checkedResult(
            input.effectiveAt === context.effectiveAt
              ? knownInvalid(context, 'EXACT_PRICE', 'INVALID_CANONICAL_CONFIGURATION')
              : indeterminate(context, 'PRICE_GROUP_ASSIGNMENT', 'CURRENTNESS_UNVERIFIABLE', [
                  'COMMERCE_CUSTOMER_CONTEXT',
                  'PRICE_GROUP_CATALOG',
                ]),
          );
    }),
    Match.tag('GUEST', (input) => {
      if (context.exactKey === undefined) {
        return checkedResult(knownInvalid(context, 'CATALOG_SELECTION', 'MISSING_EXACT_VARIANT'));
      }
      return input.effectiveAt === context.effectiveAt &&
        exactKeyEquivalence(context.exactKey, exactPriceIdentityKeyFromResolutionInput(input))
        ? checkedValue(input)
        : checkedResult(
            input.effectiveAt === context.effectiveAt
              ? knownInvalid(context, 'EXACT_PRICE', 'INVALID_CANONICAL_CONFIGURATION')
              : indeterminate(context, 'PRICE_GROUP_ASSIGNMENT', 'CURRENTNESS_UNVERIFIABLE', [
                  'COMMERCE_CUSTOMER_CONTEXT',
                  'PRICE_GROUP_CATALOG',
                ]),
          );
    }),
    Match.tag('ASSIGNED', (input) => {
      if (context.exactKey === undefined) {
        return checkedResult(knownInvalid(context, 'CATALOG_SELECTION', 'MISSING_EXACT_VARIANT'));
      }
      if (input.effectiveAt === context.effectiveAt) {
        return exactKeyEquivalence(context.exactKey, exactPriceIdentityKeyFromResolutionInput(input))
          ? checkedValue(input)
          : checkedResult(knownInvalid(context, 'EXACT_PRICE', 'INVALID_CANONICAL_CONFIGURATION'));
      }
      const { assignmentResolution } = input.interpretation;
      const { effectiveTo } = assignmentResolution;
      return effectiveTo !== null && effectiveTo <= context.effectiveAt && effectiveTo > input.effectiveAt
        ? checkedResult({
            _tag: 'STALE',
            context,
            outcome: 'PRICING_STALE',
            reason: 'MATERIAL_INPUT_CHANGED',
            retryable: true,
            staleEvidence: {
              assessedAt: input.effectiveAt,
              invalidatedAt: effectiveTo,
              invalidatedRevision: String(assignmentResolution.assignmentRevision),
            },
            subject: 'PRICE_GROUP_ASSIGNMENT',
          })
        : checkedResult(
            indeterminate(context, 'PRICE_GROUP_ASSIGNMENT', 'CURRENTNESS_UNVERIFIABLE', [
              'COMMERCE_CUSTOMER_CONTEXT',
              'PRICE_GROUP_CATALOG',
            ]),
          );
    }),
    Match.exhaustive,
  );
};

const classifyQuantityBasis = (
  context: PricingExplicitInputContext,
  assessment: PricingQuantityBasisAssessment | undefined,
): Checked<PricingQuantityBasisAssessment> => {
  if (assessment === undefined) {
    return checkedResult(indeterminate(context, 'QUANTITY_BASIS', 'QUANTITY_BASIS_UNVERIFIABLE', ['CATALOG']));
  }
  if (assessment.outcome === 'INCOMPATIBLE') {
    return checkedResult(knownInvalid(context, 'QUANTITY_BASIS', 'INCOMPATIBLE_QUANTITY_UNIT'));
  }
  if (assessment.outcome === 'INVALID') {
    return checkedResult(knownInvalid(context, 'QUANTITY_BASIS', 'INCOMPATIBLE_PRICING_BASIS'));
  }
  if (assessment.outcome === 'UNAVAILABLE') {
    return checkedResult(indeterminate(context, 'QUANTITY_BASIS', 'QUANTITY_BASIS_UNAVAILABLE', ['CATALOG']));
  }
  if (assessment.outcome === 'UNVERIFIABLE') {
    return checkedResult(indeterminate(context, 'QUANTITY_BASIS', 'QUANTITY_BASIS_UNVERIFIABLE', ['CATALOG']));
  }
  const { attempt } = assessment;
  if (context.exactKey === undefined || !exactKeyEquivalence(context.exactKey, attempt.price.identityKey)) {
    return checkedResult(
      knownInvalid(context, 'QUANTITY_BASIS', 'INCOMPATIBLE_PRICING_BASIS', [
        attempt.catalog.ownerRevision,
        attempt.catalog.hierarchyRevision,
      ]),
    );
  }
  const { validUntil } = attempt.catalog.evidence;
  if (validUntil !== undefined && validUntil <= context.effectiveAt) {
    return checkedResult(
      validUntil > attempt.catalog.evidence.assessedAt
        ? {
            _tag: 'STALE',
            context,
            outcome: 'PRICING_STALE',
            reason: 'MATERIAL_INPUT_CHANGED',
            retryable: true,
            staleEvidence: {
              assessedAt: attempt.catalog.evidence.assessedAt,
              invalidatedAt: validUntil,
              invalidatedRevision: attempt.catalog.ownerRevision,
            },
            subject: 'CATALOG_SELECTION',
          }
        : indeterminate(
            context,
            'CATALOG_SELECTION',
            'CURRENTNESS_UNVERIFIABLE',
            ['CATALOG'],
            [attempt.catalog.ownerRevision],
          ),
    );
  }
  return checkedValue(assessment);
};

const sourceInvalidReason = (
  assessment: Extract<PriceSourceAssertionAssessment, { readonly outcome: 'PRICE_SOURCE_ASSERTION_KNOWN_INVALID' }>,
): readonly [PricingExplicitInputSubject, PricingExplicitConfigurationReason] =>
  Match.value(assessment.reason).pipe(
    Match.when('PRODUCT_ONLY_TARGET', () => ['CATALOG_SELECTION', 'PRODUCT_ONLY_PRICE_TARGET'] as const),
    Match.when('MARKET_MISSING', () => ['COMMERCIAL_SCOPE', 'MISSING_COMMERCE_MARKET'] as const),
    Match.when(
      'STOREFRONT_AS_PRICE_SELECTOR',
      () => ['COMMERCIAL_SCOPE', 'STOREFRONT_PRICE_SELECTOR_FORBIDDEN'] as const,
    ),
    Match.when('VARIANT_AMBIGUOUS', () => ['CATALOG_SELECTION', 'MISSING_EXACT_VARIANT'] as const),
    Match.when('UNIT_AMBIGUOUS', () => ['QUANTITY_BASIS', 'INCOMPATIBLE_QUANTITY_UNIT'] as const),
    Match.when('CURRENCY_MISMATCH', () => ['CURRENCY_SUPPORT', 'CROSS_CURRENCY_SUBSTITUTION_FORBIDDEN'] as const),
    Match.whenOr(
      'MAPPING_REJECTED',
      'SOURCE_AUTHORITY_REJECTED',
      () => ['SOURCE_ASSERTION', 'INVALID_CANONICAL_CONFIGURATION'] as const,
    ),
    Match.exhaustive,
  );

const sourceDependency = (
  assessment: Extract<
    PriceSourceAssertionAssessment,
    { readonly outcome: 'PRICE_SOURCE_ASSERTION_DEPENDENCY_UNAVAILABLE' }
  >,
): readonly [PricingExplicitInputSubject, PricingExplicitIndeterminateReason, PricingExplicitInputDependencyOwner] =>
  Match.value(assessment.dependency).pipe(
    Match.when('CATALOG', () => ['CATALOG_SELECTION', 'CATALOG_OWNER_UNAVAILABLE', 'CATALOG'] as const),
    Match.when(
      'COMMERCE_MARKET_CATALOG',
      () => ['COMMERCIAL_SCOPE', 'COMMERCIAL_SCOPE_UNAVAILABLE', 'COMMERCE_MARKET_CATALOG'] as const,
    ),
    Match.when(
      'CURRENCY_SUPPORT',
      () => ['CURRENCY_SUPPORT', 'CURRENCY_SUPPORT_UNAVAILABLE', 'PRICING_CURRENCY_SUPPORT'] as const,
    ),
    Match.whenOr(
      'MAPPING_REGISTRY',
      'PERSISTENCE',
      'SOURCE_AUTHORITY',
      () => ['SOURCE_ASSERTION', 'EXACT_PRICE_STATE_UNAVAILABLE', 'PRICING_SOURCE_PROVENANCE'] as const,
    ),
    Match.exhaustive,
  );

const classifySource = (
  context: PricingExplicitInputContext,
  assessment: PriceSourceAssertionAssessment | undefined,
): Checked<PriceSourceAssertionAssessment> => {
  if (assessment === undefined) {
    return checkedResult(
      indeterminate(context, 'SOURCE_ASSERTION', 'EXACT_PRICE_STATE_UNVERIFIABLE', ['PRICING_SOURCE_PROVENANCE']),
    );
  }
  if (assessment.outcome === 'PRICE_SOURCE_ASSERTION_UNRESOLVED_HELD') {
    return checkedResult({
      _tag: 'NON_CANONICAL_ASSERTION_HELD',
      assessment,
      context,
      outcome: 'PRICING_INDETERMINATE',
      reason: assessment.reason,
      retryable: true,
      subject: 'SOURCE_ASSERTION',
    });
  }
  if (assessment.outcome === 'PRICE_SOURCE_ASSERTION_KNOWN_INVALID') {
    const [subject, reason] = sourceInvalidReason(assessment);
    return checkedResult(knownInvalid(context, subject, reason, [assessment.sourceAssertionId]));
  }
  if (assessment.outcome === 'PRICE_SOURCE_ASSERTION_DEPENDENCY_UNAVAILABLE') {
    const [subject, reason, owner] = sourceDependency(assessment);
    return checkedResult(indeterminate(context, subject, reason, [owner], [assessment.sourceAssertionId]));
  }
  return context.exactKey !== undefined &&
    exactKeyEquivalence(context.exactKey, assessment.provenance.canonicalLink.identityKey)
    ? checkedValue(assessment)
    : checkedResult(
        knownInvalid(context, 'SOURCE_ASSERTION', 'INVALID_CANONICAL_CONFIGURATION', [
          assessment.provenance.provenanceRef,
          assessment.provenance.evidence.sourceAssertion.sourceAssertionId,
        ]),
      );
};

const ready = (
  context: PricingExplicitInputContext,
  currencySupport: CurrentSupportedCurrenciesSuccess,
  resolutionInput: PriceGroupFallbackResolutionInput,
): PricingExplicitInputEvaluationResult => {
  const candidate = { currencySupport, resolutionInput } satisfies ExactPriceResolutionInput;
  const decoded = Schema.decodeOption(ExactPriceResolutionInputSchema, { onExcessProperty: 'error' })(candidate);
  return Option.isSome(decoded)
    ? { _tag: 'READY', exactResolutionInput: decoded.value }
    : indeterminate(
        context,
        'EXACT_PRICE',
        'EXACT_PRICE_STATE_UNVERIFIABLE',
        ['PRICING_EXACT_PRICE'],
        currencySupportEvidenceRefs(currencySupport),
      );
};

/** Pure owner-local classification. It never performs lookup, fallback, conversion, or recovery mutation. */
export const evaluatePricingExplicitInput = (
  request: PricingExplicitInputEvaluationRequest,
): PricingExplicitInputEvaluationResult => {
  const hasCurrencyConflict = Match.value(request.currencySupport).pipe(
    Match.when(
      { code: 'pricing_currency_support_revision_conflict', outcome: 'SUPPORTED_CURRENCIES_INVALID' },
      () => true,
    ),
    Match.orElse(() => false),
  );
  if (hasCurrencyConflict) {
    const terminal = classifyNonCurrentCurrencySupport(request);
    return terminal === undefined
      ? indeterminate(request.context, 'CURRENCY_SUPPORT', 'SET_COMPLETENESS_UNVERIFIABLE', [
          'PRICING_CURRENCY_SUPPORT',
        ])
      : terminal.result;
  }
  const groupTerminal = Match.value(request.priceGroupResolutionInput).pipe(
    Match.tag('BLOCKED', (input) => classifyBlockedGroup(request, input)),
    Match.orElse(() => null),
  );
  if (groupTerminal !== null) {
    return groupTerminal;
  }
  if (request.sourceAssessment !== undefined) {
    const sourceTerminal = classifySource(request.context, request.sourceAssessment);
    if (sourceTerminal.kind === 'RESULT') {
      return sourceTerminal.result;
    }
  }
  if (request.quantityBasis !== undefined) {
    const quantityTerminal = classifyQuantityBasis(request.context, request.quantityBasis);
    if (quantityTerminal.kind === 'RESULT') {
      return quantityTerminal.result;
    }
  }
  const currencyTerminal = classifyNonCurrentCurrencySupport(request);
  if (currencyTerminal !== undefined) {
    return currencyTerminal.result;
  }
  const currencySupport = classifyCurrencySupport(request);
  if (currencySupport.kind === 'RESULT') {
    return currencySupport.result;
  }
  const priceGroup = classifyPriceGroup(request);
  if (priceGroup.kind === 'RESULT') {
    return priceGroup.result;
  }
  const quantityBasis = classifyQuantityBasis(request.context, request.quantityBasis);
  if (quantityBasis.kind === 'RESULT') {
    return quantityBasis.result;
  }
  const source = classifySource(request.context, request.sourceAssessment);
  if (source.kind === 'RESULT') {
    return source.result;
  }
  return ready(request.context, currencySupport.value, priceGroup.value);
};

const trustedContextMatches = (
  context: PricingExplicitInputContext,
  trusted: BrokenExplicitInputTrustedContext,
): boolean =>
  context.tenantId === trusted.tenantId &&
  context.effectiveAt === DateTime.formatIso(trusted.trustedOperationAt) &&
  (context.exactKey === undefined || context.exactKey.commercialScope.sellingLegalEntityId === trusted.legalEntityId);

export const makeBrokenExplicitInputValidationService = (
  observations: BrokenExplicitInputObservationPort,
): BrokenExplicitInputValidationService => {
  const observationPort = BrokenExplicitInputObservations.of(observations);
  return BrokenExplicitInputValidator.of({
    evaluate: Effect.fn('BrokenExplicitInputValidation.evaluate')(function* evaluate(context, trusted) {
      if (!trustedContextMatches(context, trusted)) {
        return knownInvalid(context, 'COMMERCIAL_SCOPE', 'INVALID_CANONICAL_CONFIGURATION');
      }
      const request = yield* observationPort.acquire(context, trusted);
      return contextEquivalence(request.context, context)
        ? evaluatePricingExplicitInput(request)
        : indeterminate(context, 'EXACT_PRICE', 'CURRENTNESS_UNVERIFIABLE', ['PRICING_EXACT_PRICE']);
    }),
  });
};
