import {
  PricingAllocationRequestSchema,
  PricingAllocationResultSchema,
} from '@app/pricing-contracts/domain/discount-fee-allocation';
import type {
  PricingAllocationFailure,
  PricingAllocationLine,
  PricingAllocationRequest,
  PricingAllocationResult,
  PricingGenericAllocationRequest,
  PricingWholePurchaseContractualAllocationRequest,
} from '@app/pricing-contracts/domain/discount-fee-allocation';
import { Effect, Option, Schema } from 'effect';

export class PricingDiscountFeeAllocationRejected extends Schema.TaggedError<PricingDiscountFeeAllocationRejected>()(
  'PricingDiscountFeeAllocationRejected',
  {
    code: Schema.Literals(['ALLOCATION_REQUEST_INVALID', 'ALLOCATION_RESULT_INVALID']),
    reason: Schema.String,
  },
) {}

interface DecimalParts {
  readonly coefficient: bigint;
  readonly scale: number;
}

interface WeightedRecipient {
  readonly occurrenceId: string;
  readonly weight: string;
}

type ComputedAllocationRequest = PricingGenericAllocationRequest | PricingWholePurchaseContractualAllocationRequest;
type AllocationFailureReason = PricingAllocationFailure['reason'];
type ProportionalAllocationOutcome =
  | { readonly allocations: readonly PricingAllocationLine[]; readonly outcome: 'ALLOCATIONS_READY' }
  | { readonly outcome: 'ALLOCATION_FAILED'; readonly reason: AllocationFailureReason };

const decodeRequest = Schema.decodeUnknownOption(PricingAllocationRequestSchema);
const decodeResult = Schema.decodeUnknownOption(PricingAllocationResultSchema);

const rejected = (
  code: 'ALLOCATION_REQUEST_INVALID' | 'ALLOCATION_RESULT_INVALID',
  reason: string,
  cause?: unknown,
): PricingDiscountFeeAllocationRejected => {
  const failure = new PricingDiscountFeeAllocationRejected({ code, reason });
  return cause === undefined ? failure : Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
};

const decimalParts = (value: string): DecimalParts => {
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [integer = '0', fraction = ''] = unsigned.split('.');
  const coefficient = BigInt(`${integer}${fraction}`);
  return { coefficient: negative ? -coefficient : coefficient, scale: fraction.length };
};

const alignCoefficient = (parts: DecimalParts, scale: number): bigint =>
  parts.coefficient * 10n ** BigInt(scale - parts.scale);

const absolute = (value: bigint): bigint => (value < 0n ? -value : value);

const digitCount = (value: bigint): number => absolute(value).toString().replace(/^0+/u, '').length;

const compareStableRecipientIds = (left: string, right: string): number => {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
};

const formatScaled = (coefficient: bigint, scale: number): string => {
  if (coefficient === 0n) {
    return '0';
  }
  const sign = coefficient < 0n ? '-' : '';
  const digits = absolute(coefficient)
    .toString()
    .padStart(scale + 1, '0');
  if (scale === 0) {
    return `${sign}${digits}`;
  }
  const integer = digits.slice(0, -scale);
  const fraction = digits.slice(-scale).replace(/0+$/u, '');
  return fraction.length === 0 ? `${sign}${integer}` : `${sign}${integer}.${fraction}`;
};

const requestAmounts = (request: ComputedAllocationRequest): readonly string[] =>
  request.allocationKind === 'GENERIC_PROPORTIONAL'
    ? [
        request.originalContribution.amount,
        ...request.eligibleRecipients.map(({ baseLineValue }) => baseLineValue.amount),
      ]
    : [
        request.originalContribution.amount,
        request.eligibleBasis.eligibleAmount,
        ...request.eligibleBasis.recipients.map(({ intermediateValue }) => intermediateValue.amount),
      ];

const declaredNumericFailure = (request: ComputedAllocationRequest): AllocationFailureReason | undefined => {
  const maximumIntegerDigits = request.precision.amountPrecision - request.precision.allocationScale;
  for (const value of requestAmounts(request)) {
    const unsigned = value.startsWith('-') ? value.slice(1) : value;
    const [integer = '0', fraction = ''] = unsigned.split('.');
    if (integer.replace(/^0+/u, '').length > maximumIntegerDigits) {
      return 'ARITHMETIC_OVERFLOW';
    }
    if (fraction.length > request.precision.allocationScale) {
      return 'PRECISION_UNSUPPORTED';
    }
  }
  return undefined;
};

const weightedRecipients = (request: ComputedAllocationRequest): readonly WeightedRecipient[] =>
  request.allocationKind === 'GENERIC_PROPORTIONAL'
    ? request.eligibleRecipients.map(({ baseLineValue, occurrenceId }) => ({
        occurrenceId,
        weight: baseLineValue.amount,
      }))
    : request.eligibleBasis.recipients.map(({ intermediateValue, occurrenceId }) => ({
        occurrenceId,
        weight: intermediateValue.amount,
      }));

const allocationFailure = (
  request: ComputedAllocationRequest,
  reason: AllocationFailureReason,
): PricingAllocationFailure => ({ outcome: 'ALLOCATION_FAILED', reason, request });

const proportionalAllocations = (request: ComputedAllocationRequest): ProportionalAllocationOutcome => {
  const numericFailure = declaredNumericFailure(request);
  if (numericFailure !== undefined) {
    return { outcome: 'ALLOCATION_FAILED', reason: numericFailure };
  }

  const recipients = weightedRecipients(request);
  const weightParts = recipients.map(({ weight }) => decimalParts(weight));
  const weightScale = Math.max(0, ...weightParts.map(({ scale }) => scale));
  const weights = weightParts.map((parts) => alignCoefficient(parts, weightScale));
  const denominator = weights.reduce((sum, weight) => sum + weight, 0n);
  if (denominator === 0n) {
    return {
      outcome: 'ALLOCATION_FAILED',
      reason: request.allocationKind === 'GENERIC_PROPORTIONAL' ? 'GENERIC_ZERO_BASIS' : 'PRECISION_UNSUPPORTED',
    };
  }
  const denominatorAtDeclaredScale = alignCoefficient(
    { coefficient: denominator, scale: weightScale },
    request.precision.allocationScale,
  );
  if (digitCount(denominatorAtDeclaredScale) > request.precision.amountPrecision) {
    return { outcome: 'ALLOCATION_FAILED', reason: 'ARITHMETIC_OVERFLOW' };
  }

  const contribution = alignCoefficient(
    decimalParts(request.originalContribution.amount),
    request.precision.allocationScale,
  );
  const magnitude = absolute(contribution);
  const sign = contribution < 0n ? -1n : 1n;
  const shares = weights.map((weight) => (magnitude * weight) / denominator);
  const remainders = weights.map((weight) => (magnitude * weight) % denominator);
  let unallocated = magnitude - shares.reduce((sum, share) => sum + share, 0n);
  const ranked = recipients
    .map(({ occurrenceId }, index) => ({ index, occurrenceId, remainder: remainders[index] ?? 0n }))
    .toSorted((left, right) => {
      if (left.remainder === right.remainder) {
        return compareStableRecipientIds(left.occurrenceId, right.occurrenceId);
      }
      return left.remainder > right.remainder ? -1 : 1;
    });
  for (const recipient of ranked) {
    if (unallocated === 0n) {
      break;
    }
    shares[recipient.index] = (shares[recipient.index] ?? 0n) + 1n;
    unallocated -= 1n;
  }
  if (unallocated !== 0n) {
    return { outcome: 'ALLOCATION_FAILED', reason: 'ARITHMETIC_OVERFLOW' };
  }

  const allocations = recipients
    .map(({ occurrenceId }, index): PricingAllocationLine => ({
      amount: {
        amount: formatScaled((shares[index] ?? 0n) * sign, request.precision.allocationScale),
        currencyCode: request.decision.currencyCode,
      },
      occurrenceId,
      recipientKind: 'MERCHANDISE',
    }))
    .toSorted((left, right) => compareStableRecipientIds(left.occurrenceId, right.occurrenceId));

  if (request.allocationKind === 'WHOLE_PURCHASE_CONTRACTUAL') {
    const capacityByRecipient = new Map(
      request.eligibleBasis.recipients.map(({ intermediateValue, occurrenceId }) => [
        occurrenceId,
        alignCoefficient(decimalParts(intermediateValue.amount), request.precision.allocationScale),
      ]),
    );
    const capacityPreserved = allocations.every(({ amount, occurrenceId }) => {
      const capacity = capacityByRecipient.get(occurrenceId);
      return (
        capacity !== undefined &&
        absolute(alignCoefficient(decimalParts(amount.amount), request.precision.allocationScale)) <= capacity
      );
    });
    if (!capacityPreserved) {
      return { outcome: 'ALLOCATION_FAILED', reason: 'PRECISION_UNSUPPORTED' };
    }
  }

  return { allocations, outcome: 'ALLOCATIONS_READY' };
};

const validatedResult = (
  result: PricingAllocationResult,
): Effect.Effect<PricingAllocationResult, PricingDiscountFeeAllocationRejected> => {
  const decoded = decodeResult(result);
  return Effect.fromOption(decoded).pipe(
    Effect.mapError((cause) =>
      rejected(
        'ALLOCATION_RESULT_INVALID',
        'Pricing allocation did not satisfy its published evidence contract',
        cause,
      ),
    ),
  );
};

export const allocatePricingDiscountsAndFees = (
  input: PricingAllocationRequest,
): Effect.Effect<PricingAllocationResult, PricingDiscountFeeAllocationRejected> => {
  const decodedRequest = decodeRequest(input);
  if (Option.isNone(decodedRequest)) {
    return Effect.fail(
      rejected(
        'ALLOCATION_REQUEST_INVALID',
        'Pricing allocation requires an exact owner-authorized request with one compatible currency',
      ),
    );
  }
  const request = decodedRequest.value;
  if (request.allocationKind === 'WHOLE_PURCHASE_CONTRACTUAL_NOT_APPLICABLE') {
    return validatedResult({ outcome: 'ALLOCATION_NOT_APPLICABLE', request });
  }
  if (request.allocationKind === 'OWNER_EXACT') {
    return validatedResult({
      allocations: request.ownerAllocations,
      outcome: 'ALLOCATION_APPLIED',
      request,
      sumInvariant: 'ALLOCATIONS_SUM_TO_ORIGINAL_CONTRIBUTION',
    });
  }

  const computed = proportionalAllocations(request);
  if (computed.outcome === 'ALLOCATION_FAILED') {
    return validatedResult(allocationFailure(request, computed.reason));
  }
  return request.allocationKind === 'WHOLE_PURCHASE_CONTRACTUAL'
    ? validatedResult({
        allocations: computed.allocations,
        capacityInvariant: 'EVERY_ALLOCATION_WITHIN_ELIGIBLE_INTERMEDIATE',
        outcome: 'ALLOCATION_APPLIED',
        request,
        sumInvariant: 'ALLOCATIONS_SUM_TO_ORIGINAL_CONTRIBUTION',
      })
    : validatedResult({
        allocations: computed.allocations,
        outcome: 'ALLOCATION_APPLIED',
        request,
        sumInvariant: 'ALLOCATIONS_SUM_TO_ORIGINAL_CONTRIBUTION',
      });
};
