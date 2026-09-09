// Canonical schema-only contract extracted from the generated resend-counterparty-access-invitation Action.
import { Schema } from 'effect';
import {
  CounterpartyPermissionScopeSchema,
  CounterpartyRefSchema,
} from '../domain/access-contract.ts';
import { CounterpartyAccessInvitationSchema } from '../domain/invitation-contract.ts';
import { CounterpartyAccessInvitationRefSchema } from '../resources/counterparty-access-invitation.ts';

export const ResendCounterpartyAccessInvitationPayloadSchema = Schema.Struct({
  counterpartyRef: CounterpartyRefSchema,
  expectedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  invitationRef: CounterpartyAccessInvitationRefSchema,
  reason: Schema.optionalKey(Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(500))),
  scope: CounterpartyPermissionScopeSchema,
});
export type ResendCounterpartyAccessInvitationPayload =
  typeof ResendCounterpartyAccessInvitationPayloadSchema.Type;

export const ResendCounterpartyAccessInvitationResultSchema = Schema.Struct({
  invitation: CounterpartyAccessInvitationSchema,
  outcome: Schema.Literals(['RESENT', 'ALREADY_SENT']),
});
export type ResendCounterpartyAccessInvitationResult =
  typeof ResendCounterpartyAccessInvitationResultSchema.Type;
