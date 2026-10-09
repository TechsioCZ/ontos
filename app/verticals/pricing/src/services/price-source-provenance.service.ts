import { createHash } from 'node:crypto';

import {
  PriceSourceEvidenceSchema,
  PriceSourceFactFingerprintBasisSchema,
  PriceSourceFactFingerprintSchema,
  priceSourceFactFingerprintBasisFrom,
} from '@app/pricing-contracts/domain/price-source-provenance';
import type {
  PriceSourceAssertionHeldSchema,
  PriceSourceAssertionInput,
  PriceSourceAssertionInvalidSchema,
  PriceSourceEvidence,
  PriceSourceProvenance,
} from '@app/pricing-contracts/domain/price-source-provenance';
import { PriceIdentityKeySchema, priceDecimalValuesEqual } from '@app/pricing-contracts/domain/price-definition';
import type { PriceDefinition, PriceIdentityKey } from '@app/pricing-contracts/domain/price-definition';
import { PriceRefSchema } from '@app/pricing-contracts/resources/price';
import { DateTime, Result, Schema } from 'effect';

type InvalidAssessment = typeof PriceSourceAssertionInvalidSchema.Type;
type HeldAssessment = typeof PriceSourceAssertionHeldSchema.Type;

export interface PreparedPriceSourceEvidence {
  readonly evidence: PriceSourceEvidence;
  readonly outcome: 'READY_FOR_CANONICAL_WRITE';
}

export type PriceSourceWriteReadiness = HeldAssessment | InvalidAssessment | PreparedPriceSourceEvidence;

export interface PreparePriceSourceEvidenceInput {
  readonly actingPrincipalId: string;
  readonly effectiveFrom?: string | undefined;
  readonly identityKey?: PriceIdentityKey;
  readonly monetaryAmount: PriceDefinition['revision']['monetaryAmount'];
  readonly sourceAssertion: PriceSourceAssertionInput;
  readonly tenantId: string;
  readonly trustedOperationAt: Date;
}

const encodeFingerprintBasis = Schema.encodeResult(Schema.fromJsonString(PriceSourceFactFingerprintBasisSchema));
const decodeFingerprint = Schema.decodeResult(PriceSourceFactFingerprintSchema);
const decodeEvidence = Schema.decodeResult(PriceSourceEvidenceSchema);
const identityKeyEquivalence = Schema.toEquivalence(PriceIdentityKeySchema);
const priceRefEquivalence = Schema.toEquivalence(PriceRefSchema);

export const priceSourceFactFingerprint = (sourceAssertion: PriceSourceAssertionInput) =>
  Result.getOrThrow(
    decodeFingerprint(
      createHash('sha256')
        .update(Result.getOrThrow(encodeFingerprintBasis(priceSourceFactFingerprintBasisFrom(sourceAssertion))))
        .digest('hex'),
    ),
  );

const invalid = (
  sourceAssertion: PriceSourceAssertionInput,
  reason: InvalidAssessment['reason'],
): InvalidAssessment => ({
  outcome: 'PRICE_SOURCE_ASSERTION_KNOWN_INVALID',
  reason,
  sourceAssertionId: sourceAssertion.sourceAssertionId,
});

const held = (sourceAssertion: PriceSourceAssertionInput, reason: HeldAssessment['reason']): HeldAssessment => ({
  outcome: 'PRICE_SOURCE_ASSERTION_UNRESOLVED_HELD',
  reason,
  sourceAssertionId: sourceAssertion.sourceAssertionId,
});

const sourceLineageFor = (
  sourceAssertion: PriceSourceAssertionInput,
  actingPrincipalId: string,
): PriceSourceEvidence['lineage'] => {
  const { lineage } = sourceAssertion;
  return lineage.kind === 'INITIAL' ? lineage : { ...lineage, actingPrincipalId };
};

export const preparePriceSourceEvidence = (input: PreparePriceSourceEvidenceInput): PriceSourceWriteReadiness => {
  const { identityKey, monetaryAmount, sourceAssertion } = input;
  const { originalAssertion, preTaxNormalization } = sourceAssertion;

  if (sourceAssertion.timing.ownerBusinessEffectiveAt !== input.effectiveFrom && input.effectiveFrom !== undefined) {
    return invalid(sourceAssertion, 'MAPPING_REJECTED');
  }
  const canonicalCurrency = identityKey?.currencyCode ?? monetaryAmount.currencyCode;
  if (originalAssertion.monetaryAmount.currencyCode !== canonicalCurrency) {
    return invalid(sourceAssertion, 'CURRENCY_MISMATCH');
  }
  if (
    identityKey !== undefined &&
    (!priceDecimalValuesEqual(originalAssertion.unitBasis.quantity, identityKey.unitBasis.quantity) ||
      originalAssertion.unitBasis.unitRef.moduleId !== identityKey.unitBasis.unitRef.moduleId ||
      originalAssertion.unitBasis.unitRef.resourceId !== identityKey.unitBasis.unitRef.resourceId ||
      originalAssertion.unitBasis.unitRef.resourceType !== identityKey.unitBasis.unitRef.resourceType ||
      originalAssertion.unitBasis.unitRef.tenantId !== identityKey.unitBasis.unitRef.tenantId)
  ) {
    return invalid(sourceAssertion, 'UNIT_AMBIGUOUS');
  }
  if (originalAssertion.monetaryBoundary === 'TAX_INCLUSIVE' && preTaxNormalization === undefined) {
    return held(sourceAssertion, 'AUTHORITATIVE_PRE_TAX_NORMALIZATION_MISSING');
  }
  if (originalAssertion.monetaryBoundary === 'PRE_TAX') {
    if (
      preTaxNormalization !== undefined ||
      !priceDecimalValuesEqual(originalAssertion.monetaryAmount.amount, monetaryAmount.amount)
    ) {
      return invalid(sourceAssertion, 'MAPPING_REJECTED');
    }
  } else if (preTaxNormalization !== undefined) {
    if (
      preTaxNormalization.authority.sourceAuthorityRef !== sourceAssertion.sourceAuthority.sourceAuthorityRef ||
      preTaxNormalization.authority.sourceAuthorityVersion !== sourceAssertion.sourceAuthority.sourceAuthorityVersion
    ) {
      return invalid(sourceAssertion, 'SOURCE_AUTHORITY_REJECTED');
    }
    if (preTaxNormalization.normalizedMonetaryAmount.currencyCode !== monetaryAmount.currencyCode) {
      return invalid(sourceAssertion, 'CURRENCY_MISMATCH');
    }
    if (!priceDecimalValuesEqual(preTaxNormalization.normalizedMonetaryAmount.amount, monetaryAmount.amount)) {
      return invalid(sourceAssertion, 'MAPPING_REJECTED');
    }
  }

  return {
    evidence: Result.getOrThrow(
      decodeEvidence({
        lineage: sourceLineageFor(sourceAssertion, input.actingPrincipalId),
        recordedAt: DateTime.formatIso(DateTime.makeUnsafe(input.trustedOperationAt)),
        sourceAssertion,
        sourceFactFingerprint: priceSourceFactFingerprint(sourceAssertion),
        tenantId: input.tenantId,
      }),
    ),
    outcome: 'READY_FOR_CANONICAL_WRITE',
  };
};

export const priceSourceProvenanceMatchesDefinition = (
  provenance: PriceSourceProvenance,
  definition: PriceDefinition,
): boolean => {
  const { canonicalLink } = provenance;
  return (
    canonicalLink.effectiveFrom === definition.revision.effectiveFrom &&
    identityKeyEquivalence(canonicalLink.identityKey, definition.identityKey) &&
    priceDecimalValuesEqual(canonicalLink.monetaryAmount.amount, definition.revision.monetaryAmount.amount) &&
    canonicalLink.monetaryAmount.currencyCode === definition.revision.monetaryAmount.currencyCode &&
    canonicalLink.monetaryBoundary === definition.revision.monetaryBoundary &&
    priceRefEquivalence(canonicalLink.priceRef, definition.priceRef) &&
    canonicalLink.revision === definition.revision.revision &&
    canonicalLink.revisionId === definition.revision.revisionId
  );
};

export const acceptedPriceSourceProvenanceMatches = (input: {
  readonly definition: PriceDefinition;
  readonly expectedEvidence: PriceSourceEvidence;
  readonly provenance: PriceSourceProvenance;
}): boolean => {
  const { expectedEvidence, provenance } = input;
  const returnedFingerprint = priceSourceFactFingerprint(provenance.evidence.sourceAssertion);
  return (
    priceSourceProvenanceMatchesDefinition(provenance, input.definition) &&
    provenance.evidence.tenantId === expectedEvidence.tenantId &&
    provenance.evidence.sourceFactFingerprint === returnedFingerprint &&
    returnedFingerprint === expectedEvidence.sourceFactFingerprint &&
    provenance.evidence.sourceAssertion.timing.ownerBusinessEffectiveAt === provenance.canonicalLink.effectiveFrom
  );
};
