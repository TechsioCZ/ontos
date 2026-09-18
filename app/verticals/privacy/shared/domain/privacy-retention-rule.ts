import { Option, Schema } from 'effect';

import { PrivacyIsoTimestampSchema } from './privacy-subject.ts';

const Ref = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(300));
const RuleVersionId = Ref.pipe(Schema.brand('RuleVersionId'));
const LegalEntityId = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('LegalEntityId'));
const TenantId = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('TenantId'));
const Refs = Schema.Array(Ref).check(Schema.isMinLength(1), Schema.isMaxLength(128));
const PositiveInteger = Schema.Int.check(Schema.isGreaterThan(0));
const DispositionOutcome = Schema.Literals(['RETAIN', 'RESTRICT', 'ANONYMIZE', 'DELETE']);

export const PrivacyRetentionWindowSchema = Schema.Union([
  Schema.Struct({ durationDays: PositiveInteger, kind: Schema.Literal('DURATION') }),
  Schema.Struct({ endAt: PrivacyIsoTimestampSchema, kind: Schema.Literal('END_AT') }),
]);
export type PrivacyRetentionWindow = typeof PrivacyRetentionWindowSchema.Type;
const retentionWindowEquivalent = Schema.toEquivalence(PrivacyRetentionWindowSchema);

const PrivacyRetentionRuleVersionBaseFields = {
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
} as const;

/** Public rule intent. Governance fields and trusted business time are never caller supplied. */
export const PrivacyRetentionRuleUpsertRequestSchema = Schema.Struct({
  applicability: PrivacyRetentionRuleVersionBaseFields.applicability,
  businessStartRef: PrivacyRetentionRuleVersionBaseFields.businessStartRef,
  contentScopeRef: PrivacyRetentionRuleVersionBaseFields.contentScopeRef,
  effectiveFrom: PrivacyRetentionRuleVersionBaseFields.effectiveFrom,
  effectiveTo: PrivacyRetentionRuleVersionBaseFields.effectiveTo,
  retentionWindow: PrivacyRetentionRuleVersionBaseFields.retentionWindow,
  retroactiveApprovalRef: PrivacyRetentionRuleVersionBaseFields.retroactiveApprovalRef,
  ruleRef: PrivacyRetentionRuleVersionBaseFields.ruleRef,
  ruleVersion: PrivacyRetentionRuleVersionBaseFields.ruleVersion,
});
export type PrivacyRetentionRuleUpsertRequest = typeof PrivacyRetentionRuleUpsertRequestSchema.Type;

const PrivacyRetentionRuleEvaluationGovernanceFields = {
  controllerRef: Ref,
  dispositionOutcome: DispositionOutcome,
  evidenceRefs: Refs,
  policyRef: Ref,
  policyVersion: PositiveInteger,
  provenanceRef: Ref,
  ruleVersionId: RuleVersionId,
} as const;

/** Legacy rules still decode for history, but cannot produce an authoritative evaluation. */
export const PrivacyRetentionRuleVersionSchema = Schema.Struct({
  ...PrivacyRetentionRuleVersionBaseFields,
  businessStartAt: Schema.optional(PrivacyIsoTimestampSchema),
  controllerRef: Schema.optional(PrivacyRetentionRuleEvaluationGovernanceFields.controllerRef),
  dispositionOutcome: Schema.optional(PrivacyRetentionRuleEvaluationGovernanceFields.dispositionOutcome),
  evidenceRefs: Schema.optional(PrivacyRetentionRuleEvaluationGovernanceFields.evidenceRefs),
  policyRef: Schema.optional(PrivacyRetentionRuleEvaluationGovernanceFields.policyRef),
  policyVersion: Schema.optional(PrivacyRetentionRuleEvaluationGovernanceFields.policyVersion),
  provenanceRef: Schema.optional(PrivacyRetentionRuleEvaluationGovernanceFields.provenanceRef),
  ruleVersionId: Schema.optional(PrivacyRetentionRuleEvaluationGovernanceFields.ruleVersionId),
});
export type PrivacyRetentionRuleVersion = typeof PrivacyRetentionRuleVersionSchema.Type;

export const AuthoritativePrivacyRetentionRuleVersionSchema = Schema.Struct({
  ...PrivacyRetentionRuleVersionBaseFields,
  businessStartAt: PrivacyIsoTimestampSchema,
  ...PrivacyRetentionRuleEvaluationGovernanceFields,
});
export type AuthoritativePrivacyRetentionRuleVersion = typeof AuthoritativePrivacyRetentionRuleVersionSchema.Type;

export const RetentionRuleAuthorityResolutionSchema = Schema.Struct({
  asOf: PrivacyIsoTimestampSchema,
  legalEntityId: LegalEntityId,
  rule: AuthoritativePrivacyRetentionRuleVersionSchema,
  status: Schema.Literals(['CURRENT', 'STALE', 'CONFLICT', 'UNAVAILABLE']),
  tenantId: TenantId,
});
export type RetentionRuleAuthorityResolution = typeof RetentionRuleAuthorityResolutionSchema.Type;

export interface ValidatePrivacyRetentionRuleInput {
  readonly applicability?: PrivacyRetentionRuleVersion['applicability'];
  readonly authorityRef: string;
  /** Trusted timestamp of the business event named by businessStartRef. */
  readonly businessStartAt: typeof PrivacyIsoTimestampSchema.Type;
  readonly businessStartRef: string;
  readonly contentScopeRef: string;
  readonly controllerRef: string;
  readonly dispositionOutcome: typeof DispositionOutcome.Type;
  readonly effectiveFrom: PrivacyRetentionRuleVersion['effectiveFrom'];
  readonly effectiveTo?: PrivacyRetentionRuleVersion['effectiveTo'];
  readonly evidenceRefs: readonly string[];
  readonly policyRef: string;
  readonly policyVersion: number;
  readonly provenanceRef: string;
  readonly retentionWindow: PrivacyRetentionWindow;
  readonly retroactiveApprovalRef?: string | null;
  readonly ruleRef: string;
  readonly ruleVersion: number;
  readonly ruleVersionId?: typeof RuleVersionId.Type;
}

export type PrivacyRetentionRuleValidation =
  | { readonly rule: PrivacyRetentionRuleVersion; readonly valid: true }
  | { readonly reasons: readonly string[]; readonly valid: false };

const validateBusinessStart = (input: ValidatePrivacyRetentionRuleInput): string | undefined => {
  if (input.businessStartAt > input.effectiveFrom) {
    return 'business_start_must_precede_rule_effective_period';
  }
  return undefined;
};

const validateApplicability = (
  applicability: PrivacyRetentionRuleVersion['applicability'],
  retroactiveApprovalRef: PrivacyRetentionRuleVersion['retroactiveApprovalRef'],
): readonly string[] => {
  const reasons: string[] = [];
  if (applicability === 'EXPLICIT_RETROACTIVE' && Option.isNone(retroactiveApprovalRef)) {
    reasons.push('retroactive_applicability_requires_explicit_approval');
  }
  if (applicability === 'PROSPECTIVE_ONLY' && Option.isSome(retroactiveApprovalRef)) {
    reasons.push('prospective_applicability_cannot_have_retroactive_approval');
  }
  return reasons;
};

const validateEffectivePeriod = (input: ValidatePrivacyRetentionRuleInput): string | undefined => {
  const effectiveTo = input.effectiveTo ?? Option.none();
  if (Option.isSome(effectiveTo) && effectiveTo.value <= input.effectiveFrom) {
    return 'effective_period_is_invalid';
  }
  return undefined;
};

const validateRetentionPeriod = (input: ValidatePrivacyRetentionRuleInput): string | undefined => {
  if (input.retentionWindow.kind === 'END_AT' && input.retentionWindow.endAt <= input.businessStartAt) {
    return 'retention_period_is_invalid';
  }
  return undefined;
};

const validateRetentionRuleInput = (
  input: ValidatePrivacyRetentionRuleInput,
  applicability: PrivacyRetentionRuleVersion['applicability'],
  retroactiveApprovalRef: PrivacyRetentionRuleVersion['retroactiveApprovalRef'],
): readonly string[] =>
  [
    validateBusinessStart(input),
    ...validateApplicability(applicability, retroactiveApprovalRef),
    validateEffectivePeriod(input),
    validateRetentionPeriod(input),
  ].filter((reason): reason is string => reason !== undefined);

/** Retention is scoped to record content, not a subject, tenant, table, or whole owner. */
export const validatePrivacyRetentionRule = (
  input: ValidatePrivacyRetentionRuleInput,
): PrivacyRetentionRuleValidation => {
  const applicability = input.applicability ?? 'PROSPECTIVE_ONLY';
  const retroactiveApprovalRef =
    input.retroactiveApprovalRef === undefined || input.retroactiveApprovalRef === null
      ? Option.none()
      : Option.some(input.retroactiveApprovalRef);
  const reasons = validateRetentionRuleInput(input, applicability, retroactiveApprovalRef);
  const effectiveTo = input.effectiveTo ?? Option.none();
  if (reasons.length > 0) {
    return { reasons, valid: false };
  }
  return {
    rule: {
      applicability,
      authorityRef: input.authorityRef,
      businessStartAt: input.businessStartAt,
      businessStartRef: input.businessStartRef,
      contentScopeRef: input.contentScopeRef,
      controllerRef: input.controllerRef,
      dispositionOutcome: input.dispositionOutcome,
      effectiveFrom: input.effectiveFrom,
      effectiveTo,
      evidenceRefs: input.evidenceRefs,
      policyRef: input.policyRef,
      policyVersion: input.policyVersion,
      provenanceRef: input.provenanceRef,
      retentionWindow: input.retentionWindow,
      retroactiveApprovalRef,
      ruleRef: input.ruleRef,
      ruleVersion: input.ruleVersion,
      ruleVersionId: input.ruleVersionId,
    },
    valid: true,
  };
};

/** Validates the decoded Action value, including fields that legacy history may omit. */
export const validatePrivacyRetentionRuleVersion = (
  rule: PrivacyRetentionRuleVersion,
): PrivacyRetentionRuleValidation => {
  const {
    businessStartAt,
    controllerRef,
    dispositionOutcome,
    evidenceRefs,
    policyRef,
    policyVersion,
    provenanceRef,
    ruleVersionId,
  } = rule;
  if (businessStartAt === undefined) {
    return { reasons: ['businessStartAt_is_required'], valid: false };
  }
  if (controllerRef === undefined) {
    return { reasons: ['controllerRef_is_required'], valid: false };
  }
  if (dispositionOutcome === undefined) {
    return { reasons: ['dispositionOutcome_is_required'], valid: false };
  }
  if (evidenceRefs === undefined) {
    return { reasons: ['evidenceRefs_is_required'], valid: false };
  }
  if (policyRef === undefined) {
    return { reasons: ['policyRef_is_required'], valid: false };
  }
  if (policyVersion === undefined) {
    return { reasons: ['policyVersion_is_required'], valid: false };
  }
  if (provenanceRef === undefined) {
    return { reasons: ['provenanceRef_is_required'], valid: false };
  }
  if (ruleVersionId === undefined) {
    return { reasons: ['ruleVersionId_is_required'], valid: false };
  }
  return validatePrivacyRetentionRule({
    applicability: rule.applicability,
    authorityRef: rule.authorityRef,
    businessStartAt,
    businessStartRef: rule.businessStartRef,
    contentScopeRef: rule.contentScopeRef,
    controllerRef,
    dispositionOutcome,
    effectiveFrom: rule.effectiveFrom,
    effectiveTo: rule.effectiveTo,
    evidenceRefs,
    policyRef,
    policyVersion,
    provenanceRef,
    retentionWindow: rule.retentionWindow,
    retroactiveApprovalRef:
      rule.retroactiveApprovalRef === undefined ? null : Option.getOrNull(rule.retroactiveApprovalRef),
    ruleRef: rule.ruleRef,
    ruleVersion: rule.ruleVersion,
    ruleVersionId,
  });
};

const sameOption = (left: Option.Option<string>, right: Option.Option<string>): boolean =>
  Option.match(left, {
    onNone: () => Option.isNone(right),
    onSome: (value) => Option.isSome(right) && right.value === value,
  });

const validateRetentionRuleAuthorityCurrentness = (
  resolution: RetentionRuleAuthorityResolution,
  tenantId: string,
  legalEntityId: string,
  asOf: string,
): string | undefined => {
  if (resolution.status !== 'CURRENT') {
    return `Retention Rule governance is ${resolution.status.toLowerCase()}`;
  }
  if (resolution.asOf !== asOf || resolution.tenantId !== tenantId || resolution.legalEntityId !== legalEntityId) {
    return 'Retention Rule governance does not match the exact current Tenant, Legal Entity, or as-of time';
  }
  return undefined;
};

const retentionRuleMatchesRequest = (
  rule: AuthoritativePrivacyRetentionRuleVersion,
  request: PrivacyRetentionRuleUpsertRequest,
): boolean =>
  rule.applicability === request.applicability &&
  rule.businessStartRef === request.businessStartRef &&
  rule.contentScopeRef === request.contentScopeRef &&
  rule.effectiveFrom === request.effectiveFrom &&
  sameOption(rule.effectiveTo, request.effectiveTo) &&
  rule.ruleRef === request.ruleRef &&
  rule.ruleVersion === request.ruleVersion &&
  sameOption(rule.retroactiveApprovalRef, request.retroactiveApprovalRef) &&
  retentionWindowEquivalent(rule.retentionWindow, request.retentionWindow);

const validateRetentionRuleAuthorityIdentity = (
  request: PrivacyRetentionRuleUpsertRequest,
  resolution: RetentionRuleAuthorityResolution,
): string | undefined =>
  retentionRuleMatchesRequest(resolution.rule, request)
    ? undefined
    : 'Retention Rule governance does not match the exact requested rule identity, scope, or period';

/** Checks that a private governance result is current and exactly answers the public rule intent. */
export const validateRetentionRuleAuthorityResolution = (
  request: PrivacyRetentionRuleUpsertRequest,
  resolution: RetentionRuleAuthorityResolution,
  tenantId: string,
  legalEntityId: string,
  asOf: string,
): string | undefined =>
  validateRetentionRuleAuthorityCurrentness(resolution, tenantId, legalEntityId, asOf) ??
  validateRetentionRuleAuthorityIdentity(request, resolution) ??
  (validatePrivacyRetentionRuleVersion(resolution.rule).valid
    ? undefined
    : 'Retention Rule governance returned an invalid authoritative rule');

/** A newer rule version does not silently change the applicability of already-started content. */
export const appliesPrivacyRetentionRuleToExistingContent = (rule: PrivacyRetentionRuleVersion): boolean =>
  rule.applicability === 'EXPLICIT_RETROACTIVE' && Option.isSome(rule.retroactiveApprovalRef);
