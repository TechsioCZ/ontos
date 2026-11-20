import {
  RetailEnrollmentEvidenceSchema,
  EnrollRetailCustomerPayloadSchema,
  OwnedRetailPartyResultRequestSchema,
} from '@app/party-registry/api';
import type { PartyRef } from '@app/party-registry/resources/party';
import { GatewayContextV3ClaimsSchema } from '@app/shared-contracts';
import { ConfigProvider, Crypto, DateTime, Effect, Exit, Layer, Match, Result, Schema, Struct } from 'effect';
import { Base64Url } from 'effect/encoding';
import { FetchHttpClient } from 'effect/http';
import { expect, it } from 'effect-rstest';

import { holdTestModuleCredentials } from '../../../../packages/core-runtime/tests/support/module-credentials.ts';
import { retailCustomerDirectoryOwnerEffect } from '../../src/enrollment/journeys/retail-self-enrollment-customer-owner.ts';
import {
  acquireRetailEnrollmentPartyGateway,
  retailPartyCandidateOwnerEffect,
} from '../../src/enrollment/journeys/retail-self-enrollment-party-owner.ts';
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
const crypto = Crypto.make({
  digest: () => Effect.succeed(new Uint8Array()),
  randomBytes: (size) => new Uint8Array(size).fill(1),
});
const originator = { actionInvocationId: '91000000-0000-4000-8000-000000000001', compositionRevision, tenantId };
const delegationPayload = {
  audience: 'party-registry',
  compositionRevision,
  exchangeId: '01010101-0101-4101-8101-010101010101',
  legalEntityScope: 'subject',
  subject: { _tag: 'Originator', actionInvocationId: originator.actionInvocationId, legalEntityId, tenantId },
};
const enrollmentEvidence = Schema.decodeUnknownSync(RetailEnrollmentEvidenceSchema)({
  authenticationNamespaceId: 'ontos.commerce.portal.better-auth.v1',
  candidateEvidenceRef: '10000000-0000-4000-8000-000000000001',
  emailOwnership: 'VERIFIED',
  enrollmentAttemptId: '20000000-0000-4000-8000-000000000001',
  journey: 'RETAIL_SELF_ENROLLMENT',
  providerOwnerInvocationId: ownerInvocationId,
  providerSubjectId: 'provider-subject',
  sellingLegalEntityId: legalEntityId,
  tenantId,
});
const input: RetailPartyCandidateOwnerInput & {
  readonly verifiedEvidence: Effect.Effect<typeof RetailEnrollmentEvidenceSchema.Type>;
} = {
  candidate: {
    evidenceRefs: [],
    officialIdentifiers: [],
    partyType: 'PERSON',
    provenance: { method: 'RETAIL_SELF_ENROLLMENT', source: 'commerce.customer-context' },
    validFrom: DateTime.makeUnsafe('2026-09-19T10:00:00.000Z'),
  },
  compositionRevision,
  crypto,
  legalEntityId,
  originator,
  requestCorrelation,
  subject: Struct.omit(enrollmentEvidence, ['emailOwnership']),
  tenantId,
  verifiedEvidence: Effect.succeed(enrollmentEvidence),
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
const configuration = Layer.merge(
  ConfigProvider.layer(
    ConfigProvider.fromUnknown({ ONTOS_SHELL_GATEWAY_BASE_URL: 'https://shell.example.test/shell-super-app-api' }),
  ),
  Layer.effectDiscard(holdTestModuleCredentials({ 'commerce-customer-context': 'reviewed-ccc-module-key' })),
);
const tokenFor = (claimsTenantId = tenantId, claimsRevision = compositionRevision, tokenId = 1) => {
  const claims = {
    act: { appId: 'commerce-customer-context', buildMarker: 'ccc-release', principalId: servicePrincipalId },
    aud: 'party-registry',
    compositionRevision: claimsRevision,
    exp: 1_700_000_300,
    iat: 1_700_000_000,
    iss: 'https://shell.example.test',
    jti: `70000000-0000-4000-8000-${String(tokenId).padStart(12, '0')}`,
    principal: {
      authBindingId: '80000000-0000-4000-8000-000000000001',
      authContextRef: 'key:original-storefront',
      authenticationNamespaceId: 'ontos.staff.better-auth.v1',
      authMethod: 'api_key',
      legalEntityId,
      principalId: actorPrincipalId,
      tenantId: claimsTenantId,
    },
    sub: actorPrincipalId,
    targetBuildMarker: 'party-release-1',
    ver: 3,
  };
  return `${Base64Url.encode('{}')}.${Base64Url.encode(JSON.stringify(claims))}.test-signature`;
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
    const responses = [gatewayResponse(), { decisionRef, outcome: 'CREATED', partyRef }];
    const fakeFetch: typeof fetch = (target, init) => {
      requests.push(new Request(target, init));
      return Promise.resolve(Response.json(responses.shift()));
    };
    const outcome = yield* retailPartyCandidateOwnerEffect(input)
      .dispatch(transition)
      .pipe(Effect.provideService(FetchHttpClient.Fetch, fakeFetch), Effect.provide(configuration));
    expect(outcome.status).toBe('SUCCEEDED');
    expect(requests.map((request) => request.url)).toEqual([
      'https://shell.example.test/shell-super-app-api/auth/delegated/gateway-context',
      'https://shell.example.test/api/approved/party-registry/party-registry/actions/create-party',
    ]);
    for (const request of [requests[0]]) {
      expect(request?.headers.get('x-api-key')).toBe('reviewed-ccc-module-key');
      expect(yield* Effect.promise(() => request.json())).toEqual(delegationPayload);
    }
    expect(requests[1]?.headers.get('authorization')).toBe(`Bearer ${tokenFor(tenantId, compositionRevision, 1)}`);
    for (const request of [requests[1]]) {
      expect(request?.headers.get('x-ontos-composition-revision')).toBe(compositionRevision);
      expect(request?.headers.get('x-correlation-id')).toBe(requestCorrelation);
    }
    expect(requests[1]?.headers.get('idempotency-key')).toBe(ownerInvocationId);
  }),
);

it.effect('an originator from another Tenant fails closed before issuance', () =>
  Effect.gen(function* unconfiguredTenant() {
    const requests: Request[] = [];
    const fakeFetch: typeof fetch = (target, init) => {
      requests.push(new Request(target, init));
      return Promise.resolve(Response.json(gatewayResponse()));
    };
    const failure = yield* acquireRetailEnrollmentPartyGateway({
      compositionRevision,
      crypto,
      legalEntityId,
      originator,
      requestCorrelation,
      tenantId: '90000000-0000-4000-8000-000000000001',
    }).pipe(Effect.provideService(FetchHttpClient.Fetch, fakeFetch), Effect.provide(configuration), Effect.flip);
    expect(Schema.is(CommerceEnrollmentOwnerEffectUnavailable)(failure)).toBe(true);
    expect(failure.reason).toBe('The enrollment originator does not match the immutable Attempt scope');
    expect(requests).toHaveLength(0);
  }),
);

for (const mode of ['principal-only', 'wrong-actor', 'wrong-company', 'wrong-release'] as const) {
  it.effect(`rejects ${mode} issuer authority before contacting Party`, () =>
    Effect.gen(function* refusedIssuer() {
      const claims = Schema.decodeSync(Schema.fromJsonString(GatewayContextV3ClaimsSchema))(
        Result.getOrThrow(Base64Url.decodeString(tokenFor().split('.')[1])),
      );
      const changed = Match.value(mode).pipe(
        Match.when('principal-only', () => ({ ...Struct.omit(claims, ['act']), ver: 1 })),
        Match.when('wrong-actor', () => ({ ...claims, act: { ...claims.act, appId: 'pricing' } })),
        Match.when('wrong-company', () => ({
          ...claims,
          principal: { ...claims.principal, legalEntityId: '90000000-0000-4000-8000-000000000001' },
        })),
        Match.when('wrong-release', () => ({ ...claims, compositionRevision: 'd'.repeat(64) })),
        Match.exhaustive,
      );
      const requests: Request[] = [];
      const fakeFetch: typeof fetch = (target, init) => {
        requests.push(new Request(target, init));
        return Promise.resolve(
          Response.json({
            ...gatewayResponse(),
            token: `${Base64Url.encode('{}')}.${Base64Url.encode(JSON.stringify(changed))}.test-signature`,
          }),
        );
      };
      const failure = yield* retailPartyCandidateOwnerEffect(input)
        .dispatch(transition)
        .pipe(Effect.provideService(FetchHttpClient.Fetch, fakeFetch), Effect.provide(configuration), Effect.flip);
      expect(Schema.is(CommerceEnrollmentOwnerEffectUnavailable)(failure)).toBe(true);
      expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
        '/shell-super-app-api/auth/delegated/gateway-context',
      ]);
    }),
  );
}

it.effect('a refused module credential never falls back to a Tenant API key or contacts Party', () =>
  Effect.gen(function* refusedModule() {
    const requests: Request[] = [];
    const fakeFetch: typeof fetch = (target, init) => {
      requests.push(new Request(target, init));
      return Promise.resolve(
        Response.json(
          {
            detail: 'Module credential refused',
            status: 403,
            title: 'Forbidden',
            type: 'https://ontos.dev/problems/gateway-forbidden',
          },
          { status: 403 },
        ),
      );
    };
    const failure = yield* acquireRetailEnrollmentPartyGateway(input).pipe(
      Effect.provideService(FetchHttpClient.Fetch, fakeFetch),
      Effect.provide(
        Layer.merge(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              COMMERCE_TENANT_CREDENTIALS: JSON.stringify({
                [tenantId]: { coreIdentityApiKey: 'must-not-be-used', gatewayApiKey: 'must-not-be-used' },
              }),
              ONTOS_SHELL_GATEWAY_BASE_URL: 'https://shell.example.test/shell-super-app-api',
            }),
          ),
          Layer.effectDiscard(holdTestModuleCredentials({ 'commerce-customer-context': 'refused-module-key' })),
        ),
      ),
      Effect.flip,
    );
    expect(failure.reason).toBe('The Party Registry delegated owner credential is unavailable');
    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers.get('x-api-key')).toBe('refused-module-key');
    expect(new URL(requests[0].url).pathname).toBe('/shell-super-app-api/auth/delegated/gateway-context');
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
    expect(yield* Effect.promise(() => requests[0].json())).toEqual(delegationPayload);
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
    expect(failure.reason).toContain('create operation is unavailable');
    expect(requests).toHaveLength(1);
  }),
);

it.effect('keeps the original Attempt revision and scope when a caller later mutates its input object', () =>
  Effect.gen(function* immutableAttemptTransport() {
    const mutableInput = { ...input, originator: { ...input.originator } };
    const owner = retailPartyCandidateOwnerEffect(mutableInput);
    Object.assign(mutableInput, {
      compositionRevision: 'd'.repeat(64),
      legalEntityId: '90000000-0000-4000-8000-000000000001',
      requestCorrelation: 'changed-correlation',
      tenantId: '90000000-0000-4000-8000-000000000001',
    });
    Object.assign(mutableInput.originator, {
      actionInvocationId: '92000000-0000-4000-8000-000000000001',
      compositionRevision: 'd'.repeat(64),
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
                decisionRef,
                outcome: 'MATCHED_EXISTING',
                partyRef,
              },
        ),
      );
    };
    const outcome = yield* owner
      .dispatch(transition)
      .pipe(Effect.provideService(FetchHttpClient.Fetch, fakeFetch), Effect.provide(configuration));
    expect(outcome.resultReference).toBe(partyRef.resourceId);
    expect(yield* Effect.promise(() => requests[0].json())).toEqual(delegationPayload);
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
                state: 'RUNNING',
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
    expect(Schema.is(CommerceEnrollmentOwnerEffectUnavailable)(failure)).toBe(true);
    expect(requests).toHaveLength(2);
    expect(requests[1]?.url).toBe(
      'https://shell.example.test/api/approved/party-registry/reads/owned-retail-party-result',
    );
    expect(requests[1]?.headers.get('x-ontos-composition-revision')).toBe(compositionRevision);
    expect(requests[1]?.headers.get('x-correlation-id')).toBe(requestCorrelation);
    expect(yield* Effect.promise(() => requests[1].json())).toEqual({
      evidence: input.subject,
      idempotencyKey: ownerInvocationId,
    });
  }),
);

it.effect('committed native recovery uses one owned-result assertion without reviewer reads', () =>
  Effect.gen(function* singleUseGatewayRecovery() {
    expect(globalThis.document).toBeUndefined();
    const requests: Request[] = [];
    const consumed = new Set<string>();
    let issued = 0;
    const fakeFetch: typeof fetch = (target, init) => {
      const request = new Request(target, init);
      requests.push(request);
      if (request.url.endsWith('/auth/delegated/gateway-context')) {
        issued += 1;
        return Promise.resolve(Response.json(gatewayResponse(tenantId, issued)));
      }
      const credential = request.headers.get('authorization') ?? '';
      const [, tokenPayload] = credential.slice('Bearer '.length).split('.');
      const claims = Schema.decodeSync(Schema.fromJsonString(GatewayContextV3ClaimsSchema))(
        Result.getOrThrow(Base64Url.decodeString(tokenPayload)),
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
          request.url.endsWith('/reads/owned-retail-party-result')
            ? {
                _tag: 'PartyCommandCommitResolution',
                createResult: { decisionRef, outcome: 'CREATED', partyRef },
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
    expect(issued).toBe(1);
    expect(consumed.size).toBe(1);
    expect([...consumed]).toEqual(['70000000-0000-4000-8000-000000000001']);
    expect(requests).toHaveLength(2);
    expect(requests[1]?.headers.get('authorization')).toBe(`Bearer ${tokenFor(tenantId, compositionRevision, 1)}`);
    for (const request of [requests[1]]) {
      expect(request?.headers.get('x-ontos-composition-revision')).toBe(compositionRevision);
      expect(request?.url.startsWith('https://shell.example.test/api/approved/party-registry/')).toBe(true);
    }
  }),
);

it.effect('recovers the committed original Party using its durable subject without current email verification', () =>
  Effect.gen(function* readOnlyOriginalRecovery() {
    const requests: Request[] = [];
    const fakeFetch: typeof fetch = (target, init) => {
      const request = new Request(target, init);
      requests.push(request);
      return Promise.resolve(
        Response.json(
          request.url.endsWith('/auth/delegated/gateway-context')
            ? gatewayResponse()
            : {
                _tag: 'PartyCommandCommitResolution',
                createResult: { decisionRef, outcome: 'CREATED', partyRef },
                invocationId: ownerInvocationId,
                retryCommand: false,
                state: 'COMMITTED',
              },
        ),
      );
    };
    const mutable = {
      ...input,
      subject: { ...input.subject },
      verifiedEvidence: Effect.die('Read-only recovery must not ask for current provider email verification'),
    };
    const owner = retailPartyCandidateOwnerEffect(mutable);
    Object.assign(mutable.subject, {
      providerSubjectId: 'changed-subject',
      tenantId: '95000000-0000-4000-8000-000000000001',
    });
    const exit = yield* owner
      .reconcile({ ...transition, observedRevision: 2, ownerOperationRevision: 1 })
      .pipe(Effect.provideService(FetchHttpClient.Fetch, fakeFetch), Effect.provide(configuration), Effect.exit);
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value).toMatchObject({ resultReference: partyRef.resourceId, status: 'SUCCEEDED' });
    }
    expect(requests).toHaveLength(2);
    expect(yield* Effect.promise(() => requests[1].json())).toEqual({
      evidence: input.subject,
      idempotencyKey: ownerInvocationId,
    });
    expect(requests.some((request) => request.url.includes('/actions/'))).toBe(false);
  }),
);

it.effect('still refuses a new Party dispatch when current provider verification is unavailable', () =>
  Effect.gen(function* freshWriteRequiresVerification() {
    const requests: Request[] = [];
    const fakeFetch: typeof fetch = (target, init) => {
      requests.push(new Request(target, init));
      return Promise.resolve(Response.json(gatewayResponse()));
    };
    const failure = yield* retailPartyCandidateOwnerEffect({
      ...input,
      verifiedEvidence: Effect.fail(
        new CommerceEnrollmentOwnerEffectUnavailable({
          code: 'verification_unavailable',
          reason: 'Current provider email verification is unavailable',
        }),
      ),
    })
      .dispatch(transition)
      .pipe(Effect.provideService(FetchHttpClient.Fetch, fakeFetch), Effect.provide(configuration), Effect.flip);
    expect(Schema.is(CommerceEnrollmentOwnerEffectUnavailable)(failure)).toBe(true);
    expect(failure.code).toBe('verification_unavailable');
    expect(requests).toEqual([]);
  }),
);

const originalNativeInvocationId = '93000000-0000-4000-8000-000000000001';
const customerDirectoryInput = {
  compositionRevision,
  crypto,
  legalEntityId,
  originalPartyOwnerInvocationId: ownerInvocationId,
  originator,
  partyRef: {
    ...partyRef,
    moduleId: 'party.registry',
    resourceId: '90000000-0000-4000-8000-000000000001',
    resourceType: 'party.registry.party',
  } as const,
  registration: { displayName: 'Skutečný Zákazník', email: 'customer@example.test', phone: '+420 777 123 456' },
  requestCorrelation,
  subject: input.subject,
  tenantId,
  verifiedEvidence: input.verifiedEvidence,
};

interface CustomerTransportInput {
  readonly commandProblem?: {
    readonly body: Readonly<Record<string, string | number | boolean>>;
    readonly status: number;
  };
  readonly commandResult?: unknown;
  readonly failCommand?: boolean;
  readonly original?: 'RUNNING' | 'AMBIGUOUS' | 'WRONG_PARTY' | 'WRONG_TENANT' | 'MISSING_RESULT';
  readonly state?: 'ABSENT' | 'RUNNING' | 'COMMITTED' | 'REJECTED';
}

const customerDirectoryTransport = (options: CustomerTransportInput = {}) => {
  const requests: Request[] = [];
  const commands: (typeof EnrollRetailCustomerPayloadSchema.Type)[] = [];
  const proofs: (typeof OwnedRetailPartyResultRequestSchema.Type)[] = [];
  const consumed = new Set<string>();
  let issued = 0;
  const fakeFetch: typeof fetch = (target, init) => {
    const request = new Request(target, init);
    requests.push(request);
    if (request.url.endsWith('/auth/delegated/gateway-context')) {
      issued += 1;
      return Promise.resolve(Response.json(gatewayResponse(tenantId, issued)));
    }
    const credential = request.headers.get('authorization') ?? '';
    if (consumed.has(credential)) {
      return Promise.resolve(
        Response.json(
          {
            status: 401,
            title: 'Assertion already redeemed',
            type: 'https://ontos.dev/problems/authentication-required',
          },
          { status: 401 },
        ),
      );
    }
    consumed.add(credential);
    if (request.url.endsWith('/reads/owned-retail-party-result')) {
      return request
        .clone()
        .json()
        .then(Schema.decodeUnknownSync(OwnedRetailPartyResultRequestSchema))
        .then((proof) => {
          proofs.push(proof);
          if (options.original === 'RUNNING') {
            return Response.json({
              _tag: 'PartyCommandCommitResolution',
              invocationId: originalNativeInvocationId,
              retryCommand: false,
              state: 'RUNNING',
            });
          }
          let retainedParty: PartyRef = customerDirectoryInput.partyRef;
          if (options.original === 'WRONG_PARTY') {
            retainedParty = { ...customerDirectoryInput.partyRef, resourceId: '94000000-0000-4000-8000-000000000001' };
          } else if (options.original === 'WRONG_TENANT') {
            retainedParty = { ...customerDirectoryInput.partyRef, tenantId: '95000000-0000-4000-8000-000000000001' };
          }
          const createResult =
            options.original === 'AMBIGUOUS'
              ? {
                  caseRef: {
                    ...decisionRef,
                    resourceId: '96000000-0000-4000-8000-000000000001',
                    resourceType: 'party.registry.duplicate-candidate-case',
                  },
                  decisionRef,
                  outcome: 'AMBIGUOUS',
                }
              : { decisionRef, outcome: 'CREATED', partyRef: retainedParty };
          const resolution = {
            _tag: 'PartyCommandCommitResolution',
            invocationId: originalNativeInvocationId,
            retryCommand: false,
            state: 'COMMITTED',
          };
          if (options.original === 'MISSING_RESULT') {
            return Response.json(resolution);
          }
          return Response.json({ ...resolution, createResult });
        });
    }
    if (request.url.endsWith('/action-commits/resolve')) {
      return Promise.resolve(
        options.state === undefined || options.state === 'ABSENT'
          ? Response.json({ _tag: 'PartyCommandCommitResolution', retryCommand: true, state: 'NOT_STARTED' })
          : Response.json({
              _tag: 'PartyCommandCommitResolution',
              invocationId: '99000000-0000-4000-8000-000000000001',
              retryCommand: false,
              state: options.state,
            }),
      );
    }
    if (!request.url.endsWith('/actions/enroll-retail-customer')) {
      return Promise.reject(new Error('Unexpected generic Party transport'));
    }
    return request
      .clone()
      .json()
      .then(Schema.decodeUnknownSync(EnrollRetailCustomerPayloadSchema))
      .then((payload) => {
        commands.push(payload);
        if (options.failCommand === true) {
          throw new Error('Acknowledgement lost');
        }
        if (options.commandProblem !== undefined) {
          return Response.json(options.commandProblem.body, { status: options.commandProblem.status });
        }
        return Response.json(options.commandResult ?? { partyRef: customerDirectoryInput.partyRef });
      });
  };
  return { commands, consumed, fakeFetch, issued: () => issued, proofs, requests };
};

it.effect('enrolls a scoped CUSTOMER with real email and phone through one independently keyed finite command', () =>
  Effect.gen(function* customerDirectoryCommands() {
    const transport = customerDirectoryTransport();
    const result = yield* retailCustomerDirectoryOwnerEffect(customerDirectoryInput)
      .dispatch(transition)
      .pipe(Effect.provideService(FetchHttpClient.Fetch, transport.fakeFetch), Effect.provide(configuration));
    expect(result.status).toBe('SUCCEEDED');
    expect(result.resultReference).toBe(customerDirectoryInput.partyRef.resourceId);
    expect(transport.commands).toEqual([
      {
        email: 'customer@example.test',
        evidence: yield* input.verifiedEvidence,
        originalInvocationId: originalNativeInvocationId,
        phone: { preferred: true, type: 'PHONE', value: '+420 777 123 456' },
      },
    ]);
    expect(transport.proofs).toEqual([{ evidence: input.subject, idempotencyKey: ownerInvocationId }]);
    const commandRequests = transport.requests.filter((request) => request.url.includes('/actions/'));
    expect(commandRequests).toHaveLength(1);
    expect(transport.issued()).toBe(3);
    const recoveryRequests = transport.requests.filter((request) => request.url.endsWith('/action-commits/resolve'));
    expect(recoveryRequests).toHaveLength(1);
    expect(yield* Effect.promise(() => recoveryRequests[0].json())).toEqual({
      actionKey: 'party.registry.enroll-retail-customer',
      idempotencyKey: commandRequests[0]?.headers.get('idempotency-key'),
    });
    const ownerRequests = transport.requests.filter((request) => !request.url.endsWith('/gateway-context'));
    expect(ownerRequests.map((request) => new URL(request.url).pathname)).toEqual([
      '/api/approved/party-registry/party-registry/action-commits/resolve',
      '/api/approved/party-registry/reads/owned-retail-party-result',
      '/api/approved/party-registry/party-registry/actions/enroll-retail-customer',
    ]);
    expect(new Set(ownerRequests.map((request) => request.headers.get('authorization'))).size).toBe(3);
    expect(transport.consumed.size).toBe(3);
    for (const request of ownerRequests) {
      expect(request.headers.get('x-ontos-composition-revision')).toBe(compositionRevision);
      expect(request.headers.get('x-correlation-id')).toBe(requestCorrelation);
      expect(request.headers.has('x-api-key')).toBe(false);
    }
    for (const issuanceRequest of transport.requests.filter((request) => request.url.endsWith('/gateway-context'))) {
      expect(issuanceRequest.headers.get('x-api-key')).toBe('reviewed-ccc-module-key');
      expect(yield* Effect.promise(() => issuanceRequest.json())).toEqual(delegationPayload);
    }
  }),
);

it.effect('retains the original directory scope, Party, contacts and originator when its input is mutated', () =>
  Effect.gen(function* frozenDirectoryInput() {
    const mutable = {
      ...customerDirectoryInput,
      originator: { ...originator },
      partyRef: { ...customerDirectoryInput.partyRef },
      registration: { ...customerDirectoryInput.registration },
    };
    const owner = retailCustomerDirectoryOwnerEffect(mutable);
    Object.assign(mutable, {
      compositionRevision: 'd'.repeat(64),
      legalEntityId: '95000000-0000-4000-8000-000000000001',
      requestCorrelation: 'changed',
      tenantId: '95000000-0000-4000-8000-000000000001',
    });
    Object.assign(mutable.originator, {
      actionInvocationId: '96000000-0000-4000-8000-000000000001',
      compositionRevision: 'd'.repeat(64),
      tenantId: '95000000-0000-4000-8000-000000000001',
    });
    Object.assign(mutable.partyRef, {
      resourceId: '97000000-0000-4000-8000-000000000001',
      tenantId: '95000000-0000-4000-8000-000000000001',
    });
    Object.assign(mutable.registration, { email: 'changed@example.test', phone: '+420777999999' });
    const transport = customerDirectoryTransport();
    const result = yield* owner
      .dispatch(transition)
      .pipe(Effect.provideService(FetchHttpClient.Fetch, transport.fakeFetch), Effect.provide(configuration));
    expect(result.resultReference).toBe(customerDirectoryInput.partyRef.resourceId);
    expect(transport.commands[0]).toMatchObject({
      email: customerDirectoryInput.registration.email,
      phone: { value: customerDirectoryInput.registration.phone },
    });
    expect(yield* Effect.promise(() => transport.requests[0].json())).toEqual(delegationPayload);
    expect(
      transport.requests
        .filter((request) => !request.url.endsWith('/gateway-context'))
        .every(
          (request) =>
            request.headers.get('x-correlation-id') === requestCorrelation &&
            request.headers.get('x-ontos-composition-revision') === compositionRevision,
        ),
    ).toBe(true);
  }),
);

it.effect('reconciles an already committed finite customer command without replaying mutations', () =>
  Effect.gen(function* committedCustomerDirectory() {
    const transport = customerDirectoryTransport({ state: 'COMMITTED' });
    const result = yield* retailCustomerDirectoryOwnerEffect(customerDirectoryInput)
      .reconcile({ ...transition, observedRevision: 2, ownerOperationRevision: 1 })
      .pipe(Effect.provideService(FetchHttpClient.Fetch, transport.fakeFetch), Effect.provide(configuration));
    expect(result.status).toBe('SUCCEEDED');
    expect(transport.commands).toHaveLength(0);
    expect(transport.proofs).toHaveLength(0);
    expect(transport.issued()).toBe(1);
  }),
);

it.effect('recovers a committed atomic enrollment without rereading provider verification or the original Party', () =>
  Effect.gen(function* committedEnrollmentProofIsDurable() {
    const transport = customerDirectoryTransport({ original: 'WRONG_PARTY', state: 'COMMITTED' });
    const result = yield* retailCustomerDirectoryOwnerEffect({
      ...customerDirectoryInput,
      verifiedEvidence: Effect.die('A committed command must not reread mutable provider or Party evidence'),
    })
      .reconcile({ ...transition, observedRevision: 2, ownerOperationRevision: 1 })
      .pipe(Effect.provideService(FetchHttpClient.Fetch, transport.fakeFetch), Effect.provide(configuration));
    expect(result.status).toBe('SUCCEEDED');
    expect(transport.proofs).toHaveLength(0);
    expect(transport.commands).toHaveLength(0);
    expect(transport.issued()).toBe(1);
  }),
);

it.effect('halts on an indeterminate customer command without dispatching a duplicate', () =>
  Effect.gen(function* openCustomerDirectory() {
    const transport = customerDirectoryTransport({ state: 'RUNNING' });
    const failure = yield* retailCustomerDirectoryOwnerEffect(customerDirectoryInput)
      .dispatch(transition)
      .pipe(
        Effect.provideService(FetchHttpClient.Fetch, transport.fakeFetch),
        Effect.provide(configuration),
        Effect.flip,
      );
    expect(Schema.is(CommerceEnrollmentOwnerEffectUnavailable)(failure)).toBe(true);
    expect(transport.commands).toHaveLength(0);
    expect(transport.proofs).toHaveLength(0);
    expect(transport.issued()).toBe(1);
  }),
);

it.effect('never retries the atomic customer command after its acknowledgement is lost', () =>
  Effect.gen(function* unknownCustomerDirectory() {
    const transport = customerDirectoryTransport({ failCommand: true });
    const failure = yield* retailCustomerDirectoryOwnerEffect(customerDirectoryInput)
      .dispatch(transition)
      .pipe(
        Effect.provideService(FetchHttpClient.Fetch, transport.fakeFetch),
        Effect.provide(configuration),
        Effect.flip,
      );
    expect(Schema.is(CommerceEnrollmentOwnerEffectUnavailable)(failure)).toBe(true);
    expect(transport.commands).toHaveLength(1);
    expect(transport.issued()).toBe(3);
  }),
);

const definiteRefusal = {
  body: {
    _tag: 'EnrollRetailCustomerActionForbiddenProblem',
    code: 'action_permission_denied',
    detail: 'The finite retail command is forbidden',
    status: 403,
    title: 'Forbidden',
    type: 'https://ontos.dev/problems/retail-enrollment-forbidden',
  },
  status: 403,
};

it.effect('records a definite native finite command refusal as an owner rejection', () =>
  Effect.gen(function* refusedCustomerDirectory() {
    const transport = customerDirectoryTransport({ commandProblem: definiteRefusal });
    const failure = yield* retailCustomerDirectoryOwnerEffect(customerDirectoryInput)
      .dispatch(transition)
      .pipe(
        Effect.provideService(FetchHttpClient.Fetch, transport.fakeFetch),
        Effect.provide(configuration),
        Effect.flip,
      );
    expect(Schema.is(CommerceEnrollmentOwnerEffectRejected)(failure)).toBe(true);
    expect(failure.code).toBe('action_permission_denied');
    expect(transport.commands).toHaveLength(1);
  }),
);

it.effect('reconciles a fenced operation refused by Party into a terminal rejection', () =>
  Effect.gen(function* reconcileRefusedCustomerDirectory() {
    const transport = customerDirectoryTransport({ commandProblem: definiteRefusal });
    const resolution = yield* retailCustomerDirectoryOwnerEffect(customerDirectoryInput)
      .reconcile({ ...transition, observedRevision: 2, ownerOperationRevision: 1 })
      .pipe(Effect.provideService(FetchHttpClient.Fetch, transport.fakeFetch), Effect.provide(configuration));
    expect(resolution.status).toBe('FAILED');
    expect(resolution.failureCode).toBe('owner_rejected');
    expect(resolution.outcomeCode).toBe('action_permission_denied');
    expect(transport.commands).toHaveLength(1);
  }),
);

it.effect('reconciles a native REJECTED command as terminal without retrying the mutation', () =>
  Effect.gen(function* rejectedCustomerCommand() {
    const transport = customerDirectoryTransport({ state: 'REJECTED' });
    const resolution = yield* retailCustomerDirectoryOwnerEffect(customerDirectoryInput)
      .reconcile({ ...transition, observedRevision: 2, ownerOperationRevision: 1 })
      .pipe(Effect.provideService(FetchHttpClient.Fetch, transport.fakeFetch), Effect.provide(configuration));
    expect(resolution.status).toBe('FAILED');
    expect(resolution.failureCode).toBe('owner_rejected');
    expect(resolution.outcomeCode).toBe('retail_customer_command_rejected');
    expect(transport.commands).toHaveLength(0);
    expect(transport.proofs).toHaveLength(0);
    expect(transport.issued()).toBe(1);
  }),
);

it.effect('keeps a finite customer command outage indeterminate', () =>
  Effect.gen(function* unavailableCustomerDirectory() {
    const transport = customerDirectoryTransport({
      commandProblem: {
        body: {
          _tag: 'EnrollRetailCustomerActionUnavailableProblem',
          code: 'action_transaction_failed',
          detail: 'Party Registry is unavailable',
          retryable: true,
          status: 503,
          title: 'Unavailable',
          type: 'https://ontos.dev/problems/retail-enrollment-unavailable',
        },
        status: 503,
      },
    });
    const failure = yield* retailCustomerDirectoryOwnerEffect(customerDirectoryInput)
      .dispatch(transition)
      .pipe(
        Effect.provideService(FetchHttpClient.Fetch, transport.fakeFetch),
        Effect.provide(configuration),
        Effect.flip,
      );
    expect(Schema.is(CommerceEnrollmentOwnerEffectUnavailable)(failure)).toBe(true);
    expect(transport.commands).toHaveLength(1);
  }),
);

it.effect('treats the same finite command committing during dispatch as enrolled without resending it', () =>
  Effect.gen(function* alreadyCommittedCustomerDirectory() {
    const transport = customerDirectoryTransport({
      commandProblem: {
        body: {
          _tag: 'EnrollRetailCustomerActionAlreadyCommittedProblem',
          code: 'action_already_committed',
          detail: 'The command already committed',
          invocationId: '99000000-0000-4000-8000-000000000001',
          resolution: 'REFRESH_GOVERNED_READS',
          retryCommand: false,
          status: 409,
          title: 'Already committed',
          type: 'https://ontos.dev/problems/retail-enrollment-already-committed',
        },
        status: 409,
      },
    });
    const result = yield* retailCustomerDirectoryOwnerEffect(customerDirectoryInput)
      .dispatch(transition)
      .pipe(Effect.provideService(FetchHttpClient.Fetch, transport.fakeFetch), Effect.provide(configuration));
    expect(result.status).toBe('SUCCEEDED');
    expect(transport.commands).toHaveLength(1);
    expect(transport.issued()).toBe(3);
  }),
);

const invalidOriginals: readonly NonNullable<CustomerTransportInput['original']>[] = [
  'RUNNING',
  'AMBIGUOUS',
  'WRONG_PARTY',
  'WRONG_TENANT',
  'MISSING_RESULT',
];
for (const original of invalidOriginals) {
  it.effect(`refuses original native proof ${original} before resolving or dispatching the customer command`, () =>
    Effect.gen(function* refusedOriginalProof() {
      const transport = customerDirectoryTransport({ original });
      const failure = yield* retailCustomerDirectoryOwnerEffect(customerDirectoryInput)
        .dispatch(transition)
        .pipe(
          Effect.provideService(FetchHttpClient.Fetch, transport.fakeFetch),
          Effect.provide(configuration),
          Effect.flip,
        );
      expect(Schema.is(CommerceEnrollmentOwnerEffectUnavailable)(failure)).toBe(true);
      expect(transport.commands).toHaveLength(0);
      expect(transport.requests.filter((request) => request.url.endsWith('/action-commits/resolve'))).toHaveLength(1);
      expect(transport.issued()).toBe(2);
    }),
  );
}

const mismatchedResults = [
  {
    label: 'another Party',
    party: { ...customerDirectoryInput.partyRef, resourceId: '97000000-0000-4000-8000-000000000001' },
  },
  {
    label: 'another Tenant',
    party: { ...customerDirectoryInput.partyRef, tenantId: '98000000-0000-4000-8000-000000000001' },
  },
];
for (const { label, party } of mismatchedResults) {
  it.effect(`rejects a finite command success naming ${label}`, () =>
    Effect.gen(function* mismatchedCommandResult() {
      const transport = customerDirectoryTransport({ commandResult: { partyRef: party } });
      const result = yield* retailCustomerDirectoryOwnerEffect(customerDirectoryInput)
        .dispatch(transition)
        .pipe(
          Effect.provideService(FetchHttpClient.Fetch, transport.fakeFetch),
          Effect.provide(configuration),
          Effect.result,
        );
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(Schema.is(CommerceEnrollmentOwnerEffectUnavailable)(result.failure)).toBe(true);
      }
      expect(transport.commands).toHaveLength(1);
    }),
  );
}

it.effect('never presents the module key to a plain-HTTP Shell address off the machine', () =>
  Effect.gen(function* plainHttpShell() {
    const requests: Request[] = [];
    const fakeFetch: typeof fetch = (target, init) => {
      requests.push(new Request(target, init));
      return Promise.resolve(Response.json(gatewayResponse()));
    };
    const offMachine = new URL('https://shell.internal.example/shell-super-app-api');
    offMachine.protocol = 'http:';
    const failure = yield* acquireRetailEnrollmentPartyGateway({
      compositionRevision,
      crypto,
      legalEntityId,
      originator,
      requestCorrelation,
      tenantId,
    }).pipe(
      Effect.provideService(FetchHttpClient.Fetch, fakeFetch),
      Effect.provide(
        Layer.merge(
          ConfigProvider.layer(ConfigProvider.fromUnknown({ ONTOS_SHELL_GATEWAY_BASE_URL: offMachine.toString() })),
          Layer.effectDiscard(holdTestModuleCredentials({ 'commerce-customer-context': 'reviewed-ccc-module-key' })),
        ),
      ),
      Effect.flip,
    );
    expect(failure.reason).toBe('The Party Registry delegated owner credential is unavailable');
    expect(requests).toHaveLength(0);
  }),
);
