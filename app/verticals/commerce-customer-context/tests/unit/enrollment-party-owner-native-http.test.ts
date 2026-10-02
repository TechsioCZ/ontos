import { SupportedGatewayContextClaimsSchema } from '@app/shared-contracts';
import { ConfigProvider, DateTime, Effect, Encoding, Result, Schema } from 'effect';
import { FetchHttpClient } from 'effect/unstable/http';
import { expect, it } from 'effect-rstest';

import { retailPartyCandidateOwnerEffect } from '../../src/enrollment/journeys/retail-self-enrollment-party-owner.ts';
import type { RetailPartyCandidateOwnerInput } from '../../src/enrollment/journeys/retail-self-enrollment-party-owner.ts';
import { CommerceEnrollmentOwnerTransitionSchema } from '../../src/enrollment/orchestration/owner-transition-driver.ts';
import {
  CommerceEnrollmentOwnerEffectRejected,
  CommerceEnrollmentOwnerEffectUnavailable,
} from '../../src/enrollment/orchestration/owner-transition-errors.ts';

const compositionRevision = 'c'.repeat(64);
const tenantId = '10000000-0000-4000-8000-000000000001';
const legalEntityId = '50000000-0000-4000-8000-000000000001';
const servicePrincipalId = '60000000-0000-4000-8000-000000000001';
const actorPrincipalId = '40000000-0000-4000-8000-000000000001';
const requestCorrelation = 'scheduled-party-owner-native';
const ownerInvocationId = '30000000-0000-4000-8000-000000000001';
const partyRef = { moduleId: 'party.registry', resourceId: 'party-1', resourceType: 'party.registry.party', tenantId };
const decisionRef = {
  moduleId: 'party.registry',
  resourceId: 'decision-1',
  resourceType: 'party.registry.party-match-decision',
  tenantId,
};
const input: RetailPartyCandidateOwnerInput = {
  candidate: {
    evidenceRefs: [],
    officialIdentifiers: [],
    partyType: 'PERSON',
    provenance: { method: 'RETAIL_SELF_ENROLLMENT', source: 'commerce.customer-context' },
    validFrom: DateTime.makeUnsafe('2026-09-19T10:00:00.000Z'),
  },
  compositionRevision,
  legalEntityId,
  requestCorrelation,
  tenantId,
};
const transition = Schema.decodeSync(CommerceEnrollmentOwnerTransitionSchema)({
  actorPrincipalId,
  compositionRevision,
  correlationId: requestCorrelation,
  expectedRevision: 1,
  ownerInvocationId,
  ownerModuleKey: 'party.registry',
  portalEnrollmentAttemptId: '20000000-0000-4000-8000-000000000001',
  requestDigest: 'a'.repeat(64),
  tenantId,
  transitionKey: 'party.candidate.submit',
});
const configuration = ConfigProvider.layer(
  ConfigProvider.fromUnknown({
    ONTOS_COMMERCE_CUSTOMER_CONTEXT_GATEWAY_API_KEY: 'scheduled-service-api-key',
    ONTOS_SHELL_GATEWAY_BASE_URL: 'https://shell.example.test/shell-super-app-api',
  }),
);
const tokenFor = (claimsTenantId = tenantId, claimsRevision = compositionRevision, tokenId = 1) => {
  const claims = {
    aud: 'party-registry',
    compositionRevision: claimsRevision,
    exp: 1_700_000_300,
    iat: 1_700_000_000,
    iss: 'https://shell.example.test',
    jti: `70000000-0000-4000-8000-${String(tokenId).padStart(12, '0')}`,
    principal: {
      authBindingId: '80000000-0000-4000-8000-000000000001',
      authContextRef: 'key:scheduled-service',
      authMethod: 'api_key',
      legalEntityId,
      principalId: servicePrincipalId,
      tenantId: claimsTenantId,
    },
    sub: servicePrincipalId,
    targetBuildMarker: 'party-release-1',
    ver: 1,
  };
  return `${Encoding.encodeBase64Url('{}')}.${Encoding.encodeBase64Url(JSON.stringify(claims))}.test-signature`;
};
const gatewayResponse = (claimsTenantId = tenantId, tokenId = 1) => ({
  apiBaseUrl: '/api/approved/party-registry',
  compositionRevision,
  expiresAt: 1_700_000_300,
  token: tokenFor(claimsTenantId, compositionRevision, tokenId),
});

it.effect('scheduled dispatch uses native issuance and selected-release Party HTTP without a Document', () =>
  Effect.gen(function* nativeScheduledDispatch() {
    expect(globalThis.document).toBeUndefined();
    const requests: Request[] = [];
    const responses = [
      gatewayResponse(),
      { candidateParties: [], evidenceExplanation: [], matchRuleVersion: '1', outcome: 'NO_MATCH' },
      gatewayResponse(tenantId, 2),
      { decisionRef, outcome: 'CREATED', partyRef },
    ];
    const fakeFetch: typeof fetch = (target, init) => {
      requests.push(new Request(target, init));
      return Promise.resolve(Response.json(responses.shift()));
    };
    const outcome = yield* retailPartyCandidateOwnerEffect(input)
      .dispatch(transition)
      .pipe(Effect.provideService(FetchHttpClient.Fetch, fakeFetch), Effect.provide(configuration));
    expect(outcome.status).toBe('SUCCEEDED');
    expect(requests.map((request) => request.url)).toEqual([
      'https://shell.example.test/shell-super-app-api/auth/api-key/gateway-context',
      'https://shell.example.test/api/approved/party-registry/reads/party-match',
      'https://shell.example.test/shell-super-app-api/auth/api-key/gateway-context',
      'https://shell.example.test/api/approved/party-registry/party-registry/actions/create-party',
    ]);
    for (const request of [requests[0], requests[2]]) {
      expect(request?.headers.get('x-api-key')).toBe('scheduled-service-api-key');
      expect(yield* Effect.promise(() => request.json())).toEqual({
        audience: 'party-registry',
        compositionRevision,
        legalEntityId,
      });
    }
    expect(requests[1]?.headers.get('authorization')).toBe(`Bearer ${tokenFor(tenantId, compositionRevision, 1)}`);
    expect(requests[3]?.headers.get('authorization')).toBe(`Bearer ${tokenFor(tenantId, compositionRevision, 2)}`);
    for (const request of [requests[1], requests[3]]) {
      expect(request?.headers.get('x-ontos-composition-revision')).toBe(compositionRevision);
      expect(request?.headers.get('x-correlation-id')).toBe(requestCorrelation);
    }
    expect(requests[3]?.headers.get('idempotency-key')).toBe(ownerInvocationId);
  }),
);

it.effect('a stale original Attempt is denied by issuance before contacting Party', () =>
  Effect.gen(function* staleAttempt() {
    const requests: Request[] = [];
    const fakeFetch: typeof fetch = (target, init) => {
      requests.push(new Request(target, init));
      return Promise.resolve(
        Response.json(
          {
            detail: 'Original release expired',
            reloadRequired: true,
            status: 409,
            title: 'Reload required',
            type: 'https://ontos.dev/problems/gateway-reload-required',
          },
          { status: 409 },
        ),
      );
    };
    const failure = yield* retailPartyCandidateOwnerEffect(input)
      .dispatch(transition)
      .pipe(Effect.provideService(FetchHttpClient.Fetch, fakeFetch), Effect.provide(configuration), Effect.flip);
    expect(Schema.is(CommerceEnrollmentOwnerEffectUnavailable)(failure)).toBe(true);
    expect(requests).toHaveLength(1);
    expect(yield* Effect.promise(() => requests[0].json())).toEqual({
      audience: 'party-registry',
      compositionRevision,
      legalEntityId,
    });
  }),
);

it.effect('a mismatched issuer Tenant fails before any Party match or create', () =>
  Effect.gen(function* wrongIssuerTenant() {
    const requests: Request[] = [];
    const fakeFetch: typeof fetch = (target, init) => {
      requests.push(new Request(target, init));
      return Promise.resolve(Response.json(gatewayResponse('90000000-0000-4000-8000-000000000001')));
    };
    const failure = yield* retailPartyCandidateOwnerEffect(input)
      .dispatch(transition)
      .pipe(Effect.provideService(FetchHttpClient.Fetch, fakeFetch), Effect.provide(configuration), Effect.flip);
    expect(Schema.is(CommerceEnrollmentOwnerEffectUnavailable)(failure)).toBe(true);
    expect(failure.reason).toContain('match operation is unavailable');
    expect(requests).toHaveLength(1);
  }),
);

it.effect('keeps the original Attempt revision and scope when a caller later mutates its input object', () =>
  Effect.gen(function* immutableAttemptTransport() {
    const mutableInput = { ...input };
    const owner = retailPartyCandidateOwnerEffect(mutableInput);
    Object.assign(mutableInput, {
      compositionRevision: 'd'.repeat(64),
      legalEntityId: '90000000-0000-4000-8000-000000000001',
      requestCorrelation: 'changed-correlation',
      tenantId: '90000000-0000-4000-8000-000000000001',
    });
    const requests: Request[] = [];
    const fakeFetch: typeof fetch = (target, init) => {
      const request = new Request(target, init);
      requests.push(request);
      return Promise.resolve(
        Response.json(
          requests.length === 1
            ? gatewayResponse()
            : {
                candidateParties: [partyRef],
                evidenceExplanation: [],
                matchRuleVersion: '1',
                outcome: 'MATCHED',
              },
        ),
      );
    };
    const outcome = yield* owner
      .dispatch(transition)
      .pipe(Effect.provideService(FetchHttpClient.Fetch, fakeFetch), Effect.provide(configuration));
    expect(outcome.resultReference).toBe(partyRef.resourceId);
    expect(yield* Effect.promise(() => requests[0].json())).toEqual({
      audience: 'party-registry',
      compositionRevision,
      legalEntityId,
    });
    expect(requests[1]?.headers.get('x-ontos-composition-revision')).toBe(compositionRevision);
    expect(requests[1]?.headers.get('x-correlation-id')).toBe(requestCorrelation);
  }),
);

it.effect('scheduled reconciliation reads the original invocation through native selected-release recovery', () =>
  Effect.gen(function* nativeScheduledRecovery() {
    expect(globalThis.document).toBeUndefined();
    const requests: Request[] = [];
    const fakeFetch: typeof fetch = (target, init) => {
      requests.push(new Request(target, init));
      return Promise.resolve(
        Response.json(
          requests.length === 1
            ? gatewayResponse()
            : {
                _tag: 'PartyCommandCommitResolution',
                invocationId: ownerInvocationId,
                retryCommand: false,
                state: 'OPEN',
              },
        ),
      );
    };
    const failure = yield* retailPartyCandidateOwnerEffect(input)
      .reconcile({
        ...transition,
        observedRevision: 2,
        ownerOperationRevision: 1,
      })
      .pipe(Effect.provideService(FetchHttpClient.Fetch, fakeFetch), Effect.provide(configuration), Effect.flip);
    expect(Schema.is(CommerceEnrollmentOwnerEffectRejected)(failure)).toBe(true);
    expect(requests).toHaveLength(2);
    expect(requests[1]?.url).toBe(
      'https://shell.example.test/api/approved/party-registry/party-registry/action-commits/resolve',
    );
    expect(requests[1]?.headers.get('x-ontos-composition-revision')).toBe(compositionRevision);
    expect(requests[1]?.headers.get('x-correlation-id')).toBe(requestCorrelation);
    expect(yield* Effect.promise(() => requests[1].json())).toEqual({ invocationId: ownerInvocationId });
  }),
);

it.effect('committed native recovery acquires distinct one-use assertions for commit and decision reads', () =>
  Effect.gen(function* singleUseGatewayRecovery() {
    expect(globalThis.document).toBeUndefined();
    const requests: Request[] = [];
    const consumed = new Set<string>();
    let issued = 0;
    const fakeFetch: typeof fetch = (target, init) => {
      const request = new Request(target, init);
      requests.push(request);
      if (request.url.endsWith('/auth/api-key/gateway-context')) {
        issued += 1;
        return Promise.resolve(Response.json(gatewayResponse(tenantId, issued)));
      }
      const credential = request.headers.get('authorization') ?? '';
      const [, tokenPayload] = credential.slice('Bearer '.length).split('.');
      const claims = Schema.decodeSync(Schema.fromJsonString(SupportedGatewayContextClaimsSchema))(
        Result.getOrThrow(Encoding.decodeBase64UrlString(tokenPayload)),
      );
      if (consumed.has(claims.jti)) {
        return Promise.resolve(
          Response.json(
            {
              detail: 'Assertion already redeemed',
              status: 401,
              title: 'Unauthorized',
              type: 'https://ontos.dev/problems/authentication-required',
            },
            { status: 401 },
          ),
        );
      }
      consumed.add(claims.jti);
      return Promise.resolve(
        Response.json(
          request.url.endsWith('/action-commits/resolve')
            ? {
                _tag: 'PartyCommandCommitResolution',
                invocationId: ownerInvocationId,
                retryCommand: false,
                state: 'COMMITTED',
              }
            : {
                caseRef: null,
                committedCreateOutcome: 'CREATED',
                decidedAt: '2026-09-19T10:00:00.000Z',
                decisionRef,
                evidenceEvaluation: null,
                evidenceExplanation: [],
                matchRuleVersion: '1',
                operation: 'CREATE',
                outcome: 'CREATED',
                partyRef,
              },
        ),
      );
    };
    const resolution = yield* retailPartyCandidateOwnerEffect(input)
      .reconcile({
        ...transition,
        observedRevision: 2,
        ownerOperationRevision: 1,
      })
      .pipe(Effect.provideService(FetchHttpClient.Fetch, fakeFetch), Effect.provide(configuration));
    expect(resolution.status).toBe('SUCCEEDED');
    expect(resolution.resultReference).toBe(partyRef.resourceId);
    expect(issued).toBe(2);
    expect(consumed.size).toBe(2);
    expect([...consumed]).toEqual(['70000000-0000-4000-8000-000000000001', '70000000-0000-4000-8000-000000000002']);
    expect(requests).toHaveLength(4);
    expect(requests[1]?.headers.get('authorization')).toBe(`Bearer ${tokenFor(tenantId, compositionRevision, 1)}`);
    expect(requests[3]?.headers.get('authorization')).toBe(`Bearer ${tokenFor(tenantId, compositionRevision, 2)}`);
    for (const request of [requests[1], requests[3]]) {
      expect(request?.headers.get('x-ontos-composition-revision')).toBe(compositionRevision);
      expect(request?.url.startsWith('https://shell.example.test/api/approved/party-registry/')).toBe(true);
    }
  }),
);
