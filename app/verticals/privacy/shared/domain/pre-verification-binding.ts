import { Option, Schema } from 'effect';

import { PrivacySubjectRefSchema } from '../resources/privacy-subject.ts';
import type { PrivacySubjectRef } from '../resources/privacy-subject.ts';
import { consentIsRequired, IntendedProcessingScopeSchema } from './privacy-processing-eligibility.ts';
import type {
  PrivacyEligibilityAuthoritativeReference,
  PrivacyEligibilityOutcome,
  PrivacyEligibilityPolicyRevision,
  PrivacyInputResolution,
} from './privacy-processing-eligibility.ts';
import { isPrivacyInstantAfter, isPrivacyInstantAtOrBefore, PrivacyIsoTimestampSchema } from './privacy-subject.ts';

/**
 * PRE-VERIFICATION SUBJECT BINDING (#1406 D.8, #1396): the Privacy-owned subject of a person whose address a source
 * owner has NOT verified yet (a Portal Auth account before its e-mail is confirmed).
 *
 * - Only the source owner itself binds, and only by its OWN reference to the account. The reference locates the
 *   account; it is no proof of identity, no Party and no permission, and it is never an address, token or code.
 * - Privacy, not the source, decides what the bound subject may be processed for: a deployment-governed Privacy policy
 *   per source purpose names the controller, purpose version, operation, processing scope, data and recipient
 *   dimensions and the legal basis. No policy means nothing is bound and nothing is evaluated.
 * - The binding is Tenant-scoped; its Legal Entity is optional and exact. A Tenant-wide realm binds without one and is
 *   never given an invented Legal Entity; a binding of one Legal Entity is invisible in any other scope.
 * - Privacy may withdraw a binding at any time (objection, restriction, erasure request or a binding found invalid);
 *   every later eligibility for it is a proven NOT_ALLOWED, and a new bind of the same account stays withdrawn.
 */

const Ref = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(300));
const Uuid = Schema.String.check(Schema.isUUID());
const TenantIdSchema = Uuid.pipe(Schema.brand('PrivacyPreVerificationTenantId'), Schema.decodeTo(Schema.String));
const LegalEntityIdSchema = Uuid.pipe(
  Schema.brand('PrivacyPreVerificationLegalEntityId'),
  Schema.decodeTo(Schema.String),
);
const PrincipalIdSchema = Uuid.pipe(Schema.brand('PrivacyPreVerificationPrincipalId'), Schema.decodeTo(Schema.String));

/** The finite set of source owners Privacy admits to bind a pre-verification subject. */
export const PreVerificationSourceModuleSchema = Schema.Literal('commerce.customer-context');
type PreVerificationSourceModule = typeof PreVerificationSourceModuleSchema.Type;

/** The verified calling application of each admitted source owner; a module may bind only its own accounts. */
export const preVerificationSourceAppIdOf = {
  'commerce.customer-context': 'commerce-customer-context',
} as const satisfies Readonly<Record<PreVerificationSourceModule, string>>;

/** The verified calling application of the only consumer admitted to ask for a pre-verification eligibility. */
export const preVerificationConsumerAppIdOf = { 'communications.core': 'communications' } as const;

/** The source owner's OWN reference to the not yet verified account (for Portal Auth: its provider subject id). */
export const PreVerificationSourceSubjectSchema = Schema.Struct({
  moduleId: PreVerificationSourceModuleSchema,
  resourceId: Ref.pipe(Schema.brand('PrivacyPreVerificationSourceResourceId'), Schema.decodeTo(Schema.String)),
  resourceType: Ref,
});
export type PreVerificationSourceSubject = typeof PreVerificationSourceSubjectSchema.Type;

/** Length-prefixed identity of a source subject, so no part can imitate a boundary. */
export const preVerificationSourceSubjectKey = (subject: PreVerificationSourceSubject): string =>
  [subject.moduleId, subject.resourceType, subject.resourceId].map((part) => `${part.length}:${part}`).join('|');

/** The opaque Privacy identity of one bound subject. It is the resource id of the subject's Privacy reference. */
export const PreVerificationBindingRefSchema = Uuid.pipe(Schema.brand('PrivacyPreVerificationBindingRef'));

/** The scope a policy allows, without the subject: Privacy adds its own subject reference to it at evaluation. */
const PreVerificationPolicyScopeSchema = Schema.Struct({
  controllerRef: IntendedProcessingScopeSchema.fields.controllerRef,
  dataCategoryRefs: IntendedProcessingScopeSchema.fields.dataCategoryRefs,
  operation: IntendedProcessingScopeSchema.fields.operation,
  processingScopeRef: IntendedProcessingScopeSchema.fields.processingScopeRef,
  purposeRef: IntendedProcessingScopeSchema.fields.purposeRef,
  purposeVersionId: IntendedProcessingScopeSchema.fields.purposeVersionId,
  recipientRefs: IntendedProcessingScopeSchema.fields.recipientRefs,
});

/**
 * One deployment-governed Privacy owner policy: what ONE source purpose may do with a bound subject in ONE scope, during
 * its validity. Its values are product and legal decisions of the Privacy owner and are configured, never defaulted.
 */
export const PreVerificationBindingPolicySchema = Schema.Struct({
  effectiveFrom: PrivacyIsoTimestampSchema,
  legalBasisRef: Ref,
  /** Absent for a Tenant-wide realm; never invented. */
  legalEntityId: Schema.optionalKey(LegalEntityIdSchema),
  policyRef: Ref,
  revision: Ref,
  scope: PreVerificationPolicyScopeSchema,
  sourceModuleId: PreVerificationSourceModuleSchema,
  /** The source's own purpose key, for example the Communications catalog purpose of a Portal Auth message type. */
  sourcePurposeRef: Ref,
  sourceResourceType: Ref,
  tenantId: TenantIdSchema,
  validUntil: PrivacyIsoTimestampSchema,
}).check(
  Schema.makeFilter((policy) =>
    isPrivacyInstantAfter(policy.validUntil, policy.effectiveFrom)
      ? undefined
      : 'A pre-verification binding policy must end after it starts',
  ),
);
export type PreVerificationBindingPolicy = typeof PreVerificationBindingPolicySchema.Type;

export const PreVerificationBindingStatusSchema = Schema.Literals(['ACTIVE', 'WITHDRAWN']);

/** Privacy's durable record of one bound subject. It holds the source reference and Privacy facts only. */
export const PreVerificationBindingRecordSchema = Schema.Struct({
  bindingRef: PreVerificationBindingRefSchema,
  boundAt: PrivacyIsoTimestampSchema,
  legalEntityId: Schema.optionalKey(LegalEntityIdSchema),
  revision: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  source: PreVerificationSourceSubjectSchema,
  status: PreVerificationBindingStatusSchema,
  tenantId: TenantIdSchema,
  updatedAt: PrivacyIsoTimestampSchema,
  /** The latest instant a source occurrence of this subject stays usable, as the source stated it at bind time. */
  validUntil: PrivacyIsoTimestampSchema,
  withdrawal: Schema.optionalKey(
    Schema.Struct({ evidenceRef: Ref, withdrawnAt: PrivacyIsoTimestampSchema, withdrawnBy: PrincipalIdSchema }),
  ),
}).check(
  Schema.makeFilter((record) =>
    (record.status === 'WITHDRAWN') === (record.withdrawal !== undefined)
      ? undefined
      : 'A withdrawn binding, and only a withdrawn binding, carries its withdrawal',
  ),
);
export type PreVerificationBindingRecord = typeof PreVerificationBindingRecordSchema.Type;

/** The Privacy reference of a bound subject, as an evaluated scope names its subject. */
export const preVerificationSubjectRefOf = (binding: PreVerificationBindingRecord): PrivacySubjectRef =>
  PrivacySubjectRefSchema.make({
    moduleId: 'privacy.core',
    resourceId: binding.bindingRef,
    resourceType: 'privacy.core.privacy-subject',
    tenantId: binding.tenantId,
  });

/** Why Privacy evaluated nothing; the same vocabulary as the source-processing contract, so a consumer reads it once. */
const PreVerificationNotEvaluatedCauseSchema = Schema.Literals([
  'CONTEXT_NOT_CURRENT',
  'MULTIPLE_CONTEXTS',
  'NO_CONTEXT',
  'SUBJECT_NOT_FOUND',
]);
export type PreVerificationNotEvaluatedCause = typeof PreVerificationNotEvaluatedCauseSchema.Type;

interface PreVerificationPolicyQuery {
  /** Absent for a Tenant-wide operation; compared exactly. */
  readonly legalEntityId?: string | undefined;
  /** Absent at bind time (every operation of the purpose); present at eligibility, where it must be the policy's. */
  readonly operation?: string;
  readonly sourceModuleId: PreVerificationSourceModule;
  readonly sourcePurposeRef: string;
  readonly sourceResourceType: string;
  readonly tenantId: string;
}

type PreVerificationPolicyResolution =
  | { readonly kind: 'CURRENT'; readonly policy: PreVerificationBindingPolicy }
  | { readonly kind: 'NOT_EVALUATED'; readonly reasonCode: PreVerificationNotEvaluatedCause };

/**
 * The ONE policy of an exact use, or why there is none. The Legal Entity is compared exactly, an absent one included,
 * so a Tenant-wide request never matches a Legal Entity policy and the reverse.
 */
export const resolvePreVerificationPolicy = (
  policies: readonly PreVerificationBindingPolicy[],
  query: PreVerificationPolicyQuery,
  asOf: string,
): PreVerificationPolicyResolution => {
  const exact = policies.filter(
    (policy) =>
      policy.tenantId === query.tenantId &&
      policy.legalEntityId === query.legalEntityId &&
      policy.sourceModuleId === query.sourceModuleId &&
      policy.sourceResourceType === query.sourceResourceType &&
      policy.sourcePurposeRef === query.sourcePurposeRef &&
      (query.operation === undefined || policy.scope.operation === query.operation),
  );
  const [policy] = exact;
  if (policy === undefined) {
    return { kind: 'NOT_EVALUATED', reasonCode: 'NO_CONTEXT' };
  }
  if (exact.length !== 1) {
    return { kind: 'NOT_EVALUATED', reasonCode: 'MULTIPLE_CONTEXTS' };
  }
  return isPrivacyInstantAtOrBefore(policy.effectiveFrom, asOf) && isPrivacyInstantAfter(policy.validUntil, asOf)
    ? { kind: 'CURRENT', policy }
    : { kind: 'NOT_EVALUATED', reasonCode: 'CONTEXT_NOT_CURRENT' };
};

/** The binding that a new bind of the same source subject produces: a later occurrence extends it, nothing reopens it. */
export const rebindPreVerificationSubject = (
  existing: PreVerificationBindingRecord,
  occurrenceValidUntil: string,
  now: string,
): PreVerificationBindingRecord =>
  isPrivacyInstantAfter(occurrenceValidUntil, existing.validUntil)
    ? { ...existing, revision: existing.revision + 1, updatedAt: now, validUntil: occurrenceValidUntil }
    : existing;

type PreVerificationEligibilityEvaluation =
  | {
      readonly authoritativeReferences: readonly PrivacyEligibilityAuthoritativeReference[];
      readonly kind: 'EVALUATED';
      readonly outcome: PrivacyEligibilityOutcome;
      readonly policyRevisions: readonly PrivacyEligibilityPolicyRevision[];
    }
  | { readonly kind: 'NOT_EVALUATED'; readonly reasonCode: PreVerificationNotEvaluatedCause };

const WITHDRAWN_REASON = 'pre_verification_binding_withdrawn';
const EXPIRED_REASON = 'pre_verification_binding_expired';

const resolution = (
  state: PrivacyInputResolution['state'],
  reason: string,
  currentness: PrivacyInputResolution['currentness'],
): PrivacyInputResolution => ({ currentness, reason, state });

const unknownReasonsOf = (
  binding: PreVerificationBindingRecord,
  policy: PreVerificationBindingPolicy,
  asOf: string,
): readonly string[] => [
  ...(isPrivacyInstantAfter(binding.validUntil, asOf) ? [] : [EXPIRED_REASON]),
  // nobody can have given a Current Consent for an account whose address is not verified
  ...(consentIsRequired(policy.legalBasisRef) ? ['consent_absent'] : []),
];

/** A withdrawal decides alone; otherwise any input Privacy cannot evidence makes the result INDETERMINATE. */
const decisionOf = (
  binding: PreVerificationBindingRecord,
  unknown: readonly string[],
): Pick<PrivacyEligibilityOutcome, 'outcome' | 'reasonCodes'> => {
  if (binding.status === 'WITHDRAWN') {
    return { outcome: 'NOT_ALLOWED', reasonCodes: [WITHDRAWN_REASON] };
  }
  return unknown.length > 0
    ? { outcome: 'INDETERMINATE', reasonCodes: unknown }
    : { outcome: 'ALLOWED', reasonCodes: ['all_mandatory_inputs_current_no_blocker'] };
};

/** The restriction fact of a binding: withdrawn (a blocker), past its stated validity (stale), or none. */
const restrictionOf = (
  binding: PreVerificationBindingRecord,
  unknown: readonly string[],
  currentness: PrivacyInputResolution['currentness'],
): PrivacyInputResolution => {
  if (binding.status === 'WITHDRAWN') {
    return resolution('CURRENT', WITHDRAWN_REASON, currentness);
  }
  return unknown.includes(EXPIRED_REASON)
    ? resolution('STALE', EXPIRED_REASON, currentness)
    : resolution('CURRENT', 'restriction_absent', currentness);
};

/**
 * The eligibility of ONE bound subject for ONE current policy, now. A withdrawal is a proven prohibition (NOT_ALLOWED)
 * whatever else holds; a binding past the validity the source stated, or a legal basis that needs a Consent nobody can
 * have given yet, cannot be evidenced (INDETERMINATE); only an active, current binding under a current policy whose
 * basis needs no Consent is ALLOWED. A binding of another source, resource type or Legal Entity is not this subject.
 */
export const evaluatePreVerificationEligibility = (input: {
  readonly asOf: string;
  readonly binding: Option.Option<PreVerificationBindingRecord>;
  readonly legalEntityId?: string | undefined;
  readonly policy: PreVerificationBindingPolicy;
}): PreVerificationEligibilityEvaluation => {
  const { asOf, policy } = input;
  const binding = input.binding.pipe(
    Option.filter(
      (record) =>
        record.tenantId === policy.tenantId &&
        record.legalEntityId === input.legalEntityId &&
        record.source.moduleId === policy.sourceModuleId &&
        record.source.resourceType === policy.sourceResourceType,
    ),
  );
  if (Option.isNone(binding)) {
    return { kind: 'NOT_EVALUATED', reasonCode: 'SUBJECT_NOT_FOUND' };
  }
  const bound = binding.value;
  const bindingCurrentness = {
    authoritative: true,
    observedAt: asOf,
    revision: String(bound.revision),
    sourceRef: bound.bindingRef,
    validUntil: bound.validUntil,
  };
  const policyCurrentness = {
    authoritative: true,
    observedAt: asOf,
    revision: policy.revision,
    sourceRef: policy.policyRef,
    validUntil: policy.validUntil,
  };
  const unknown = unknownReasonsOf(bound, policy, asOf);
  const outcome: PrivacyEligibilityOutcome = {
    ...decisionOf(bound, unknown),
    evaluatedAt: asOf,
    evaluatedScope: { ...policy.scope, subjectRef: preVerificationSubjectRefOf(bound) },
    inputResolutions: {
      applicability: resolution('CURRENT', 'pre_verification_policy_current', policyCurrentness),
      consent: resolution(
        'ABSENT',
        consentIsRequired(policy.legalBasisRef) ? 'consent_absent' : 'consent_not_required',
        policyCurrentness,
      ),
      legalBasis: resolution('CURRENT', 'pre_verification_policy_legal_basis', {
        ...policyCurrentness,
        sourceRef: policy.legalBasisRef,
      }),
      objection: resolution('CURRENT', 'objection_absent', bindingCurrentness),
      restriction: restrictionOf(bound, unknown, bindingCurrentness),
    },
  };
  return {
    authoritativeReferences: [
      { kind: 'privacy.core.pre-verification-binding', reference: bound.bindingRef, revision: String(bound.revision) },
      { kind: 'privacy.core.pre-verification-policy', reference: policy.policyRef, revision: policy.revision },
    ],
    kind: 'EVALUATED',
    outcome,
    policyRevisions: [{ policyRef: policy.policyRef, revision: policy.revision }],
  };
};
