import { Match, Schema } from 'effect';

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

/** Safe receipt projection: no recipient, credentials, SMTP detail or untrusted error text crosses the read boundary. */
export const PersonInvitationDeliverySchema = Schema.Union([
  Schema.Struct({ status: Schema.Literal('pending') }),
  Schema.Struct({ status: Schema.Literal('sent') }),
  Schema.Struct({ status: Schema.Literal('unknown') }),
  Schema.Struct({
    reason: Schema.Literals(['recipient_unavailable', 'rejected', 'retry_expired', 'invitation_expired']),
    status: Schema.Literal('undeliverable'),
  }),
]);

const invitationFailureReason = (errorTag: string | null) =>
  Match.value(errorTag).pipe(
    Match.when('undeliverable_recipient', () => 'recipient_unavailable' as const),
    Match.when('retry_window_expired', () => 'retry_expired' as const),
    Match.orElse(() => 'rejected' as const),
  );

export const invitationDeliveryFromLedger = (input: {
  readonly errorTag: string | null;
  readonly expired: boolean | null;
  readonly status: string | null;
}): typeof PersonInvitationDeliverySchema.Type =>
  Match.value(input.status).pipe(
    Match.when('SENT', () => ({ status: 'sent' as const })),
    Match.when('SKIPPED', () => ({
      reason: invitationFailureReason(input.errorTag),
      status: 'undeliverable' as const,
    })),
    Match.when('FAILED', () => ({ reason: invitationFailureReason(input.errorTag), status: 'undeliverable' as const })),
    Match.when('SENDING', () => ({ status: 'pending' as const })),
    Match.when('RETRY', () => ({ status: 'pending' as const })),
    Match.when(null, () =>
      input.expired === true
        ? { reason: 'invitation_expired' as const, status: 'undeliverable' as const }
        : { status: 'pending' as const },
    ),
    // UNKNOWN may already have reached the server. Never claim success or offer a blind retry.
    Match.orElse(() => ({ status: 'unknown' as const })),
  );
