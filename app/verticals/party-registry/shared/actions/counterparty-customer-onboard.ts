import { Schema } from 'effect';
import { SymmySourceOrganizationWitnessSchema } from '@app/shared-contracts/symmy/organization-source-witness';

import { PartyClientSourceReferenceSchema } from '../domain/identity-contracts.ts';

import {
  CounterpartyCreationProvenanceSchema,
  CounterpartyIsoTimestampSchema,
  CounterpartyProvenanceSchema,
  LegalEntityRefSchema,
} from '../domain/counterparty-contract.ts';
import { CounterpartyRefSchema } from '../resources/counterparty.ts';
import { CounterpartyRolePeriodRefSchema } from '../resources/counterparty-role-period.ts';
import { PartyRefSchema } from '../resources/party.ts';

/**
 * The context and the CUSTOMER assertion deliberately carry independent provenance. A
 * purchasing relationship is sufficient role evidence but is not, by itself, context evidence.
 */
export const CounterpartyCustomerOnboardPayloadSchema = Schema.Struct({
  sourceOrganizationWitness: Schema.optionalKey(SymmySourceOrganizationWitnessSchema),
  sourceReference: Schema.optionalKey(PartyClientSourceReferenceSchema),
  counterpartyProvenance: CounterpartyCreationProvenanceSchema,
  customerEvidence: CounterpartyProvenanceSchema,
  partyRef: PartyRefSchema,
  validFrom: CounterpartyIsoTimestampSchema,
  validTo: Schema.optionalKey(CounterpartyIsoTimestampSchema),
}).check(
  Schema.makeFilter((payload) =>
    payload.validTo === undefined || payload.validTo >= payload.validFrom
      ? undefined
      : [{ issue: 'validTo must not precede validFrom', path: ['validTo'] }],
  ),
);
export type CounterpartyCustomerOnboardPayload = typeof CounterpartyCustomerOnboardPayloadSchema.Type;

export const CounterpartyCustomerOnboardResultSchema = Schema.Struct({
  counterpartyCreated: Schema.Boolean,
  counterpartyRef: CounterpartyRefSchema,
  rolePeriodCreated: Schema.Boolean,
  legalEntityRef: LegalEntityRefSchema,
  partyRef: PartyRefSchema,
  rolePeriodRef: CounterpartyRolePeriodRefSchema,
  roleType: Schema.Literal('CUSTOMER'),
  validFrom: CounterpartyIsoTimestampSchema,
  validTo: Schema.toEncoded(Schema.OptionFromNullOr(CounterpartyIsoTimestampSchema)),
});
