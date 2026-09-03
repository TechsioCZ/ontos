// Canonical schema-only contract extracted from the generated counterparty-create Action.
import { Schema } from 'effect';
import {
  CounterpartyCreationProvenanceSchema,
  LegalEntityRefSchema,
} from '../domain/counterparty-contract.ts';
import { CounterpartyRefSchema } from '../resources/counterparty.ts';
import { PartyRefSchema } from '../resources/party.ts';

export const CounterpartyCreatePayloadSchema = Schema.Struct({
  partyRef: PartyRefSchema,
  provenance: CounterpartyCreationProvenanceSchema,
});
export type CounterpartyCreatePayload = typeof CounterpartyCreatePayloadSchema.Type;

export const CounterpartyCreateResultSchema = Schema.Struct({
  counterpartyRef: CounterpartyRefSchema,
  created: Schema.Boolean,
  legalEntityRef: LegalEntityRefSchema,
  partyRef: PartyRefSchema,
});
export type CounterpartyCreateResult = typeof CounterpartyCreateResultSchema.Type;
