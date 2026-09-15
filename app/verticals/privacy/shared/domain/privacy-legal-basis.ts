/* eslint-disable effect-native/no-nullable-schema-field, effect-native/no-unbranded-identifier-schema -- Privacy cross-owner wire contracts preserve explicit JSON null, canonical UTC string encodings, and owner-issued opaque references; generated API and Resource boundaries validate provenance without a misleading shared brand. expires: 2027-03-31. */
import { PrincipalRefSchema } from '@app/core-runtime';
import { Schema } from 'effect';

import { PrivacyApplicabilityDecisionSchema } from './privacy-applicability.ts';
import { PrivacyIsoTimestampSchema } from './privacy-subject.ts';
import { ProcessingScopeRefSchema } from './privacy-responsibility-assignment.ts';
import { LegalBasisAssignmentRefSchema } from '../resources/legal-basis-assignment.ts';
import { ProcessingPurposeRefSchema } from '../resources/processing-purpose.ts';

const Ref = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(300));
const EvidenceRefs = Schema.Array(Ref).check(Schema.isMinLength(1), Schema.isMaxLength(32));

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

export type PrivacyLegalBasisValidation =
  | { readonly valid: true }
  | { readonly errors: readonly string[]; readonly valid: false };

export const validatePrivacyLegalBasisAssignment = (
  assignment: PrivacyLegalBasisAssignment,
): PrivacyLegalBasisValidation => {
  const errors: string[] = [];
  if (assignment.effectiveTo !== null && assignment.effectiveTo <= assignment.effectiveFrom) {
    errors.push('Legal Basis Assignment effective period is invalid');
  }
  if (assignment.applicabilityDecision.outcome !== 'APPLICABLE') {
    errors.push('Legal Basis Assignment requires an applicable Privacy Applicability Decision');
  }
  if (
    assignment.applicabilityDecision.evaluatedScope.processingScopeRef.scopeId !==
    assignment.scope.processingScopeRef.scopeId
  ) {
    errors.push('Legal Basis Assignment scope must match the Applicability Decision scope');
  }
  if (assignment.actor.tenantId !== assignment.assignmentRef.tenantId) {
    errors.push('Legal Basis Assignment actor and assignment must share a tenant');
  }
  return errors.length === 0 ? { valid: true } : { errors, valid: false };
};

const sameScope = (left: PrivacyLegalBasisScope, right: PrivacyLegalBasisScope): boolean =>
  left.controllerRef === right.controllerRef &&
  left.purposeRef.moduleId === right.purposeRef.moduleId &&
  left.purposeRef.resourceId === right.purposeRef.resourceId &&
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
