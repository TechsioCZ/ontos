import { DateTime, Option, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  AresAppliedEvidenceSchema,
  aresRegisteredAddressMatches,
  deriveAresEvidenceApplication,
  deriveAresCorrectionReviewHandoffs,
  prefillPartyCandidateFromAres,
  makeAresAppliedEvidence,
} from '../../shared/domain/ares-application.ts';
import type { AresCanonicalSnapshot } from '../../shared/domain/ares-application.ts';
import type { AresSubjectEvidenceSchema } from '../../shared/domain/ares-evidence.ts';

const evidence: typeof AresSubjectEvidenceSchema.Encoded = {
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

it('#246 fixed owner policy enriches only selected missing facts after explicit confirmation', () => {
  expect(derive().factDecisions.map((decision) => decision.route)).toEqual([
    'PARTY_UPDATE',
    'IDENTIFIER_ADD',
    'CONTACT_POINT_ADD',
  ]);
  expect(derive(canonical, false).outcome).toBe('NEEDS_CONFIRMATION');
  const selected = deriveAresEvidenceApplication({
    canonical,
    decidedAt: '2026-09-03T08:01:00.000Z',
    evidence,
    selectedFacts: ['ICO'],
    userConfirmed: true,
  });
  expect(selected.factDecisions.map((decision) => decision.fact)).toEqual(['ICO']);
  expect(selected.factDecisions[0]?.authorityPolicyKey).toBe('party_registry.ares_enrichment');
});

it('#246 canonical equality is no-change and conflicting facts never authorize overwrite', () => {
  const result = derive({
    ...canonical,
    displayName: 'Example',
    icoValues: ['01234567'],
    registeredAddresses: [
      {
        addressLine1: 'Main 10',
        city: 'Praha',
        countryCode: 'CZ',
        postalCode: '12000',
      },
    ],
  });
  expect(result.outcome).toBe('NO_CHANGE');
  expect(result.factDecisions.every((decision) => decision.route === null)).toBe(true);
  const conflict = derive({
    ...canonical,
    displayName: 'Different',
    registeredAddresses: [
      {
        addressLine1: 'Main 100',
        city: 'Praha',
        countryCode: 'CZ',
        postalCode: '12000',
      },
    ],
  });
  expect(conflict.factDecisions[0]?.outcome).toBe('NEEDS_CONFIRMATION');
  expect(conflict.factDecisions[2]?.outcome).toBe('NEEDS_CONFIRMATION');
});

it('#246 conflicting official identity blocks all enrichment and no Party remains prefill-only', () => {
  for (const snapshot of [
    { ...canonical, icoValues: ['87654321'] },
    { ...canonical, identityAmbiguous: true },
  ]) {
    expect(
      derive(snapshot).factDecisions.every(
        (decision) => decision.outcome === 'IDENTITY_AMBIGUITY' && decision.route === null,
      ),
    ).toBe(true);
  }
  expect(derive(null).outcome).toBe('PREFILL_ONLY');
});

it('#246 candidate prefill cannot authorize create against an existing Party', () => {
  const result = deriveAresEvidenceApplication({
    canonical: { ...canonical, archived: true, identityAmbiguous: true },
    decidedAt: '2026-09-03T08:01:00.000Z',
    evidence,
    selectedFacts: ['PARTY_CANDIDATE'],
    userConfirmed: true,
  });
  expect(result.outcome).toBe('NEEDS_CONFIRMATION');
  expect(result.factDecisions[0]?.route).toBe(null);
});

it('#246 structural registered address comparison cannot confuse substrings or unknown fields', () => {
  const observed = evidence.subject.registeredAddress;
  expect(observed).toBeDefined();
  if (observed === null) {
    throw new Error('Expected observed to be defined');
  }
  const current = {
    addressLine1: 'Main 10',
    city: 'Praha',
    countryCode: 'CZ',
    postalCode: '12000',
  };
  expect(aresRegisteredAddressMatches(observed, current)).toBe(true);
  expect(
    aresRegisteredAddressMatches(observed, {
      ...current,
      addressLine1: 'Main 100',
    }),
  ).toBe(false);
  expect(aresRegisteredAddressMatches(observed, { ...current, region: 'Extra' })).toBe(false);
  expect(aresRegisteredAddressMatches(observed, { ...current, postalCode: '13000' })).toBe(false);
});

it('#246 stale observations and archived Parties cannot be enriched', () => {
  expect(derive({ ...canonical, archived: true }).factDecisions.every((decision) => decision.route === null)).toBe(
    true,
  );
  const stale = deriveAresEvidenceApplication({
    canonical,
    decidedAt: '2026-09-03T09:01:00.000Z',
    evidence,
    selectedFacts: ['ICO'],
    userConfirmed: true,
  });
  expect(stale.outcome).toBe('NEEDS_CONFIRMATION');
});

it('#246 durable evidence retains observation and authority metadata without raw provider body', () => {
  const application = derive();
  const [decision] = application.factDecisions;
  expect(decision).toBeDefined();
  if (decision === undefined) {
    throw new Error('Expected decision to be defined');
  }
  const durable = makeAresAppliedEvidence(application, decision);
  expect(DateTime.formatIso(durable.observedAt)).toBe(evidence.observedAt);
  expect(DateTime.formatIso(durable.decidedAt)).toBe(DateTime.formatIso(application.decidedAt));
  expect(
    Option.match(durable.providerChangedOn, {
      onNone: () => null,
      onSome: DateTime.formatIsoDateUtc,
    }),
  ).toBe(evidence.providerChangedOn);
  expect(durable.fact).toBe('BUSINESS_NAME');
  expect(durable.evidenceRef.startsWith('ares:01234567:')).toBe(true);
  expect(Object.hasOwn(durable, 'subject')).toBe(false);
  const encoded = Result.getOrThrow(Schema.encodeUnknownResult(AresAppliedEvidenceSchema)(durable));
  expect(encoded.observedAt).toBe(evidence.observedAt);
  expect(encoded.providerChangedOn).toBe(evidence.providerChangedOn);
  expect(Result.getOrThrow(Schema.decodeResult(AresAppliedEvidenceSchema)(encoded))).toEqual(durable);
});

const acceptedEvidence = (fact: 'BUSINESS_NAME' | 'ICO') => {
  const result = derive();
  const decision = result.factDecisions.find((item) => item.fact === fact);
  expect(decision).toBeDefined();
  if (decision === undefined) {
    throw new Error('Expected decision to be defined');
  }
  return Result.getOrThrow(
    Schema.encodeUnknownResult(AresAppliedEvidenceSchema)(makeAresAppliedEvidence(result, decision)),
  );
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

it('unchanged provider revision nominates an exact conflicting accepted assertion for review', () => {
  const result = decideName();
  expect(result.outcome).toBe('CORRECTION_CANDIDATE');
  expect(result.factDecisions[0]?.route).toBe(null);
  const [review] = deriveAresCorrectionReviewHandoffs(result, conflictingName);
  expect(review?.targetAssertionId).toBe(conflictingName.factEvidence?.[0]?.assertionId);
  expect(review?.observedValue).toBe('Example');
  expect(review?.evidence.outcome).toBe('CORRECTION_CANDIDATE');
});

it('ordinary change, missing provenance, ambiguous assertions and temporal mismatch are not historical proof', () => {
  const assertion = conflictingName.factEvidence?.[0];
  expect(assertion).toBeDefined();
  if (assertion === undefined) {
    throw new Error('Expected assertion to be defined');
  }
  const prior = acceptedEvidence('BUSINESS_NAME');
  for (const snapshot of [
    { ...conflictingName, factEvidence: [] },
    {
      ...conflictingName,
      factEvidence: [assertion, { ...assertion, assertionId: 'other' }],
    },
    {
      ...conflictingName,
      factEvidence: [{ ...assertion, externalEvidence: null }],
    },
    {
      ...conflictingName,
      factEvidence: [{ ...assertion, externalEvidence: { ...prior, queryIco: '87654321' } }],
    },
    {
      ...conflictingName,
      factEvidence: [
        {
          ...assertion,
          externalEvidence: { ...prior, providerRecordRef: 'different-record' },
        },
      ],
    },
    {
      ...conflictingName,
      factEvidence: [
        {
          ...assertion,
          externalEvidence: { ...prior, providerChangedOn: null },
        },
      ],
    },
    {
      ...conflictingName,
      factEvidence: [{ ...assertion, validFrom: '2026-09-03T07:59:00.000Z' }],
    },
  ]) {
    expect(decideName(snapshot).outcome).toBe('NEEDS_CONFIRMATION');
    expect(deriveAresCorrectionReviewHandoffs(decideName(snapshot), snapshot)).toEqual([]);
  }
  expect(
    decideName(conflictingName, {
      ...evidence,
      providerChangedOn: '2026-09-02',
    }).outcome,
  ).toBe('NEEDS_CONFIRMATION');
  expect(
    decideName(conflictingName, {
      ...evidence,
      observedAt: '2026-09-03T07:00:00.000Z',
    }).outcome,
  ).toBe('NEEDS_CONFIRMATION');
  expect(decideName({ ...conflictingName, archived: true }).outcome).toBe('NEEDS_CONFIRMATION');
});

it('historical ICO suspicion nominates only its assertion and never permits other enrichment', () => {
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
  expect(result.factDecisions.find((item) => item.fact === 'ICO')?.outcome).toBe('CORRECTION_CANDIDATE');
  expect(result.factDecisions.find((item) => item.fact === 'BUSINESS_NAME')?.outcome).toBe('IDENTITY_AMBIGUITY');
  expect(result.factDecisions.every((item) => item.route === null)).toBe(true);
  expect(deriveAresCorrectionReviewHandoffs(result, snapshot)[0]?.fact).toBe('ICO');
  expect(derive({ ...snapshot, identityAmbiguous: true }).outcome).toBe('IDENTITY_AMBIGUITY');
});

it('candidate prefill supplies a proposal without declaring subject type or actor evidence', () => {
  const candidate = prefillPartyCandidateFromAres(evidence);
  expect(candidate.partyType).toBe('UNRESOLVED');
  expect(candidate.subjectEvidence).toEqual([]);
  expect(candidate.officialIdentifiers).toEqual([
    {
      identifierType: 'ICO',
      value: evidence.subject.ico,
      verification: 'UNVERIFIED',
    },
  ]);
  expect(candidate.provenance.externalEvidence).toBe(undefined);
  expect(candidate.displayName).toBe(evidence.subject.businessName);
});

it('six amended outcomes remain reachable and unsupported name or address never applies', () => {
  expect(
    new Set([
      derive(null).outcome,
      derive().outcome,
      decideName({ ...canonical, displayName: 'Example' }).outcome,
      derive(canonical, false).outcome,
      decideName().outcome,
      derive({ ...canonical, identityAmbiguous: true }).outcome,
    ]),
  ).toEqual(
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
      subject: {
        ...evidence.subject,
        businessName: 'x'.repeat(301),
        registeredAddress: null,
      },
    },
    selectedFacts: ['BUSINESS_NAME', 'REGISTERED_ADDRESS'],
    userConfirmed: true,
  });
  expect(result.outcome).toBe('NO_CHANGE');
});

it('authoritative ICO enrichment requires an ORGANIZATION and address enrichment requires supported Czech structure', () => {
  for (const partyType of ['PERSON', 'UNRESOLVED'] as const) {
    const result = deriveAresEvidenceApplication({
      canonical: { ...canonical, partyType },
      decidedAt: '2026-09-03T08:01:00.000Z',
      evidence,
      selectedFacts: ['ICO'],
      userConfirmed: true,
    });
    expect(result.outcome).toBe('NEEDS_CONFIRMATION');
    expect(result.factDecisions[0]?.reasonCode).toBe('party_type_not_supported_for_authoritative_ico');
  }
  const address = evidence.subject.registeredAddress;
  expect(address).toBeDefined();
  if (address === null) {
    throw new Error('Expected address to be defined');
  }
  for (const registeredAddress of [
    { ...address, countryCode: 'DE' },
    { ...address, buildingNumber: null, street: null },
  ]) {
    const result = deriveAresEvidenceApplication({
      canonical,
      decidedAt: '2026-09-03T08:01:00.000Z',
      evidence: {
        ...evidence,
        subject: { ...evidence.subject, registeredAddress },
      },
      selectedFacts: ['REGISTERED_ADDRESS'],
      userConfirmed: true,
    });
    expect(result.outcome).toBe('NO_CHANGE');
  }
});
