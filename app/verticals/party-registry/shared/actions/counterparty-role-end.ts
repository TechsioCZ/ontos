// Canonical schema-only contract extracted from the generated counterparty-role-end Action.
import { Schema } from 'effect';

import {
  CounterpartyIsoTimestampSchema,
  CounterpartyProvenanceSchema,
  CounterpartyRoleTypeSchema,
} from '../domain/counterparty-contract.ts';
import { CounterpartyRolePeriodRefSchema } from '../resources/counterparty-role-period.ts';
import { CounterpartyRefSchema } from '../resources/counterparty.ts';

export const CounterpartyRoleEndPayloadSchema = Schema.Struct({
  counterpartyRef: CounterpartyRefSchema,
  provenance: CounterpartyProvenanceSchema,
  rolePeriodRef: CounterpartyRolePeriodRefSchema,
  validTo: CounterpartyIsoTimestampSchema,
});
export type CounterpartyRoleEndPayload = typeof CounterpartyRoleEndPayloadSchema.Type;

export const CounterpartyRoleEndResultSchema = Schema.Struct({
  counterpartyRef: CounterpartyRefSchema,
  rolePeriodRef: CounterpartyRolePeriodRefSchema,
  roleType: CounterpartyRoleTypeSchema,
  validFrom: CounterpartyIsoTimestampSchema,
  validTo: CounterpartyIsoTimestampSchema,
});
