import { DateTime } from 'effect';
import { expect, it } from 'effect-rstest';

import { partySubjectKeyFromString } from '../../shared/domain/identity-contracts.ts';
import type { PartyCandidate, PartySubjectEvidence } from '../../shared/domain/identity-contracts.ts';
import { createPartyAction } from '../../src/actions/create-party.action.ts';
import {
  decideCreateWithoutStrongIdentifier,
  evaluatePartySubjectEvidence,
} from '../../src/policies/create-party-without-strong-identifier.policy.ts';
import {
  decideAtomicCreateWithoutStrongIdentifier,
  candidateFingerprint,
} from '../../src/services/party-matching-persistence.service.ts';

const evidence = (observedSubject: PartySubjectEvidence['observedSubject']): PartySubjectEvidence => ({
  basis: 'DIRECT_INTERACTION',
  evidenceRef: 'meeting/42',
  kind: 'ACTOR_ATTESTATION',
  observedSubject,
  statement: 'Observed this concrete subject during onboarding',
  subjectKey: partySubjectKeyFromString('one-subject'),
});
const candidate = (overrides: Partial<PartyCandidate> = {}): PartyCandidate => ({
  evidenceRefs: [],
  officialIdentifiers: [],
  partyType: 'UNRESOLVED',
  provenance: { method: 'MANUAL', source: 'onboarding' },
  subjectEvidence: [evidence('CONCRETE_SUBJECT')],
  validFrom: DateTime.makeUnsafe('2020-01-01T00:00:00.000Z'),
  ...overrides,
});
const decide = (value: PartyCandidate) => decideCreateWithoutStrongIdentifier(value, { requireIdentityReview: false });
it('concrete subject evidence needs neither a name nor an official ID', () => {
  expect(decide(candidate()).decision).toBe('ALLOW');
  expect(decide(candidate({ displayName: 'A' })).decision).toBe('ALLOW');
  expect(decide(candidate({ displayName: 'Unknown' })).decision).toBe('ALLOW');
});

it('names, reference prefixes and identifiers never substitute for subject evidence', () => {
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
    expect(decide(input).decision).toBe('DENY');
  }
});

it('type support is separate from evidence of a concrete subject', () => {
  for (const partyType of ['PERSON', 'ORGANIZATION'] as const) {
    expect(decide(candidate({ partyType })).reasonCode).toBe('party_type_evidence_required');
    expect(decide(candidate({ partyType, subjectEvidence: [evidence(partyType)] })).decision).toBe('ALLOW');
  }
  expect(
    decide(
      candidate({
        subjectEvidence: [evidence('PERSON'), evidence('ORGANIZATION')],
      }),
    ).reasonCode,
  ).toBe('conflicting_type_evidence');
});

it('technical records, managed Legal Entities and multiple subjects fail closed', () => {
  for (const kind of ['TECHNICAL_RECORD', 'MANAGED_LEGAL_ENTITY'] as const) {
    expect(decide(candidate({ subjectEvidence: [evidence(kind)] })).decision).toBe('DENY');
  }
  expect(
    decide(
      candidate({
        subjectEvidence: [
          evidence('PERSON'),
          {
            ...evidence('PERSON'),
            subjectKey: partySubjectKeyFromString('another'),
          },
        ],
      }),
    ).reasonCode,
  ).toBe('one_concrete_subject_required');
});

it('review configuration cannot waive evidence and eligible review remains atomic', () => {
  expect(createPartyAction.descriptor.policies).toEqual([]);
  expect(decideAtomicCreateWithoutStrongIdentifier(candidate(), false).decision).toBe('REVIEW_REQUIRED');
  expect(decideAtomicCreateWithoutStrongIdentifier(candidate(), true).decision).toBe('ALLOW');
  expect(decideAtomicCreateWithoutStrongIdentifier(candidate({ subjectEvidence: [] }), true).decision).toBe('DENY');
});

it('reference spelling is neutral; meaningful evidence and independent versions are retained', () => {
  const original = candidate();
  const arbitrary = candidate({
    subjectEvidence: [{ ...evidence('CONCRETE_SUBJECT'), evidenceRef: 'anything' }],
  });
  expect(decide(arbitrary).decision).toBe('ALLOW');
  expect(candidateFingerprint(original)).not.toBe(candidateFingerprint(arbitrary));
  const result = evaluatePartySubjectEvidence(original);
  expect(result.subjectEligibilityVersion).toBe('party-concrete-subject.v1');
  expect(result.typeRuleVersion).toBe('party-subject-type.v1');
  expect(result.evidence).toEqual(original.subjectEvidence);
});
