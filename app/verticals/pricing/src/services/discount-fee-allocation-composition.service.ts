import type {
  PricingAllocationLine,
  PricingAllocationPrecision,
  PricingAllocationRequest,
  PricingAllocationResult,
  PricingAllocationSourceEvidence,
  PricingGenericAllocationRequest,
  PricingOwnerExactAllocationRequest,
} from '@app/pricing-contracts/domain/discount-fee-allocation';
import type { PricingDecision } from '@app/pricing-contracts/pricing-decision';
import { PricingDecisionSchema } from '@app/pricing-contracts/pricing-decision';
import { Effect, Schema } from 'effect';

import type { PricingDiscountFeeAllocationRejected } from './discount-fee-allocation.service.ts';
import { allocatePricingDiscountsAndFees } from './discount-fee-allocation.service.ts';

export interface PricingAllocationRecipientClassification {
  readonly occurrenceId: string;
  readonly recipientKind: 'MERCHANDISE' | 'SHIPPING';
}

type PricingMoney = PricingAllocationLine['amount'];

export interface PricingFeeContributionEvidence {
  readonly amount: PricingMoney;
  readonly fee: {
    readonly definition: {
      readonly feeRef: { readonly moduleId: string; readonly resourceId: string };
      readonly revision: { readonly revisionId: string };
    };
  };
  readonly occurrenceId: string;
}

export interface PricingAppliedFeeCompositionEvidence {
  readonly contributions: readonly PricingFeeContributionEvidence[];
  readonly contributionTotal: PricingMoney;
  readonly discountableLineBasis: PricingMoney;
  readonly input: {
    readonly baseLineValue: PricingMoney;
    readonly decision: typeof PricingDecisionSchema.Type;
    readonly occurrenceId: string;
  };
  readonly outcome: 'COMMERCIAL_FEES_APPLIED';
}

export interface PricingLineDiscountCompositionEvidence {
  readonly amount: PricingMoney;
  readonly basis: { readonly amount: PricingMoney; readonly occurrenceId: string };
  readonly candidate: {
    readonly definition: {
      readonly discountId: string;
      readonly revision: { readonly revisionId: string };
    };
    readonly occurrenceId: string;
  };
}

type PricingWholePurchaseBasis = Extract<
  PricingAllocationRequest,
  { readonly allocationKind: 'WHOLE_PURCHASE_CONTRACTUAL' }
>['eligibleBasis'];

export interface PricingDiscountCompositionEvidence {
  readonly lineContributions: readonly PricingLineDiscountCompositionEvidence[];
  readonly outcome: 'DISCOUNT_COMPOSITION_READY';
  readonly request: {
    readonly decision: typeof PricingDecisionSchema.Type;
    readonly lineBases: readonly {
      readonly amount: PricingMoney;
      readonly applicablePricingFeeTotal: PricingMoney;
      readonly baseLineValue: PricingMoney;
      readonly occurrenceId: string;
    }[];
  };
  readonly wholePurchaseContribution?: {
    readonly amount: PricingOwnerExactAllocationRequest['originalContribution'];
    readonly candidate: {
      readonly applicability: { readonly basis: PricingWholePurchaseBasis };
      readonly definition: {
        readonly discountId: string;
        readonly revision: { readonly revisionId: string };
      };
    };
  };
}

export interface PricingOwnerExactCompositionContribution {
  readonly originalContribution: PricingOwnerExactAllocationRequest['originalContribution'];
  readonly ownerAllocations: PricingOwnerExactAllocationRequest['ownerAllocations'];
  readonly source: PricingAllocationSourceEvidence;
}

export interface PricingGenericCompositionContribution {
  readonly eligibleOccurrenceIds: readonly string[];
  readonly originalContribution: PricingGenericAllocationRequest['originalContribution'];
  readonly source: PricingAllocationSourceEvidence;
}

export interface PricingDiscountFeeAllocationCompositionInput {
  readonly discountComposition: PricingDiscountCompositionEvidence;
  readonly feeResults: readonly PricingAppliedFeeCompositionEvidence[];
  readonly genericContributions?: readonly PricingGenericCompositionContribution[];
  readonly ownerExactContributions?: readonly PricingOwnerExactCompositionContribution[];
  readonly precision: PricingAllocationPrecision;
  readonly recipientClassifications: readonly PricingAllocationRecipientClassification[];
}

export interface PricingDiscountFeeLineIntermediate {
  readonly baseLineValue: PricingMoney;
  readonly discountableLineBasis: PricingMoney;
  readonly feeContributions: readonly PricingFeeContributionEvidence[];
  readonly lineDiscountContributions: readonly PricingLineDiscountCompositionEvidence[];
  readonly occurrenceId: string;
  readonly recipientKind: PricingAllocationRecipientClassification['recipientKind'];
  readonly value: PricingMoney;
}

export interface PricingDiscountFeeComposedLine {
  readonly multiLineAllocations: readonly PricingAllocationLine[];
  readonly occurrenceId: string;
  readonly preAllocationIntermediateValue: PricingMoney;
  readonly rawPostAllocationValue: PricingMoney;
  readonly recipientKind: PricingAllocationRecipientClassification['recipientKind'];
}

interface PricingDiscountFeeAllocationCompositionBase {
  readonly allocationResults: readonly PricingAllocationResult[];
  readonly decision: PricingDecision;
  readonly lineIntermediates: readonly PricingDiscountFeeLineIntermediate[];
}

export interface PricingDiscountFeeAllocationCompositionReady extends PricingDiscountFeeAllocationCompositionBase {
  readonly composedLines: readonly PricingDiscountFeeComposedLine[];
  readonly outcome: 'ALLOCATION_COMPOSITION_READY';
}

export interface PricingDiscountFeeAllocationCompositionFailed extends PricingDiscountFeeAllocationCompositionBase {
  readonly outcome: 'ALLOCATION_COMPOSITION_FAILED';
}

export type PricingDiscountFeeAllocationCompositionResult =
  | PricingDiscountFeeAllocationCompositionFailed
  | PricingDiscountFeeAllocationCompositionReady;

export class PricingDiscountFeeAllocationCompositionRejected extends Schema.TaggedError<PricingDiscountFeeAllocationCompositionRejected>()(
  'PricingDiscountFeeAllocationCompositionRejected',
  {
    code: Schema.Literals([
      'COMPOSITION_INPUT_INVALID',
      'COMPOSITION_BASIS_UNVERIFIABLE',
      'COMPOSITION_OWNER_IDENTITY_CONFLICT',
    ]),
    reason: Schema.String,
  },
) {}

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

const sumDecimals = (values: readonly string[]): string => {
  const parts = values.map(decimalParts);
  const scale = Math.max(0, ...parts.map((part) => part.scale));
  return formatDecimal(
    parts.reduce((sum, part) => sum + alignedCoefficient(part, scale), 0n),
    scale,
  );
};

const decimalsEqual = (left: string, right: string): boolean => {
  const leftParts = decimalParts(left);
  const rightParts = decimalParts(right);
  const scale = Math.max(leftParts.scale, rightParts.scale);
  return alignedCoefficient(leftParts, scale) === alignedCoefficient(rightParts, scale);
};

const isPositive = (value: string): boolean => decimalParts(value).coefficient > 0n;
const isNonNegative = (value: string): boolean => decimalParts(value).coefficient >= 0n;

const reject = (
  code: PricingDiscountFeeAllocationCompositionRejected['code'],
  reason: string,
): PricingDiscountFeeAllocationCompositionRejected =>
  new PricingDiscountFeeAllocationCompositionRejected({ code, reason });

const sameDecision = Schema.toEquivalence(PricingDecisionSchema);

const sourceForFee = (contribution: PricingFeeContributionEvidence): PricingAllocationSourceEvidence => ({
  allocationAuthority: 'LINE_NATIVE',
  logicalFactRef: contribution.fee.definition.feeRef.resourceId,
  ownerModuleId: contribution.fee.definition.feeRef.moduleId,
  revisionRef: contribution.fee.definition.revision.revisionId,
  sourceKind: 'PRICING_FEE',
});

const sourceForDiscount = (contribution: PricingLineDiscountCompositionEvidence): PricingAllocationSourceEvidence => ({
  allocationAuthority: 'LINE_NATIVE',
  logicalFactRef: contribution.candidate.definition.discountId,
  ownerModuleId: 'commerce.pricing',
  revisionRef: contribution.candidate.definition.revision.revisionId,
  sourceKind: 'PRICING_DISCOUNT',
});

const allocationLine = (occurrenceId: string, amount: PricingMoney): PricingAllocationLine => ({
  amount,
  occurrenceId,
  recipientKind: 'MERCHANDISE',
});

const lineNativeRequest = (
  decision: PricingDiscountCompositionEvidence['request']['decision'],
  precision: PricingAllocationPrecision,
  occurrenceId: string,
  amount: PricingOwnerExactAllocationRequest['originalContribution'],
  source: PricingAllocationSourceEvidence,
): PricingOwnerExactAllocationRequest => ({
  allocationKind: 'OWNER_EXACT',
  decision,
  originalContribution: amount,
  ownerAllocations: [allocationLine(occurrenceId, amount)],
  ownerScope: 'LINE_NATIVE',
  precision,
  source,
});

const exactClassifications = (
  input: PricingDiscountFeeAllocationCompositionInput,
): ReadonlyMap<string, PricingAllocationRecipientClassification> | null => {
  const occurrenceIds = input.recipientClassifications.map(({ occurrenceId }) => occurrenceId);
  const decisionIds = input.discountComposition.request.decision.lines.map(({ occurrenceId }) => occurrenceId);
  const occurrenceIdSet = new Set(occurrenceIds);
  if (
    occurrenceIds.length !== decisionIds.length ||
    occurrenceIdSet.size !== occurrenceIds.length ||
    !decisionIds.every((occurrenceId) => occurrenceIdSet.has(occurrenceId))
  ) {
    return null;
  }
  return new Map(input.recipientClassifications.map((classification) => [classification.occurrenceId, classification]));
};

const ownerIdentityConflict = (input: PricingDiscountFeeAllocationCompositionInput): null | string => {
  for (const feeResult of input.feeResults) {
    const logicalFeeKeys = feeResult.contributions.map(
      ({ fee }) => `${fee.definition.feeRef.moduleId}:${fee.definition.feeRef.resourceId}`,
    );
    if (new Set(logicalFeeKeys).size !== logicalFeeKeys.length) {
      return 'A Pricing Line cannot apply duplicate or competing Revisions of one logical Commercial Fee';
    }
  }
  const logicalDiscountPaths = input.discountComposition.lineContributions.map(
    ({ candidate }) => `${candidate.occurrenceId}:${candidate.definition.discountId}`,
  );
  return new Set(logicalDiscountPaths).size === logicalDiscountPaths.length
    ? null
    : 'A Pricing Line path cannot apply duplicate or competing Revisions of one logical Discount';
};

type PricingCompositionLineBasis = PricingDiscountCompositionEvidence['request']['lineBases'][number];

const feeLineEvidenceIsCoherent = (
  currencyCode: string,
  occurrenceId: string,
  feeResult: PricingAppliedFeeCompositionEvidence,
  lineBasis: PricingCompositionLineBasis,
): boolean => {
  const contributionTotalAmount = feeResult.contributionTotal.amount;
  const discountableLineBasisAmount = feeResult.discountableLineBasis.amount;
  const baseLineValueAmount = feeResult.input.baseLineValue.amount;
  const feeContributionAmounts = feeResult.contributions.map(({ amount }) => amount.amount);
  const currencies = [
    feeResult.discountableLineBasis.currencyCode,
    feeResult.input.baseLineValue.currencyCode,
    feeResult.contributionTotal.currencyCode,
    lineBasis.amount.currencyCode,
    lineBasis.applicablePricingFeeTotal.currencyCode,
    lineBasis.baseLineValue.currencyCode,
    ...feeResult.contributions.map(({ amount }) => amount.currencyCode),
  ];
  const contributionsBindLine = feeResult.contributions.every(
    (contribution) => contribution.occurrenceId === occurrenceId,
  );
  const arithmeticMatches = [
    decimalsEqual(contributionTotalAmount, sumDecimals(feeContributionAmounts)),
    decimalsEqual(discountableLineBasisAmount, sumDecimals([baseLineValueAmount, contributionTotalAmount])),
    decimalsEqual(discountableLineBasisAmount, lineBasis.amount.amount),
    decimalsEqual(baseLineValueAmount, lineBasis.baseLineValue.amount),
    decimalsEqual(contributionTotalAmount, lineBasis.applicablePricingFeeTotal.amount),
    decimalsEqual(
      lineBasis.amount.amount,
      sumDecimals([lineBasis.baseLineValue.amount, lineBasis.applicablePricingFeeTotal.amount]),
    ),
  ];
  return (
    currencies.every((nestedCurrencyCode) => nestedCurrencyCode === currencyCode) &&
    contributionsBindLine &&
    arithmeticMatches.every(Boolean)
  );
};

const lineDiscountEvidenceIsCoherent = (
  currencyCode: string,
  occurrenceId: string,
  lineBasisAmount: string,
  contributions: readonly PricingLineDiscountCompositionEvidence[],
): boolean =>
  contributions.every(
    (contribution) =>
      contribution.amount.currencyCode === currencyCode &&
      contribution.basis.amount.currencyCode === currencyCode &&
      contribution.basis.occurrenceId === occurrenceId &&
      decimalsEqual(contribution.basis.amount.amount, lineBasisAmount),
  );

const buildIntermediates = (
  input: PricingDiscountFeeAllocationCompositionInput,
  classifications: ReadonlyMap<string, PricingAllocationRecipientClassification>,
): null | readonly PricingDiscountFeeLineIntermediate[] => {
  const {
    discountComposition: {
      lineContributions,
      request: { decision, lineBases },
    },
    feeResults,
  } = input;
  const decisionOccurrenceIds = new Set(decision.lines.map(({ occurrenceId }) => occurrenceId));
  const lineBasisIds = lineBases.map(({ occurrenceId }) => occurrenceId);
  if (
    lineBasisIds.length !== decisionOccurrenceIds.size ||
    new Set(lineBasisIds).size !== lineBasisIds.length ||
    !lineBasisIds.every((occurrenceId) => decisionOccurrenceIds.has(occurrenceId)) ||
    lineContributions.some(
      ({ amount, basis, candidate }) =>
        !decisionOccurrenceIds.has(candidate.occurrenceId) ||
        basis.occurrenceId !== candidate.occurrenceId ||
        amount.currencyCode !== decision.currencyCode ||
        basis.amount.currencyCode !== decision.currencyCode,
    )
  ) {
    return null;
  }
  const feeIds = feeResults.map(({ input: feeInput }) => feeInput.occurrenceId);
  const feeIdSet = new Set(feeIds);
  if (
    feeIds.length !== decision.lines.length ||
    feeIdSet.size !== feeIds.length ||
    !decision.lines.every(({ occurrenceId }) => feeIdSet.has(occurrenceId)) ||
    feeResults.some(({ input: feeInput }) => !sameDecision(feeInput.decision, decision))
  ) {
    return null;
  }

  const intermediates: PricingDiscountFeeLineIntermediate[] = [];
  const feeByOccurrence = new Map(feeResults.map((feeResult) => [feeResult.input.occurrenceId, feeResult]));
  const lineBasisByOccurrence = new Map(lineBases.map((lineBasis) => [lineBasis.occurrenceId, lineBasis]));
  for (const { occurrenceId } of decision.lines) {
    const feeResult = feeByOccurrence.get(occurrenceId);
    const lineBasis = lineBasisByOccurrence.get(occurrenceId);
    const classification = classifications.get(occurrenceId);
    if (feeResult === undefined || lineBasis === undefined || classification === undefined) {
      return null;
    }
    if (!feeLineEvidenceIsCoherent(decision.currencyCode, occurrenceId, feeResult, lineBasis)) {
      return null;
    }
    const lineDiscountContributions = lineContributions.filter(
      (contribution) => contribution.candidate.occurrenceId === occurrenceId,
    );
    if (
      !lineDiscountEvidenceIsCoherent(
        decision.currencyCode,
        occurrenceId,
        lineBasis.amount.amount,
        lineDiscountContributions,
      )
    ) {
      return null;
    }
    intermediates.push({
      baseLineValue: feeResult.input.baseLineValue,
      discountableLineBasis: feeResult.discountableLineBasis,
      feeContributions: feeResult.contributions,
      lineDiscountContributions,
      occurrenceId,
      recipientKind: classification.recipientKind,
      value: {
        amount: sumDecimals([
          feeResult.discountableLineBasis.amount,
          ...lineDiscountContributions.map(({ amount }) => amount.amount),
        ]),
        currencyCode: decision.currencyCode,
      },
    });
  }
  return intermediates;
};

const wholePurchaseRequest = (
  input: PricingDiscountFeeAllocationCompositionInput,
  intermediates: readonly PricingDiscountFeeLineIntermediate[],
): null | PricingAllocationRequest | undefined => {
  const whole = input.discountComposition.wholePurchaseContribution;
  if (whole === undefined) {
    return undefined;
  }
  const derivedRecipients = intermediates.flatMap(({ occurrenceId, recipientKind, value }) =>
    recipientKind === 'MERCHANDISE' && isPositive(value.amount)
      ? [{ intermediateValue: value, occurrenceId, recipientKind } as const]
      : [],
  );
  const derivedEligibleAmount = sumDecimals(derivedRecipients.map(({ intermediateValue }) => intermediateValue.amount));
  const evidenceBasis = whole.candidate.applicability.basis;
  if (
    !decimalsEqual(evidenceBasis.eligibleAmount, derivedEligibleAmount) ||
    evidenceBasis.currencyCode !== input.discountComposition.request.decision.currencyCode ||
    evidenceBasis.recipients.length !== derivedRecipients.length ||
    !evidenceBasis.recipients.every((recipient) =>
      derivedRecipients.some(
        (derived) =>
          derived.occurrenceId === recipient.occurrenceId &&
          decimalsEqual(derived.intermediateValue.amount, recipient.intermediateValue.amount) &&
          derived.intermediateValue.currencyCode === recipient.intermediateValue.currencyCode,
      ),
    )
  ) {
    return null;
  }
  return {
    allocationKind: 'WHOLE_PURCHASE_CONTRACTUAL',
    decision: input.discountComposition.request.decision,
    eligibleBasis: evidenceBasis,
    originalContribution: whole.amount,
    precision: input.precision,
    source: {
      allocationAuthority: 'PRICING_WHOLE_PURCHASE_CONTRACTUAL',
      logicalFactRef: whole.candidate.definition.discountId,
      ownerModuleId: 'commerce.pricing',
      revisionRef: whole.candidate.definition.revision.revisionId,
      sourceKind: 'PRICING_DISCOUNT',
    },
  };
};

const allocationRequests = (
  input: PricingDiscountFeeAllocationCompositionInput,
  intermediates: readonly PricingDiscountFeeLineIntermediate[],
): null | readonly PricingAllocationRequest[] => {
  const {
    discountComposition: {
      request: { decision },
    },
  } = input;
  const requests: PricingAllocationRequest[] = [];
  const classificationByOccurrence = new Map(
    intermediates.map(({ occurrenceId, recipientKind }) => [occurrenceId, recipientKind]),
  );
  for (const intermediate of intermediates) {
    if (intermediate.recipientKind !== 'MERCHANDISE') {
      if (intermediate.feeContributions.length > 0 || intermediate.lineDiscountContributions.length > 0) {
        return null;
      }
      continue;
    }
    for (const contribution of intermediate.feeContributions) {
      requests.push(
        lineNativeRequest(
          decision,
          input.precision,
          intermediate.occurrenceId,
          contribution.amount,
          sourceForFee(contribution),
        ),
      );
    }
    for (const contribution of intermediate.lineDiscountContributions) {
      requests.push(
        lineNativeRequest(
          decision,
          input.precision,
          intermediate.occurrenceId,
          contribution.amount,
          sourceForDiscount(contribution),
        ),
      );
    }
  }
  for (const contribution of input.ownerExactContributions ?? []) {
    if (
      contribution.ownerAllocations.some(
        ({ occurrenceId }) => classificationByOccurrence.get(occurrenceId) !== 'MERCHANDISE',
      )
    ) {
      return null;
    }
    requests.push({
      allocationKind: 'OWNER_EXACT',
      decision,
      originalContribution: contribution.originalContribution,
      ownerAllocations: contribution.ownerAllocations,
      ownerScope: 'MULTI_LINE',
      precision: input.precision,
      source: contribution.source,
    });
  }
  const intermediateByOccurrence = new Map(
    intermediates.map((intermediate) => [intermediate.occurrenceId, intermediate]),
  );
  for (const contribution of input.genericContributions ?? []) {
    if (new Set(contribution.eligibleOccurrenceIds).size !== contribution.eligibleOccurrenceIds.length) {
      return null;
    }
    const eligibleRecipients = [];
    for (const occurrenceId of contribution.eligibleOccurrenceIds) {
      const intermediate = intermediateByOccurrence.get(occurrenceId);
      if (
        intermediate === undefined ||
        intermediate.recipientKind !== 'MERCHANDISE' ||
        !isNonNegative(intermediate.baseLineValue.amount)
      ) {
        return null;
      }
      eligibleRecipients.push({
        baseLineValue: intermediate.baseLineValue,
        occurrenceId,
        recipientKind: 'MERCHANDISE' as const,
      });
    }
    requests.push({
      allocationKind: 'GENERIC_PROPORTIONAL',
      basisKind: 'ELIGIBLE_BASE_LINE_VALUE',
      decision,
      eligibleRecipients,
      originalContribution: contribution.originalContribution,
      precision: input.precision,
      source: contribution.source,
    });
  }
  const whole = wholePurchaseRequest(input, intermediates);
  if (whole === null) {
    return null;
  }
  if (whole !== undefined) {
    requests.push(whole);
  }
  return requests;
};

const multiLineAllocations = (results: readonly PricingAllocationResult[]): readonly PricingAllocationLine[] =>
  results.flatMap((result) => {
    if (result.outcome !== 'ALLOCATION_APPLIED') {
      return [];
    }
    if (result.request.allocationKind === 'OWNER_EXACT' && result.request.ownerScope === 'LINE_NATIVE') {
      return [];
    }
    return result.allocations;
  });

export const composePricingDiscountFeeAllocations = (
  input: PricingDiscountFeeAllocationCompositionInput,
): Effect.Effect<
  PricingDiscountFeeAllocationCompositionResult,
  PricingDiscountFeeAllocationCompositionRejected | PricingDiscountFeeAllocationRejected
> => {
  const identityConflict = ownerIdentityConflict(input);
  if (identityConflict !== null) {
    return Effect.fail(reject('COMPOSITION_OWNER_IDENTITY_CONFLICT', identityConflict));
  }
  const classifications = exactClassifications(input);
  if (classifications === null) {
    return Effect.fail(
      reject('COMPOSITION_INPUT_INVALID', 'Every original Pricing Line requires one exact recipient classification'),
    );
  }
  const intermediates = buildIntermediates(input, classifications);
  if (intermediates === null) {
    return Effect.fail(
      reject(
        'COMPOSITION_BASIS_UNVERIFIABLE',
        'Fee and line Discount evidence must bind one exact Decision line, Base Line Value, and currency',
      ),
    );
  }
  const requests = allocationRequests(input, intermediates);
  if (requests === null) {
    return Effect.fail(
      reject(
        'COMPOSITION_BASIS_UNVERIFIABLE',
        'Allocation recipients and whole-purchase evidence must bind the exact derived Pricing intermediates',
      ),
    );
  }
  return Effect.forEach(requests, (request) => allocatePricingDiscountsAndFees(request), { concurrency: 1 }).pipe(
    Effect.map((allocationResults): PricingDiscountFeeAllocationCompositionResult => {
      if (allocationResults.some(({ outcome }) => outcome === 'ALLOCATION_FAILED')) {
        return {
          allocationResults,
          decision: input.discountComposition.request.decision,
          lineIntermediates: intermediates,
          outcome: 'ALLOCATION_COMPOSITION_FAILED',
        };
      }
      const allocations = multiLineAllocations(allocationResults);
      return {
        allocationResults,
        composedLines: intermediates.map((intermediate) => {
          const lineAllocations = allocations.filter(({ occurrenceId }) => occurrenceId === intermediate.occurrenceId);
          return {
            multiLineAllocations: lineAllocations,
            occurrenceId: intermediate.occurrenceId,
            preAllocationIntermediateValue: intermediate.value,
            rawPostAllocationValue: {
              amount: sumDecimals([intermediate.value.amount, ...lineAllocations.map(({ amount }) => amount.amount)]),
              currencyCode: intermediate.value.currencyCode,
            },
            recipientKind: intermediate.recipientKind,
          };
        }),
        decision: input.discountComposition.request.decision,
        lineIntermediates: intermediates,
        outcome: 'ALLOCATION_COMPOSITION_READY',
      };
    }),
  );
};
