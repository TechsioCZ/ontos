/* eslint-disable effect-native/no-unbranded-identifier-schema -- Privacy cross-owner wire contracts preserve explicit JSON null, canonical UTC string encodings, and owner-issued opaque references; generated API and Resource boundaries validate provenance without a misleading shared brand. expires: 2027-03-31. */
import { PrincipalRefSchema } from '@app/core-runtime';
import { Schema } from 'effect';

import { PrivacyResponsibilityAssignmentRefSchema } from '../resources/privacy-responsibility-assignment.ts';
import { PrivacyPartyRefSchema } from './party-reference.ts';
import { PrivacyIsoTimestampSchema } from './privacy-subject.ts';

const BoundedTextSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(500));
const BoundedIdSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(300));

/** Canonical Core identity reference. Kept distinct from PartyRef by design. */
export const LegalEntityRefSchema = Schema.Struct({
  moduleId: Schema.Literal('core.identity'),
  resourceId: BoundedIdSchema,
  resourceType: Schema.Literal('core.identity.legal-entity'),
  tenantId: Schema.String.check(Schema.isUUID()),
});

export const ProcessingScopeRefSchema = Schema.Struct({
  scopeId: BoundedIdSchema,
  scopeType: Schema.Literal('privacy.processing-scope'),
});
export type ProcessingScopeRef = typeof ProcessingScopeRefSchema.Type;

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
