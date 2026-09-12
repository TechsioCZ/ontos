// Canonical schema-only contract extracted from the generated grant-counterparty-commerce-access Action.
import { Schema } from 'effect';
import {
  CounterpartyAccessGrantSchema,
  CounterpartyPermissionScopeSchema,
  CounterpartyRefSchema,
  PrincipalRefSchema,
} from '../domain/access-contract.ts';
import { CounterpartyPermissionCodeSchema } from '../domain/permission-catalog.ts';
import { AccessAuthorizationMutationEvidenceSchema } from '../domain/access-authorization-mutation.ts';

export const GrantCounterpartyCommerceAccessPayloadSchema = Schema.Struct({
  counterpartyRef: CounterpartyRefSchema,
  permission: CounterpartyPermissionCodeSchema,
  reason: Schema.optionalKey(Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(500))),
  recipient: PrincipalRefSchema,
  scope: CounterpartyPermissionScopeSchema,
});
export type GrantCounterpartyCommerceAccessPayload = typeof GrantCounterpartyCommerceAccessPayloadSchema.Type;

export const GrantCounterpartyCommerceAccessResultSchema = Schema.Union([
  Schema.Struct({
    grant: CounterpartyAccessGrantSchema,
    outcome: Schema.Literals(['APPLIED', 'ALREADY_ACTIVE', 'CONFLICT']),
  }),
  Schema.Struct({
    grant: CounterpartyAccessGrantSchema,
    outcome: Schema.Literal('RECONCILIATION_REQUIRED'),
    reconciliation: AccessAuthorizationMutationEvidenceSchema,
  }),
]);
