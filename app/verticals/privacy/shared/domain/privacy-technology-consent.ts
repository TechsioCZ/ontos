/* eslint-disable effect-native/no-nullable-schema-field, effect-native/no-unbranded-identifier-schema -- Privacy cross-owner wire contracts preserve explicit JSON null, canonical UTC string encodings, and owner-issued opaque references; generated API and Resource boundaries validate provenance without a misleading shared brand. expires: 2027-03-31. */
import { Schema } from 'effect';

import { ConsentScopeSchema } from './privacy-consent-scope.ts';
import type { ConsentScope } from './privacy-consent-scope.ts';
import { PrivacySubjectSchema, PrivacyIsoTimestampSchema } from './privacy-subject.ts';

const Ref = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(300));
const Meaning = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(2000));

/** A governed technology classification. The label is never a legal decision. */
export const TechnologyCategorySchema = Schema.Struct({
  categoryRef: Ref,
  evidenceRefs: Schema.Array(Ref).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
  meaning: Meaning,
  processingPurposeRef: Ref,
  purposeVersionRef: Ref,
  status: Schema.Literals(['ACTIVE', 'RETIRED']),
});
export type TechnologyCategory = typeof TechnologyCategorySchema.Type;

export const TechnologyProviderSetSchema = Schema.Struct({
  evidenceRefs: Schema.Array(Ref).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
  meaning: Meaning,
  providerRefs: Schema.Array(Ref).check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  providerSetRef: Ref,
  version: Ref,
});
export type TechnologyProviderSet = typeof TechnologyProviderSetSchema.Type;

/** Rejects labels that would turn classification into an undeclared privacy authority. */
export const validateTechnologyCategory = (category: TechnologyCategory): string | undefined => {
  if (/^(?:other|necessary|essential|analytics|marketing)$/iu.test(category.categoryRef)) {
    return 'Technology Category must use a governed identifier, not a generic label';
  }
  if (category.status === 'ACTIVE' && category.evidenceRefs.length === 0) {
    return 'Active Technology Category requires evidence';
  }
  return undefined;
};

export const validateTechnologyProviderSet = (set: TechnologyProviderSet): string | undefined => {
  if (new Set(set.providerRefs).size !== set.providerRefs.length) {
    return 'Technology Provider Set cannot contain duplicate providers';
  }
  return undefined;
};

export const TechnologyConsentContextSchema = Schema.Struct({
  addressableUntil: PrivacyIsoTimestampSchema,
  contextRef: Ref,
  deviceContextRef: Schema.NullOr(Ref),
  evidenceRefs: Schema.Array(Ref).check(Schema.isMaxLength(32)),
  siteRef: Ref,
  subject: PrivacySubjectSchema,
});
export type TechnologyConsentContext = typeof TechnologyConsentContextSchema.Type;

export const TechnologyConsentChoiceSchema = Schema.Struct({
  contextRef: Ref,
  explicit: Schema.Boolean,
  outcome: Schema.Literals(['GRANTED', 'REFUSED', 'ABSENT', 'UNKNOWN']),
  recordedAt: PrivacyIsoTimestampSchema,
  scope: ConsentScopeSchema,
});
export type TechnologyConsentChoice = typeof TechnologyConsentChoiceSchema.Type;

const consentScopeEquivalence = Schema.toEquivalence(ConsentScopeSchema);

/** Missing, lost, or indeterminate persistence is fail-closed, never a grant. */
// fallow-ignore-next-line complexity -- Technology choice resolution intentionally enumerates every fail-closed validity and expiry state.
export const resolveTechnologyChoice = (input: {
  readonly context: TechnologyConsentContext;
  readonly now: string;
  readonly persisted?: TechnologyConsentChoice;
  readonly persistenceReliable: boolean;
  readonly scope: ConsentScope;
}): TechnologyConsentChoice['outcome'] => {
  const anonymousContextExpiry =
    input.context.subject.kind === 'ANONYMOUS' ? input.context.subject.anonymousContext.expiresAt : undefined;
  if (
    input.context.addressableUntil <= input.now ||
    (anonymousContextExpiry !== undefined && anonymousContextExpiry <= input.now)
  ) {
    return 'UNKNOWN';
  }
  const choice = input.persisted;
  if (!input.persistenceReliable || choice === undefined) {
    return input.persistenceReliable ? 'ABSENT' : 'UNKNOWN';
  }
  if (choice.contextRef !== input.context.contextRef || !consentScopeEquivalence(choice.scope, input.scope)) {
    return 'UNKNOWN';
  }
  if (!choice.explicit || choice.outcome === 'ABSENT' || choice.outcome === 'UNKNOWN') {
    return 'UNKNOWN';
  }
  return choice.outcome;
};

export const TechnologyConsentLinkingSchema = Schema.Struct({
  anonymousContextRef: Ref,
  dataSubjectRef: Ref,
  evidenceRefs: Schema.Array(Ref).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
  explicit: Schema.Literal(true),
  linkedAt: PrivacyIsoTimestampSchema,
  linkRef: Ref,
});
export type TechnologyConsentLinking = typeof TechnologyConsentLinkingSchema.Type;

/** Linking preserves anonymous provenance and is not itself a Consent Decision. */
export const validateTechnologyConsentLinking = (link: TechnologyConsentLinking): string | undefined =>
  link.anonymousContextRef === link.dataSubjectRef
    ? 'Technology Consent linking requires distinct anonymous and subject references'
    : undefined;

export const TechnologyConsentReassessmentSchema = Schema.Struct({
  currentScope: ConsentScopeSchema,
  explicitMateriality: Schema.Boolean,
  outcome: Schema.Literals(['NO_REPROMPT_REQUIRED', 'REPROMPT_REQUIRED', 'BLOCK_UNTIL_NEW_DECISION']),
  policyRef: Schema.NullOr(Ref),
  previousScope: ConsentScopeSchema,
});
export type TechnologyConsentReassessment = typeof TechnologyConsentReassessmentSchema.Type;

const reassessmentOutcome = (
  material: boolean,
  policyRef: string | undefined,
): TechnologyConsentReassessment['outcome'] => {
  if (!material) {
    return 'NO_REPROMPT_REQUIRED';
  }
  return policyRef === undefined ? 'BLOCK_UNTIL_NEW_DECISION' : 'REPROMPT_REQUIRED';
};

/** Purpose/category/provider-set changes require a fresh evaluation before protected use. */
export const assessTechnologyConsentReassessment = (input: {
  readonly current: ConsentScope;
  readonly materialChange: boolean;
  readonly policyRef?: string;
  readonly previous: ConsentScope;
}): TechnologyConsentReassessment => {
  const changed = !consentScopeEquivalence(input.previous, input.current);
  const material = input.materialChange && changed;
  return {
    currentScope: input.current,
    explicitMateriality: input.materialChange,
    outcome: reassessmentOutcome(material, input.policyRef),
    policyRef: input.policyRef ?? null,
    previousScope: input.previous,
  };
};

export const TechnologyConsentWithdrawalSchema = Schema.Struct({
  effectiveAt: PrivacyIsoTimestampSchema,
  historicalProcessingPreserved: Schema.Literal(true),
  scope: ConsentScopeSchema,
  stopsFutureUse: Schema.Literal(true),
  withdrawalDecisionId: Ref,
});
export type TechnologyConsentWithdrawal = typeof TechnologyConsentWithdrawalSchema.Type;

export const isTechnologyConsentScopeEquivalent = (left: ConsentScope, right: ConsentScope): boolean =>
  consentScopeEquivalence(left, right);
