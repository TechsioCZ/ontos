import { expect, it } from 'effect-rstest';
// @effect-diagnostics nodeBuiltinImport:off -- Source-contract test reads actual module files; expires: 2026-12-31.
import { readFile } from 'node:fs/promises';
import { Effect, Option, Schema } from 'effect';
import { FetchHttpClient } from 'effect/unstable/http';
import {
  AttachOrganizationEngagementPayloadSchema,
  AttachPersonEngagementPayloadSchema,
  engagementProfileOperationContexts,
  partyRegistryApiContract,
} from '../../shared/api.ts';
import { attachOrganizationEngagement } from '../../src/api/engagement-profile-client.ts';

const tenantId = 'd1000000-0000-4000-8000-000000000001';
const partyRef = {
  moduleId: 'party.registry',
  resourceId: 'd2000000-0000-4000-8000-000000000001',
  resourceType: 'party.registry.party',
  tenantId,
} as const;
const counterpartyRef = {
  moduleId: 'party.registry',
  resourceId: 'd3000000-0000-4000-8000-000000000001',
  resourceType: 'party.registry.counterparty',
  tenantId,
} as const;

it('publishes engagement operations from the Party Registry API boundary', () => {
  expect(partyRegistryApiContract.readinessPath).toBe(
    '/party-registry-api/party-registry/readiness',
  );
  expect(
    Object.values(engagementProfileOperationContexts)
      .map(({ routePath }) => routePath)
      .toSorted(),
  ).toEqual([
    '/contacts/engagement/organizations/archive',
    '/contacts/engagement/organizations/attach',
    '/contacts/engagement/organizations/unarchive',
    '/contacts/engagement/people/archive',
    '/contacts/engagement/people/attach',
    '/contacts/engagement/people/unarchive',
    '/reads/organization-engagement-profile',
    '/reads/person-engagement-profile',
  ]);
});

it.effect('attach contracts accept only public Party Registry refs', () =>
  Effect.gen(function* decodeContracts() {
    const payload = { counterpartyRef, partyRef };
    expect(
      yield* Schema.decodeUnknownEffect(AttachOrganizationEngagementPayloadSchema)(payload),
    ).toEqual(payload);
    expect(yield* Schema.decodeUnknownEffect(AttachPersonEngagementPayloadSchema)(payload)).toEqual(
      payload,
    );

    for (const schema of [
      AttachOrganizationEngagementPayloadSchema,
      AttachPersonEngagementPayloadSchema,
    ] as const) {
      expect(
        yield* Schema.decodeUnknownEffect(schema, { onExcessProperty: 'error' })({ partyRef }),
      ).toEqual({ partyRef });
      expect(
        yield* Schema.decodeUnknownEffect(schema, { onExcessProperty: 'error' })({
          ...payload,
          customerId: 'd4000000-0000-4000-8000-000000000001',
        }).pipe(Effect.isFailure),
      ).toBe(true);
    }
  }),
);

it.effect('public engagement mutations preserve owner request context at the HTTP boundary', () =>
  Effect.gen(function* verifyCase3() {
    const requests: Request[] = [];
    const timestamp = '2026-09-07T00:00:00.000Z';
    const traceparent = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
    const fakeFetch: typeof fetch = (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      const { pathname } = new URL(request.url);
      if (pathname === '/auth/gateway-context') {
        return Promise.resolve(Response.json({ expiresAt: 1, token: 'test-gateway-token' }));
      }
      expect(pathname).toBe('/party-registry-api/contacts/engagement/organizations/attach');
      return Promise.resolve(
        Response.json({
          archivedAt: null,
          counterpartyRef,
          createdAt: timestamp,
          partyRef,
          profileRef: {
            moduleId: 'party.registry',
            resourceId: 'd5000000-0000-4000-8000-000000000001',
            resourceType: 'party.registry.organization-engagement-profile',
            tenantId,
          },
          updatedAt: timestamp,
        }),
      );
    };

    yield* attachOrganizationEngagement(
      { counterpartyRef, partyRef },
      {
        baseUrl: 'https://party.example/party-registry-api',
        correlationId: 'engagement-correlation',
        gateway: { baseUrl: 'https://party.example' },
        idempotencyKey: 'attach-engagement',
        locale: 'cs',
        traceId: 'engagement-trace',
        traceparent,
      },
    ).pipe(Effect.provideService(FetchHttpClient.Fetch, fakeFetch));

    const mutationRequest = requests.find(({ url }) => url.includes('/contacts/engagement/'));
    const gatewayRequest = requests.find(({ url }) => url.endsWith('/auth/gateway-context'));
    expect(gatewayRequest).toBeDefined();
    expect(mutationRequest).toBeDefined();
    const gatewayPayload = yield* Effect.promise(() =>
      Option.getOrThrow(Option.fromNullishOr(gatewayRequest)).json(),
    );
    expect(gatewayPayload).toEqual({ audience: 'party-registry' });
    expect(mutationRequest?.headers.get('authorization')).toBe('Bearer test-gateway-token');
    expect(mutationRequest?.headers.get('accept-language')).toBe('cs');
    expect(mutationRequest?.headers.get('x-trace-id')).toBe('engagement-trace');
    expect(mutationRequest?.headers.get('traceparent')).toBe(traceparent);
    expect(mutationRequest?.headers.get('x-correlation-id')).toBe('engagement-correlation');
    expect(mutationRequest?.headers.get('x-operation-id')).toBe(
      engagementProfileOperationContexts.attachOrganizationEngagement.operationId,
    );
    expect(
      yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(
        mutationRequest?.headers.get('x-modernjs-bff-operation-context') ?? '',
      ),
    ).toEqual(engagementProfileOperationContexts.attachOrganizationEngagement);
  }),
);

it.effect('public Party Registry engagement API does not expose legacy identity operations', () =>
  Effect.gen(function* verifyCase4() {
    const [apiSource, clientSource] = yield* Effect.all([
      Effect.promise(() =>
        readFile(new URL('../../shared/engagement-profile-api.ts', import.meta.url), 'utf-8'),
      ),
      Effect.promise(() =>
        readFile(new URL('../../src/api/engagement-profile-client.ts', import.meta.url), 'utf-8'),
      ),
    ]);

    for (const source of [apiSource, clientSource]) {
      expect(source).not.toMatch(
        /\b(?:createCustomer|editCustomer|archiveCustomer|unarchiveCustomer)\b/u,
      );
      expect(source).not.toMatch(
        /\b(?:createContact|editContact|archiveContact|unarchiveContact)\b/u,
      );
      expect(source).not.toMatch(/CustomerAresLookup|customerId|contactId/u);
    }
  }),
);
