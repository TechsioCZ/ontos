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
