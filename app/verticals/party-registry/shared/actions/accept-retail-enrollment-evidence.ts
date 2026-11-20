import { Schema } from 'effect';

import { ActionInvocationIdSchema } from '../domain/correction-contracts.ts';

export { PartyCreateOutcomeSchema as AcceptRetailEnrollmentEvidenceResultSchema } from '../domain/identity-contracts.ts';

/** Durable subject facts identify an owned historical Create without asserting current email control. */
export const RetailEnrollmentSubjectSchema = Schema.Struct({
  authenticationNamespaceId: Schema.Literal('ontos.commerce.portal.better-auth.v1'),
  candidateEvidenceRef: Schema.String.check(Schema.isUUID()),
  enrollmentAttemptId: Schema.String.check(Schema.isUUID()),
  journey: Schema.Literals(['RETAIL_SELF_ENROLLMENT', 'EXISTING_ACCOUNT']),
  providerOwnerInvocationId: ActionInvocationIdSchema,
  providerSubjectId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300)),
  sellingLegalEntityId: Schema.String.check(Schema.isUUID()),
  tenantId: Schema.String.check(Schema.isUUID()),
});
export type RetailEnrollmentSubject = typeof RetailEnrollmentSubjectSchema.Type;

/** A new write additionally requires current verified email ownership. */
export const RetailEnrollmentEvidenceSchema = Schema.Struct({
  ...RetailEnrollmentSubjectSchema.fields,
  emailOwnership: Schema.Literal('VERIFIED'),
});
export type RetailEnrollmentEvidence = typeof RetailEnrollmentEvidenceSchema.Type;

export const AcceptRetailEnrollmentEvidencePayloadSchema = Schema.Struct({
  evidence: RetailEnrollmentEvidenceSchema,
  originalInvocationId: ActionInvocationIdSchema,
});
export type AcceptRetailEnrollmentEvidencePayload = typeof AcceptRetailEnrollmentEvidencePayloadSchema.Type;
