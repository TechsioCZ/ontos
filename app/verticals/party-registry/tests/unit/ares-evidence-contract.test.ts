import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { AresLookupRequestSchema, AresLookupResponseSchema } from '../../shared/apis/ares-lookup.ts';
import { AresCanonicalRouteSchema, AresEvidenceApplicationSchema } from '../../shared/domain/ares-application.ts';
import { AresSubjectEvidenceSchema, AresSubjectLookupIcoSchema } from '../../shared/domain/ares-evidence.ts';

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

it.effect('normalizes only surrounding whitespace and preserves leading zeroes in an exact IČO', () =>
  Effect.gen(function* validateContract1() {
    expect(yield* Schema.decodeEffect(AresSubjectLookupIcoSchema)(' 01234567 ')).toBe('01234567');
    expect(
      yield* Schema.decodeEffect(AresLookupRequestSchema)({
        ico: ' 01234567 ',
      }),
    ).toEqual({
      ico: '01234567',
    });

    for (const ico of ['1234567', '123456789', '1234 5678', 'abcdefgh', '']) {
      expect(() => Schema.decodeSync(AresSubjectLookupIcoSchema)(ico)).toThrow();
    }
  }),
);

it.effect('returns one bounded evidence envelope and strips unowned provider payload fields', () =>
  Effect.gen(function* validateContract2() {
    const decoded = yield* Schema.decodeUnknownEffect(AresLookupResponseSchema)({
      ...evidence,
      rawResponse: { privateProviderBody: true },
      subject: {
        ...evidence.subject,
        czNace: ['62010'],
        seznamRegistraci: { unsafe: 'unbounded' },
      },
    });
    const encoded = yield* Schema.encodeEffect(AresLookupResponseSchema)(decoded);

    expect(encoded).toEqual(evidence);
    expect(Object.hasOwn(decoded, 'rawResponse')).toBe(false);
    expect(Object.hasOwn(decoded.subject, 'czNace')).toBe(false);
    expect(yield* Schema.decodeEffect(AresSubjectEvidenceSchema)(encoded)).toEqual(decoded);
  }),
);

it.effect('keeps observed time separate from provider change time and cache-serving time', () =>
  Effect.gen(function* validateContract3() {
    expect(() =>
      Schema.decodeSync(AresSubjectEvidenceSchema)({
        ...evidence,
        observedAt: '2026-02-30T08:00:00.000Z',
      }),
    ).toThrow();
    const cached = yield* Schema.decodeEffect(AresSubjectEvidenceSchema)({
      ...evidence,
      cacheAgeSeconds: 120,
      servedAt: '2026-09-03T08:02:00.000Z',
    });
    const encoded = yield* Schema.encodeEffect(AresSubjectEvidenceSchema)(cached);

    expect(encoded.observedAt).toBe('2026-09-03T08:00:00.000Z');
    expect(encoded.servedAt).toBe('2026-09-03T08:02:00.000Z');
    expect(encoded.providerChangedOn).toBe('2026-09-01');
    expect(encoded.cacheAgeSeconds).toBe(120);
  }),
);

it.effect('allows ARES evidence to route only through standard Party-owned lifecycle Actions', () =>
  Effect.gen(function* validateContract4() {
    const routes = ['PARTY_UPDATE', 'IDENTIFIER_ADD', 'CONTACT_POINT_ADD', 'PARTY_CORRECTION'] as const;
    for (const route of routes) {
      expect(yield* Schema.decodeEffect(AresCanonicalRouteSchema)(route)).toBe(route);
    }
    for (const forbiddenRoute of ['PARTY_CREATE', 'ARES_APPLY', 'PARTY_MERGE', 'RAW_PROVIDER_OVERWRITE']) {
      expect(() => Schema.decodeUnknownSync(AresCanonicalRouteSchema)(forbiddenRoute)).toThrow();
    }

    const application = yield* Schema.decodeEffect(AresEvidenceApplicationSchema)({
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
    expect(application.factDecisions.length).toBe(3);
    expect(application.userConfirmed).toBe(true);
  }),
);

it.effect('rejects unattended enrichment and mutation routes on non-applying outcomes', () =>
  Effect.gen(function* validateContract5() {
    expect(() =>
      Schema.decodeSync(AresEvidenceApplicationSchema)({
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
    ).toThrow();
    expect(() =>
      Schema.decodeSync(AresEvidenceApplicationSchema)({
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
    ).toThrow();

    const conflict = yield* Schema.decodeEffect(AresEvidenceApplicationSchema)({
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
    expect(conflict.factDecisions[0]?.route).toBe(null);
  }),
);
