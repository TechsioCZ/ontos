// Canonical schema-only contract extracted from the generated unarchive-party Action.
import { Schema } from 'effect';
import { PartySchema } from '../domain/identity-contracts.ts';
import { PartyRefSchema } from '../resources/party.ts';
import { DuplicateCandidateCaseRefSchema } from '../resources/duplicate-candidate-case.ts';
import { PartyMatchDecisionRefSchema } from '../resources/party-match-decision.ts';

export const UnarchivePartyPayloadSchema = Schema.Struct({
  expectedRevision: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThan(0)),
  partyRef: PartyRefSchema,
  reason: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(1000)),
});
export type UnarchivePartyPayload = typeof UnarchivePartyPayloadSchema.Type;
export const UnarchivePartyBlockedSchema = Schema.Struct({
  caseRef: DuplicateCandidateCaseRefSchema,
  decisionRef: PartyMatchDecisionRefSchema,
  outcome: Schema.Literal('BLOCKED'),
  party: PartySchema,
  reasonCode: Schema.Literals([
    'EXACT_CLAIM_CONFLICT',
    'EXACT_CLAIM_AMBIGUOUS',
    'OPEN_DUPLICATE_CASE',
    'UNRESOLVED_IDENTITY',
  ]),
});
export type UnarchivePartyBlocked = typeof UnarchivePartyBlockedSchema.Type;
export const UnarchivePartyResultSchema = Schema.Union([
  Schema.Struct({ outcome: Schema.Literal('UNARCHIVED'), party: PartySchema }),
  UnarchivePartyBlockedSchema,
]);
export type UnarchivePartyResult = typeof UnarchivePartyResultSchema.Type;
