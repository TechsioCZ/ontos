import { Schema } from 'effect';

import { ActionInvocationIdSchema } from '../domain/correction-contracts.ts';

export { PartyCreateOutcomeSchema as AcceptRetailEnrollmentEvidenceResultSchema } from '../domain/identity-contracts.ts';

/** Credential-free provider facts attested by the explicitly authorized enrollment workload. */
export const RetailEnrollmentEvidenceSchema = Schema.Struct({
  authenticationNamespaceId: Schema.Literal('ontos.commerce.portal.better-auth.v1'),
  candidateEvidenceRef: Schema.String.check(Schema.isUUID()),
  emailOwnership: Schema.Literal('VERIFIED'),
  enrollmentAttemptId: Schema.String.check(Schema.isUUID()),
  journey: Schema.Literal('RETAIL_SELF_ENROLLMENT'),
  providerOwnerInvocationId: ActionInvocationIdSchema,
  providerSubjectId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300)),
  sellingLegalEntityId: Schema.String.check(Schema.isUUID()),
  tenantId: Schema.String.check(Schema.isUUID()),
});
export type RetailEnrollmentEvidence = typeof RetailEnrollmentEvidenceSchema.Type;

export const AcceptRetailEnrollmentEvidencePayloadSchema = Schema.Struct({
  evidence: RetailEnrollmentEvidenceSchema,
  originalInvocationId: ActionInvocationIdSchema,
});
export type AcceptRetailEnrollmentEvidencePayload = typeof AcceptRetailEnrollmentEvidencePayloadSchema.Type;
