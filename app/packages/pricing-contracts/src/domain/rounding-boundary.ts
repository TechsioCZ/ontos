import { Schema } from 'effect';

import { PricingPublishedCommercialLineSchema } from './commercial-total.ts';
import type { PricingPublishedCommercialLine } from './commercial-total.ts';
import {
  PRICING_CZK_PUBLICATION_PROFILE_VERSION,
  PricingCzkPublicationProfileSchema,
  PricingExactNonNegativeDecimalSchema,
} from './exact-decimal.ts';
import type { PricingCzkPublicationProfile, PricingExactNonNegativeDecimal } from './exact-decimal.ts';
import { PricingFinalPreRoundReadySchema, PricingLineComposedLineSchema } from './line-composition.ts';
import type { PricingFinalPreRoundReady } from './line-composition.ts';
import { PricingDecisionSchema } from './pricing-decision.ts';
import type { PricingDecision } from './pricing-decision.ts';

const stableReference = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300), Schema.isTrimmed());
const boundedMessage = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000), Schema.isTrimmed());

interface DecimalParts {
  readonly coefficient: bigint;
  readonly scale: number;
}

const decimalParts = (value: string): DecimalParts => {
  const [integer = '0', fraction = ''] = value.split('.');
  return { coefficient: BigInt(`${integer}${fraction}`), scale: fraction.length };
};

const formatParts = ({ coefficient, scale }: DecimalParts): string => {
  if (coefficient === 0n) {
    return '0';
  }
  let normalizedCoefficient = coefficient;
  let normalizedScale = scale;
  while (normalizedScale > 0 && normalizedCoefficient % 10n === 0n) {
    normalizedCoefficient /= 10n;
    normalizedScale -= 1;
  }
  if (normalizedScale === 0) {
    return normalizedCoefficient.toString();
  }
  const digits = normalizedCoefficient.toString().padStart(normalizedScale + 1, '0');
  const splitAt = digits.length - normalizedScale;
  return `${digits.slice(0, splitAt)}.${digits.slice(splitAt)}`;
};

/**
 * Applies the declared ordinary publication rule without floating point.
 * `undefined` means that the requested scale or the carried result is outside
 * the exact-decimal envelope and must become a typed publication failure.
 */
export const roundPricingExactDecimalHalfUp = (
  value: PricingExactNonNegativeDecimal,
  publishedScale: number,
): PricingExactNonNegativeDecimal | undefined => {
  if (!Number.isInteger(publishedScale) || publishedScale < 0 || publishedScale > 18) {
    return undefined;
  }
  const parts = decimalParts(value);
  if (parts.scale <= publishedScale) {
    return value;
  }
  const divisor = 10n ** BigInt(parts.scale - publishedScale);
  const quotient = parts.coefficient / divisor;
  const remainder = parts.coefficient % divisor;
  const roundedCoefficient = remainder * 2n >= divisor ? quotient + 1n : quotient;
  const rounded = formatParts({ coefficient: roundedCoefficient, scale: publishedScale });
  return Schema.is(PricingExactNonNegativeDecimalSchema)(rounded) ? rounded : undefined;
};

export interface PricingLinePublicationRequest {
  readonly candidateRef: string;
  readonly decision: PricingDecision;
  readonly preRound: PricingFinalPreRoundReady;
  readonly publicationProfileVersion: string;
}

export const PricingLinePublicationRequestSchema: Schema.Codec<PricingLinePublicationRequest, unknown> = Schema.Struct({
  candidateRef: stableReference,
  decision: PricingDecisionSchema,
  preRound: PricingFinalPreRoundReadySchema,
  publicationProfileVersion: stableReference,
});

export interface PricingLinePublicationReady {
  readonly candidateRef: string;
  readonly decision: PricingDecision;
  readonly outcome: 'LINE_VALUES_PUBLISHED';
  readonly publicationProfile: PricingCzkPublicationProfile;
  readonly publishedLines: readonly PricingPublishedCommercialLine[];
  readonly sourceEvidence: { readonly preRound: PricingFinalPreRoundReady };
}

const sameDecision = Schema.toEquivalence(PricingDecisionSchema);
const sameComposedLine = Schema.toEquivalence(PricingLineComposedLineSchema);

const alignedCoefficient = (parts: DecimalParts, scale: number): bigint =>
  parts.coefficient * 10n ** BigInt(scale - parts.scale);

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

const sourceEvidenceIsCoherent = (
  decision: PricingDecision,
  candidateRef: string,
  preRound: PricingFinalPreRoundReady,
): boolean =>
  candidateRef === preRound.rawComposition.candidateRef &&
  sameDecision(decision, preRound.decision) &&
  sameDecision(decision, preRound.rawComposition.decision) &&
  decision.lines.length === preRound.lines.length &&
  preRound.lines.length === preRound.rawComposition.lines.length &&
  decision.lines.every((decisionLine, index) => {
    const line = preRound.lines[index];
    const rawLine = preRound.rawComposition.lines[index];
    if (
      line === undefined ||
      rawLine === undefined ||
      decisionLine.occurrenceId !== line.occurrenceId ||
      decisionLine.occurrenceId !== rawLine.occurrenceId ||
      !sameComposedLine(line.composition, rawLine)
    ) {
      return false;
    }
    const { floorAdjustment, rawPostCompositionValue } = line.floorEvaluation;
    if (
      rawPostCompositionValue.currencyCode !== decision.currencyCode ||
      rawPostCompositionValue.amount !== rawLine.rawPostCompositionValue.amount ||
      floorAdjustment.currencyCode !== decision.currencyCode ||
      line.nonNegativePreRoundValue.currencyCode !== decision.currencyCode ||
      line.floorEvaluation.nonNegativePreRoundValue.currencyCode !== decision.currencyCode ||
      line.nonNegativePreRoundValue.amount !== line.floorEvaluation.nonNegativePreRoundValue.amount
    ) {
      return false;
    }
    if (rawPostCompositionValue.amount.startsWith('-')) {
      return (
        line.floorEvaluation.kind === 'AUTHORIZED_ZERO_FLOOR' &&
        line.nonNegativePreRoundValue.amount === '0' &&
        decimalSumEquals('0', [rawPostCompositionValue.amount, floorAdjustment.amount])
      );
    }
    return (
      line.floorEvaluation.kind === 'NOT_REQUIRED' &&
      floorAdjustment.amount === '0' &&
      line.nonNegativePreRoundValue.amount === rawPostCompositionValue.amount
    );
  });

const publishedLinesAreCanonical = (
  decision: PricingDecision,
  preRound: PricingFinalPreRoundReady,
  publishedLines: readonly PricingPublishedCommercialLine[],
): boolean =>
  decision.currencyCode === 'CZK' &&
  publishedLines.length === preRound.lines.length &&
  publishedLines.every((published, index) => {
    const source = preRound.lines[index];
    if (
      source === undefined ||
      published.occurrenceId !== source.occurrenceId ||
      published.publicationProfile.profileVersion !== PRICING_CZK_PUBLICATION_PROFILE_VERSION ||
      published.publishedLineValue.currencyCode !== 'CZK' ||
      published.roundingAdjustment.currencyCode !== 'CZK'
    ) {
      return false;
    }
    const expected = roundPricingExactDecimalHalfUp(
      source.nonNegativePreRoundValue.amount,
      published.publicationProfile.publishedScale,
    );
    return (
      expected !== undefined &&
      published.publishedLineValue.amount === expected &&
      decimalSumEquals(expected, [source.nonNegativePreRoundValue.amount, published.roundingAdjustment.amount])
    );
  });

export const PricingLinePublicationReadySchema: Schema.Codec<PricingLinePublicationReady, unknown> = Schema.Struct({
  candidateRef: stableReference,
  decision: PricingDecisionSchema,
  outcome: Schema.Literal('LINE_VALUES_PUBLISHED'),
  publicationProfile: PricingCzkPublicationProfileSchema,
  publishedLines: Schema.Array(PricingPublishedCommercialLineSchema).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(500),
  ),
  sourceEvidence: Schema.Struct({ preRound: PricingFinalPreRoundReadySchema }),
}).check(
  Schema.makeFilter((ready) => {
    const { candidateRef, decision, publicationProfile, publishedLines } = ready;
    const { preRound } = ready.sourceEvidence;
    if (!sourceEvidenceIsCoherent(decision, candidateRef, preRound)) {
      return 'Line publication must retain the exact original lines and prove raw-negative guarding before rounding';
    }
    if (publicationProfile.profileVersion !== PRICING_CZK_PUBLICATION_PROFILE_VERSION) {
      return 'Line publication must use the declared Launch CZK profile';
    }
    return publishedLinesAreCanonical(decision, preRound, publishedLines)
      ? undefined
      : 'Every original line must cross exactly one CZK HALF_UP publication boundary with signed adjustment evidence';
  }),
);

export const PricingLinePublicationFailureCodeSchema = Schema.Literals([
  'INVALID_INPUT',
  'UNSUPPORTED_PROFILE',
  'UNSUPPORTED_PRECISION',
  'UNSUPPORTED_CURRENCY',
  'CURRENCY_MISMATCH',
  'RAW_NEGATIVE_UNGUARDED',
  'ARITHMETIC_OVERFLOW',
  'EVIDENCE_UNVERIFIABLE',
]);
export type PricingLinePublicationFailureCode = typeof PricingLinePublicationFailureCodeSchema.Type;

export const PricingLinePublicationFailedSchema = Schema.Struct({
  candidateRef: stableReference,
  failure: Schema.Struct({
    code: PricingLinePublicationFailureCodeSchema,
    message: boundedMessage,
    retryable: Schema.Boolean,
  }),
  outcome: Schema.Literal('LINE_PUBLICATION_FAILED'),
});
export type PricingLinePublicationFailed = typeof PricingLinePublicationFailedSchema.Type;

export const PricingLinePublicationResultSchema = Schema.Union([
  PricingLinePublicationReadySchema,
  PricingLinePublicationFailedSchema,
]);
export type PricingLinePublicationResult = typeof PricingLinePublicationResultSchema.Type;

/** Provider-safe JSON representation, including recursively retained DateTime evidence. */
export const PricingLinePublicationResultWireSchema = Schema.toCodecJson(PricingLinePublicationResultSchema);
