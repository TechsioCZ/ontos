import assert from 'node:assert/strict';
import test from 'node:test';
import { Schema } from 'effect';
import {
  AresAppliedEvidenceSchema,
  aresRegisteredAddressMatches,
  deriveAresEvidenceApplication,
  deriveAresCorrectionReviewHandoffs,
  prefillPartyCandidateFromAres,
  makeAresAppliedEvidence,
} from '../../shared/domain/ares-application.ts';
import type { AresCanonicalSnapshot } from '../../shared/domain/ares-application.ts';
import type { AresSubjectEvidence } from '../../shared/domain/ares-evidence.ts';

const evidence: AresSubjectEvidence = {
  cacheAgeSeconds: 0,
  observedAt: '2026-09-03T08:00:00.000Z',
  provider: 'ares',
  providerChangedOn: '2026-09-01',
  providerRecordRef: 'opaque-provider-record',
  queryIco: '01234567',
  servedAt: '2026-09-03T08:00:00.000Z',
  status: 'FOUND',
  subject: {
    businessName: 'Example',
    dic: null,
    dissolvedOn: null,
    establishedOn: null,
    ico: '01234567',
    legalFormCode: null,
    registeredAddress: {
      buildingNumber: '10',
      countryCode: 'CZ',
      formatted: 'Main 10, Praha',
      municipality: 'Praha',
      municipalityPart: null,
      orientationNumber: null,
      postalCode: '12000',
      street: 'Main',
    },
  },
};
const canonical: AresCanonicalSnapshot = {
  archived: false,
  displayName: null,
  icoValues: [],
  identityAmbiguous: false,
  partyType: 'ORGANIZATION',
  registeredAddresses: [],
};
const derive = (snapshot: AresCanonicalSnapshot | null = canonical, confirmed = true) =>
  deriveAresEvidenceApplication({
    canonical: snapshot,
    decidedAt: '2026-09-03T08:01:00.000Z',
    evidence,
    selectedFacts: ['BUSINESS_NAME', 'ICO', 'REGISTERED_ADDRESS'],
    userConfirmed: confirmed,
  });

test('#246 fixed owner policy enriches only selected missing facts after explicit confirmation', () => {
  assert.deepEqual(
    derive().factDecisions.map((decision) => decision.route),
    ['PARTY_UPDATE', 'IDENTIFIER_ADD', 'CONTACT_POINT_ADD'],
  );
  assert.equal(derive(canonical, false).outcome, 'NEEDS_CONFIRMATION');
  const selected = deriveAresEvidenceApplication({
    canonical,
    decidedAt: '2026-09-03T08:01:00.000Z',
    evidence,
    selectedFacts: ['ICO'],
    userConfirmed: true,
  });
  assert.deepEqual(
    selected.factDecisions.map((decision) => decision.fact),
    ['ICO'],
  );
  assert.equal(selected.factDecisions[0]?.authorityPolicyKey, 'party_registry.ares_enrichment');
});

test('#246 canonical equality is no-change and conflicting facts never authorize overwrite', () => {
  const result = derive({
    ...canonical,
    displayName: 'Example',
    icoValues: ['01234567'],
    registeredAddresses: [
      { addressLine1: 'Main 10', city: 'Praha', countryCode: 'CZ', postalCode: '12000' },
    ],
  });
  assert.equal(result.outcome, 'NO_CHANGE');
  assert.ok(result.factDecisions.every((decision) => decision.route === null));
  const conflict = derive({
    ...canonical,
    displayName: 'Different',
    registeredAddresses: [
      { addressLine1: 'Main 100', city: 'Praha', countryCode: 'CZ', postalCode: '12000' },
    ],
  });
  assert.equal(conflict.factDecisions[0]?.outcome, 'NEEDS_CONFIRMATION');
  assert.equal(conflict.factDecisions[2]?.outcome, 'NEEDS_CONFIRMATION');
});

test('#246 conflicting official identity blocks all enrichment and no Party remains prefill-only', () => {
  for (const snapshot of [
    { ...canonical, icoValues: ['87654321'] },
    { ...canonical, identityAmbiguous: true },
  ]) {
    assert.ok(
      derive(snapshot).factDecisions.every(
        (decision) => decision.outcome === 'IDENTITY_AMBIGUITY' && decision.route === null,
      ),
    );
  }
  assert.equal(derive(null).outcome, 'PREFILL_ONLY');
});

test('#246 candidate prefill cannot authorize create against an existing Party', () => {
  const result = deriveAresEvidenceApplication({
    canonical: { ...canonical, archived: true, identityAmbiguous: true },
    decidedAt: '2026-09-03T08:01:00.000Z',
    evidence,
    selectedFacts: ['PARTY_CANDIDATE'],
    userConfirmed: true,
  });
  assert.equal(result.outcome, 'NEEDS_CONFIRMATION');
  assert.equal(result.factDecisions[0]?.route, null);
});

test('#246 structural registered address comparison cannot confuse substrings or unknown fields', () => {
  const observed = evidence.subject.registeredAddress;
  assert.ok(observed);
  const current = {
    addressLine1: 'Main 10',
    city: 'Praha',
    countryCode: 'CZ',
    postalCode: '12000',
  };
  assert.equal(aresRegisteredAddressMatches(observed, current), true);
  assert.equal(
    aresRegisteredAddressMatches(observed, { ...current, addressLine1: 'Main 100' }),
    false,
  );
  assert.equal(aresRegisteredAddressMatches(observed, { ...current, region: 'Extra' }), false);
  assert.equal(aresRegisteredAddressMatches(observed, { ...current, postalCode: '13000' }), false);
});

test('#246 stale observations and archived Parties cannot be enriched', () => {
  assert.ok(
    derive({ ...canonical, archived: true }).factDecisions.every(
      (decision) => decision.route === null,
    ),
  );
  const stale = deriveAresEvidenceApplication({
    canonical,
    decidedAt: '2026-09-03T09:01:00.000Z',
    evidence,
    selectedFacts: ['ICO'],
    userConfirmed: true,
  });
  assert.equal(stale.outcome, 'NEEDS_CONFIRMATION');
});

test('#246 durable evidence retains observation and authority metadata without raw provider body', () => {
  const application = derive();
  const [decision] = application.factDecisions;
  assert.ok(decision);
  const durable = makeAresAppliedEvidence(application, decision);
  assert.equal(durable.observedAt, evidence.observedAt);
  assert.equal(durable.decidedAt, application.decidedAt);
  assert.equal(durable.providerChangedOn, '2026-09-01');
  assert.equal(durable.fact, 'BUSINESS_NAME');
  assert.ok(durable.evidenceRef.startsWith('ares:01234567:'));
  assert.equal(Object.hasOwn(durable, 'subject'), false);
  assert.deepEqual(Schema.decodeUnknownSync(AresAppliedEvidenceSchema)(durable), durable);
});

const acceptedEvidence = (fact: 'BUSINESS_NAME' | 'ICO') => {
  const result = derive();
  const decision = result.factDecisions.find((item) => item.fact === fact);
  assert.ok(decision);
  return makeAresAppliedEvidence(result, decision);
};
const conflictingName: AresCanonicalSnapshot = {
  ...canonical,
  displayName: 'Erroneous accepted name',
  factEvidence: [
    {
      assertionId: '30000000-0000-4000-8000-000000000001',
      externalEvidence: acceptedEvidence('BUSINESS_NAME'),
      fact: 'BUSINESS_NAME',
      validFrom: evidence.observedAt,
      value: 'Erroneous accepted name',
    },
  ],
};
const decideName = (snapshot = conflictingName, observed = evidence) =>
  deriveAresEvidenceApplication({
    canonical: snapshot,
    decidedAt: '2026-09-03T08:01:00.000Z',
    evidence: observed,
    selectedFacts: ['BUSINESS_NAME'],
    userConfirmed: true,
  });

test('unchanged provider revision nominates an exact conflicting accepted assertion for review', () => {
  const result = decideName();
  assert.equal(result.outcome, 'CORRECTION_CANDIDATE');
  assert.equal(result.factDecisions[0]?.route, null);
  const [review] = deriveAresCorrectionReviewHandoffs(result, conflictingName);
  assert.equal(review?.targetAssertionId, conflictingName.factEvidence?.[0]?.assertionId);
  assert.equal(review?.observedValue, 'Example');
  assert.equal(review?.evidence.outcome, 'CORRECTION_CANDIDATE');
});

test('ordinary change, missing provenance, ambiguous assertions and temporal mismatch are not historical proof', () => {
  const assertion = conflictingName.factEvidence?.[0];
  assert.ok(assertion);
  const prior = assertion.externalEvidence;
  assert.ok(prior);
  for (const snapshot of [
    { ...conflictingName, factEvidence: [] },
    { ...conflictingName, factEvidence: [assertion, { ...assertion, assertionId: 'other' }] },
    { ...conflictingName, factEvidence: [{ ...assertion, externalEvidence: null }] },
    {
      ...conflictingName,
      factEvidence: [{ ...assertion, externalEvidence: { ...prior, queryIco: '87654321' } }],
    },
    {
      ...conflictingName,
      factEvidence: [
        { ...assertion, externalEvidence: { ...prior, providerRecordRef: 'different-record' } },
      ],
    },
    {
      ...conflictingName,
      factEvidence: [{ ...assertion, externalEvidence: { ...prior, providerChangedOn: null } }],
    },
    { ...conflictingName, factEvidence: [{ ...assertion, validFrom: '2026-09-03T07:59:00.000Z' }] },
  ]) {
    assert.equal(decideName(snapshot).outcome, 'NEEDS_CONFIRMATION');
    assert.deepEqual(deriveAresCorrectionReviewHandoffs(decideName(snapshot), snapshot), []);
  }
  assert.equal(
    decideName(conflictingName, { ...evidence, providerChangedOn: '2026-09-02' }).outcome,
    'NEEDS_CONFIRMATION',
  );
  assert.equal(
    decideName(conflictingName, { ...evidence, observedAt: '2026-09-03T07:00:00.000Z' }).outcome,
    'NEEDS_CONFIRMATION',
  );
  assert.equal(decideName({ ...conflictingName, archived: true }).outcome, 'NEEDS_CONFIRMATION');
});

test('historical ICO suspicion nominates only its assertion and never permits other enrichment', () => {
  const snapshot: AresCanonicalSnapshot = {
    ...canonical,
    factEvidence: [
      {
        assertionId: '30000000-0000-4000-8000-000000000002',
        externalEvidence: acceptedEvidence('ICO'),
        fact: 'ICO',
        validFrom: evidence.observedAt,
        value: '87654321',
      },
    ],
    icoValues: ['87654321'],
  };
  const result = derive(snapshot);
  assert.equal(
    result.factDecisions.find((item) => item.fact === 'ICO')?.outcome,
    'CORRECTION_CANDIDATE',
  );
  assert.equal(
    result.factDecisions.find((item) => item.fact === 'BUSINESS_NAME')?.outcome,
    'IDENTITY_AMBIGUITY',
  );
  assert.ok(result.factDecisions.every((item) => item.route === null));
  assert.equal(deriveAresCorrectionReviewHandoffs(result, snapshot)[0]?.fact, 'ICO');
  assert.equal(derive({ ...snapshot, identityAmbiguous: true }).outcome, 'IDENTITY_AMBIGUITY');
});

test('candidate prefill supplies a proposal without declaring subject type or actor evidence', () => {
  const candidate = prefillPartyCandidateFromAres(evidence);
  assert.equal(candidate.partyType, 'UNRESOLVED');
  assert.deepEqual(candidate.subjectEvidence, []);
  assert.deepEqual(candidate.officialIdentifiers, [
    { identifierType: 'ICO', value: evidence.subject.ico, verification: 'UNVERIFIED' },
  ]);
  assert.equal(candidate.provenance.externalEvidence, undefined);
  assert.equal(candidate.displayName, evidence.subject.businessName);
});

test('six amended outcomes remain reachable and unsupported name or address never applies', () => {
  assert.deepEqual(
    new Set([
      derive(null).outcome,
      derive().outcome,
      decideName({ ...canonical, displayName: 'Example' }).outcome,
      derive(canonical, false).outcome,
      decideName().outcome,
      derive({ ...canonical, identityAmbiguous: true }).outcome,
    ]),
    new Set([
      'PREFILL_ONLY',
      'APPLY_ENRICHMENT',
      'NO_CHANGE',
      'NEEDS_CONFIRMATION',
      'CORRECTION_CANDIDATE',
      'IDENTITY_AMBIGUITY',
    ]),
  );
  const result = deriveAresEvidenceApplication({
    canonical,
    decidedAt: '2026-09-03T08:01:00.000Z',
    evidence: {
      ...evidence,
      subject: { ...evidence.subject, businessName: 'x'.repeat(301), registeredAddress: null },
    },
    selectedFacts: ['BUSINESS_NAME', 'REGISTERED_ADDRESS'],
    userConfirmed: true,
  });
  assert.equal(result.outcome, 'NO_CHANGE');
});

test('authoritative ICO enrichment requires an ORGANIZATION and address enrichment requires supported Czech structure', () => {
  for (const partyType of ['PERSON', 'UNRESOLVED'] as const) {
    const result = deriveAresEvidenceApplication({
      canonical: { ...canonical, partyType },
      decidedAt: '2026-09-03T08:01:00.000Z',
      evidence,
      selectedFacts: ['ICO'],
      userConfirmed: true,
    });
    assert.equal(result.outcome, 'NEEDS_CONFIRMATION');
    assert.equal(
      result.factDecisions[0]?.reasonCode,
      'party_type_not_supported_for_authoritative_ico',
    );
  }
  const address = evidence.subject.registeredAddress;
  assert.ok(address);
  for (const registeredAddress of [
    { ...address, countryCode: 'DE' },
    { ...address, buildingNumber: null, street: null },
  ]) {
    const result = deriveAresEvidenceApplication({
      canonical,
      decidedAt: '2026-09-03T08:01:00.000Z',
      evidence: { ...evidence, subject: { ...evidence.subject, registeredAddress } },
      selectedFacts: ['REGISTERED_ADDRESS'],
      userConfirmed: true,
    });
    assert.equal(result.outcome, 'NO_CHANGE');
  }
});
