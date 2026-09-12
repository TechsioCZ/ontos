// Canonical schema-only contract extracted from the generated create-counterparty-access-invitation Action.
import { Schema } from 'effect';
import {
  AccessInstantSchema,
  CounterpartyPermissionScopeSchema,
  CounterpartyRefSchema,
} from '../domain/access-contract.ts';
import {
  CounterpartyAccessInvitationDeliveryMethodSchema,
  CounterpartyAccessInvitationSchema,
} from '../domain/invitation-contract.ts';
import { CounterpartyPermissionCodeSchema } from '../domain/permission-catalog.ts';

export const CreateCounterpartyAccessInvitationPayloadSchema = Schema.Struct({
  counterpartyRef: CounterpartyRefSchema,
  deliveryMethod: CounterpartyAccessInvitationDeliveryMethodSchema,
  deliveryReference: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
  expiresAt: AccessInstantSchema,
  intendedPermissions: Schema.Array(CounterpartyPermissionCodeSchema),
  reason: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
  scope: CounterpartyPermissionScopeSchema,
});
export type CreateCounterpartyAccessInvitationPayload = typeof CreateCounterpartyAccessInvitationPayloadSchema.Type;

export const CreateCounterpartyAccessInvitationResultSchema = Schema.Struct({
  invitation: CounterpartyAccessInvitationSchema,
  outcome: Schema.Literals(['CREATED', 'ALREADY_PENDING']),
});
