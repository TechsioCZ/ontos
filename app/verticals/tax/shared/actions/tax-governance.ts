import { DateTime, Schema } from 'effect';
import { TaxFactAuthorityContractRefSchema } from '../resources/tax-fact-authority-contract.ts';
import { TaxRuleRevisionRefSchema } from '../resources/tax-rule-revision.ts';
import { TaxRuleRefSchema } from '../resources/tax-rule.ts';

const ReasonSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(500));
const ProvenanceRefSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(500));
const InstantSchema = Schema.DateTimeUtcFromString;
const FingerprintSchema = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
const RevisionNumberSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
const StableCodeSchema = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9._-]{0,127}$/u));
const OwnerReferenceSchema = Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(300));

/** Launch Tax Rule meaning: one statutory VAT rate for one Tax Classification (#929, #941). */
export const TaxRuleMeaningKindSchema = Schema.Literal('VAT_RATE');

/** Exact positive base-10 decimal percent; never a binary float (#919, #938). */
const RatePercentSchema = Schema.String.check(Schema.isPattern(/^(?:0\.\d*[1-9]\d*|[1-9]\d*(?:\.\d+)?)$/u));

/**
 * Immutable Tax Rule Revision content with its half-open Effective Period `[effectiveFrom, effectiveTo)`
 * (#929 F4-F10). An absent end is open-ended.
 */
export const TaxRuleRevisionContentSchema = Schema.Struct({
  compositionKind: Schema.Literal('EXCLUSIVE'),
  effectiveFrom: InstantSchema,
  effectiveTo: Schema.optionalKey(InstantSchema),
  jurisdiction: Schema.Literal('CZ_DOMESTIC'),
  ratePercent: RatePercentSchema,
  taxClassificationCode: OwnerReferenceSchema,
  treatmentCategory: Schema.Literal('TAXABLE'),
}).check(
  Schema.makeFilter(
    ({ effectiveFrom, effectiveTo }) =>
      effectiveTo === undefined ||
      DateTime.isLessThan(effectiveFrom, effectiveTo) ||
      'A Tax Rule Revision Effective Period must end after it starts',
  ),
);
export type TaxRuleRevisionContent = typeof TaxRuleRevisionContentSchema.Type;

export const CreateTaxRulePayloadSchema = Schema.Struct({
  initialRevision: TaxRuleRevisionContentSchema,
  meaningKind: TaxRuleMeaningKindSchema,
  provenanceRef: ProvenanceRefSchema,
  reason: ReasonSchema,
  stableCode: StableCodeSchema,
});
export type CreateTaxRulePayload = typeof CreateTaxRulePayloadSchema.Type;
export const CreateTaxRuleResultSchema = Schema.Struct({
  created: Schema.Boolean,
  initialRevisionRef: TaxRuleRevisionRefSchema,
  taxRuleRef: TaxRuleRefSchema,
});

export const CreateTaxRuleRevisionPayloadSchema = Schema.Struct({
  content: TaxRuleRevisionContentSchema,
  expectedBasisFingerprint: FingerprintSchema,
  provenanceRef: ProvenanceRefSchema,
  reason: ReasonSchema,
  taxRuleRef: TaxRuleRefSchema,
});
export type CreateTaxRuleRevisionPayload = typeof CreateTaxRuleRevisionPayloadSchema.Type;
export const CreateTaxRuleRevisionResultSchema = Schema.Struct({
  created: Schema.Boolean,
  revisionNumber: RevisionNumberSchema,
  taxRuleRevisionRef: TaxRuleRevisionRefSchema,
});

export const EndTaxRuleRevisionPayloadSchema = Schema.Struct({
  endedEffectiveTo: InstantSchema,
  expectedBasisFingerprint: FingerprintSchema,
  provenanceRef: ProvenanceRefSchema,
  reason: ReasonSchema,
  taxRuleRevisionRef: TaxRuleRevisionRefSchema,
});
export type EndTaxRuleRevisionPayload = typeof EndTaxRuleRevisionPayloadSchema.Type;
export const EndTaxRuleRevisionResultSchema = Schema.Struct({
  ended: Schema.Boolean,
  taxRuleRevisionRef: TaxRuleRevisionRefSchema,
});

/** Confirmed correction: a new correcting revision plus explicit provenance; the wrong revision stays addressable. */
export const CorrectTaxRuleRevisionPayloadSchema = Schema.Struct({
  confirmedAt: InstantSchema,
  correctingContent: TaxRuleRevisionContentSchema,
  expectedBasisFingerprint: FingerprintSchema,
  provenanceRef: ProvenanceRefSchema,
  reason: ReasonSchema,
  wrongRevisionRef: TaxRuleRevisionRefSchema,
});
export type CorrectTaxRuleRevisionPayload = typeof CorrectTaxRuleRevisionPayloadSchema.Type;
export const CorrectTaxRuleRevisionResultSchema = Schema.Struct({
  correctingRevisionRef: TaxRuleRevisionRefSchema,
  created: Schema.Boolean,
  wrongRevisionRef: TaxRuleRevisionRefSchema,
});

/** Launch fact family governed per Selling Legal Entity (#949 F22-F24, #925). */
export const TaxFactFamilySchema = Schema.Literal('SELLING_LEGAL_ENTITY_VAT_REGISTRATION');

/**
 * Authority content: exactly one System of Record may decide the fact; evidence-only sources are a distinct role
 * and never confer authority (#949 F24-F28).
 */
export const TaxFactAuthorityContentSchema = Schema.Struct({
  authorityFrom: InstantSchema,
  authorityTo: Schema.optionalKey(InstantSchema),
  evidenceSourceRefs: Schema.Array(OwnerReferenceSchema).check(Schema.isMaxLength(20)),
  systemOfRecordRef: OwnerReferenceSchema,
}).check(
  Schema.makeFilter(
    ({ authorityFrom, authorityTo }) =>
      authorityTo === undefined ||
      DateTime.isLessThan(authorityFrom, authorityTo) ||
      'A Tax Fact Authority period must end after it starts',
  ),
  Schema.makeFilter(
    ({ evidenceSourceRefs, systemOfRecordRef }) =>
      (new Set(evidenceSourceRefs).size === evidenceSourceRefs.length &&
        !evidenceSourceRefs.includes(systemOfRecordRef)) ||
      'Evidence source roles must be distinct and separate from the System of Record',
  ),
);
export type TaxFactAuthorityContent = typeof TaxFactAuthorityContentSchema.Type;

export const EstablishTaxFactAuthorityContractPayloadSchema = Schema.Struct({
  authority: TaxFactAuthorityContentSchema,
  factFamily: TaxFactFamilySchema,
  provenanceRef: ProvenanceRefSchema,
  reason: ReasonSchema,
  stableCode: StableCodeSchema,
});
export type EstablishTaxFactAuthorityContractPayload = typeof EstablishTaxFactAuthorityContractPayloadSchema.Type;
export const EstablishTaxFactAuthorityContractResultSchema = Schema.Struct({
  contractRef: TaxFactAuthorityContractRefSchema,
  created: Schema.Boolean,
  revisionNumber: RevisionNumberSchema,
});

export const ReviseTaxFactAuthorityContractPayloadSchema = Schema.Struct({
  authority: TaxFactAuthorityContentSchema,
  contractRef: TaxFactAuthorityContractRefSchema,
  expectedBasisFingerprint: FingerprintSchema,
  provenanceRef: ProvenanceRefSchema,
  reason: ReasonSchema,
});
export type ReviseTaxFactAuthorityContractPayload = typeof ReviseTaxFactAuthorityContractPayloadSchema.Type;
export const ReviseTaxFactAuthorityContractResultSchema = Schema.Struct({
  contractRef: TaxFactAuthorityContractRefSchema,
  created: Schema.Boolean,
  revisionNumber: RevisionNumberSchema,
});

export const EndTaxFactAuthorityContractPayloadSchema = Schema.Struct({
  authorityTo: InstantSchema,
  contractRef: TaxFactAuthorityContractRefSchema,
  expectedBasisFingerprint: FingerprintSchema,
  provenanceRef: ProvenanceRefSchema,
  reason: ReasonSchema,
});
export type EndTaxFactAuthorityContractPayload = typeof EndTaxFactAuthorityContractPayloadSchema.Type;
export const EndTaxFactAuthorityContractResultSchema = Schema.Struct({
  contractRef: TaxFactAuthorityContractRefSchema,
  ended: Schema.Boolean,
  revisionNumber: RevisionNumberSchema,
});
