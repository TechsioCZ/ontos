import {
  PricingDiscountCompositionRequestSchema,
  PricingDiscountCompositionResultSchema,
} from '@app/pricing-contracts/domain/discount-composition';
import type {
  PricingDiscountCompositionCandidate,
  PricingDiscountCompositionRequest,
  PricingDiscountCompositionResult,
  PricingDiscountLineContribution,
} from '@app/pricing-contracts/domain/discount-composition';
import { Effect, Option, Schema } from 'effect';

export class PricingDiscountCompositionRejected extends Schema.TaggedError<PricingDiscountCompositionRejected>()(
  'PricingDiscountCompositionRejected',
  {
    code: Schema.Literals(['COMPOSITION_REQUEST_INVALID', 'COMPOSITION_RESULT_INVALID']),
    reason: Schema.String,
  },
) {}

interface DecimalParts {
  readonly coefficient: bigint;
  readonly scale: number;
}

const decimalParts = (value: string): DecimalParts => {
  const [integer = '0', fraction = ''] = value.split('.');
  return { coefficient: BigInt(`${integer}${fraction}`), scale: fraction.length };
};

const formatDecimal = (coefficient: bigint, scale: number): string => {
  if (coefficient === 0n) {
    return '0';
  }
  const digits = coefficient.toString().padStart(scale + 1, '0');
  if (scale === 0) {
    return digits;
  }
  const integer = digits.slice(0, -scale);
  const fraction = digits.slice(-scale).replace(/0+$/u, '');
  return fraction.length === 0 ? integer : `${integer}.${fraction}`;
};

const negativeDecimal = (value: string): string => {
  const parts = decimalParts(value);
  const canonical = formatDecimal(parts.coefficient, parts.scale);
  return canonical === '0' ? '0' : `-${canonical}`;
};

const percentageReduction = (basis: string, percentage: string): string => {
  const basisParts = decimalParts(basis);
  const percentageParts = decimalParts(percentage);
  return negativeDecimal(
    formatDecimal(basisParts.coefficient * percentageParts.coefficient, basisParts.scale + percentageParts.scale + 2),
  );
};

const rejection = (
  code: PricingDiscountCompositionRejected['code'],
  reason: string,
  cause?: unknown,
): PricingDiscountCompositionRejected => {
  const failure = new PricingDiscountCompositionRejected({ code, reason });
  return cause === undefined ? failure : Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
};

const decodeRequest = Schema.decodeUnknownOption(PricingDiscountCompositionRequestSchema, {
  onExcessProperty: 'error',
});
const decodeResult = Schema.decodeUnknownOption(PricingDiscountCompositionResultSchema, {
  onExcessProperty: 'error',
});

const candidatePathKey = (candidate: PricingDiscountCompositionCandidate): string =>
  candidate.kind === 'VARIANT_LINE'
    ? `VARIANT_LINE:${candidate.occurrenceId}:${candidate.layer}`
    : 'WHOLE_PURCHASE:COUNTERPARTY_WHOLE_PURCHASE';

const competingCandidates = (
  candidates: readonly PricingDiscountCompositionCandidate[],
): readonly PricingDiscountCompositionCandidate[] | undefined => {
  const candidatesByPath = new Map<string, PricingDiscountCompositionCandidate[]>();
  for (const candidate of candidates) {
    const key = candidatePathKey(candidate);
    const pathCandidates = candidatesByPath.get(key) ?? [];
    pathCandidates.push(candidate);
    candidatesByPath.set(key, pathCandidates);
  }
  return [...candidatesByPath.values()].find((pathCandidates) => pathCandidates.length > 1);
};

const lineContribution = (
  request: PricingDiscountCompositionRequest,
  candidate: Extract<PricingDiscountCompositionCandidate, { readonly kind: 'VARIANT_LINE' }>,
): Option.Option<PricingDiscountLineContribution> => {
  const basis = request.lineBases.find(({ occurrenceId }) => occurrenceId === candidate.occurrenceId);
  if (basis === undefined) {
    return Option.none();
  }
  const effect = candidate.definition.revision.configuredEffect;
  const amount =
    effect.kind === 'PERCENTAGE'
      ? percentageReduction(basis.amount.amount, effect.level)
      : negativeDecimal(effect.level.amount);
  return Option.some({
    amount: { amount, currencyCode: basis.amount.currencyCode },
    applicationCount: 'ONCE_PER_STABLE_LINE',
    basis,
    candidate,
    contributionDirection: 'NON_POSITIVE_REDUCTION',
  });
};

const conflictPath = (candidate: PricingDiscountCompositionCandidate) =>
  candidate.kind === 'VARIANT_LINE'
    ? ({
        kind: 'VARIANT_LINE_LAYER' as const,
        layer: candidate.layer,
        occurrenceId: candidate.occurrenceId,
      } as const)
    : ({ kind: 'WHOLE_PURCHASE_LAYER' as const, layer: 'COUNTERPARTY_WHOLE_PURCHASE' as const } as const);

/**
 * Composes only already-applicable owner-proven Discount facts. All line percentages use the
 * unchanged fee-inclusive basis, fixed line effects are applied once, and any layer collision
 * produces one typed conflict instead of selecting a latest or cheapest winner.
 */
export const composePricingDiscounts = (
  input: PricingDiscountCompositionRequest,
): Effect.Effect<PricingDiscountCompositionResult, PricingDiscountCompositionRejected> => {
  const decodedRequest = decodeRequest(input);
  if (Option.isNone(decodedRequest)) {
    return Effect.fail(
      rejection(
        'COMPOSITION_REQUEST_INVALID',
        'Discount composition requires exact Current tenant currency support and already-applicable exact candidates',
      ),
    );
  }
  const request = decodedRequest.value;
  const conflictCandidates = competingCandidates(request.candidates);
  let candidateResult: PricingDiscountCompositionResult;
  if (conflictCandidates === undefined) {
    const contributionOptions = request.candidates.flatMap((candidate) =>
      candidate.kind === 'VARIANT_LINE' ? [lineContribution(request, candidate)] : [],
    );
    if (contributionOptions.some(Option.isNone)) {
      return Effect.fail(
        rejection('COMPOSITION_RESULT_INVALID', 'Applicable Discount lost its exact original stable line basis'),
      );
    }
    const lineContributions = contributionOptions.flatMap((contribution) =>
      Option.isSome(contribution) ? [contribution.value] : [],
    );
    const wholePurchaseCandidate = request.candidates.find(
      (candidate): candidate is Extract<PricingDiscountCompositionCandidate, { readonly kind: 'WHOLE_PURCHASE' }> =>
        candidate.kind === 'WHOLE_PURCHASE',
    );
    const readyResult = {
      lineContributions,
      outcome: 'DISCOUNT_COMPOSITION_READY' as const,
      request,
    };
    if (wholePurchaseCandidate === undefined) {
      candidateResult = readyResult;
    } else if (wholePurchaseCandidate.applicability.outcome === 'WHOLE_PURCHASE_DISCOUNT_APPLICABLE') {
      candidateResult = {
        ...readyResult,
        wholePurchaseContribution: {
          amount: wholePurchaseCandidate.applicability.contribution,
          applicationCount: 'ONCE_PER_PRICING_DECISION',
          candidate: wholePurchaseCandidate,
          contributionDirection: 'NON_POSITIVE_REDUCTION',
        },
      };
    } else {
      return Effect.fail(
        rejection('COMPOSITION_RESULT_INVALID', 'Whole-purchase candidate was not already proven applicable'),
      );
    }
  } else {
    const [first] = conflictCandidates;
    if (first === undefined) {
      return Effect.fail(rejection('COMPOSITION_RESULT_INVALID', 'Discount cardinality conflict had no claimant'));
    }
    candidateResult = {
      conflict: {
        claimants: conflictCandidates,
        conflictKind: 'DISCOUNT_LAYER_CARDINALITY',
        path: conflictPath(first),
      },
      outcome: 'DISCOUNT_CARDINALITY_CONFLICT',
      request,
    };
  }
  const decodedResult = decodeResult(candidateResult);
  return Effect.fromOption(decodedResult).pipe(
    Effect.mapError((cause) =>
      rejection(
        'COMPOSITION_RESULT_INVALID',
        'Discount composition did not satisfy its published evidence contract',
        cause,
      ),
    ),
  );
};
