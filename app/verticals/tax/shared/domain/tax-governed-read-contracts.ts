import { Schema } from 'effect';

import { TaxRuleMeaningKindSchema } from '../actions/tax-governance.ts';
import { TaxRuleRevisionRefSchema } from '../resources/tax-rule-revision.ts';
import { TaxRuleRefSchema } from '../resources/tax-rule.ts';

const InstantSchema = Schema.DateTimeUtcFromString;
const FingerprintSchema = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
const RevisionNumberSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
const OwnerReferenceSchema = Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(300));
const TextSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000));
const RowCountSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** Decisive Tax Rule predicate; the Selling Legal Entity comes from the trusted Operational Scope (#950 F24). */
export const ApplicableTaxRuleSetRequestContractSchema = Schema.Struct({
  jurisdiction: Schema.Literal('CZ_DOMESTIC'),
  taxClassificationCode: OwnerReferenceSchema,
  taxRelevantTime: InstantSchema,
});

const ApplicableTaxRuleRevisionSchema = Schema.Struct({
  compositionKind: Schema.Literal('EXCLUSIVE'),
  effectiveFrom: InstantSchema,
  effectiveTo: Schema.OptionFromNullOr(InstantSchema),
  endedEffectiveTo: Schema.OptionFromNullOr(InstantSchema),
  ratePercent: Schema.String,
  revisionNumber: RevisionNumberSchema,
  semanticFingerprint: FingerprintSchema,
  taxRuleRef: TaxRuleRefSchema,
  taxRuleRevisionRef: TaxRuleRevisionRefSchema,
  treatmentCategory: Schema.Literal('TAXABLE'),
});

const CorrectionProvenanceSchema = Schema.Struct({
  correctingRevisionRef: TaxRuleRevisionRefSchema,
  wrongRevisionRef: TaxRuleRevisionRefSchema,
});

/**
 * The complete applicable set for the predicate at Tax-Relevant Time plus a completeness token over the whole
 * predicate state; never a single "best" row (#929 F17, #930 F5-F6, #942 F9-F15).
 */
export const ApplicableTaxRuleSetResponseContractSchema = Schema.Struct({
  applicable: Schema.Array(ApplicableTaxRuleRevisionSchema),
  completeness: Schema.Struct({
    predicate: Schema.Struct({
      jurisdiction: Schema.Literal('CZ_DOMESTIC'),
      taxClassificationCode: OwnerReferenceSchema,
    }),
    predicateFingerprint: FingerprintSchema,
    rowCount: RowCountSchema,
    setFingerprint: FingerprintSchema,
  }),
  excludedByCorrection: Schema.Array(CorrectionProvenanceSchema),
  outcome: Schema.Literals([
    'SELECTED',
    'TAX_RULE_MISSING',
    'TAX_RULE_OVERLAP',
    'TAX_RULE_CONFLICT',
    'TAX_STATE_INDETERMINATE',
  ]),
  taxRelevantTime: InstantSchema,
});

export const TaxRuleHistoryRequestContractSchema = Schema.Struct({ taxRuleRef: TaxRuleRefSchema });

const GovernedAttributionFields = {
  provenanceRef: TextSchema,
  reason: TextSchema,
  recordedAt: InstantSchema,
};

/** Full evidence history: every revision, end fact and correction, including wrong revisions (#930 F8). */
export const TaxRuleHistoryResponseContractSchema = Schema.Struct({
  basisFingerprint: FingerprintSchema,
  corrections: Schema.Array(
    Schema.Struct({
      ...GovernedAttributionFields,
      confirmedAt: InstantSchema,
      correctingRevisionRef: TaxRuleRevisionRefSchema,
      wrongRevisionRef: TaxRuleRevisionRefSchema,
    }),
  ),
  meaningKind: TaxRuleMeaningKindSchema,
  revisions: Schema.Array(
    Schema.Struct({
      ...GovernedAttributionFields,
      compositionKind: Schema.Literal('EXCLUSIVE'),
      effectiveFrom: InstantSchema,
      effectiveTo: Schema.OptionFromNullOr(InstantSchema),
      endFact: Schema.OptionFromNullOr(
        Schema.Struct({ ...GovernedAttributionFields, endedEffectiveTo: InstantSchema }),
      ),
      jurisdiction: Schema.Literal('CZ_DOMESTIC'),
      ratePercent: Schema.String,
      revisionNumber: RevisionNumberSchema,
      semanticFingerprint: FingerprintSchema,
      supersedesRevisionRef: Schema.OptionFromNullOr(TaxRuleRevisionRefSchema),
      taxClassificationCode: OwnerReferenceSchema,
      taxRuleRevisionRef: TaxRuleRevisionRefSchema,
      treatmentCategory: Schema.Literal('TAXABLE'),
    }),
  ),
  stableCode: Schema.String,
  taxRuleRef: TaxRuleRefSchema,
});
