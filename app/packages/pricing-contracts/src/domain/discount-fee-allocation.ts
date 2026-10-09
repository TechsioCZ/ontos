import { Schema } from 'effect';

import { PricingCurrencyCodeSchema } from '../apis/current-supported-currencies.ts';
import {
  PRICING_ALLOCATION_PROFILE,
  PRICING_ALLOCATION_PROFILE_VERSION,
  PricingExactNonPositiveDecimalSchema,
  PricingExactPositiveDecimalSchema,
} from './exact-decimal.ts';
import {
  PricingDecisionSchema,
  PricingNonNegativeDecimalSchema,
  PricingNonPositiveDecimalSchema,
  PricingPositiveDecimalSchema,
  PricingPurchaseDemandOccurrenceIdSchema,
} from './pricing-decision.ts';
import { PricingWholePurchaseContractualEligibleBasisSchema } from './discount.ts';

export const PRICING_ALLOCATION_CONTRACT_VERSION = PRICING_ALLOCATION_PROFILE_VERSION;

const stableReference = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300), Schema.isTrimmed());
const PricingSignedInputDecimalSchema = Schema.Union([PricingNonPositiveDecimalSchema, PricingPositiveDecimalSchema]);
const PricingSignedAllocationDecimalSchema = Schema.Union([
  PricingExactNonPositiveDecimalSchema,
  PricingExactPositiveDecimalSchema,
]);
const PricingSignedInputMoneySchema = Schema.Struct({
  amount: PricingSignedInputDecimalSchema,
  currencyCode: PricingCurrencyCodeSchema,
});
const PricingSignedAllocationMoneySchema = Schema.Struct({
  amount: PricingSignedAllocationDecimalSchema,
  currencyCode: PricingCurrencyCodeSchema,
});
const PricingNonNegativeMoneySchema = Schema.Struct({
  amount: PricingNonNegativeDecimalSchema,
  currencyCode: PricingCurrencyCodeSchema,
});
const PricingAllocationOwnerModuleIdSchema = stableReference.pipe(
  Schema.brand('PricingAllocationOwnerModuleId'),
  Schema.decodeTo(Schema.String),
);

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

const alignedCoefficient = (parts: DecimalParts, scale: number): bigint =>
  parts.coefficient * 10n ** BigInt(scale - parts.scale);

const decimalsEqual = (left: string, right: string): boolean => {
  const leftParts = decimalParts(left);
  const rightParts = decimalParts(right);
  const scale = Math.max(leftParts.scale, rightParts.scale);
  return alignedCoefficient(leftParts, scale) === alignedCoefficient(rightParts, scale);
};

const decimalSumEquals = (expected: string, values: readonly string[]): boolean => {
  const parts = [decimalParts(expected), ...values.map(decimalParts)];
  const scale = Math.max(0, ...parts.map((part) => part.scale));
  const [expectedParts, ...valueParts] = parts;
  return (
    expectedParts !== undefined &&
    alignedCoefficient(expectedParts, scale) ===
      valueParts.reduce((sum, part) => sum + alignedCoefficient(part, scale), 0n)
  );
};

const compareNonNegativeDecimals = (left: string, right: string): number => {
  const leftParts = decimalParts(left);
  const rightParts = decimalParts(right);
  const scale = Math.max(leftParts.scale, rightParts.scale);
  const leftCoefficient = alignedCoefficient(leftParts, scale);
  const rightCoefficient = alignedCoefficient(rightParts, scale);
  if (leftCoefficient < rightCoefficient) {
    return -1;
  }
  return leftCoefficient > rightCoefficient ? 1 : 0;
};

const decimalMagnitude = (value: string): string => (value.startsWith('-') ? value.slice(1) : value);

/** Stable across hosts: JavaScript UTF-16 code-unit lexical order, never locale collation. */
const compareStableRecipientIds = (left: string, right: string): number => {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
};

const fitsAllocationPrecision = (value: string, precision: PricingAllocationPrecision): boolean => {
  const unsigned = value.startsWith('-') ? value.slice(1) : value;
  const [integer = '0', fraction = ''] = unsigned.split('.');
  return (
    integer.replace(/^0+/u, '').length <= precision.amountPrecision - precision.allocationScale &&
    fraction.length <= precision.allocationScale
  );
};

export const PricingAllocationPrecisionSchema = Schema.Struct({
  allocationScale: Schema.Literal(PRICING_ALLOCATION_PROFILE.maximumScale),
  amountPrecision: Schema.Literal(PRICING_ALLOCATION_PROFILE.maximumPrecision),
  contractVersion: Schema.Literal(PRICING_ALLOCATION_CONTRACT_VERSION),
  remainderRule: Schema.Literal(PRICING_ALLOCATION_PROFILE.remainderRule),
});
export type PricingAllocationPrecision = typeof PricingAllocationPrecisionSchema.Type;

export const PricingAllocationSourceEvidenceSchema = Schema.Struct({
  allocationAuthority: Schema.Literals([
    'LINE_NATIVE',
    'OWNER_EXACT',
    'GENERIC_SUPPORTED',
    'PRICING_WHOLE_PURCHASE_CONTRACTUAL',
  ]),
  logicalFactRef: stableReference,
  ownerModuleId: PricingAllocationOwnerModuleIdSchema,
  revisionRef: stableReference,
  sourceKind: Schema.Literals(['PRICING_DISCOUNT', 'PRICING_FEE', 'PROMOTION', 'OTHER_OWNER']),
});
export type PricingAllocationSourceEvidence = typeof PricingAllocationSourceEvidenceSchema.Type;

export const PricingAllocationRecipientBasisSchema = Schema.Struct({
  baseLineValue: PricingNonNegativeMoneySchema,
  occurrenceId: PricingPurchaseDemandOccurrenceIdSchema,
  recipientKind: Schema.Literal('MERCHANDISE'),
});
export type PricingAllocationRecipientBasis = typeof PricingAllocationRecipientBasisSchema.Type;

export const PricingAllocationLineSchema = Schema.Struct({
  amount: PricingSignedAllocationMoneySchema,
  occurrenceId: PricingPurchaseDemandOccurrenceIdSchema,
  recipientKind: Schema.Literal('MERCHANDISE'),
});
export type PricingAllocationLine = typeof PricingAllocationLineSchema.Type;

const distinctRecipients = (occurrenceIds: readonly string[]): boolean =>
  new Set(occurrenceIds).size === occurrenceIds.length;

const recipientsBelongToDecision = (
  occurrenceIds: readonly string[],
  decision: typeof PricingDecisionSchema.Type,
): boolean => occurrenceIds.every((occurrenceId) => decision.lines.some((line) => line.occurrenceId === occurrenceId));

const allocationsUseCurrency = (allocations: readonly PricingAllocationLine[], currencyCode: string): boolean =>
  allocations.every(({ amount }) => amount.currencyCode === currencyCode);

const sameAllocationSet = (left: readonly PricingAllocationLine[], right: readonly PricingAllocationLine[]): boolean =>
  left.length === right.length &&
  left.every((allocation) =>
    right.some(
      (other) =>
        allocation.occurrenceId === other.occurrenceId &&
        allocation.amount.currencyCode === other.amount.currencyCode &&
        decimalsEqual(allocation.amount.amount, other.amount.amount),
    ),
  );

export const PricingOwnerExactAllocationRequestSchema = Schema.Struct({
  allocationKind: Schema.Literal('OWNER_EXACT'),
  decision: PricingDecisionSchema,
  originalContribution: PricingSignedInputMoneySchema,
  ownerAllocations: Schema.Array(PricingAllocationLineSchema).check(Schema.isMinLength(1)),
  ownerScope: Schema.Literals(['LINE_NATIVE', 'MULTI_LINE']),
  precision: PricingAllocationPrecisionSchema,
  source: PricingAllocationSourceEvidenceSchema,
}).check(
  Schema.makeFilter(({ decision, originalContribution, ownerAllocations, ownerScope, source }) => {
    if (
      (ownerScope === 'LINE_NATIVE' && source.allocationAuthority !== 'LINE_NATIVE') ||
      (ownerScope === 'MULTI_LINE' && source.allocationAuthority !== 'OWNER_EXACT')
    ) {
      return 'Owner allocation scope must preserve the authority declared by the contribution owner';
    }
    if (ownerScope === 'LINE_NATIVE' && ownerAllocations.length !== 1) {
      return 'A line-native contribution must preserve exactly one original recipient allocation';
    }
    const occurrenceIds = ownerAllocations.map(({ occurrenceId }) => occurrenceId);
    if (!distinctRecipients(occurrenceIds) || !recipientsBelongToDecision(occurrenceIds, decision)) {
      return 'Owner allocations must preserve distinct original Pricing Line recipients';
    }
    if (
      originalContribution.currencyCode !== decision.currencyCode ||
      !allocationsUseCurrency(ownerAllocations, decision.currencyCode)
    ) {
      return 'Owner allocation and its original contribution must use the exact Pricing Decision currency';
    }
    return decimalSumEquals(
      originalContribution.amount,
      ownerAllocations.map(({ amount }) => amount.amount),
    )
      ? undefined
      : 'Owner-issued exact allocations must preserve the original contribution sum';
  }),
);
export type PricingOwnerExactAllocationRequest = typeof PricingOwnerExactAllocationRequestSchema.Type;

export const PricingGenericAllocationRequestSchema = Schema.Struct({
  allocationKind: Schema.Literal('GENERIC_PROPORTIONAL'),
  basisKind: Schema.Literal('ELIGIBLE_BASE_LINE_VALUE'),
  decision: PricingDecisionSchema,
  eligibleRecipients: Schema.Array(PricingAllocationRecipientBasisSchema),
  originalContribution: PricingSignedInputMoneySchema,
  precision: PricingAllocationPrecisionSchema,
  source: PricingAllocationSourceEvidenceSchema,
}).check(
  Schema.makeFilter(({ decision, eligibleRecipients, originalContribution, source }) => {
    if (source.allocationAuthority !== 'GENERIC_SUPPORTED') {
      return 'Generic allocation requires explicit permission from the owning contribution contract';
    }
    const occurrenceIds = eligibleRecipients.map(({ occurrenceId }) => occurrenceId);
    if (!distinctRecipients(occurrenceIds) || !recipientsBelongToDecision(occurrenceIds, decision)) {
      return 'Generic allocation recipients must be distinct original Pricing merchandise lines';
    }
    if (
      originalContribution.currencyCode !== decision.currencyCode ||
      eligibleRecipients.some(({ baseLineValue }) => baseLineValue.currencyCode !== decision.currencyCode)
    ) {
      return 'Generic contribution and eligible Base Line Values must use the exact Pricing Decision currency';
    }
    return [];
  }),
);
export type PricingGenericAllocationRequest = typeof PricingGenericAllocationRequestSchema.Type;

export const PricingWholePurchaseContractualAllocationRequestSchema = Schema.Struct({
  allocationKind: Schema.Literal('WHOLE_PURCHASE_CONTRACTUAL'),
  decision: PricingDecisionSchema,
  eligibleBasis: PricingWholePurchaseContractualEligibleBasisSchema,
  originalContribution: Schema.Struct({
    amount: PricingNonPositiveDecimalSchema,
    currencyCode: PricingCurrencyCodeSchema,
  }),
  precision: PricingAllocationPrecisionSchema,
  source: PricingAllocationSourceEvidenceSchema,
}).check(
  Schema.makeFilter(({ decision, eligibleBasis, originalContribution, source }) => {
    if (
      source.allocationAuthority !== 'PRICING_WHOLE_PURCHASE_CONTRACTUAL' ||
      source.sourceKind !== 'PRICING_DISCOUNT'
    ) {
      return 'Whole-purchase contractual allocation requires Pricing Discount owner evidence';
    }
    const occurrenceIds = eligibleBasis.recipients.map(({ occurrenceId }) => occurrenceId);
    if (!recipientsBelongToDecision(occurrenceIds, decision)) {
      return 'Whole-purchase contractual allocation must preserve original Pricing Line recipients';
    }
    if (
      eligibleBasis.currencyCode !== decision.currencyCode ||
      originalContribution.currencyCode !== decision.currencyCode
    ) {
      return 'Whole-purchase basis and contribution must use the exact Pricing Decision currency';
    }
    return compareNonNegativeDecimals(eligibleBasis.eligibleAmount, decimalMagnitude(originalContribution.amount)) > 0
      ? undefined
      : 'Whole-purchase contractual allocation is applicable only under strict B > D';
  }),
);
export type PricingWholePurchaseContractualAllocationRequest =
  typeof PricingWholePurchaseContractualAllocationRequestSchema.Type;

export const PricingWholePurchaseContractualNotApplicableRequestSchema = Schema.Struct({
  allocationKind: Schema.Literal('WHOLE_PURCHASE_CONTRACTUAL_NOT_APPLICABLE'),
  configuredDiscount: PricingNonNegativeMoneySchema,
  decision: PricingDecisionSchema,
  eligibleBasis: PricingWholePurchaseContractualEligibleBasisSchema,
  reason: Schema.Literals(['EMPTY_ELIGIBLE_SET', 'BASIS_NOT_GREATER_THAN_DISCOUNT']),
  source: PricingAllocationSourceEvidenceSchema,
}).check(
  Schema.makeFilter(({ configuredDiscount, decision, eligibleBasis, reason, source }) => {
    if (
      source.allocationAuthority !== 'PRICING_WHOLE_PURCHASE_CONTRACTUAL' ||
      source.sourceKind !== 'PRICING_DISCOUNT'
    ) {
      return 'Whole-purchase contractual non-applicability requires Pricing Discount owner evidence';
    }
    if (
      configuredDiscount.currencyCode !== decision.currencyCode ||
      eligibleBasis.currencyCode !== decision.currencyCode
    ) {
      return 'Whole-purchase non-applicability evidence must use the exact Pricing Decision currency';
    }
    if (
      !recipientsBelongToDecision(
        eligibleBasis.recipients.map(({ occurrenceId }) => occurrenceId),
        decision,
      )
    ) {
      return 'Whole-purchase non-applicability must preserve original Pricing Line recipients';
    }
    if (eligibleBasis.recipients.length === 0) {
      return reason === 'EMPTY_ELIGIBLE_SET' ? undefined : 'An empty eligible set requires its explicit reason';
    }
    return compareNonNegativeDecimals(eligibleBasis.eligibleAmount, configuredDiscount.amount) <= 0 &&
      reason === 'BASIS_NOT_GREATER_THAN_DISCOUNT'
      ? undefined
      : 'A non-empty whole-purchase basis is non-applicable exactly when B <= D';
  }),
);
export type PricingWholePurchaseContractualNotApplicableRequest =
  typeof PricingWholePurchaseContractualNotApplicableRequestSchema.Type;

const PricingComputedAllocationRequestSchema = Schema.Union([
  PricingGenericAllocationRequestSchema,
  PricingWholePurchaseContractualAllocationRequestSchema,
]);

export const PricingAllocationRequestSchema = Schema.Union([
  PricingOwnerExactAllocationRequestSchema,
  PricingGenericAllocationRequestSchema,
  PricingWholePurchaseContractualAllocationRequestSchema,
  PricingWholePurchaseContractualNotApplicableRequestSchema,
]);
export type PricingAllocationRequest = typeof PricingAllocationRequestSchema.Type;

const genericBasisTotalIsZero = (request: PricingGenericAllocationRequest): boolean =>
  decimalSumEquals(
    '0',
    request.eligibleRecipients.map(({ baseLineValue }) => baseLineValue.amount),
  );

const requestAmounts = (
  request:
    | PricingGenericAllocationRequest
    | PricingOwnerExactAllocationRequest
    | PricingWholePurchaseContractualAllocationRequest,
): readonly string[] => {
  if (request.allocationKind === 'OWNER_EXACT') {
    return [request.originalContribution.amount, ...request.ownerAllocations.map(({ amount }) => amount.amount)];
  }
  if (request.allocationKind === 'GENERIC_PROPORTIONAL') {
    return [
      request.originalContribution.amount,
      ...request.eligibleRecipients.map(({ baseLineValue }) => baseLineValue.amount),
    ];
  }
  return [
    request.originalContribution.amount,
    request.eligibleBasis.eligibleAmount,
    ...request.eligibleBasis.recipients.map(({ intermediateValue }) => intermediateValue.amount),
  ];
};

interface WeightedRecipient {
  readonly occurrenceId: string;
  readonly weight: string;
}

const expectedProportionalAllocations = (
  contribution: string,
  recipients: readonly WeightedRecipient[],
  precision: PricingAllocationPrecision,
): null | ReadonlyMap<string, bigint> => {
  if (
    ![contribution, ...recipients.map(({ weight }) => weight)].every((value) =>
      fitsAllocationPrecision(value, precision),
    )
  ) {
    return null;
  }
  const contributionParts = decimalParts(contribution);
  const contributionAtScale = alignedCoefficient(contributionParts, precision.allocationScale);
  const magnitude = contributionAtScale < 0n ? -contributionAtScale : contributionAtScale;
  const sign = contributionAtScale < 0n ? -1n : 1n;
  const weightParts = recipients.map(({ weight }) => decimalParts(weight));
  const weightScale = Math.max(0, ...weightParts.map((part) => part.scale));
  const weights = weightParts.map((part) => alignedCoefficient(part, weightScale));
  const denominator = weights.reduce((sum, weight) => sum + weight, 0n);
  if (denominator === 0n) {
    return null;
  }
  const floors = weights.map((weight) => (magnitude * weight) / denominator);
  const remainders = weights.map((weight) => (magnitude * weight) % denominator);
  const unallocated = magnitude - floors.reduce((sum, floor) => sum + floor, 0n);
  const rankedIndexes = recipients
    .map((recipient, index) => ({ index, occurrenceId: recipient.occurrenceId, remainder: remainders[index] ?? 0n }))
    .toSorted((left, right) => {
      if (left.remainder === right.remainder) {
        return compareStableRecipientIds(left.occurrenceId, right.occurrenceId);
      }
      return left.remainder > right.remainder ? -1 : 1;
    });
  for (let index = 0; index < Number(unallocated); index += 1) {
    const ranked = rankedIndexes[index];
    if (ranked === undefined) {
      return null;
    }
    floors[ranked.index] = (floors[ranked.index] ?? 0n) + 1n;
  }
  return new Map(recipients.map((recipient, index) => [recipient.occurrenceId, (floors[index] ?? 0n) * sign]));
};

const allocationMatchesScaledCoefficient = (
  allocation: PricingAllocationLine,
  expected: bigint,
  precision: PricingAllocationPrecision,
): boolean => {
  if (!fitsAllocationPrecision(allocation.amount.amount, precision)) {
    return false;
  }
  return alignedCoefficient(decimalParts(allocation.amount.amount), precision.allocationScale) === expected;
};

const appliedAllocationsMatchRequest = (
  request:
    | PricingGenericAllocationRequest
    | PricingOwnerExactAllocationRequest
    | PricingWholePurchaseContractualAllocationRequest,
  allocations: readonly PricingAllocationLine[],
): boolean => {
  if (
    !distinctRecipients(allocations.map(({ occurrenceId }) => occurrenceId)) ||
    !allocationsUseCurrency(allocations, request.decision.currencyCode) ||
    !decimalSumEquals(
      request.originalContribution.amount,
      allocations.map(({ amount }) => amount.amount),
    ) ||
    ![...requestAmounts(request), ...allocations.map(({ amount }) => amount.amount)].every((value) =>
      fitsAllocationPrecision(value, request.precision),
    )
  ) {
    return false;
  }
  if (request.allocationKind === 'OWNER_EXACT') {
    return sameAllocationSet(request.ownerAllocations, allocations);
  }
  const recipients =
    request.allocationKind === 'GENERIC_PROPORTIONAL'
      ? request.eligibleRecipients.map(({ baseLineValue, occurrenceId }) => ({
          occurrenceId,
          weight: baseLineValue.amount,
        }))
      : request.eligibleBasis.recipients.map(({ intermediateValue, occurrenceId }) => ({
          occurrenceId,
          weight: intermediateValue.amount,
        }));
  const expected = expectedProportionalAllocations(request.originalContribution.amount, recipients, request.precision);
  return (
    expected !== null &&
    expected.size === allocations.length &&
    allocations.every((entry) => {
      const expectedCoefficient = expected.get(entry.occurrenceId);
      return (
        expectedCoefficient !== undefined &&
        allocationMatchesScaledCoefficient(entry, expectedCoefficient, request.precision)
      );
    })
  );
};

export const PricingAllocationAppliedSchema = Schema.Struct({
  allocations: Schema.Array(PricingAllocationLineSchema).check(Schema.isMinLength(1)),
  capacityInvariant: Schema.optionalKey(Schema.Literal('EVERY_ALLOCATION_WITHIN_ELIGIBLE_INTERMEDIATE')),
  outcome: Schema.Literal('ALLOCATION_APPLIED'),
  request: Schema.Union([
    PricingOwnerExactAllocationRequestSchema,
    PricingGenericAllocationRequestSchema,
    PricingWholePurchaseContractualAllocationRequestSchema,
  ]),
  sumInvariant: Schema.Literal('ALLOCATIONS_SUM_TO_ORIGINAL_CONTRIBUTION'),
}).check(
  Schema.makeFilter(({ allocations, capacityInvariant, request }) => {
    if (!appliedAllocationsMatchRequest(request, allocations)) {
      return 'Applied allocations must preserve the original contribution, stable recipients, and declared allocation rule';
    }
    if (request.allocationKind !== 'WHOLE_PURCHASE_CONTRACTUAL') {
      return capacityInvariant === undefined
        ? undefined
        : 'Recipient capacity proof belongs only to whole-purchase contractual allocation';
    }
    if (capacityInvariant === undefined) {
      return 'Whole-purchase contractual allocation must preserve an explicit recipient capacity proof';
    }
    return allocations.every((entry) => {
      const recipient = request.eligibleBasis.recipients.find(
        ({ occurrenceId }) => occurrenceId === entry.occurrenceId,
      );
      return (
        recipient !== undefined &&
        compareNonNegativeDecimals(decimalMagnitude(entry.amount.amount), recipient.intermediateValue.amount) <= 0
      );
    })
      ? undefined
      : 'Whole-purchase allocation must keep every reduction within its recipient intermediate value';
  }),
);
export type PricingAllocationApplied = typeof PricingAllocationAppliedSchema.Type;

export const PricingAllocationNotApplicableSchema = Schema.Struct({
  outcome: Schema.Literal('ALLOCATION_NOT_APPLICABLE'),
  request: PricingWholePurchaseContractualNotApplicableRequestSchema,
});
export type PricingAllocationNotApplicable = typeof PricingAllocationNotApplicableSchema.Type;

export const PricingAllocationFailureSchema = Schema.Struct({
  outcome: Schema.Literal('ALLOCATION_FAILED'),
  reason: Schema.Literals(['GENERIC_ZERO_BASIS', 'PRECISION_UNSUPPORTED', 'ARITHMETIC_OVERFLOW']),
  request: PricingComputedAllocationRequestSchema,
}).check(
  Schema.makeFilter(({ reason, request }) => {
    if (reason !== 'GENERIC_ZERO_BASIS') {
      return [];
    }
    return request.allocationKind === 'GENERIC_PROPORTIONAL' && genericBasisTotalIsZero(request)
      ? undefined
      : 'GENERIC_ZERO_BASIS is valid only for a generic request whose eligible Base Line Value sum is zero';
  }),
);
export type PricingAllocationFailure = typeof PricingAllocationFailureSchema.Type;

export const PricingAllocationResultSchema = Schema.Union([
  PricingAllocationAppliedSchema,
  PricingAllocationNotApplicableSchema,
  PricingAllocationFailureSchema,
]);
export type PricingAllocationResult = typeof PricingAllocationResultSchema.Type;
