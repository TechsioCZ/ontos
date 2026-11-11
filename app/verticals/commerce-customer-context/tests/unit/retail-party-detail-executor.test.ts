import type { OperationalScope } from '@app/core-runtime';
import { TrustedPrincipalContextSchema } from '@app/core-runtime/actions/principal-context';
import { trustVerifiedGatewayPrincipalContext } from '@app/core-runtime/auth/system-principal-context-provenance';
import { PartyDetailApi } from '@app/party-registry/api';
import { PartyDetailResponseSchema } from '@app/party-registry/api/client';
import { GatewayContextApi } from '@app/shared-contracts';
import { NodeCrypto } from '@effect/platform-node';
import { HttpApiBuilder, HttpRouter, HttpServer } from '@modern-js/bff-effect/effect-edge';
import { ConfigProvider, Context, Effect, Layer, Redacted, Schema } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { expect, it } from 'effect-rstest';

import {
  RetailPartyDetailExecutor,
  retailPartyDetailExecutorLive,
} from '../../src/integrations/retail-party-detail-executor.ts';
import { ProfilePersistenceDependencyFailure } from '../../src/persistence/profile-persistence.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const legalEntityId = '20000000-0000-4000-8000-000000000002';
const compositionRevision = 'a'.repeat(64);
const correlationId = 'retail-party-delegation';
const sourceAssertion = 'fixture-original-human-source-assertion';
const principal = Schema.decodeSync(TrustedPrincipalContextSchema)({
  authBindingId: '30000000-0000-4000-8000-000000000003',
  authContextRef: 'better-auth-session:original-retail-requester',
  authMethod: 'session',
  legalEntityId,
  principalId: '40000000-0000-4000-8000-000000000004',
  tenantId,
});
const verifiedScope = (audience = 'commerce-customer-context'): OperationalScope =>
  trustVerifiedGatewayPrincipalContext({ ...principal, correlationId }, compositionRevision, {
    assertion: Redacted.make(sourceAssertion),
    audience,
  });
const partyRef = {
  moduleId: 'party.registry',
  resourceId: '50000000-0000-4000-8000-000000000005',
  resourceType: 'party.registry.party',
  tenantId,
} as const;
const payload = { partyRef };
const authorityFor = (scope: OperationalScope) => ({
  actionInvocationId: '60000000-0000-4000-8000-000000000006',
  compositionRevision,
  scope,
});
const partyResponse = Schema.decodeUnknownSync(PartyDetailResponseSchema)({
  currentFactAssertions: [],
  party: {
    archivedAt: null,
    businessName: null,
    createdAt: '2026-09-09T09:00:00.000Z',
    displayName: 'Original Retail requester',
    firstName: 'Retail',
    lastName: 'Requester',
    partyRef,
    partyType: 'PERSON',
    revision: 7,
    updatedAt: '2026-09-09T09:00:00.000Z',
  },
  resolution: { aliasChain: [], canonicalPartyRef: partyRef, kind: 'DIRECT', requestedPartyRef: partyRef },
});

/** Native generated clients and public contracts, with only their HTTP transport supplied in memory. */
const nativeOwnerTransport = (issuedRevision = compositionRevision) =>
  Effect.gen(function* makeNativeOwnerTransport() {
    const exchanges: {
      readonly audience: string;
      readonly compositionRevision: string;
      readonly exchangeId: string;
      readonly legalEntityScope: string;
      readonly sourceAssertion: string | null;
    }[] = [];
    const requests: { readonly headers: Headers; readonly url: string }[] = [];
    const partyCalls: { readonly authorization: string | undefined; readonly partyResourceId: string }[] = [];
    const api = GatewayContextApi.prefix('/shell-super-app-api').addHttpApi(PartyDetailApi.prefix('/party-owner'));
    const gateway = HttpApiBuilder.group(api, 'gatewayContext', (handlers) =>
      handlers
        .handle('issueGatewayContext', () => Effect.die('Retail owner reads must use delegated context'))
        .handle('issueApiKeyGatewayContext', () => Effect.die('Do not replace the requester with a service principal'))
        .handle('readWithApiKeyGatewayContext', () => Effect.die('Retail owner reads require the Party contract'))
        .handle('issueDelegatedGatewayContext', ({ payload: exchange }) => {
          exchanges.push({
            audience: exchange.audience,
            compositionRevision: exchange.compositionRevision,
            exchangeId: exchange.exchangeId,
            legalEntityScope: exchange.legalEntityScope,
            sourceAssertion:
              exchange.subject._tag === 'Assertion' ? Redacted.value(exchange.subject.sourceAssertion) : null,
          });
          return Effect.succeed({
            apiBaseUrl: '/party-owner',
            compositionRevision: issuedRevision,
            expiresAt: 1_800_000_300,
            token: `fresh-party-assertion-${exchanges.length}`,
          });
        }),
    );
    const party = HttpApiBuilder.group(api, 'partyDetail', (handlers) =>
      handlers.handle('execute', ({ payload: selector, request }) => {
        partyCalls.push({
          authorization: request.headers.authorization,
          partyResourceId: selector.partyRef.resourceId,
        });
        return Effect.succeed(partyResponse);
      }),
    );
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        HttpRouter.toWebHandler(
          HttpApiBuilder.layer(api).pipe(
            Layer.provide(Layer.mergeAll(gateway, party)),
            Layer.provide(HttpServer.layerServices),
          ),
          { disableLogger: true },
        ),
      ),
      (web) => Effect.promise(() => web.dispose()),
    );
    const nativeFetch: typeof fetch = (input, init) => {
      const request = new Request(input, init);
      requests.push({ headers: new Headers(request.headers), url: request.url });
      return server.handler(request, Context.empty());
    };
    return {
      exchanges,
      layer: Layer.mergeAll(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            ONTOS_GATEWAY_MODULE_API_KEY: 'fixture-commerce-module-credential',
            ONTOS_SHELL_GATEWAY_BASE_URL: 'https://native-retail-owner.test/shell-super-app-api',
          }),
        ),
        Layer.succeed(FetchHttpClient.Fetch, nativeFetch),
      ),
      partyCalls,
      requests,
    };
  });

it.effect('relays the original verified requester and acquires a fresh Party assertion for every owner read', () =>
  Effect.scoped(
    Effect.gen(function* preservesRequester() {
      const transport = yield* nativeOwnerTransport();
      const executor = yield* RetailPartyDetailExecutor.pipe(Effect.provide(retailPartyDetailExecutorLive));
      const scope = verifiedScope();
      const authority = authorityFor(scope);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        expect(
          yield* executor.execute(payload, correlationId, authority).pipe(Effect.provide(transport.layer)),
        ).toEqual(partyResponse);
      }
      expect(transport.exchanges).toHaveLength(2);
      for (const exchange of transport.exchanges) {
        expect(exchange).toMatchObject({
          audience: 'party-registry',
          compositionRevision,
          legalEntityScope: 'subject',
          sourceAssertion,
        });
      }
      expect(transport.exchanges[0]?.exchangeId).not.toBe(transport.exchanges[1]?.exchangeId);
      expect(transport.partyCalls).toEqual([
        { authorization: 'Bearer fresh-party-assertion-1', partyResourceId: partyRef.resourceId },
        { authorization: 'Bearer fresh-party-assertion-2', partyResourceId: partyRef.resourceId },
      ]);
      expect(transport.requests).toHaveLength(4);
      for (const request of transport.requests) {
        expect(request.headers.get('x-correlation-id')).toBe(correlationId);
        if (request.url.endsWith('/auth/delegated/gateway-context')) {
          expect(request.headers.get('x-api-key')).toBe('fixture-commerce-module-credential');
          expect(request.headers.get('authorization')).toBeNull();
        } else {
          expect(request.url).toBe('https://native-retail-owner.test/party-owner/reads/party-detail');
          expect(request.headers.get('x-api-key')).toBeNull();
        }
      }
    }),
  ).pipe(Effect.provide(NodeCrypto.layer)),
);

it.effect('rejects forged, copied and mismatched Retail authority before any HTTP request', () =>
  Effect.scoped(
    Effect.gen(function* refusesUntrustedAuthority() {
      const transport = yield* nativeOwnerTransport();
      const executor = yield* RetailPartyDetailExecutor.pipe(Effect.provide(retailPartyDetailExecutorLive));
      const scope = verifiedScope();
      const authority = authorityFor(scope);
      const invalid = [
        { authority: authorityFor({ ...principal, correlationId }), correlationId, payload },
        { authority: authorityFor({ ...scope }), correlationId, payload },
        { authority: authorityFor(verifiedScope('catalog')), correlationId, payload },
        { authority: { ...authority, compositionRevision: 'b'.repeat(64) }, correlationId, payload },
        { authority, correlationId: 'another-correlation', payload },
        {
          authority,
          correlationId,
          payload: { partyRef: { ...partyRef, tenantId: '10000000-0000-4000-8000-000000000009' } },
        },
      ];
      for (const candidate of invalid) {
        const failure = yield* executor
          .execute(candidate.payload, candidate.correlationId, candidate.authority)
          .pipe(Effect.provide(transport.layer), Effect.flip);
        expect(Schema.is(ProfilePersistenceDependencyFailure)(failure)).toBe(true);
      }
      expect(transport.requests).toHaveLength(0);
      expect(transport.exchanges).toHaveLength(0);
      expect(transport.partyCalls).toHaveLength(0);
    }),
  ).pipe(Effect.provide(NodeCrypto.layer)),
);

it.effect('does not contact Party when the issuer changes the admitted composition revision', () =>
  Effect.scoped(
    Effect.gen(function* refusesChangedRelease() {
      const transport = yield* nativeOwnerTransport('b'.repeat(64));
      const executor = yield* RetailPartyDetailExecutor.pipe(Effect.provide(retailPartyDetailExecutorLive));
      const failure = yield* executor
        .execute(payload, correlationId, authorityFor(verifiedScope()))
        .pipe(Effect.provide(transport.layer), Effect.flip);
      expect(Schema.is(ProfilePersistenceDependencyFailure)(failure)).toBe(true);
      expect(transport.requests).toHaveLength(1);
      expect(transport.exchanges).toHaveLength(1);
      expect(transport.partyCalls).toHaveLength(0);
    }),
  ).pipe(Effect.provide(NodeCrypto.layer)),
);
