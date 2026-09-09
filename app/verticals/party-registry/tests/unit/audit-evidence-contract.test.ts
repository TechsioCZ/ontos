import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { PartySubjectEvidenceSchema, makePartyRef } from '../../shared/domain/identity-contracts.ts';
import { PartyMatchDecisionRecordSchema } from '../../shared/domain/matching-contracts.ts';
import { makeDuplicateCandidateCaseRef } from '../../shared/resources/duplicate-candidate-case.ts';
import { makePartyMatchDecisionRef } from '../../shared/resources/party-match-decision.ts';

const tenant = '11111111-1111-4111-8111-111111111111';
const id = '22222222-2222-4222-8222-222222222222';
it('typed subject evidence accepts arbitrary reference spelling, rejects unsupported authority', () => {
  const evidence = {
    basis: 'DIRECT_INTERACTION',
    evidenceRef: 'meeting/42',
    kind: 'ACTOR_ATTESTATION',
    observedSubject: 'PERSON',
    statement: 'Met the human who submitted this request',
    subjectKey: 'request-subject',
  };
  expect(Schema.decodeUnknownSync(PartySubjectEvidenceSchema)(evidence)).toEqual(evidence);
  expect(() =>
    Schema.decodeUnknownSync(PartySubjectEvidenceSchema)({
      ...evidence,
      kind: 'AUTHORITATIVE_REGISTRY',
    }),
  ).toThrow();
  expect(() =>
    Schema.decodeUnknownSync(PartySubjectEvidenceSchema)({
      ...evidence,
      statement: '',
    }),
  ).toThrow();
});
it('Create recovery distinguishes matching outcome and enforces reference invariants', () => {
  const record = {
    caseRef: null,
    committedCreateOutcome: 'MATCHED_EXISTING',
    decidedAt: '2026-09-04T00:00:00Z',
    decisionRef: makePartyMatchDecisionRef(tenant, id),
    evidenceExplanation: [],
    matchRuleVersion: 'party-exact-claims.v1',
    operation: 'CREATE',
    outcome: 'MATCHED',
    partyRef: makePartyRef(tenant, id),
  };
  const decode = Schema.decodeUnknownSync(PartyMatchDecisionRecordSchema);
  expect(decode(record).committedCreateOutcome).toBe('MATCHED_EXISTING');
  expect(decode(record).decidedAt).toBe('2026-09-04T00:00:00.000Z');
  expect(() => decode({ ...record, decidedAt: 'September 4, 2026' })).toThrow();
  expect(() => decode({ ...record, committedCreateOutcome: 'MATCHED' })).toThrow();
  expect(() => decode({ ...record, operation: 'MATCH' })).toThrow();
  expect(() => decode({ ...record, caseRef: makeDuplicateCandidateCaseRef(tenant, id) })).toThrow();
  expect(() =>
    decode({
      ...record,
      committedCreateOutcome: null,
      outcome: 'NO_MATCH',
      partyRef: null,
    }),
  ).toThrow();
  expect(
    decode({
      ...record,
      committedCreateOutcome: null,
      operation: 'MATCH',
      outcome: 'NO_MATCH',
      partyRef: null,
    }).outcome,
  ).toBe('NO_MATCH');
});
it('matching decision JSON keeps nullable and optional wire fields compatible', () => {
  const record = {
    caseRef: null,
    committedCreateOutcome: null,
    decidedAt: '2026-09-04T00:00:00.000Z',
    decisionRef: makePartyMatchDecisionRef(tenant, id),
    evidenceEvaluation: null,
    evidenceExplanation: [],
    matchRuleVersion: 'party-exact-claims.v1',
    operation: 'MATCH' as const,
    outcome: 'NO_MATCH' as const,
    partyRef: null,
  };
  const decoded = Schema.decodeSync(PartyMatchDecisionRecordSchema)(record);
  const encoded = Schema.encodeUnknownSync(Schema.toCodecJson(PartyMatchDecisionRecordSchema))(decoded);
  expect(encoded).toEqual(record);
  const omitted = {
    caseRef: record.caseRef,
    decidedAt: record.decidedAt,
    decisionRef: record.decisionRef,
    evidenceExplanation: record.evidenceExplanation,
    matchRuleVersion: record.matchRuleVersion,
    operation: record.operation,
    outcome: record.outcome,
    partyRef: record.partyRef,
  };
  const omittedEncoded = Schema.encodeUnknownSync(Schema.toCodecJson(PartyMatchDecisionRecordSchema))(
    Schema.decodeSync(PartyMatchDecisionRecordSchema)(omitted),
  );
  const omittedEncodedObject = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))(omittedEncoded);
  expect('committedCreateOutcome' in omittedEncodedObject).toBe(false);
  expect('evidenceEvaluation' in omittedEncodedObject).toBe(false);
});
