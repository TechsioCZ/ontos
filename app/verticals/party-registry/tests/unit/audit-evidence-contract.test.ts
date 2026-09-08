import assert from 'node:assert/strict';
import test from 'node:test';
import { Schema } from 'effect';
import {
  PartySubjectEvidenceSchema,
  makePartyRef,
} from '../../shared/domain/identity-contracts.ts';
import { PartyMatchDecisionRecordSchema } from '../../shared/domain/matching-contracts.ts';
import { makePartyMatchDecisionRef } from '../../shared/resources/party-match-decision.ts';
import { makeDuplicateCandidateCaseRef } from '../../shared/resources/duplicate-candidate-case.ts';

const tenant = '11111111-1111-4111-8111-111111111111';
const id = '22222222-2222-4222-8222-222222222222';
test('typed subject evidence accepts arbitrary reference spelling, rejects unsupported authority', () => {
  const evidence = {
    basis: 'DIRECT_INTERACTION',
    evidenceRef: 'meeting/42',
    kind: 'ACTOR_ATTESTATION',
    observedSubject: 'PERSON',
    statement: 'Met the human who submitted this request',
    subjectKey: 'request-subject',
  };
  assert.deepEqual(Schema.decodeUnknownSync(PartySubjectEvidenceSchema)(evidence), evidence);
  assert.throws(() =>
    Schema.decodeUnknownSync(PartySubjectEvidenceSchema)({
      ...evidence,
      kind: 'AUTHORITATIVE_REGISTRY',
    }),
  );
  assert.throws(() =>
    Schema.decodeUnknownSync(PartySubjectEvidenceSchema)({ ...evidence, statement: '' }),
  );
});
test('Create recovery distinguishes matching outcome and enforces reference invariants', () => {
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
  assert.equal(decode(record).committedCreateOutcome, 'MATCHED_EXISTING');
  assert.equal(decode(record).decidedAt, '2026-09-04T00:00:00.000Z');
  assert.throws(() => decode({ ...record, decidedAt: 'September 4, 2026' }));
  assert.throws(() => decode({ ...record, committedCreateOutcome: 'MATCHED' }));
  assert.throws(() => decode({ ...record, operation: 'MATCH' }));
  assert.throws(() => decode({ ...record, caseRef: makeDuplicateCandidateCaseRef(tenant, id) }));
  assert.throws(() =>
    decode({ ...record, committedCreateOutcome: null, outcome: 'NO_MATCH', partyRef: null }),
  );
  assert.equal(
    decode({
      ...record,
      committedCreateOutcome: null,
      operation: 'MATCH',
      outcome: 'NO_MATCH',
      partyRef: null,
    }).outcome,
    'NO_MATCH',
  );
});

test('matching decision JSON keeps nullable and optional wire fields compatible', () => {
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
  const decoded = Schema.decodeUnknownSync(PartyMatchDecisionRecordSchema)(record);
  const encoded = Schema.encodeUnknownSync(Schema.toCodecJson(PartyMatchDecisionRecordSchema))(
    decoded,
  );
  assert.deepEqual(encoded, record);

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
  const omittedEncoded = Schema.encodeUnknownSync(
    Schema.toCodecJson(PartyMatchDecisionRecordSchema),
  )(Schema.decodeUnknownSync(PartyMatchDecisionRecordSchema)(omitted));
  const omittedEncodedObject = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))(
    omittedEncoded,
  );
  assert.equal('committedCreateOutcome' in omittedEncodedObject, false);
  assert.equal('evidenceEvaluation' in omittedEncodedObject, false);
});
