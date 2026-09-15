/* eslint-disable effect-native/no-nullable-schema-field, effect-native/no-unbranded-identifier-schema -- Privacy cross-owner wire contracts preserve explicit JSON null, canonical UTC string encodings, and owner-issued opaque references; generated API and Resource boundaries validate provenance without a misleading shared brand. expires: 2027-03-31. */
import { PrincipalRefSchema } from '@app/core-runtime';
import { DateTime, Option, Schema } from 'effect';

import { PrivacyApplicabilityDecisionSchema } from './privacy-applicability.ts';
import { PrivacyIsoTimestampSchema } from './privacy-subject.ts';
import { ProcessingScopeRefSchema } from './privacy-responsibility-assignment.ts';
import { LegalBasisAssignmentRefSchema } from '../resources/legal-basis-assignment.ts';
import { ProcessingPurposeRefSchema } from '../resources/processing-purpose.ts';

const Ref = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(300));
const EvidenceRefs = Schema.Array(Ref).check(Schema.isMinLength(1), Schema.isMaxLength(32));
const samePurposeRef = Schema.toEquivalence(ProcessingPurposeRefSchema);

export const PrivacyLegalBasisKindSchema = Schema.Literals([
  'CONSENT',
  'CONTRACT',
  'LEGAL_OBLIGATION',
  'VITAL_INTERESTS',
  'PUBLIC_TASK',
  'LEGITIMATE_INTERESTS',
]);
export type PrivacyLegalBasisKind = typeof PrivacyLegalBasisKindSchema.Type;

export const PrivacyLegalBasisDecisionSchema = Schema.Literals(['APPROVED', 'REJECTED']);
export type PrivacyLegalBasisDecision = typeof PrivacyLegalBasisDecisionSchema.Type;

export const PrivacyLegalBasisScopeSchema = Schema.Struct({
  controllerRef: Ref,
  operation: Ref,
  processingScopeRef: ProcessingScopeRefSchema,
  purposeRef: ProcessingPurposeRefSchema,
  purposeVersionId: Ref,
});
export type PrivacyLegalBasisScope = typeof PrivacyLegalBasisScopeSchema.Type;

export const PrivacyLegalBasisProvenanceSchema = Schema.Struct({
  decisionEvidenceRefs: EvidenceRefs,
  policyRef: Ref,
  policyVersion: Ref,
  reason: Ref,
  recordedAt: PrivacyIsoTimestampSchema,
});
export type PrivacyLegalBasisProvenance = typeof PrivacyLegalBasisProvenanceSchema.Type;

/** An explicit governance decision. No field is optional enough to infer a basis or Controller. */
export const PrivacyLegalBasisAssignmentSchema = Schema.Struct({
  actor: PrincipalRefSchema,
  applicabilityDecision: PrivacyApplicabilityDecisionSchema,
  assignmentRef: LegalBasisAssignmentRefSchema,
  basis: PrivacyLegalBasisKindSchema,
  basisVersion: Ref,
  decision: PrivacyLegalBasisDecisionSchema,
  effectiveFrom: PrivacyIsoTimestampSchema,
  effectiveTo: Schema.NullOr(PrivacyIsoTimestampSchema),
  provenance: PrivacyLegalBasisProvenanceSchema,
  scope: PrivacyLegalBasisScopeSchema,
});
export type PrivacyLegalBasisAssignment = typeof PrivacyLegalBasisAssignmentSchema.Type;

/** Action input deliberately excludes applicabilityDecision. The handler loads it from Privacy authority. */
export const PrivacyLegalBasisAssignmentInputSchema = Schema.Struct({
  actor: PrincipalRefSchema,
  assignmentRef: LegalBasisAssignmentRefSchema,
  basis: PrivacyLegalBasisKindSchema,
  basisVersion: Ref,
  decision: PrivacyLegalBasisDecisionSchema,
  effectiveFrom: PrivacyIsoTimestampSchema,
  effectiveTo: Schema.NullOr(PrivacyIsoTimestampSchema),
  provenance: PrivacyLegalBasisProvenanceSchema,
  scope: PrivacyLegalBasisScopeSchema,
});
export type PrivacyLegalBasisAssignmentInput = typeof PrivacyLegalBasisAssignmentInputSchema.Type;

export type PrivacyLegalBasisValidation =
  | { readonly valid: true }
  | { readonly errors: readonly string[]; readonly valid: false };

const timestampMillis = (value: string): number | undefined =>
  DateTime.make(value).pipe(Option.map(DateTime.toEpochMillis), Option.getOrUndefined);

const isTimestampWithinPeriod = (value: string, from: string, to: string | null): boolean => {
  const valueMillis = timestampMillis(value);
  const fromMillis = timestampMillis(from);
  const toMillis = to === null ? undefined : timestampMillis(to);
  return (
    valueMillis !== undefined &&
    fromMillis !== undefined &&
    valueMillis >= fromMillis &&
    (to === null || (toMillis !== undefined && valueMillis < toMillis))
  );
};

const validateAuthorityBinding = (assignment: PrivacyLegalBasisAssignment): readonly string[] => {
  const errors: string[] = [];
  const { authority } = assignment.applicabilityDecision;
  if (authority === undefined) {
    return ['Legal Basis Assignment requires tenant-bound typed Applicability authority'];
  }
  if (authority.tenantId !== assignment.assignmentRef.tenantId) {
    errors.push('Legal Basis Assignment Applicability authority must share its tenant');
  }
  if (!samePurposeRef(authority.purposeRef, assignment.scope.purposeRef)) {
    errors.push('Legal Basis Assignment Purpose must exactly match the Applicability authority');
  }
  if (authority.purposeVersionRef.resourceId !== assignment.scope.purposeVersionId) {
    errors.push('Legal Basis Assignment Purpose Version must exactly match the Applicability authority');
  }
  if (authority.controllerRef.resourceId !== assignment.scope.controllerRef) {
    errors.push('Legal Basis Assignment Controller must exactly match the Applicability authority');
  }
  return errors;
};

const validateApplicabilityDecisionBindings = (assignment: PrivacyLegalBasisAssignment): readonly string[] => {
  const errors: string[] = [];
  if (assignment.applicabilityDecision.outcome !== 'APPLICABLE') {
    errors.push('Legal Basis Assignment requires an applicable Privacy Applicability Decision');
  }
  errors.push(...validateAuthorityBinding(assignment));
  const hasExactApplicabilityPolicy = assignment.applicabilityDecision.policyIdentities.some(
    ({ policyKey, policyVersion }) =>
      policyKey === assignment.provenance.policyRef && policyVersion === assignment.provenance.policyVersion,
  );
  if (!hasExactApplicabilityPolicy) {
    errors.push('Legal Basis Assignment policy provenance must match the Applicability Decision');
  }
  if (assignment.applicabilityDecision.evaluatedScope.operation !== assignment.scope.operation) {
    errors.push('Legal Basis Assignment operation must match the Applicability Decision operation');
  }
  if (
    assignment.applicabilityDecision.evaluatedScope.processingScopeRef.scopeType !==
      assignment.scope.processingScopeRef.scopeType ||
    assignment.applicabilityDecision.evaluatedScope.processingScopeRef.scopeId !==
      assignment.scope.processingScopeRef.scopeId
  ) {
    errors.push('Legal Basis Assignment scope must exactly match the Applicability Decision scope');
  }
  if (
    !isTimestampWithinPeriod(
      assignment.applicabilityDecision.evaluatedAt,
      assignment.effectiveFrom,
      assignment.effectiveTo,
    )
  ) {
    errors.push('Applicability Decision must be evaluated within the Legal Basis Assignment effective period');
  }
  return errors;
};

const validateApplicabilityFacts = (assignment: PrivacyLegalBasisAssignment): readonly string[] => {
  const errors: string[] = [];
  const facts = new Map<string, string[]>();
  for (const fact of assignment.applicabilityDecision.evaluatedScope.facts) {
    facts.set(fact.dimension, [...(facts.get(fact.dimension) ?? []), fact.value]);
  }
  const requiredFacts = [
    ['CONTROLLER_SCOPE', assignment.scope.controllerRef],
    ['PROCESSING_PURPOSE', assignment.scope.purposeRef.resourceId],
    ['PROCESSING_PURPOSE_VERSION', assignment.scope.purposeVersionId],
  ] as const;
  for (const [dimension, expected] of requiredFacts) {
    const values = facts.get(dimension);
    if (values === undefined || values.length !== 1 || values[0] !== expected) {
      errors.push(`Legal Basis Assignment ${dimension} fact must match its exact scope`);
    }
  }
  return errors;
};

const validateApplicabilityEvidence = (assignment: PrivacyLegalBasisAssignment): readonly string[] => [
  ...validateApplicabilityDecisionBindings(assignment),
  ...validateApplicabilityFacts(assignment),
];

export const validatePrivacyLegalBasisAssignment = (
  assignment: PrivacyLegalBasisAssignment,
): PrivacyLegalBasisValidation => {
  const errors: string[] = [];
  if (assignment.effectiveTo !== null && assignment.effectiveTo <= assignment.effectiveFrom) {
    errors.push('Legal Basis Assignment effective period is invalid');
  }
  errors.push(...validateApplicabilityEvidence(assignment));
  if (assignment.actor.tenantId !== assignment.assignmentRef.tenantId) {
    errors.push('Legal Basis Assignment actor and assignment must share a tenant');
  }
  if (assignment.scope.purposeRef.tenantId !== assignment.assignmentRef.tenantId) {
    errors.push('Legal Basis Assignment Purpose and assignment must share a tenant');
  }
  return errors.length === 0 ? { valid: true } : { errors, valid: false };
};

const sameScope = (left: PrivacyLegalBasisScope, right: PrivacyLegalBasisScope): boolean =>
  left.controllerRef === right.controllerRef &&
  left.operation === right.operation &&
  samePurposeRef(left.purposeRef, right.purposeRef) &&
  left.purposeVersionId === right.purposeVersionId &&
  left.processingScopeRef.scopeId === right.processingScopeRef.scopeId &&
  left.processingScopeRef.scopeType === right.processingScopeRef.scopeType;

const appliesAt = (assignment: PrivacyLegalBasisAssignment, asOf: string): boolean =>
  assignment.effectiveFrom <= asOf && (assignment.effectiveTo === null || asOf < assignment.effectiveTo);

export type PrivacyLegalBasisResolution =
  | { readonly assignment: PrivacyLegalBasisAssignment; readonly outcome: 'CURRENT' }
  | { readonly outcome: 'ABSENT' }
  | { readonly assignments: readonly PrivacyLegalBasisAssignment[]; readonly outcome: 'CONFLICT' };

/** Resolves only explicit assignments. Missing or ambiguous governance never falls back to another basis. */
export const resolveCurrentPrivacyLegalBasis = (
  assignments: readonly PrivacyLegalBasisAssignment[],
  scope: PrivacyLegalBasisScope,
  asOf: string,
): PrivacyLegalBasisResolution => {
  const current = assignments.filter(
    (assignment) =>
      assignment.decision === 'APPROVED' && sameScope(assignment.scope, scope) && appliesAt(assignment, asOf),
  );
  if (current.length === 0) {
    return { outcome: 'ABSENT' };
  }
  if (current.length !== 1) {
    return { assignments: current, outcome: 'CONFLICT' };
  }
  const assignment = current.at(0);
  return assignment === undefined ? { outcome: 'ABSENT' } : { assignment, outcome: 'CURRENT' };
};
