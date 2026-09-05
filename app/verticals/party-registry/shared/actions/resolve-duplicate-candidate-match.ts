// Canonical schema-only contract extracted from the generated resolve-duplicate-candidate-match Action.
import { Schema } from 'effect';
import {
  DuplicateCaseResolutionPayloadSchema,
  DuplicateCaseResolutionResultSchema,
} from '../domain/matching-contracts.ts';
import { PartyRefSchema } from '../resources/party.ts';

export const ResolveDuplicateCandidateMatchPayloadSchema = Schema.Struct({
  ...DuplicateCaseResolutionPayloadSchema.fields,
  selectedPartyRef: PartyRefSchema,
});
export type ResolveDuplicateCandidateMatchPayload =
  typeof ResolveDuplicateCandidateMatchPayloadSchema.Type;
export const ResolveDuplicateCandidateMatchResultSchema = DuplicateCaseResolutionResultSchema;
export type ResolveDuplicateCandidateMatchResult =
  typeof ResolveDuplicateCandidateMatchResultSchema.Type;
