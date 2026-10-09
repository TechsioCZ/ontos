import {
  PricingCommercialFeeCalculationInputSchema,
  PricingCommercialFeeCalculationResultSchema,
  pricingCommercialFeeCurrentSetPredicateRef,
  pricingCommercialFeeIdentityKeysEqual,
} from '@app/pricing-contracts/domain/commercial-fee';
import type {
  PricingCommercialFeeCalculationInput,
  PricingCommercialFeeCalculationResult,
  PricingCommercialFeeContribution,
  ScheduledPricingCommercialFeeRevision,
} from '@app/pricing-contracts/domain/commercial-fee';
import { priceDecimalValuesEqual } from '@app/pricing-contracts/domain/price-definition';
import { Effect, Option, Schema } from 'effect';

export class PricingCommercialFeeCalculationRejected extends Schema.TaggedError<PricingCommercialFeeCalculationRejected>()(
  'PricingCommercialFeeCalculationRejected',
  {
    code: Schema.Literals(['CALCULATION_REQUEST_INVALID', 'CALCULATION_RESULT_INVALID']),
    reason: Schema.String,
  },
) {}

interface DecimalParts {
  readonly coefficient: bigint;
  readonly scale: number;
}

const decimalParts = (value: string): DecimalParts => {
  const [whole = '0', fractional = ''] = value.split('.');
  return { coefficient: BigInt(`${whole}${fractional}`), scale: fractional.length };
};

const formatDecimal = (coefficient: bigint, scale: number): string => {
  if (coefficient === 0n) {
    return '0';
  }
  const digits = coefficient.toString().padStart(scale + 1, '0');
  if (scale === 0) {
    return digits;
  }
  const whole = digits.slice(0, -scale);
  const fractional = digits.slice(-scale).replace(/0+$/u, '');
  return fractional.length === 0 ? whole : `${whole}.${fractional}`;
};

const alignCoefficient = (parts: DecimalParts, scale: number): bigint =>
  parts.coefficient * 10n ** BigInt(scale - parts.scale);

const addDecimals = (left: string, right: string): string => {
  const leftParts = decimalParts(left);
  const rightParts = decimalParts(right);
  const scale = Math.max(leftParts.scale, rightParts.scale);
  return formatDecimal(alignCoefficient(leftParts, scale) + alignCoefficient(rightParts, scale), scale);
};

const greatestCommonDivisor = (left: bigint, right: bigint): bigint => {
  let dividend = left;
  let divisor = right;
  while (divisor !== 0n) {
    const remainder = dividend % divisor;
    dividend = divisor;
    divisor = remainder;
  }
  return dividend;
};

/** Exact decimal multiplication by an exact rational quantity factor, with no rounding. */
const multiplyByQuantityBasis = (amount: string, quantity: string, basisQuantity: string): Option.Option<string> => {
  const amountParts = decimalParts(amount);
  const quantityParts = decimalParts(quantity);
  const basisParts = decimalParts(basisQuantity);
  let numerator = amountParts.coefficient * quantityParts.coefficient * 10n ** BigInt(basisParts.scale);
  let denominator = basisParts.coefficient * 10n ** BigInt(amountParts.scale + quantityParts.scale);
  const divisor = greatestCommonDivisor(numerator, denominator);
  numerator /= divisor;
  denominator /= divisor;

  let powerOfTwo = 0;
  let powerOfFive = 0;
  while (denominator % 2n === 0n) {
    denominator /= 2n;
    powerOfTwo += 1;
  }
  while (denominator % 5n === 0n) {
    denominator /= 5n;
    powerOfFive += 1;
  }
  if (denominator !== 1n) {
    return Option.none();
  }
  const scale = Math.max(powerOfTwo, powerOfFive);
  const coefficient = numerator * 2n ** BigInt(scale - powerOfTwo) * 5n ** BigInt(scale - powerOfFive);
  return Option.some(formatDecimal(coefficient, scale));
};

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

const decodeInput = Schema.decodeUnknownOption(PricingCommercialFeeCalculationInputSchema, {
  onExcessProperty: 'error',
});
const decodeResult = Schema.decodeUnknownOption(PricingCommercialFeeCalculationResultSchema, {
  onExcessProperty: 'error',
});

const reject = (
  code: PricingCommercialFeeCalculationRejected['code'],
  reason: string,
  cause?: unknown,
): PricingCommercialFeeCalculationRejected => {
  const failure = new PricingCommercialFeeCalculationRejected({ code, reason });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  }
  return failure;
};

type PricingCommercialFeeCalculationFailureReason = Extract<
  PricingCommercialFeeCalculationResult,
  { readonly outcome: 'COMMERCIAL_FEE_CALCULATION_FAILED' }
>['reason'];

const failed = (
  occurrenceId: PricingCommercialFeeCalculationInput['occurrenceId'],
  reason: PricingCommercialFeeCalculationFailureReason,
): PricingCommercialFeeCalculationResult => ({
  occurrenceId,
  outcome: 'COMMERCIAL_FEE_CALCULATION_FAILED',
  reason,
});

const exactKeyConflict = (
  fees: readonly ScheduledPricingCommercialFeeRevision[],
): readonly ScheduledPricingCommercialFeeRevision[] | undefined => {
  for (const fee of fees) {
    const claimants = fees.filter((candidate) =>
      pricingCommercialFeeIdentityKeysEqual(candidate.definition.identityKey, fee.definition.identityKey),
    );
    if (claimants.length > 1) {
      return claimants;
    }
  }
  return undefined;
};

const currentSetEvidenceFailure = (
  input: PricingCommercialFeeCalculationInput,
): PricingCommercialFeeCalculationFailureReason | undefined => {
  const expectedPredicate = pricingCommercialFeeCurrentSetPredicateRef({
    commercialScope: input.feeSet.commercialScope,
    currencyCode: input.feeSet.currencyCode,
    target: input.feeSet.target,
  });
  if (input.feeSet.completenessEvidence.scope.kind !== 'EXACT_PREDICATE') {
    return 'INCOMPLETE_CURRENT_SET';
  }
  if (
    input.feeSet.completenessEvidence.scope.predicateRef !== expectedPredicate ||
    input.feeSet.currentnessEvidence.predicateRef !== expectedPredicate ||
    input.feeSet.completenessEvidence.ownerRevision !== input.feeSet.currentnessEvidence.ownerRevision ||
    input.feeSet.currentnessEvidence.verificationMode !== 'OWNER_CURRENT_SET_REVALIDATED'
  ) {
    return 'UNVERIFIABLE_CURRENT_SET';
  }
  return input.feeSet.observedAt !== input.decision.operationTime ||
    input.feeSet.completenessEvidence.observedAt !== input.decision.operationTime ||
    input.feeSet.currentnessEvidence.observedAt !== input.decision.operationTime ||
    input.feeSet.currentnessEvidence.revalidatedAt < input.feeSet.observedAt ||
    (input.feeSet.completenessEvidence.nextApplicabilityBoundary !== undefined &&
      input.feeSet.currentnessEvidence.revalidatedAt >= input.feeSet.completenessEvidence.nextApplicabilityBoundary)
    ? 'STALE_CURRENT_SET'
    : undefined;
};

const monetaryFailure = (
  input: PricingCommercialFeeCalculationInput,
): PricingCommercialFeeCalculationFailureReason | undefined => {
  if (!input.currencySupport.supportedCurrencies.includes(input.decision.currencyCode)) {
    return 'CURRENCY_UNSUPPORTED';
  }
  if (
    input.baseLineValue.currencyCode !== input.decision.currencyCode ||
    input.feeSet.currencyCode !== input.decision.currencyCode ||
    input.feeSet.fees.some(
      ({ definition }) =>
        definition.identityKey.currencyCode !== input.decision.currencyCode ||
        definition.revision.configuredAmount.currencyCode !== input.decision.currencyCode,
    )
  ) {
    return 'CURRENCY_MISMATCH';
  }
  return undefined;
};

const currencySupportIsStale = (input: PricingCommercialFeeCalculationInput): boolean =>
  input.currencySupport.tenantId !== input.decision.tenantId ||
  input.currencySupport.effectiveAt !== input.decision.operationTime ||
  input.currencySupport.currentnessEvidence.evaluatedAt !== input.decision.operationTime ||
  input.currencySupport.currentnessEvidence.evaluationMode !== 'CURRENT_WITH_REVALIDATION';

const contributionFor = (
  input: PricingCommercialFeeCalculationInput,
  fee: ScheduledPricingCommercialFeeRevision,
): Option.Option<PricingCommercialFeeContribution> => {
  const configuredAmount = fee.definition.revision.configuredAmount.amount;
  if (priceDecimalValuesEqual(configuredAmount, '0')) {
    return Option.none();
  }
  const { calculationBasis } = fee.definition.identityKey;
  if (calculationBasis.kind === 'FIXED_PER_LINE') {
    return Option.some({
      amount: { amount: configuredAmount, currencyCode: input.decision.currencyCode },
      appliedQuantity: { count: '1', kind: 'LINE' },
      fee,
      monetaryBoundary: 'PRE_TAX',
      occurrenceId: input.occurrenceId,
    });
  }
  const line = input.decision.lines.find(({ occurrenceId }) => occurrenceId === input.occurrenceId);
  if (line === undefined || !sameResourceRef(calculationBasis.unitBasis.unitRef, line.pricingBasis.unitRef)) {
    return Option.none();
  }
  const amount = multiplyByQuantityBasis(
    configuredAmount,
    line.pricingBasis.quantity,
    calculationBasis.unitBasis.quantity,
  );
  return Option.isSome(amount)
    ? Option.some({
        amount: { amount: amount.value, currencyCode: input.decision.currencyCode },
        appliedQuantity: {
          kind: 'QUANTITY',
          quantity: line.pricingBasis.quantity,
          unitRef: line.pricingBasis.unitRef,
        },
        fee,
        monetaryBoundary: 'PRE_TAX',
        occurrenceId: input.occurrenceId,
      })
    : Option.none();
};

/**
 * Applies only an owner-proven complete Current Fee set to one original stable Pricing Line.
 * The resulting Fee total is added to the line basis exactly once and the full input/fact evidence is retained.
 */
export const calculatePricingCommercialFees = (
  rawInput: PricingCommercialFeeCalculationInput,
): Effect.Effect<PricingCommercialFeeCalculationResult, PricingCommercialFeeCalculationRejected> => {
  const line = rawInput.decision.lines.find(({ occurrenceId }) => occurrenceId === rawInput.occurrenceId);
  if (line === undefined) {
    return Effect.fail(reject('CALCULATION_REQUEST_INVALID', 'Commercial Fee calculation lost its original line'));
  }
  const evidenceFailure = currentSetEvidenceFailure(rawInput);
  if (evidenceFailure !== undefined) {
    return Effect.succeed(failed(rawInput.occurrenceId, evidenceFailure));
  }
  if (currencySupportIsStale(rawInput)) {
    return Effect.succeed(failed(rawInput.occurrenceId, 'STALE_CURRENT_SET'));
  }
  const moneyFailure = monetaryFailure(rawInput);
  if (moneyFailure !== undefined) {
    return Effect.succeed(failed(rawInput.occurrenceId, moneyFailure));
  }

  const decodedInput = decodeInput(rawInput);
  if (Option.isNone(decodedInput)) {
    return Effect.fail(
      reject(
        'CALCULATION_REQUEST_INVALID',
        'Commercial Fee calculation requires exact line, Variant, commercial scope, Current set, and owner evidence',
      ),
    );
  }
  const input = decodedInput.value;
  const conflict = exactKeyConflict(input.feeSet.fees);
  if (conflict !== undefined) {
    const [first] = conflict;
    if (first === undefined) {
      return Effect.fail(reject('CALCULATION_RESULT_INVALID', 'Commercial Fee conflict had no claimant'));
    }
    const conflictResult: PricingCommercialFeeCalculationResult = {
      candidateRevisionIds: conflict.map(({ definition }) => definition.revision.revisionId),
      identityKey: first.definition.identityKey,
      occurrenceId: input.occurrenceId,
      outcome: 'COMMERCIAL_FEE_CALCULATION_CONFLICT',
    };
    const decodedConflict = decodeResult(conflictResult);
    return Effect.fromOption(decodedConflict).pipe(
      Effect.mapError((cause) =>
        reject('CALCULATION_RESULT_INVALID', 'Commercial Fee conflict evidence was invalid', cause),
      ),
    );
  }

  const contributionOptions = input.feeSet.fees.map((fee) => contributionFor(input, fee));
  const invalidQuantityBasis = input.feeSet.fees.some(({ definition }) => {
    const { calculationBasis } = definition.identityKey;
    if (calculationBasis.kind === 'FIXED_PER_LINE') {
      return false;
    }
    return (
      !sameResourceRef(calculationBasis.unitBasis.unitRef, line.pricingBasis.unitRef) ||
      Option.isNone(
        multiplyByQuantityBasis(
          definition.revision.configuredAmount.amount,
          line.pricingBasis.quantity,
          calculationBasis.unitBasis.quantity,
        ),
      )
    );
  });
  if (invalidQuantityBasis) {
    return Effect.succeed(failed(input.occurrenceId, 'QUANTITY_BASIS_MISMATCH'));
  }
  const contributions = contributionOptions.flatMap((contribution) =>
    Option.isSome(contribution) ? [contribution.value] : [],
  );
  let contributionTotal = '0';
  for (const contribution of contributions) {
    contributionTotal = addDecimals(contributionTotal, contribution.amount.amount);
  }
  const result: PricingCommercialFeeCalculationResult = {
    contributions,
    contributionTotal: { amount: contributionTotal, currencyCode: input.decision.currencyCode },
    discountableLineBasis: {
      amount: addDecimals(input.baseLineValue.amount, contributionTotal),
      currencyCode: input.decision.currencyCode,
    },
    input,
    outcome: 'COMMERCIAL_FEES_APPLIED',
  };
  const decodedResult = decodeResult(result);
  return Effect.fromOption(decodedResult).pipe(
    Effect.mapError((cause) =>
      reject('CALCULATION_RESULT_INVALID', 'Commercial Fee calculation did not satisfy its evidence contract', cause),
    ),
  );
};
