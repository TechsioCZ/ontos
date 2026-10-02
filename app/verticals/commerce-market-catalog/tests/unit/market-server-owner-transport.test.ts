import { MarketSubjectRestrictionsCurrentResponseSchema } from '@app/customer-market-retirement-contracts/market-subject-restrictions-current';
import {
  CurrentStorefrontApplicationRequestSchema,
  CurrentStorefrontApplicationResponseSchema,
} from '@app/storefront-registry-contracts';
import { ConfigProvider, DateTime, Effect, Option, Predicate, Schema } from 'effect';
import { FetchHttpClient } from 'effect/unstable/http';
import { describe, expect, it } from 'effect-rstest';

import { makeServerCurrentStorefrontApplicationAuthority } from '../../src/integrations/current-storefront-application.ts';
import { makeServerMarketSubjectRestrictionsReader } from '../../src/integrations/market-subject-restrictions.ts';

const compositionRevision = 'a'.repeat(64);
const tenantId = '11111111-1111-4111-8111-111111111111';
const legalEntityId = '22222222-2222-4222-8222-222222222222';
const requestCorrelation = 'market-server-owner-transport';
const configuration = ConfigProvider.fromUnknown({
  ONTOS_COMMERCE_MARKET_CATALOG_GATEWAY_API_KEY: 'market-server-api-key',
  ONTOS_SHELL_GATEWAY_BASE_URL: 'https://shell.example.test/shell-super-app-api',
});
const storefrontRequest = Schema.decodeUnknownSync(CurrentStorefrontApplicationRequestSchema)({
  effectiveAt: '2026-10-01T00:00:00.000Z',
  requestedChannel: 'B2C',
  storefrontAppId: 'shop-cz',
  tenantId,
});
const storefrontResponse = Schema.decodeUnknownSync(CurrentStorefrontApplicationResponseSchema)({
  ...storefrontRequest,
  allowedChannels: ['B2C'],
  effectiveInterval: { effectiveFrom: '2026-09-01T00:00:00.000Z' },
  lifecycle: 'ACTIVE',
  nextApplicabilityBoundary: '2026-11-01T00:00:00.000Z',
  observedAt: '2026-09-30T23:59:59.000Z',
  outcome: 'CURRENT',
  ownerRevision: 'storefront-application:shop-cz:r3:g7',
});
const subject = {
  counterpartyRef: {
    moduleId: 'party.registry',
    resourceId: '33333333-3333-4333-8333-333333333333',
    resourceType: 'party.registry.counterparty',
    tenantId,
  },
  kind: 'COUNTERPARTY',
  profileRef: {
    moduleId: 'commerce.customer-context',
    resourceId: '44444444-4444-4444-8444-444444444444',
    resourceType: 'commerce.customer-context.counterparty-purchasing-profile',
    tenantId,
  },
} as const;
const restrictionsResponse = Schema.decodeUnknownSync(MarketSubjectRestrictionsCurrentResponseSchema)({
  channelConstraint: { allowedChannels: ['B2B'], kind: 'ALLOWED_CHANNELS' },
  completenessEvidence: {
    observedAt: '2026-10-01T00:00:00.000Z',
    ownerRevision: 'counterparty-profile:7',
    scope: { kind: 'EXACT_PREDICATE', predicateRef: 'counterparty-profile:current-restrictions' },
  },
  decision: 'ALLOWED',
  evidenceRefs: ['commerce-customer-context:counterparty-profile:revision:7'],
  marketConstraint: { kind: 'ANY_MARKET' },
  observedAt: '2026-10-01T00:00:00.000Z',
  outcome: 'SUBJECT_RESTRICTIONS_CURRENT',
  ownerRevision: 'counterparty-profile:7',
  profileState: 'ACTIVE',
  sellerConstraint: {
    kind: 'ALLOWED_SELLERS',
    sellerRefs: [
      {
        moduleId: 'core.identity',
        resourceId: legalEntityId,
        resourceType: 'core.identity.legal-entity',
        tenantId,
      },
    ],
  },
  subject,
});

describe('Commerce Market server owner transport', () => {
  it.effect(
    'retains captured Storefront revision and legal entity after input mutation through native HTTP clients',
    () =>
      Effect.gen(function* storefrontOwnerTransport() {
        const requests: Request[] = [];
        const fakeFetch: typeof fetch = (input, init) => {
          const request = new Request(input, init);
          requests.push(request);
          return Promise.resolve(
            Response.json(
              new URL(request.url).pathname.endsWith('/auth/api-key/gateway-context')
                ? {
                    apiBaseUrl: '/module-api/commerce.storefront-registry',
                    compositionRevision,
                    expiresAt: 1_700_000_300,
                    token: 'storefront-owner-assertion',
                  }
                : Schema.encodeSync(CurrentStorefrontApplicationResponseSchema)(storefrontResponse),
            ),
          );
        };
        const captured = { compositionRevision, legalEntityId };
        const authority = makeServerCurrentStorefrontApplicationAuthority(captured);
        captured.compositionRevision = 'b'.repeat(64);
        captured.legalEntityId = '55555555-5555-4555-8555-555555555555';
        const evidence = yield* authority
          .validateCurrent(storefrontRequest, requestCorrelation)
          .pipe(
            Effect.provideService(FetchHttpClient.Fetch, fakeFetch),
            Effect.provide(ConfigProvider.layer(configuration)),
          );

        expect(evidence).toEqual({
          nextApplicabilityBoundary: '2026-11-01T00:00:00.000Z',
          observedAt: '2026-09-30T23:59:59.000Z',
          ownerRevision: 'storefront-application:shop-cz:r3:g7',
        });
        expect(requests).toHaveLength(2);
        const issuerRequest = yield* Effect.fromNullishOr(requests[0]);
        const ownerRequest = yield* Effect.fromNullishOr(requests[1]);
        expect(issuerRequest.url).toBe('https://shell.example.test/shell-super-app-api/auth/api-key/gateway-context');
        expect(issuerRequest.method).toBe('POST');
        expect(issuerRequest.headers.get('x-api-key')).toBe('market-server-api-key');
        expect(issuerRequest.headers.get('authorization')).toBeNull();
        expect(issuerRequest.headers.get('x-correlation-id')).toBe(requestCorrelation);
        expect(yield* Effect.promise(() => issuerRequest.json())).toEqual({
          audience: 'storefront-registry',
          compositionRevision,
          legalEntityId,
        });
        expect(ownerRequest.url).toBe(
          'https://shell.example.test/module-api/commerce.storefront-registry/reads/current-storefront-application',
        );
        expect(ownerRequest.method).toBe('POST');
        expect(ownerRequest.headers.get('authorization')).toBe('Bearer storefront-owner-assertion');
        expect(ownerRequest.headers.get('x-api-key')).toBeNull();
        expect(ownerRequest.headers.get('x-ontos-composition-revision')).toBe(compositionRevision);
        expect(ownerRequest.headers.get('x-correlation-id')).toBe(requestCorrelation);
        expect(yield* Effect.promise(() => ownerRequest.json())).toEqual(
          Schema.encodeSync(CurrentStorefrontApplicationRequestSchema)(storefrontRequest),
        );
      }),
  );

  it.effect(
    'retains captured Customer Context revision and legal entity after input mutation for subject restrictions',
    () =>
      Effect.gen(function* subjectOwnerTransport() {
        const requests: Request[] = [];
        const fakeFetch: typeof fetch = (input, init) => {
          const request = new Request(input, init);
          requests.push(request);
          return Promise.resolve(
            Response.json(
              new URL(request.url).pathname.endsWith('/auth/api-key/gateway-context')
                ? {
                    apiBaseUrl: '/module-api/commerce.customer-context',
                    compositionRevision,
                    expiresAt: 1_700_000_300,
                    token: 'customer-context-owner-assertion',
                  }
                : Schema.encodeSync(MarketSubjectRestrictionsCurrentResponseSchema)(restrictionsResponse),
            ),
          );
        };
        const captured = { compositionRevision, legalEntityId };
        const reader = makeServerMarketSubjectRestrictionsReader(captured);
        captured.compositionRevision = 'b'.repeat(64);
        captured.legalEntityId = '55555555-5555-4555-8555-555555555555';
        const result = yield* reader
          .current(subject, requestCorrelation)
          .pipe(
            Effect.provideService(FetchHttpClient.Fetch, fakeFetch),
            Effect.provide(ConfigProvider.layer(configuration)),
          );

        expect(result).toMatchObject({
          allowedChannels: ['B2B'],
          allowedSellerIds: [legalEntityId],
          decision: 'ALLOWED',
          ownerRevision: 'counterparty-profile:7',
          profileState: 'ACTIVE',
          subjectIdentityRef: subject.profileRef.resourceId,
          subjectKind: 'COUNTERPARTY',
        });
        expect(DateTime.formatIso(result.observedAt)).toBe('2026-10-01T00:00:00.000Z');
        expect(requests).toHaveLength(2);
        const issuerRequest = yield* Effect.fromNullishOr(requests[0]);
        const ownerRequest = yield* Effect.fromNullishOr(requests[1]);
        expect(issuerRequest.url).toBe('https://shell.example.test/shell-super-app-api/auth/api-key/gateway-context');
        expect(issuerRequest.headers.get('x-api-key')).toBe('market-server-api-key');
        expect(issuerRequest.headers.get('x-correlation-id')).toBe(requestCorrelation);
        expect(yield* Effect.promise(() => issuerRequest.json())).toEqual({
          audience: 'commerce-customer-context',
          compositionRevision,
          legalEntityId,
        });
        expect(ownerRequest.url).toBe(
          'https://shell.example.test/module-api/commerce.customer-context/reads/market-subject-restrictions-current',
        );
        expect(ownerRequest.method).toBe('POST');
        expect(ownerRequest.headers.get('authorization')).toBe('Bearer customer-context-owner-assertion');
        expect(ownerRequest.headers.get('x-api-key')).toBeNull();
        expect(ownerRequest.headers.get('x-ontos-composition-revision')).toBe(compositionRevision);
        expect(ownerRequest.headers.get('x-correlation-id')).toBe(requestCorrelation);
        expect(yield* Effect.promise(() => ownerRequest.json())).toEqual({ subject });
      }),
  );

  it.effect('rejects credentials for a later composition before either owner operation runs', () =>
    Effect.gen(function* rejectMismatchedComposition() {
      const requests: Request[] = [];
      const fakeFetch: typeof fetch = (input, init) => {
        requests.push(new Request(input, init));
        return Promise.resolve(
          Response.json({
            apiBaseUrl: '/module-api/selected-later-owner',
            compositionRevision: 'b'.repeat(64),
            expiresAt: 1_700_000_300,
            token: 'later-composition-assertion',
          }),
        );
      };
      const storefrontFailure = yield* makeServerCurrentStorefrontApplicationAuthority({
        compositionRevision,
        legalEntityId,
      })
        .validateCurrent(storefrontRequest, requestCorrelation)
        .pipe(
          Effect.flip,
          Effect.provideService(FetchHttpClient.Fetch, fakeFetch),
          Effect.provide(ConfigProvider.layer(configuration)),
        );
      const restrictionsFailure = yield* makeServerMarketSubjectRestrictionsReader({
        compositionRevision,
        legalEntityId,
      })
        .current(subject, requestCorrelation)
        .pipe(
          Effect.flip,
          Effect.provideService(FetchHttpClient.Fetch, fakeFetch),
          Effect.provide(ConfigProvider.layer(configuration)),
        );

      expect(Predicate.isTagged(storefrontFailure, 'StorefrontApplicationValidationUnavailable')).toBe(true);
      expect(Predicate.isTagged(restrictionsFailure, 'MarketSubjectRestrictionsUnavailable')).toBe(true);
      expect(requests).toHaveLength(2);
      expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
        '/shell-super-app-api/auth/api-key/gateway-context',
        '/shell-super-app-api/auth/api-key/gateway-context',
      ]);
    }),
  );

  it.effect('rejects a missing captured revision even if the input is later filled before restrictions read', () =>
    Effect.gen(function* rejectMissingComposition() {
      let fetchCount = 0;
      const fakeFetch: typeof fetch = () => {
        fetchCount += 1;
        return Promise.reject(new Error('Missing composition must fail before any HTTP transport'));
      };
      const captured = {
        compositionRevision: Option.getOrUndefined(Option.none<string>()),
        legalEntityId,
      };
      const reader = makeServerMarketSubjectRestrictionsReader(captured);
      captured.compositionRevision = 'b'.repeat(64);
      captured.legalEntityId = '55555555-5555-4555-8555-555555555555';
      const failure = yield* reader
        .current(subject, requestCorrelation)
        .pipe(Effect.flip, Effect.provideService(FetchHttpClient.Fetch, fakeFetch));

      expect(Predicate.isTagged(failure, 'MarketSubjectRestrictionsUnavailable')).toBe(true);
      expect(failure).toHaveProperty(
        'cause',
        'Cross-owner subject restrictions require the original verified composition revision',
      );
      expect(fetchCount).toBe(0);
    }),
  );

  it.effect('rejects a missing captured Legal Entity even if the input is later filled before restrictions read', () =>
    Effect.gen(function* rejectMissingLegalEntity() {
      let fetchCount = 0;
      const fakeFetch: typeof fetch = () => {
        fetchCount += 1;
        return Promise.reject(new Error('Missing Legal Entity must fail before any HTTP transport'));
      };
      const captured = {
        compositionRevision,
        legalEntityId: Option.getOrUndefined(Option.none<string>()),
      };
      const reader = makeServerMarketSubjectRestrictionsReader(captured);
      captured.legalEntityId = legalEntityId;
      const failure = yield* reader
        .current(subject, requestCorrelation)
        .pipe(Effect.flip, Effect.provideService(FetchHttpClient.Fetch, fakeFetch));

      expect(Predicate.isTagged(failure, 'MarketSubjectRestrictionsUnavailable')).toBe(true);
      expect(failure).toHaveProperty(
        'cause',
        'Cross-owner subject restrictions require the original verified Legal Entity',
      );
      expect(fetchCount).toBe(0);
    }),
  );
});
