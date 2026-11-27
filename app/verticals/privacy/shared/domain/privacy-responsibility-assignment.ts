import { PrincipalRefSchema } from '@app/core-runtime/permissions/principal-ref';
import {
  PrivacyBoundedIdSchema as BoundedIdSchema,
  ProcessingScopeRefSchema,
} from '@app/privacy-contracts/domain/processing-scope-ref';
import { Option, Schema } from 'effect';

import { PrivacyResponsibilityAssignmentRefSchema } from '../resources/privacy-responsibility-assignment.ts';
import { PrivacyPartyRefSchema } from './party-reference.ts';
import { isPrivacyInstantAfter, isPrivacyInstantAtOrBefore, PrivacyIsoTimestampSchema } from './privacy-subject.ts';

const BoundedTextSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(500));

/** Canonical Core identity reference. Kept distinct from PartyRef by design. */
export const LegalEntityRefSchema = Schema.Struct({
  moduleId: Schema.Literal('core.identity'),
  resourceId: BoundedIdSchema,
  resourceType: Schema.Literal('core.identity.legal-entity'),
  tenantId: Schema.toEncoded(Schema.String.check(Schema.isUUID()).pipe(Schema.brand('PrivacyTenantId'))),
});

export { ProcessingScopeRefSchema } from '@app/privacy-contracts/domain/processing-scope-ref';
export type { ProcessingScopeRef } from '@app/privacy-contracts/domain/processing-scope-ref';

const ResponsibilityRoleSchema = Schema.Literals(['CONTROLLER', 'PROCESSOR', 'RECIPIENT']);

export const ResponsibilityRoleHolderSchema = Schema.Union([
  Schema.Struct({ holder: LegalEntityRefSchema, holderKind: Schema.Literal('LEGAL_ENTITY') }),
  // Principal is the Action actor/provenance, never the legal role holder.
  Schema.Struct({ holder: PrivacyPartyRefSchema, holderKind: Schema.Literal('PARTY') }),
]);

const ResponsibilityAssignmentProvenanceSchema = Schema.Struct({
  decisionEvidenceRefs: Schema.Array(BoundedIdSchema).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
  reason: BoundedTextSchema,
  recordedAt: PrivacyIsoTimestampSchema,
});

export const PrivacyResponsibilityAssignmentSchema = Schema.Struct({
  assignmentRef: PrivacyResponsibilityAssignmentRefSchema,
  effectiveFrom: PrivacyIsoTimestampSchema,
  effectiveTo: Schema.OptionFromNullOr(PrivacyIsoTimestampSchema),
  holder: ResponsibilityRoleHolderSchema,
  provenance: ResponsibilityAssignmentProvenanceSchema,
  role: ResponsibilityRoleSchema,
  scopeRef: ProcessingScopeRefSchema,
  /** The protected Action actor, when this assignment was created or changed. */
  actor: PrincipalRefSchema,
}).check(
  Schema.makeFilter((assignment) => {
    if (assignment.holder.holder.tenantId !== assignment.assignmentRef.tenantId) {
      return 'Privacy Responsibility Assignment holder and assignment must share a tenant';
    }
    return assignment.actor.tenantId === assignment.assignmentRef.tenantId
      ? undefined
      : 'Privacy Responsibility Assignment actor and assignment must share a tenant';
  }),
);

/** Resolve across all assignments in the trusted tenant and legal entity, not just the nominated references. */
export const currentScopeControllers = (
  assignments: readonly (typeof PrivacyResponsibilityAssignmentSchema.Type)[],
  scope: typeof ProcessingScopeRefSchema.Type,
  at: string,
) =>
  assignments.filter(
    (assignment) =>
      assignment.role === 'CONTROLLER' &&
      assignment.scopeRef.scopeId === scope.scopeId &&
      assignment.scopeRef.scopeType === scope.scopeType &&
      isPrivacyInstantAtOrBefore(assignment.effectiveFrom, at) &&
      (Option.isNone(assignment.effectiveTo) || isPrivacyInstantAfter(assignment.effectiveTo.value, at)),
  );
