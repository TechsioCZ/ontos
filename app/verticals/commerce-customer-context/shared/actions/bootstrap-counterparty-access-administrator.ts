// Canonical schema-only contract extracted from the generated bootstrap-counterparty-access-administrator Action.
import { Schema } from 'effect';
import { CounterpartyAccessGrantSchema, CounterpartyRefSchema, PrincipalRefSchema } from '../domain/access-contract.ts';
import { AccessAuthorizationMutationEvidenceSchema } from '../domain/access-authorization-mutation.ts';

export const BootstrapCounterpartyAccessAdministratorPayloadSchema = Schema.Struct({
  counterpartyRef: CounterpartyRefSchema,
  reason: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
  recipient: PrincipalRefSchema,
});
export type BootstrapCounterpartyAccessAdministratorPayload =
  typeof BootstrapCounterpartyAccessAdministratorPayloadSchema.Type;

export const BootstrapCounterpartyAccessAdministratorResultSchema = Schema.Union([
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
