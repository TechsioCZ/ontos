import { Schema } from 'effect';

import { CompanyAffiliationSchema, CompanyMembershipSchema } from '../permissions/company-membership.ts';
import { PrincipalRefSchema } from '../permissions/principal-ref.ts';

const InvitationIdSchema = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('PersonInvitationId'),
  Schema.decodeTo(Schema.String),
);

export const InvitePersonPayloadSchema = Schema.Struct({
  affiliation: CompanyAffiliationSchema,
  displayName: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200), Schema.isPattern(/^\S(?:.*\S)?$/u)),
  email: Schema.String.check(Schema.isMaxLength(254), Schema.isPattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/u)),
});
export type InvitePersonPayload = typeof InvitePersonPayloadSchema.Type;

/** Pending means durable invitation intent, never proof of SMTP delivery or accepted company access. */
export const InvitePersonResultSchema = Schema.Struct({
  delivery: Schema.Literal('pending'),
  invitationId: InvitationIdSchema,
  membership: CompanyMembershipSchema,
  principalRef: PrincipalRefSchema,
});
export type InvitePersonResult = typeof InvitePersonResultSchema.Type;

export const InvitePersonAuditEvidenceSchema = Schema.Struct({
  ...InvitePersonPayloadSchema.fields,
  invitationId: InvitationIdSchema,
  legalEntityId: CompanyMembershipSchema.fields.legalEntityId,
  membershipRevision: Schema.Literal(1),
  membershipStatus: Schema.Literal('invited'),
  principalRef: PrincipalRefSchema,
});
