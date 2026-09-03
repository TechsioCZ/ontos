// Canonical schema-only contract extracted from the generated create-party Action.
import { Schema } from 'effect';
import { PartyCandidateSchema, PartyCreateOutcomeSchema } from '../domain/identity-contracts.ts';
import type { PartyCandidate } from '../domain/identity-contracts.ts';

export const CreatePartyPayloadSchema = Schema.Struct({ candidate: PartyCandidateSchema });
export interface CreatePartyPayload {
  readonly candidate: PartyCandidate;
}
export const CreatePartyResultSchema = PartyCreateOutcomeSchema;
export type CreatePartyResult = typeof CreatePartyResultSchema.Type;
