import { Option, Schema } from 'effect';

import { PrivacyIsoTimestampSchema } from './privacy-subject.ts';

const Ref = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(300));
const PositiveInteger = Schema.Int.check(Schema.isGreaterThan(0));

export const PrivacyRetentionWindowSchema = Schema.Union([
  Schema.Struct({ durationDays: PositiveInteger, kind: Schema.Literal('DURATION') }),
  Schema.Struct({ endAt: PrivacyIsoTimestampSchema, kind: Schema.Literal('END_AT') }),
]);
export type PrivacyRetentionWindow = typeof PrivacyRetentionWindowSchema.Type;

export const PrivacyRetentionRuleVersionSchema = Schema.Struct({
  applicability: Schema.Literals(['PROSPECTIVE_ONLY', 'EXPLICIT_RETROACTIVE']),
  authorityRef: Ref,
  businessStartRef: Ref,
  contentScopeRef: Ref,
  effectiveFrom: PrivacyIsoTimestampSchema,
  effectiveTo: Schema.OptionFromNullOr(PrivacyIsoTimestampSchema),
  retentionWindow: PrivacyRetentionWindowSchema,
  retroactiveApprovalRef: Schema.OptionFromNullOr(Ref),
  ruleRef: Ref,
  ruleVersion: PositiveInteger,
});
export type PrivacyRetentionRuleVersion = typeof PrivacyRetentionRuleVersionSchema.Type;

export interface ValidatePrivacyRetentionRuleInput {
  readonly applicability?: PrivacyRetentionRuleVersion['applicability'];
  readonly authorityRef: string;
  readonly businessStartRef: string;
  readonly contentScopeRef: string;
  readonly effectiveFrom: PrivacyRetentionRuleVersion['effectiveFrom'];
  readonly effectiveTo?: PrivacyRetentionRuleVersion['effectiveTo'];
  readonly retentionWindow: PrivacyRetentionWindow;
  readonly retroactiveApprovalRef?: string | null;
  readonly ruleRef: string;
  readonly ruleVersion: number;
}

export type PrivacyRetentionRuleValidation =
  | { readonly rule: PrivacyRetentionRuleVersion; readonly valid: true }
  | { readonly reasons: readonly string[]; readonly valid: false };

/** Retention is scoped to record content, not a subject, tenant, table, or whole owner. */
export const validatePrivacyRetentionRule = (
  input: ValidatePrivacyRetentionRuleInput,
): PrivacyRetentionRuleValidation => {
  const applicability = input.applicability ?? 'PROSPECTIVE_ONLY';
  const retroactiveApprovalRef =
    input.retroactiveApprovalRef === undefined || input.retroactiveApprovalRef === null
      ? Option.none()
      : Option.some(input.retroactiveApprovalRef);
  const reasons: string[] = [];
  if (applicability === 'EXPLICIT_RETROACTIVE' && Option.isNone(retroactiveApprovalRef)) {
    reasons.push('retroactive_applicability_requires_explicit_approval');
  }
  const effectiveTo = input.effectiveTo ?? Option.none();
  if (Option.isSome(effectiveTo) && effectiveTo.value <= input.effectiveFrom) {
    reasons.push('effective_period_is_invalid');
  }
  if (reasons.length > 0) {
    return { reasons, valid: false };
  }
  return {
    rule: {
      applicability,
      authorityRef: input.authorityRef,
      businessStartRef: input.businessStartRef,
      contentScopeRef: input.contentScopeRef,
      effectiveFrom: input.effectiveFrom,
      effectiveTo,
      retentionWindow: input.retentionWindow,
      retroactiveApprovalRef,
      ruleRef: input.ruleRef,
      ruleVersion: input.ruleVersion,
    },
    valid: true,
  };
};

/** A newer rule version does not silently change the applicability of already-started content. */
export const appliesPrivacyRetentionRuleToExistingContent = (rule: PrivacyRetentionRuleVersion): boolean =>
  rule.applicability === 'EXPLICIT_RETROACTIVE' && Option.isSome(rule.retroactiveApprovalRef);
