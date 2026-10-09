import { CurrentSupportedCurrenciesSuccessSchema } from '@app/pricing-contracts/current-supported-currencies';
import type { CurrentSupportedCurrenciesSuccess } from '@app/pricing-contracts/current-supported-currencies';
import {
  PricingDiscountAudienceEvidenceBindingSchema,
  PricingDiscountCurrentResolutionSchema,
  PricingWholePurchaseContractualApplicabilitySchema,
  PricingWholePurchaseContractualEligibleBasisSchema,
  pricingDiscountIdentityKeysEqual,
} from '@app/pricing-contracts/domain/discount';
import type {
  PricingDiscountAudienceEvidenceBinding,
  PricingDiscountCurrentResolution,
  PricingDiscountDefinition,
  PricingDiscountIdentityKey,
  PricingWholePurchaseContractualApplicability,
  PricingWholePurchaseContractualEligibleBasis,
  ScheduledPricingDiscountRevision,
} from '@app/pricing-contracts/domain/discount';
import { Effect, Option, Schema } from 'effect';

export class PricingDiscountApplicabilityRejected extends Schema.TaggedError<PricingDiscountApplicabilityRejected>()(
  'PricingDiscountApplicabilityRejected',
  {
    code: Schema.Literals([
      'AUDIENCE_EVIDENCE_INVALID',
      'CURRENT_RESOLUTION_INVALID',
      'CURRENT_RESOLUTION_MISMATCH',
      'WHOLE_PURCHASE_BASIS_REQUIRED',
      'MONETARY_INTERMEDIATE_INVALID',
      'CURRENCY_MISMATCH',
      'WHOLE_PURCHASE_APPLICABILITY_INVALID',
      'CURRENCY_SUPPORT_INVALID',
      'CURRENCY_SUPPORT_MISMATCH',
      'CURRENCY_UNSUPPORTED',
    ]),
    reason: Schema.String,
  },
) {}

export interface PricingDiscountMonetaryIntermediate {
  readonly amount: {
    readonly amount: string;
    readonly currencyCode: string;
  };
  readonly occurrenceId: string;
  readonly recipientKind: 'DELIVERY' | 'MERCHANDISE' | 'SHIPPING';
}

export interface PricingWholePurchaseThresholdInput {
  readonly configuredAmount: {
    readonly amount: string;
    readonly currencyCode: string;
  };
  readonly decisionCurrencyCode: string;
  readonly intermediates: readonly PricingDiscountMonetaryIntermediate[];
}

export type PricingWholePurchaseThresholdResult =
  | {
      readonly basis: PricingWholePurchaseContractualEligibleBasis;
      readonly outcome: 'WHOLE_PURCHASE_DISCOUNT_NOT_APPLICABLE';
      readonly reason: 'BASIS_NOT_GREATER_THAN_DISCOUNT' | 'EMPTY_ELIGIBLE_SET';
    }
  | {
      readonly applicationCount: 'ONCE_PER_PRICING_DECISION';
      readonly basis: PricingWholePurchaseContractualEligibleBasis;
      readonly contribution: { readonly amount: string; readonly currencyCode: string };
      readonly outcome: 'WHOLE_PURCHASE_DISCOUNT_APPLICABLE';
    };

export interface InterpretPricingDiscountApplicabilityInput {
  readonly audienceBinding: PricingDiscountAudienceEvidenceBinding;
  readonly currencySupport: CurrentSupportedCurrenciesSuccess;
  readonly currentResolution: PricingDiscountCurrentResolution;
  readonly wholePurchaseIntermediates?: readonly PricingDiscountMonetaryIntermediate[];
}

type DiscountApplicabilityEvidence = Pick<PricingDiscountAudienceEvidenceBinding, 'basePricePath' | 'evidence'>;

export type PricingDiscountApplicability =
  | (DiscountApplicabilityEvidence & {
      readonly currentResolution: Extract<
        PricingDiscountCurrentResolution,
        { readonly outcome: 'DISCOUNT_CURRENT_ABSENT' }
      >;
      readonly outcome: 'DISCOUNT_ABSENT';
    })
  | (DiscountApplicabilityEvidence & {
      readonly currentResolution: Extract<
        PricingDiscountCurrentResolution,
        { readonly outcome: 'DISCOUNT_CURRENT_CONFLICT' }
      >;
      readonly outcome: 'DISCOUNT_CONFLICT';
    })
  | (DiscountApplicabilityEvidence & {
      readonly currentResolution: Extract<
        PricingDiscountCurrentResolution,
        { readonly outcome: 'DISCOUNT_REVISION_INVARIANT_VIOLATION' }
      >;
      readonly outcome: 'DISCOUNT_INVARIANT_VIOLATION';
    })
  | (DiscountApplicabilityEvidence & {
      readonly applicationCount: 'ONCE_PER_STABLE_LINE';
      readonly definition: PricingDiscountDefinition;
      readonly outcome: 'DISCOUNT_APPLICABLE';
    })
  | (DiscountApplicabilityEvidence & {
      readonly applicability: PricingWholePurchaseContractualApplicability;
      readonly applicationCount: 'ONCE_PER_PRICING_DECISION';
      readonly definition: PricingDiscountDefinition;
      readonly outcome: 'DISCOUNT_APPLICABLE' | 'DISCOUNT_NOT_APPLICABLE';
    });

interface EffectiveRevisionCandidate {
  readonly effectivePeriod: { readonly effectiveFrom: string; readonly effectiveTo: null | string };
}

export type EffectivePricingDiscountRevisionInterpretation<T extends EffectiveRevisionCandidate> =
  | { readonly outcome: 'DISCOUNT_REVISION_ABSENT' }
  | { readonly outcome: 'DISCOUNT_REVISION_CURRENT'; readonly revision: T }
  | { readonly conflictingRevisions: readonly T[]; readonly outcome: 'DISCOUNT_REVISION_CONFLICT' };

const reject = (
  code: PricingDiscountApplicabilityRejected['code'],
  reason: string,
  cause?: unknown,
): PricingDiscountApplicabilityRejected => {
  const failure = new PricingDiscountApplicabilityRejected({ code, reason });
  return cause === undefined ? failure : Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
};

const decodeAudienceEvidenceBinding = Schema.decodeUnknownOption(PricingDiscountAudienceEvidenceBindingSchema, {
  onExcessProperty: 'error',
});
const decodeCurrentResolution = Schema.decodeUnknownOption(PricingDiscountCurrentResolutionSchema, {
  onExcessProperty: 'error',
});
const decodeCurrencySupport = Schema.decodeUnknownOption(CurrentSupportedCurrenciesSuccessSchema, {
  onExcessProperty: 'error',
});
const decodeWholePurchaseApplicability = Schema.decodeUnknownOption(
  PricingWholePurchaseContractualApplicabilitySchema,
  { onExcessProperty: 'error' },
);
const decodeWholePurchaseBasis = Schema.decodeUnknownOption(PricingWholePurchaseContractualEligibleBasisSchema, {
  onExcessProperty: 'error',
});

const signedDecimalPattern = /^(?:-(?:0\.\d*[1-9]\d*|[1-9]\d*(?:\.\d+)?)|0(?:\.\d+)?|[1-9]\d*(?:\.\d+)?)$/u;

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

const compareDecimals = (left: string, right: string): -1 | 0 | 1 => {
  const leftParts = decimalParts(left);
  const rightParts = decimalParts(right);
  const scale = Math.max(leftParts.scale, rightParts.scale);
  const leftCoefficient = alignedCoefficient(leftParts, scale);
  const rightCoefficient = alignedCoefficient(rightParts, scale);
  if (leftCoefficient < rightCoefficient) {
    return -1;
  }
  if (leftCoefficient > rightCoefficient) {
    return 1;
  }
  return 0;
};

const formatDecimal = (coefficient: bigint, scale: number): string => {
  if (scale === 0) {
    return coefficient.toString();
  }
  const negative = coefficient < 0n;
  const absolute = negative ? -coefficient : coefficient;
  const padded = absolute.toString().padStart(scale + 1, '0');
  const integer = padded.slice(0, -scale);
  const fraction = padded.slice(-scale).replace(/0+$/u, '');
  const unsigned = fraction.length === 0 ? integer : `${integer}.${fraction}`;
  return negative ? `-${unsigned}` : unsigned;
};

const sumDecimals = (values: readonly string[]): string => {
  const parts = values.map(decimalParts);
  const scale = Math.max(0, ...parts.map((part) => part.scale));
  const coefficient = parts.reduce((sum, part) => sum + alignedCoefficient(part, scale), 0n);
  return formatDecimal(coefficient, scale);
};

const negativeContribution = (amount: string): string => (/^0(?:\.0+)?$/u.test(amount) ? '0' : `-${amount}`);

/**
 * Interprets half-open Currentness without picking latest, largest, or source-order winners.
 * The owner-visible generic keeps this exact cardinality rule reusable while the typed wrapper
 * below retains Discount identities and Revision evidence.
 */
export const interpretEffectivePricingDiscountRevisions = <T extends EffectiveRevisionCandidate>(
  revisions: readonly T[],
  effectiveAt: string,
): EffectivePricingDiscountRevisionInterpretation<T> => {
  const current = revisions.filter(
    ({ effectivePeriod }) =>
      effectivePeriod.effectiveFrom <= effectiveAt &&
      (effectivePeriod.effectiveTo === null || effectiveAt < effectivePeriod.effectiveTo),
  );
  if (current.length === 0) {
    return { outcome: 'DISCOUNT_REVISION_ABSENT' };
  }
  if (current.length === 1 && current[0] !== undefined) {
    return { outcome: 'DISCOUNT_REVISION_CURRENT', revision: current[0] };
  }
  return { conflictingRevisions: current, outcome: 'DISCOUNT_REVISION_CONFLICT' };
};

/** Constructs the published 0/1/>1 result for one exact logical Discount key. */
export const resolveCurrentPricingDiscountRevisions = (
  identityKey: PricingDiscountIdentityKey,
  revisions: readonly ScheduledPricingDiscountRevision[],
  observedAt: string,
): Effect.Effect<PricingDiscountCurrentResolution, PricingDiscountApplicabilityRejected> => {
  if (revisions.some(({ definition }) => !pricingDiscountIdentityKeysEqual(definition.identityKey, identityKey))) {
    return Effect.fail(
      reject(
        'CURRENT_RESOLUTION_MISMATCH',
        'Revision candidates did not all bind the requested exact logical Discount',
      ),
    );
  }
  const duplicateRevisionId = revisions.find(({ definition }, index) =>
    revisions.some(
      (candidate, candidateIndex) =>
        candidateIndex !== index && candidate.definition.revision.revisionId === definition.revision.revisionId,
    ),
  )?.definition.revision.revisionId;
  const duplicateRevisionNumber = revisions.find(({ definition }, index) =>
    revisions.some(
      (candidate, candidateIndex) =>
        candidateIndex !== index && candidate.definition.revision.revision === definition.revision.revision,
    ),
  )?.definition.revision.revision;
  if (duplicateRevisionId !== undefined || duplicateRevisionNumber !== undefined) {
    const reason = duplicateRevisionId === undefined ? 'DUPLICATE_REVISION_NUMBER' : 'DUPLICATE_REVISION_ID';
    const claimants = revisions.flatMap(({ definition }) => {
      const matches =
        reason === 'DUPLICATE_REVISION_ID'
          ? definition.revision.revisionId === duplicateRevisionId
          : definition.revision.revision === duplicateRevisionNumber;
      return matches ? [{ revision: definition.revision.revision, revisionId: definition.revision.revisionId }] : [];
    });
    const invariant = decodeCurrentResolution({
      claimants,
      identityKey,
      observedAt,
      outcome: 'DISCOUNT_REVISION_INVARIANT_VIOLATION',
      reason,
    });
    return Effect.fromOption(invariant).pipe(
      Effect.mapError((cause) =>
        reject(
          'CURRENT_RESOLUTION_INVALID',
          'Duplicate Discount Revision identity could not be represented as invariant evidence',
          cause,
        ),
      ),
    );
  }
  const interpreted = interpretEffectivePricingDiscountRevisions(revisions, observedAt);
  let result;
  if (interpreted.outcome === 'DISCOUNT_REVISION_ABSENT') {
    result = { identityKey, observedAt, outcome: 'DISCOUNT_CURRENT_ABSENT' as const };
  } else if (interpreted.outcome === 'DISCOUNT_REVISION_CURRENT') {
    result = { observedAt, outcome: 'DISCOUNT_CURRENT' as const, revision: interpreted.revision };
  } else {
    result = {
      candidateRevisionIds: interpreted.conflictingRevisions.map(({ definition }) => definition.revision.revisionId),
      identityKey,
      observedAt,
      outcome: 'DISCOUNT_CURRENT_CONFLICT' as const,
    };
  }
  const decoded = decodeCurrentResolution(result);
  return Effect.fromOption(decoded).pipe(
    Effect.mapError((cause) =>
      reject('CURRENT_RESOLUTION_INVALID', 'Current Discount evidence failed its published contract', cause),
    ),
  );
};

/**
 * Computes B from positive merchandise intermediates only and applies the strict B > D rule.
 * It deliberately returns no recipients or allocations in the applicable outcome: #774 owns
 * capacity-constrained allocation of the one whole-Decision contribution.
 */
export const assessWholePurchaseDiscountThreshold = (
  input: PricingWholePurchaseThresholdInput,
): Effect.Effect<PricingWholePurchaseThresholdResult, PricingDiscountApplicabilityRejected> => {
  if (
    !signedDecimalPattern.test(input.configuredAmount.amount) ||
    compareDecimals(input.configuredAmount.amount, '0') < 0 ||
    input.intermediates.some(({ amount }) => !signedDecimalPattern.test(amount.amount))
  ) {
    return Effect.fail(
      reject('MONETARY_INTERMEDIATE_INVALID', 'Whole-purchase applicability requires canonical exact decimal values'),
    );
  }
  if (
    input.configuredAmount.currencyCode !== input.decisionCurrencyCode ||
    input.intermediates.some(({ amount }) => amount.currencyCode !== input.decisionCurrencyCode)
  ) {
    return Effect.fail(
      reject('CURRENCY_MISMATCH', 'Whole-purchase applicability does not convert or relabel monetary values'),
    );
  }
  const merchandiseOccurrenceIds = input.intermediates.flatMap(({ occurrenceId, recipientKind }) =>
    recipientKind === 'MERCHANDISE' ? [occurrenceId] : [],
  );
  if (new Set(merchandiseOccurrenceIds).size !== merchandiseOccurrenceIds.length) {
    return Effect.fail(
      reject('MONETARY_INTERMEDIATE_INVALID', 'Merchandise intermediates must preserve distinct original lines'),
    );
  }
  const recipients = input.intermediates.flatMap(({ amount, occurrenceId, recipientKind }) =>
    recipientKind === 'MERCHANDISE' && compareDecimals(amount.amount, '0') > 0
      ? [{ intermediateValue: amount, occurrenceId, recipientKind } as const]
      : [],
  );
  const eligibleAmount = sumDecimals(recipients.map(({ intermediateValue }) => intermediateValue.amount));
  const basis = decodeWholePurchaseBasis({
    currencyCode: input.decisionCurrencyCode,
    eligibleAmount,
    recipients,
  });
  if (Option.isNone(basis)) {
    return Effect.fail(
      reject('MONETARY_INTERMEDIATE_INVALID', 'Whole-purchase eligible basis failed its published contract'),
    );
  }
  if (recipients.length === 0) {
    return Effect.succeed({
      basis: basis.value,
      outcome: 'WHOLE_PURCHASE_DISCOUNT_NOT_APPLICABLE',
      reason: 'EMPTY_ELIGIBLE_SET',
    });
  }
  if (compareDecimals(eligibleAmount, input.configuredAmount.amount) <= 0) {
    return Effect.succeed({
      basis: basis.value,
      outcome: 'WHOLE_PURCHASE_DISCOUNT_NOT_APPLICABLE',
      reason: 'BASIS_NOT_GREATER_THAN_DISCOUNT',
    });
  }
  return Effect.succeed({
    applicationCount: 'ONCE_PER_PRICING_DECISION',
    basis: basis.value,
    contribution: {
      amount: negativeContribution(input.configuredAmount.amount),
      currencyCode: input.decisionCurrencyCode,
    },
    outcome: 'WHOLE_PURCHASE_DISCOUNT_APPLICABLE',
  });
};

const exactResolutionIdentity = (resolution: PricingDiscountCurrentResolution): PricingDiscountIdentityKey =>
  resolution.outcome === 'DISCOUNT_CURRENT' ? resolution.revision.definition.identityKey : resolution.identityKey;

const discountTenantId = (identityKey: PricingDiscountIdentityKey): string => {
  const { audience } = identityKey;
  if (audience.kind === 'CATALOG_PATH') {
    return audience.selection.productRef.tenantId;
  }
  return audience.kind === 'PRICE_GROUP' ? audience.priceGroupRef.tenantId : audience.counterpartyRef.tenantId;
};

const evidenceFor = (binding: PricingDiscountAudienceEvidenceBinding) => ({
  basePricePath: binding.basePricePath,
  evidence: binding.evidence,
});

/**
 * Interprets one exact Discount independently of other audience layers. The used base Price path is
 * retained as evidence but never gates a separately owner-proven Group or Counterparty benefit.
 */
export const interpretPricingDiscountApplicability = (
  input: InterpretPricingDiscountApplicabilityInput,
): Effect.Effect<PricingDiscountApplicability, PricingDiscountApplicabilityRejected> => {
  const binding = decodeAudienceEvidenceBinding(input.audienceBinding);
  if (Option.isNone(binding)) {
    return Effect.fail(
      reject('AUDIENCE_EVIDENCE_INVALID', 'Discount audience evidence did not bind the exact applicability basis'),
    );
  }
  const resolution = decodeCurrentResolution(input.currentResolution);
  if (Option.isNone(resolution)) {
    return Effect.fail(
      reject('CURRENT_RESOLUTION_INVALID', 'Current Discount resolution failed its published contract'),
    );
  }
  if (
    !pricingDiscountIdentityKeysEqual(exactResolutionIdentity(resolution.value), binding.value.identityKey) ||
    resolution.value.observedAt !== binding.value.applicabilityBasis.observedAt
  ) {
    return Effect.fail(
      reject(
        'CURRENT_RESOLUTION_MISMATCH',
        'Current Discount resolution did not bind the exact audience evidence and trusted observation instant',
      ),
    );
  }
  const currencySupport = decodeCurrencySupport(input.currencySupport);
  if (
    Option.isNone(currencySupport) ||
    currencySupport.value.currentnessEvidence.evaluationMode !== 'CURRENT_WITH_REVALIDATION'
  ) {
    return Effect.fail(
      reject(
        'CURRENCY_SUPPORT_INVALID',
        'Discount applicability requires complete Current Tenant Currency Support with fresh revalidation',
      ),
    );
  }
  if (
    currencySupport.value.tenantId !== discountTenantId(binding.value.identityKey) ||
    currencySupport.value.effectiveAt !== binding.value.applicabilityBasis.observedAt
  ) {
    return Effect.fail(
      reject(
        'CURRENCY_SUPPORT_MISMATCH',
        'Currency Support must bind the exact Discount Tenant and applicability instant',
      ),
    );
  }
  if (!currencySupport.value.supportedCurrencies.includes(binding.value.identityKey.currencyCode)) {
    return Effect.fail(
      reject('CURRENCY_UNSUPPORTED', 'The exact Discount currency is not enabled by Current Tenant Currency Support'),
    );
  }
  const evidence = evidenceFor(binding.value);
  if (resolution.value.outcome === 'DISCOUNT_CURRENT_ABSENT') {
    return Effect.succeed({
      ...evidence,
      currentResolution: resolution.value,
      outcome: 'DISCOUNT_ABSENT',
    });
  }
  if (resolution.value.outcome === 'DISCOUNT_CURRENT_CONFLICT') {
    return Effect.succeed({
      ...evidence,
      currentResolution: resolution.value,
      outcome: 'DISCOUNT_CONFLICT',
    });
  }
  if (resolution.value.outcome === 'DISCOUNT_REVISION_INVARIANT_VIOLATION') {
    return Effect.succeed({
      ...evidence,
      currentResolution: resolution.value,
      outcome: 'DISCOUNT_INVARIANT_VIOLATION',
    });
  }
  const { definition } = resolution.value.revision;
  if (definition.identityKey.scope === 'VARIANT_LINE') {
    return Effect.succeed({
      ...evidence,
      applicationCount: 'ONCE_PER_STABLE_LINE',
      definition,
      outcome: 'DISCOUNT_APPLICABLE',
    });
  }
  if (input.wholePurchaseIntermediates === undefined) {
    return Effect.fail(
      reject('WHOLE_PURCHASE_BASIS_REQUIRED', 'A Current whole-purchase Discount requires exact line intermediates'),
    );
  }
  const { configuredEffect } = definition.revision;
  if (configuredEffect.kind !== 'FIXED_MONETARY_AMOUNT') {
    return Effect.fail(
      reject('WHOLE_PURCHASE_APPLICABILITY_INVALID', 'Whole-purchase Launch applicability requires a fixed effect'),
    );
  }
  return assessWholePurchaseDiscountThreshold({
    configuredAmount: configuredEffect.level,
    decisionCurrencyCode: definition.identityKey.currencyCode,
    intermediates: input.wholePurchaseIntermediates,
  }).pipe(
    Effect.flatMap((threshold) => {
      const applicabilityCandidate =
        threshold.outcome === 'WHOLE_PURCHASE_DISCOUNT_APPLICABLE'
          ? {
              basis: threshold.basis,
              contribution: threshold.contribution,
              definition,
              outcome: threshold.outcome,
            }
          : {
              basis: threshold.basis,
              definition,
              outcome: threshold.outcome,
              reason: threshold.reason,
            };
      const applicability = decodeWholePurchaseApplicability(applicabilityCandidate);
      if (Option.isNone(applicability)) {
        return Effect.fail(
          reject('WHOLE_PURCHASE_APPLICABILITY_INVALID', 'Whole-purchase result failed its published contract'),
        );
      }
      const applicabilityValue = applicability.value;
      return Effect.succeed({
        ...evidence,
        applicability: applicabilityValue,
        applicationCount: 'ONCE_PER_PRICING_DECISION' as const,
        definition,
        outcome:
          applicabilityValue.outcome === 'WHOLE_PURCHASE_DISCOUNT_APPLICABLE'
            ? ('DISCOUNT_APPLICABLE' as const)
            : ('DISCOUNT_NOT_APPLICABLE' as const),
      });
    }),
  );
};
