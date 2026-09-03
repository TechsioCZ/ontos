// Canonical schema-only contract extracted from the generated match-party Action.
import { Schema } from 'effect';
import { PartyMatchRequestSchema, PartyMatchResponseSchema } from '../domain/matching-contracts.ts';
import { DuplicateCandidateCaseRefSchema } from '../resources/duplicate-candidate-case.ts';

export const MatchPartyPayloadSchema = Schema.Struct({
  ...PartyMatchRequestSchema.fields,
  priorCaseRef: Schema.optionalKey(DuplicateCandidateCaseRefSchema),
});
export type MatchPartyPayload = typeof MatchPartyPayloadSchema.Type;

export const MatchPartyResultSchema = PartyMatchResponseSchema;
export type MatchPartyResult = typeof MatchPartyResultSchema.Type;
