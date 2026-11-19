import { GatewayDelegatedContextRequestSchema } from '@app/shared-contracts';
import { TrustedPrincipalContextSchema, trustVerifiedGatewayPrincipalContext } from '@app/core-runtime';
import {
  CurrentStorefrontApplicationForbiddenProblemSchema,
  CurrentStorefrontApplicationRequestSchema,
  CurrentStorefrontApplicationResponseSchema,
} from '@app/storefront-registry-contracts';
import { ConfigProvider, Crypto, Effect, Predicate, Redacted, Schema } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { describe, expect, it } from 'effect-rstest';

import { makeServerCurrentStorefrontApplicationAuthority } from '../../src/integrations/current-storefront-application.ts';

const compositionRevision = 'a'.repeat(64);
const tenantId = '11111111-1111-4111-8111-111111111111';
const legalEntityId = '22222222-2222-4222-8222-222222222222';
const requestCorrelation = 'market-server-owner-transport';
const configuration = ConfigProvider.fromUnknown({
  ONTOS_GATEWAY_MODULE_API_KEY: 'market-module-api-key',
  ONTOS_SHELL_GATEWAY_BASE_URL: 'https://shell.example.test/shell-super-app-api',
});
const sourceAssertion = 'verified-original-administrator-source-proof';
const sourceScope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authBindingId: '88888888-8888-4888-8888-888888888888',
    authContextRef: 'better-auth-session:market-administrator',
    authMethod: 'session',
    legalEntityId,
    principalId: '77777777-7777-4777-8777-777777777777',
    tenantId,
  }),
  correlationId: requestCorrelation,
};
const scope = trustVerifiedGatewayPrincipalContext(sourceScope, compositionRevision, {
  assertion: Redacted.make(sourceAssertion),
  audience: 'commerce-market-catalog',
});
let randomSequence = 0;
const crypto = Crypto.make({
  digest: () => Effect.succeed(new Uint8Array()),
  randomBytes: (size) => {
    randomSequence += 1;
    return new Uint8Array(size).fill(randomSequence);
  },
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
describe('Commerce Market server owner transport', () => {
  it.effect('relays the captured original admission and exact revision through generated Storefront HTTP clients', () =>
    Effect.gen(function* storefrontOwnerTransport() {
      const requests: Request[] = [];
      const fakeFetch: typeof fetch = (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        return Promise.resolve(
          Response.json(
            new URL(request.url).pathname.endsWith('/auth/delegated/gateway-context')
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
      const captured = { compositionRevision, crypto, scope };
      const authority = makeServerCurrentStorefrontApplicationAuthority(captured);
      captured.compositionRevision = 'b'.repeat(64);
      captured.scope = trustVerifiedGatewayPrincipalContext(sourceScope, 'b'.repeat(64), {
        assertion: Redacted.make('replacement-source-proof'),
        audience: 'commerce-market-catalog',
      });
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
      expect(issuerRequest.url).toBe('https://shell.example.test/shell-super-app-api/auth/delegated/gateway-context');
      expect(issuerRequest.method).toBe('POST');
      expect(issuerRequest.headers.get('x-api-key')).toBe('market-module-api-key');
      expect(issuerRequest.headers.get('authorization')).toBeNull();
      expect(issuerRequest.headers.get('x-correlation-id')).toBe(requestCorrelation);
      expect(yield* Effect.promise(() => issuerRequest.json())).toEqual({
        audience: 'storefront-registry',
        compositionRevision,
        exchangeId: expect.any(String),
        legalEntityScope: 'subject',
        subject: { _tag: 'Assertion', sourceAssertion },
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

  it.effect('rejects unverified, copied, other-owner and changed-revision source contexts before HTTP', () =>
    Effect.gen(function* rejectUntrustedStorefrontSource() {
      let fetchCount = 0;
      const fakeFetch: typeof fetch = () => {
        fetchCount += 1;
        return Promise.reject(new Error('Untrusted source must never reach transport'));
      };
      const otherOwner = trustVerifiedGatewayPrincipalContext(sourceScope, compositionRevision, {
        assertion: Redacted.make(sourceAssertion),
        audience: 'catalog',
      });
      for (const [candidate, admittedRevision] of [
        [sourceScope, compositionRevision],
        [{ ...scope }, compositionRevision],
        [otherOwner, compositionRevision],
        [scope, 'b'.repeat(64)],
      ] as const) {
        const failure = yield* makeServerCurrentStorefrontApplicationAuthority({
          compositionRevision: admittedRevision,
          crypto,
          scope: candidate,
        })
          .validateCurrent(storefrontRequest, requestCorrelation)
          .pipe(Effect.flip, Effect.provideService(FetchHttpClient.Fetch, fakeFetch));
        expect(Predicate.isTagged(failure, 'StorefrontApplicationValidationUnavailable')).toBe(true);
      }
      expect(fetchCount).toBe(0);
    }),
  );

  it.effect('rejects mismatched trusted Tenant, missing Legal Entity and correlation before HTTP', () =>
    Effect.gen(function* rejectStorefrontScopeSpoof() {
      let fetchCount = 0;
      const fakeFetch: typeof fetch = () => {
        fetchCount += 1;
        return Promise.reject(new Error('Scope mismatch must never reach transport'));
      };
      const noLegalEntity = trustVerifiedGatewayPrincipalContext(
        {
          ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
            authBindingId: sourceScope.authBindingId,
            authContextRef: sourceScope.authContextRef,
            authMethod: 'session',
            principalId: sourceScope.principalId,
            tenantId,
          }),
          correlationId: requestCorrelation,
        },
        compositionRevision,
        { assertion: Redacted.make(sourceAssertion), audience: 'commerce-market-catalog' },
      );
      const crossTenant = Schema.decodeUnknownSync(CurrentStorefrontApplicationRequestSchema)({
        ...storefrontRequest,
        tenantId: '99999999-9999-4999-8999-999999999999',
      });
      for (const [candidate, input, correlation] of [
        [scope, crossTenant, requestCorrelation],
        [noLegalEntity, storefrontRequest, requestCorrelation],
        [scope, storefrontRequest, 'spoofed-correlation'],
      ] as const) {
        const failure = yield* makeServerCurrentStorefrontApplicationAuthority({
          compositionRevision,
          crypto,
          scope: candidate,
        })
          .validateCurrent(input, correlation)
          .pipe(Effect.flip, Effect.provideService(FetchHttpClient.Fetch, fakeFetch));
        expect(Predicate.isTagged(failure, 'StorefrontApplicationValidationUnavailable')).toBe(true);
      }
      expect(fetchCount).toBe(0);
    }),
  );

  it.effect('honors independent receiver denial without retrying under a service Principal', () =>
    Effect.gen(function* denyStorefrontReceiver() {
      const requests: Request[] = [];
      const fakeFetch: typeof fetch = (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        if (new URL(request.url).pathname.endsWith('/auth/delegated/gateway-context')) {
          return Promise.resolve(
            Response.json({
              apiBaseUrl: '/module-api/commerce.storefront-registry',
              compositionRevision,
              expiresAt: 1_700_000_300,
              token: 'original-actor-destination-assertion',
            }),
          );
        }
        return Promise.resolve(
          Response.json(
            Schema.encodeSync(CurrentStorefrontApplicationForbiddenProblemSchema)({
              _tag: 'CurrentStorefrontApplicationForbiddenProblem',
              detail: 'The original actor is denied',
              status: 403,
              title: 'Forbidden',
              type: 'urn:storefront:forbidden',
            }),
            { headers: { 'content-type': 'application/problem+json' }, status: 403 },
          ),
        );
      };
      const failure = yield* makeServerCurrentStorefrontApplicationAuthority({ compositionRevision, crypto, scope })
        .validateCurrent(storefrontRequest, requestCorrelation)
        .pipe(
          Effect.flip,
          Effect.provideService(FetchHttpClient.Fetch, fakeFetch),
          Effect.provide(ConfigProvider.layer(configuration)),
        );
      expect(Predicate.isTagged(failure, 'StorefrontApplicationValidationUnavailable')).toBe(true);
      expect(requests).toHaveLength(2);
      expect(requests[1]?.headers.get('authorization')).toBe('Bearer original-actor-destination-assertion');
      expect(requests[1]?.headers.get('x-api-key')).toBeNull();
    }),
  );

  it.effect(
    'keeps support provenance in the source proof and acquires a fresh exchange for each receiving attempt',
    () =>
      Effect.gen(function* supportRelayAttempts() {
        const proof = 'verified-effective-and-original-support-principal-proof';
        const supportScope = trustVerifiedGatewayPrincipalContext(
          {
            ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
              authBindingId: sourceScope.authBindingId,
              authContextRef: 'better-auth-session:support-market-administration',
              authMethod: 'support_impersonation',
              impersonatedByPrincipalId: '66666666-6666-4666-8666-666666666666',
              legalEntityId,
              principalId: sourceScope.principalId,
              tenantId,
            }),
            correlationId: requestCorrelation,
          },
          compositionRevision,
          { assertion: Redacted.make(proof), audience: 'commerce-market-catalog' },
        );
        const exchanges: Request[] = [];
        const fakeFetch: typeof fetch = (input, init) => {
          const request = new Request(input, init);
          if (new URL(request.url).pathname.endsWith('/auth/delegated/gateway-context')) {
            exchanges.push(request);
            return Promise.resolve(
              Response.json({
                apiBaseUrl: '/module-api/commerce.storefront-registry',
                compositionRevision,
                expiresAt: 1_700_000_300,
                token: 'support-destination-assertion',
              }),
            );
          }
          return Promise.resolve(
            Response.json(Schema.encodeSync(CurrentStorefrontApplicationResponseSchema)(storefrontResponse)),
          );
        };
        const authority = makeServerCurrentStorefrontApplicationAuthority({
          compositionRevision,
          crypto,
          scope: supportScope,
        });
        const attempt = authority
          .validateCurrent(storefrontRequest, requestCorrelation)
          .pipe(
            Effect.provideService(FetchHttpClient.Fetch, fakeFetch),
            Effect.provide(ConfigProvider.layer(configuration)),
          );
        yield* attempt;
        yield* attempt;
        expect(exchanges).toHaveLength(2);
        const bodies: unknown[] = [];
        for (const request of exchanges) {
          bodies.push(yield* Effect.promise(() => request.json()));
        }
        expect(bodies).toEqual([
          {
            audience: 'storefront-registry',
            compositionRevision,
            exchangeId: expect.any(String),
            legalEntityScope: 'subject',
            subject: { _tag: 'Assertion', sourceAssertion: proof },
          },
          {
            audience: 'storefront-registry',
            compositionRevision,
            exchangeId: expect.any(String),
            legalEntityScope: 'subject',
            subject: { _tag: 'Assertion', sourceAssertion: proof },
          },
        ]);
        const identitySchema = GatewayDelegatedContextRequestSchema;
        expect(Schema.decodeUnknownSync(identitySchema)(bodies[0]).exchangeId).not.toBe(
          Schema.decodeUnknownSync(identitySchema)(bodies[1]).exchangeId,
        );
      }),
  );

  it.effect('stops after an expired-source relay refusal without renewal or service-key fallback', () =>
    Effect.gen(function* expiredSourceRefusal() {
      const requests: Request[] = [];
      const fakeFetch: typeof fetch = (input, init) => {
        requests.push(new Request(input, init));
        return Promise.resolve(new Response(null, { status: 401 }));
      };
      const failure = yield* makeServerCurrentStorefrontApplicationAuthority({ compositionRevision, crypto, scope })
        .validateCurrent(storefrontRequest, requestCorrelation)
        .pipe(
          Effect.flip,
          Effect.provideService(FetchHttpClient.Fetch, fakeFetch),
          Effect.provide(ConfigProvider.layer(configuration)),
        );
      expect(Predicate.isTagged(failure, 'StorefrontApplicationValidationUnavailable')).toBe(true);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe('https://shell.example.test/shell-super-app-api/auth/delegated/gateway-context');
    }),
  );

  it.effect('rejects credentials for a later composition before the owner operation runs', () =>
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
        crypto,
        scope,
      })
        .validateCurrent(storefrontRequest, requestCorrelation)
        .pipe(
          Effect.flip,
          Effect.provideService(FetchHttpClient.Fetch, fakeFetch),
          Effect.provide(ConfigProvider.layer(configuration)),
        );

      expect(Predicate.isTagged(storefrontFailure, 'StorefrontApplicationValidationUnavailable')).toBe(true);
      expect(requests).toHaveLength(1);
      expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
        '/shell-super-app-api/auth/delegated/gateway-context',
      ]);
    }),
  );
});
