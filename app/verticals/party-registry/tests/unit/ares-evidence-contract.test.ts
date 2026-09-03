import assert from 'node:assert/strict';
import test from 'node:test';
import { Schema } from 'effect';
import {
  AresCanonicalRouteSchema,
  AresEvidenceApplicationSchema,
} from '../../shared/domain/ares-application.ts';
import {
  AresSubjectEvidenceSchema,
  AresSubjectLookupIcoSchema,
} from '../../shared/domain/ares-evidence.ts';
import {
  AresLookupRequestSchema,
  AresLookupResponseSchema,
} from '../../shared/apis/ares-lookup.ts';

const evidence = {
  cacheAgeSeconds: 0,
  observedAt: '2026-09-03T08:00:00.000Z',
  provider: 'ares',
  providerChangedOn: '2026-09-01',
  providerRecordRef: 'ares:ico:01234567',
  queryIco: '01234567',
  servedAt: '2026-09-03T08:00:00.000Z',
  status: 'FOUND',
  subject: {
    businessName: 'Example s.r.o.',
    dic: 'CZ01234567',
    dissolvedOn: null,
    establishedOn: '2020-01-02',
    ico: '01234567',
    legalFormCode: '112',
    registeredAddress: {
      buildingNumber: '10',
      countryCode: 'CZ',
      formatted: 'Karlovo namesti 10, 120 00 Praha',
      municipality: 'Praha',
      municipalityPart: null,
      orientationNumber: null,
      postalCode: '12000',
      street: 'Karlovo namesti',
    },
  },
} as const;

test('normalizes only surrounding whitespace and preserves leading zeroes in an exact IČO', () => {
  assert.equal(Schema.decodeUnknownSync(AresSubjectLookupIcoSchema)(' 01234567 '), '01234567');
  assert.deepEqual(Schema.decodeUnknownSync(AresLookupRequestSchema)({ ico: ' 01234567 ' }), {
    ico: '01234567',
  });

  for (const ico of ['1234567', '123456789', '1234 5678', 'abcdefgh', '']) {
    assert.throws(() => Schema.decodeUnknownSync(AresSubjectLookupIcoSchema)(ico));
  }
});

test('returns one bounded evidence envelope and strips unowned provider payload fields', () => {
  const decoded = Schema.decodeUnknownSync(AresLookupResponseSchema)({
    ...evidence,
    rawResponse: { privateProviderBody: true },
    subject: {
      ...evidence.subject,
      czNace: ['62010'],
      seznamRegistraci: { unsafe: 'unbounded' },
    },
  });

  assert.deepEqual(decoded, evidence);
  assert.equal(Object.hasOwn(decoded, 'rawResponse'), false);
  assert.equal(Object.hasOwn(decoded.subject, 'czNace'), false);
  assert.deepEqual(Schema.decodeUnknownSync(AresSubjectEvidenceSchema)(decoded), evidence);
});

test('keeps observed time separate from provider change time and cache-serving time', () => {
  assert.throws(() =>
    Schema.decodeUnknownSync(AresSubjectEvidenceSchema)({
      ...evidence,
      observedAt: '2026-02-30T08:00:00.000Z',
    }),
  );
  const cached = Schema.decodeUnknownSync(AresSubjectEvidenceSchema)({
    ...evidence,
    cacheAgeSeconds: 120,
    servedAt: '2026-09-03T08:02:00.000Z',
  });

  assert.equal(cached.observedAt, '2026-09-03T08:00:00.000Z');
  assert.equal(cached.servedAt, '2026-09-03T08:02:00.000Z');
  assert.equal(cached.providerChangedOn, '2026-09-01');
  assert.equal(cached.cacheAgeSeconds, 120);
});

test('allows ARES evidence to route only through standard Party-owned lifecycle Actions', () => {
  const routes = [
    'PARTY_UPDATE',
    'IDENTIFIER_ADD',
    'CONTACT_POINT_ADD',
    'PARTY_CORRECTION',
  ] as const;
  for (const route of routes) {
    assert.equal(Schema.decodeUnknownSync(AresCanonicalRouteSchema)(route), route);
  }
  for (const forbiddenRoute of [
    'PARTY_CREATE',
    'ARES_APPLY',
    'PARTY_MERGE',
    'RAW_PROVIDER_OVERWRITE',
  ]) {
    assert.throws(() => Schema.decodeUnknownSync(AresCanonicalRouteSchema)(forbiddenRoute));
  }

  const application = Schema.decodeUnknownSync(AresEvidenceApplicationSchema)({
    decidedAt: '2026-09-03T08:01:00.000Z',
    evidence,
    factDecisions: [
      {
        authorityPolicyKey: 'party.registry.ares.ico',
        authorityPolicyVersion: '1',
        fact: 'ICO',
        outcome: 'APPLY_ENRICHMENT',
        reasonCode: 'missing_supported_ico',
        route: 'IDENTIFIER_ADD',
      },
      {
        authorityPolicyKey: 'party.registry.ares.business-name',
        authorityPolicyVersion: '1',
        fact: 'BUSINESS_NAME',
        outcome: 'APPLY_ENRICHMENT',
        reasonCode: 'missing_supported_name',
        route: 'PARTY_UPDATE',
      },
      {
        authorityPolicyKey: 'party.registry.ares.registered-address',
        authorityPolicyVersion: '1',
        fact: 'REGISTERED_ADDRESS',
        outcome: 'APPLY_ENRICHMENT',
        reasonCode: 'missing_supported_address',
        route: 'CONTACT_POINT_ADD',
      },
    ],
    outcome: 'APPLY_ENRICHMENT',
    userConfirmed: true,
  });
  assert.equal(application.factDecisions.length, 3);
  assert.equal(application.userConfirmed, true);
});

test('rejects unattended enrichment and mutation routes on non-applying outcomes', () => {
  assert.throws(() =>
    Schema.decodeUnknownSync(AresEvidenceApplicationSchema)({
      decidedAt: '2026-09-03T08:01:00.000Z',
      evidence,
      factDecisions: [
        {
          authorityPolicyKey: 'party.registry.ares.ico',
          authorityPolicyVersion: '1',
          fact: 'ICO',
          outcome: 'APPLY_ENRICHMENT',
          reasonCode: 'missing_supported_ico',
          route: 'IDENTIFIER_ADD',
        },
      ],
      outcome: 'APPLY_ENRICHMENT',
      userConfirmed: false,
    }),
  );
  assert.throws(() =>
    Schema.decodeUnknownSync(AresEvidenceApplicationSchema)({
      decidedAt: '2026-09-03T08:01:00.000Z',
      evidence,
      factDecisions: [
        {
          authorityPolicyKey: 'party.registry.ares.ico',
          authorityPolicyVersion: '1',
          fact: 'ICO',
          outcome: 'APPLY_ENRICHMENT',
          reasonCode: 'missing_supported_ico',
          route: 'IDENTIFIER_ADD',
        },
      ],
      outcome: 'NEEDS_CONFIRMATION',
      userConfirmed: true,
    }),
  );

  const conflict = Schema.decodeUnknownSync(AresEvidenceApplicationSchema)({
    decidedAt: '2026-09-03T08:01:00.000Z',
    evidence,
    factDecisions: [
      {
        authorityPolicyKey: 'party.registry.ares.ico',
        authorityPolicyVersion: '1',
        fact: 'ICO',
        outcome: 'IDENTITY_AMBIGUITY',
        reasonCode: 'conflicting_authoritative_ico',
        route: null,
      },
    ],
    outcome: 'IDENTITY_AMBIGUITY',
    userConfirmed: true,
  });
  assert.equal(conflict.factDecisions[0]?.route, null);
});
