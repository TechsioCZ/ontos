// Canonical schema-only contract extracted from the generated counterparty-role-add Action.
import { Schema } from 'effect';
import {
  CounterpartyIsoTimestampSchema,
  CounterpartyProvenanceSchema,
  CounterpartyRoleTypeSchema,
} from '../domain/counterparty-contract.ts';
import { CounterpartyRefSchema } from '../resources/counterparty.ts';
import { CounterpartyRolePeriodRefSchema } from '../resources/counterparty-role-period.ts';

export const CounterpartyRoleAddPayloadSchema = Schema.Struct({
  counterpartyRef: CounterpartyRefSchema,
  provenance: CounterpartyProvenanceSchema,
  roleType: CounterpartyRoleTypeSchema,
  validFrom: CounterpartyIsoTimestampSchema,
  validTo: Schema.optionalKey(CounterpartyIsoTimestampSchema),
}).check(
  Schema.makeFilter((payload) =>
    payload.validTo === undefined || payload.validTo >= payload.validFrom
      ? undefined
      : [{ issue: 'validTo must not precede validFrom', path: ['validTo'] }],
  ),
);
export type CounterpartyRoleAddPayload = typeof CounterpartyRoleAddPayloadSchema.Type;

export const CounterpartyRoleAddResultSchema = Schema.Struct({
  counterpartyRef: CounterpartyRefSchema,
  rolePeriodRef: CounterpartyRolePeriodRefSchema,
  roleType: CounterpartyRoleTypeSchema,
  validFrom: CounterpartyIsoTimestampSchema,
  validTo: Schema.NullOr(CounterpartyIsoTimestampSchema),
});
export type CounterpartyRoleAddResult = typeof CounterpartyRoleAddResultSchema.Type;
