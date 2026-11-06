import { DateTime } from 'effect';
import { expect, it } from 'effect-rstest';

import { partySubjectKeyFromString } from '../../shared/domain/identity-contracts.ts';
import type { PartyCandidate, PartySubjectEvidence } from '../../shared/domain/identity-contracts.ts';
import { createPartyAction } from '../../src/actions/create-party.action.ts';
import { evaluatePartySubjectEvidence } from '../../src/policies/create-party-without-strong-identifier.policy.ts';
import { candidateFingerprint } from '../../src/services/party-matching-persistence.service.ts';

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
it('concrete subject evidence needs neither a name nor an official ID', () => {
  expect(evaluatePartySubjectEvidence(candidate()).typeSupported).toBe(true);
  expect(evaluatePartySubjectEvidence(candidate({ firstName: 'A' })).typeSupported).toBe(true);
  expect(evaluatePartySubjectEvidence(candidate({ businessName: 'Unknown' })).typeSupported).toBe(true);
});

it('names, reference prefixes and identifiers never substitute for subject evidence', () => {
  for (const input of [
    candidate({ firstName: 'Jane', lastName: 'Smith', subjectEvidence: [] }),
    candidate({
      evidenceRefs: ['business-record:42', 'evidence-artifact:42'],
      subjectEvidence: [],
    }),
    candidate({
      officialIdentifiers: [{ identifierType: 'ICO', value: '27074358' }],
      subjectEvidence: [],
    }),
  ]) {
    expect(evaluatePartySubjectEvidence(input).typeSupported).toBe(false);
  }
});

it('type support is separate from evidence of a concrete subject', () => {
  for (const partyType of ['PERSON', 'ORGANIZATION'] as const) {
    expect(evaluatePartySubjectEvidence(candidate({ partyType })).reasonCode).toBe('party_type_evidence_required');
    expect(
      evaluatePartySubjectEvidence(candidate({ partyType, subjectEvidence: [evidence(partyType)] })).typeSupported,
    ).toBe(true);
  }
  expect(
    evaluatePartySubjectEvidence(
      candidate({
        subjectEvidence: [evidence('PERSON'), evidence('ORGANIZATION')],
      }),
    ).reasonCode,
  ).toBe('conflicting_type_evidence');
});

it('technical records, managed Legal Entities and multiple subjects fail closed', () => {
  for (const kind of ['TECHNICAL_RECORD', 'MANAGED_LEGAL_ENTITY'] as const) {
    expect(evaluatePartySubjectEvidence(candidate({ subjectEvidence: [evidence(kind)] })).typeSupported).toBe(false);
  }
  expect(
    evaluatePartySubjectEvidence(
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

it('Create keeps subject evaluation and duplicate decisions inside the owner Action', () => {
  expect(createPartyAction.descriptor.policies).toEqual([]);
  expect(createPartyAction.descriptor.accessActor).toEqual(
    expect.objectContaining({
      callers: ['commerce-customer-context'],
      reason: expect.any(String),
      subject: 'identity',
      subjectWorkloads: ['commerce.storefront-client'],
    }),
  );
});

it('reference spelling is neutral; meaningful evidence and independent versions are retained', () => {
  const original = candidate();
  const arbitrary = candidate({
    subjectEvidence: [{ ...evidence('CONCRETE_SUBJECT'), evidenceRef: 'anything' }],
  });
  expect(evaluatePartySubjectEvidence(arbitrary).typeSupported).toBe(true);
  expect(candidateFingerprint(original)).not.toBe(candidateFingerprint(arbitrary));
  const result = evaluatePartySubjectEvidence(original);
  expect(result.subjectEligibilityVersion).toBe('party-concrete-subject.v1');
  expect(result.typeRuleVersion).toBe('party-subject-type.v1');
  expect(result.evidence).toEqual(original.subjectEvidence);
});
