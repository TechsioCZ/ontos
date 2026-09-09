// Canonical schema-only contract extracted from the generated resolve-duplicate-candidate-match Action.
import { Schema } from 'effect';

import { DuplicateCaseResolutionPayloadSchema } from '../domain/matching-contracts.ts';
import { PartyRefSchema } from '../resources/party.ts';

export const ResolveDuplicateCandidateMatchPayloadSchema = Schema.Struct({
  ...DuplicateCaseResolutionPayloadSchema.fields,
  selectedPartyRef: PartyRefSchema,
});
export type ResolveDuplicateCandidateMatchPayload = typeof ResolveDuplicateCandidateMatchPayloadSchema.Type;
export { DuplicateCaseResolutionResultSchema as ResolveDuplicateCandidateMatchResultSchema } from '../domain/matching-contracts.ts';
