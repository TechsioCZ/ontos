// Canonical schema-only contract extracted from the generated revoke-counterparty-access-invitation Action.
import { Schema } from 'effect';
import { CounterpartyPermissionScopeSchema, CounterpartyRefSchema } from '../domain/access-contract.ts';
import { CounterpartyAccessInvitationSchema } from '../domain/invitation-contract.ts';
import { CounterpartyAccessInvitationRefSchema } from '../resources/counterparty-access-invitation.ts';

export const RevokeCounterpartyAccessInvitationPayloadSchema = Schema.Struct({
  counterpartyRef: CounterpartyRefSchema,
  expectedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  invitationRef: CounterpartyAccessInvitationRefSchema,
  reason: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
  scope: CounterpartyPermissionScopeSchema,
});
export type RevokeCounterpartyAccessInvitationPayload = typeof RevokeCounterpartyAccessInvitationPayloadSchema.Type;

export const RevokeCounterpartyAccessInvitationResultSchema = Schema.Struct({
  invitation: CounterpartyAccessInvitationSchema,
  outcome: Schema.Literals(['REVOKED', 'ALREADY_REVOKED']),
});
