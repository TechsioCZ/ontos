// Canonical schema-only contract extracted from the generated revoke-counterparty-commerce-access Action.
import { Schema } from 'effect';
import {
  CounterpartyAccessGrantSchema,
  CounterpartyPermissionScopeSchema,
  CounterpartyRefSchema,
  PrincipalRefSchema,
} from '../domain/access-contract.ts';
import { CounterpartyPermissionCodeSchema } from '../domain/permission-catalog.ts';
import { CounterpartyCommerceAccessGrantRefSchema } from '../resources/counterparty-commerce-access-grant.ts';
import { AccessAuthorizationMutationEvidenceSchema } from '../domain/access-authorization-mutation.ts';

export const RevokeCounterpartyCommerceAccessPayloadSchema = Schema.Struct({
  counterpartyRef: CounterpartyRefSchema,
  grantRef: Schema.optionalKey(CounterpartyCommerceAccessGrantRefSchema),
  permission: CounterpartyPermissionCodeSchema,
  reason: Schema.optionalKey(Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(500))),
  recipient: PrincipalRefSchema,
  scope: CounterpartyPermissionScopeSchema,
});
export type RevokeCounterpartyCommerceAccessPayload = typeof RevokeCounterpartyCommerceAccessPayloadSchema.Type;

export const RevokeCounterpartyCommerceAccessResultSchema = Schema.Union([
  Schema.Struct({
    grant: CounterpartyAccessGrantSchema,
    outcome: Schema.Literals(['REVOKED', 'ALREADY_REVOKED', 'LAST_ADMIN_PROTECTED', 'SCOPE_MISMATCH']),
  }),
  Schema.Struct({
    grant: CounterpartyAccessGrantSchema,
    outcome: Schema.Literal('RECONCILIATION_REQUIRED'),
    reconciliation: AccessAuthorizationMutationEvidenceSchema,
  }),
]);
