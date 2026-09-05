import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  PartyCandidate,
  PartySubjectEvidence,
} from '../../shared/domain/identity-contracts.ts';
import { createPartyAction } from '../../src/actions/create-party.action.ts';
import {
  decideCreateWithoutStrongIdentifier,
  evaluatePartySubjectEvidence,
} from '../../src/policies/create-party-without-strong-identifier.policy.ts';
import {
  decideAtomicCreateWithoutStrongIdentifier,
  candidateFingerprint,
} from '../../src/services/party-matching-persistence.service.ts';

const evidence = (
  observedSubject: PartySubjectEvidence['observedSubject'],
): PartySubjectEvidence => ({
  basis: 'DIRECT_INTERACTION',
  evidenceRef: 'meeting/42',
  kind: 'ACTOR_ATTESTATION',
  observedSubject,
  statement: 'Observed this concrete subject during onboarding',
  subjectKey: 'one-subject',
});
const candidate = (overrides: Partial<PartyCandidate> = {}): PartyCandidate => ({
  evidenceRefs: [],
  officialIdentifiers: [],
  partyType: 'UNRESOLVED',
  provenance: { method: 'MANUAL', source: 'onboarding' },
  subjectEvidence: [evidence('CONCRETE_SUBJECT')],
  validFrom: '2020-01-01T00:00:00.000Z',
  ...overrides,
});
const decide = (value: PartyCandidate) =>
  decideCreateWithoutStrongIdentifier(value, { requireIdentityReview: false });
test('concrete subject evidence needs neither a name nor an official ID', () => {
  assert.equal(decide(candidate()).decision, 'ALLOW');
  assert.equal(decide(candidate({ displayName: 'A' })).decision, 'ALLOW');
  assert.equal(decide(candidate({ displayName: 'Unknown' })).decision, 'ALLOW');
});
test('names, reference prefixes and identifiers never substitute for subject evidence', () => {
  for (const input of [
    candidate({ displayName: 'Jane Smith', subjectEvidence: [] }),
    candidate({
      evidenceRefs: ['business-record:42', 'evidence-artifact:42'],
      subjectEvidence: [],
    }),
    candidate({
      officialIdentifiers: [{ identifierType: 'ICO', value: '27074358', verification: 'VERIFIED' }],
      subjectEvidence: [],
    }),
  ]) {
    assert.equal(decide(input).decision, 'DENY');
  }
});
test('type support is separate from evidence of a concrete subject', () => {
  for (const partyType of ['PERSON', 'ORGANIZATION'] as const) {
    assert.equal(decide(candidate({ partyType })).reasonCode, 'party_type_evidence_required');
    assert.equal(
      decide(candidate({ partyType, subjectEvidence: [evidence(partyType)] })).decision,
      'ALLOW',
    );
  }
  assert.equal(
    decide(candidate({ subjectEvidence: [evidence('PERSON'), evidence('ORGANIZATION')] }))
      .reasonCode,
    'conflicting_type_evidence',
  );
});
test('technical records, managed Legal Entities and multiple subjects fail closed', () => {
  for (const kind of ['TECHNICAL_RECORD', 'MANAGED_LEGAL_ENTITY'] as const) {
    assert.equal(decide(candidate({ subjectEvidence: [evidence(kind)] })).decision, 'DENY');
  }
  assert.equal(
    decide(
      candidate({
        subjectEvidence: [evidence('PERSON'), { ...evidence('PERSON'), subjectKey: 'another' }],
      }),
    ).reasonCode,
    'one_concrete_subject_required',
  );
});
test('review configuration cannot waive evidence and eligible review remains atomic', () => {
  assert.deepEqual(createPartyAction.descriptor.policies, []);
  assert.equal(
    decideAtomicCreateWithoutStrongIdentifier(candidate(), false).decision,
    'REVIEW_REQUIRED',
  );
  assert.equal(decideAtomicCreateWithoutStrongIdentifier(candidate(), true).decision, 'ALLOW');
  assert.equal(
    decideAtomicCreateWithoutStrongIdentifier(candidate({ subjectEvidence: [] }), true).decision,
    'DENY',
  );
});
test('reference spelling is neutral; meaningful evidence and independent versions are retained', () => {
  const original = candidate();
  const arbitrary = candidate({
    subjectEvidence: [{ ...evidence('CONCRETE_SUBJECT'), evidenceRef: 'anything' }],
  });
  assert.equal(decide(arbitrary).decision, 'ALLOW');
  assert.notEqual(candidateFingerprint(original), candidateFingerprint(arbitrary));
  const result = evaluatePartySubjectEvidence(original);
  assert.equal(result.subjectEligibilityVersion, 'party-concrete-subject.v1');
  assert.equal(result.typeRuleVersion, 'party-subject-type.v1');
  assert.deepEqual(result.evidence, original.subjectEvidence);
});
