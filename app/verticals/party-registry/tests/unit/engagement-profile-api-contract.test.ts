import { runEffectTestPromise } from '@app/core-runtime/testing/effect-runtime';
// @effect-diagnostics nodeBuiltinImport:off asyncFunction:off -- Existing compatibility boundary; expires: 2026-12-31.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Effect, Schema } from 'effect';
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

test('publishes engagement operations from the Party Registry API boundary', () => {
  assert.equal(
    partyRegistryApiContract.readinessPath,
    '/party-registry-api/party-registry/readiness',
  );
  assert.deepEqual(
    Object.values(engagementProfileOperationContexts)
      .map(({ routePath }) => routePath)
      .toSorted(),
    [
      '/contacts/engagement/organizations/archive',
      '/contacts/engagement/organizations/attach',
      '/contacts/engagement/organizations/unarchive',
      '/contacts/engagement/people/archive',
      '/contacts/engagement/people/attach',
      '/contacts/engagement/people/unarchive',
      '/reads/organization-engagement-profile',
      '/reads/person-engagement-profile',
    ],
  );
});

test('attach contracts accept only public Party Registry refs', () => {
  const payload = { counterpartyRef, partyRef };
  assert.deepEqual(
    Schema.decodeUnknownSync(AttachOrganizationEngagementPayloadSchema)(payload),
    payload,
  );
  assert.deepEqual(Schema.decodeUnknownSync(AttachPersonEngagementPayloadSchema)(payload), payload);

  for (const schema of [
    AttachOrganizationEngagementPayloadSchema,
    AttachPersonEngagementPayloadSchema,
  ] as const) {
    assert.deepEqual(
      Schema.decodeUnknownSync(schema, { onExcessProperty: 'error' })({ partyRef }),
      { partyRef },
    );
    assert.throws(() =>
      Schema.decodeUnknownSync(schema, { onExcessProperty: 'error' })({
        ...payload,
        customerId: 'd4000000-0000-4000-8000-000000000001',
      }),
    );
  }
});

test('public engagement mutations use the owner audience and preserve HTTP context', async () => {
  const requests: Request[] = [];
  const timestamp = '2026-09-07T00:00:00.000Z';
  const traceparent = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
  const fakeFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    const { pathname } = new URL(request.url);
    if (pathname === '/auth/gateway-context') {
      return Response.json({ expiresAt: 1, token: 'test-gateway-token' });
    }
    assert.equal(pathname, '/party-registry-api/contacts/engagement/organizations/attach');
    return Response.json({
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
    });
  };

  await runEffectTestPromise(
    attachOrganizationEngagement(
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
    ).pipe(Effect.provideService(FetchHttpClient.Fetch, fakeFetch)),
  );

  const mutationRequest = requests.find(({ url }) => url.includes('/contacts/engagement/'));
  const gatewayRequest = requests.find(({ url }) => url.endsWith('/auth/gateway-context'));
  assert.ok(gatewayRequest);
  assert.ok(mutationRequest);
  assert.deepEqual(await gatewayRequest.json(), { audience: 'party-registry' });
  assert.equal(mutationRequest.headers.get('authorization'), 'Bearer test-gateway-token');
  assert.equal(mutationRequest.headers.get('accept-language'), 'cs');
  assert.equal(mutationRequest.headers.get('x-trace-id'), 'engagement-trace');
  assert.equal(mutationRequest.headers.get('traceparent'), traceparent);
  assert.equal(mutationRequest.headers.get('x-correlation-id'), 'engagement-correlation');
  assert.equal(
    mutationRequest.headers.get('x-operation-id'),
    engagementProfileOperationContexts.attachOrganizationEngagement.operationId,
  );
  assert.deepEqual(
    JSON.parse(mutationRequest.headers.get('x-modernjs-bff-operation-context') ?? ''),
    engagementProfileOperationContexts.attachOrganizationEngagement,
  );
});

test('public Party Registry engagement API does not expose legacy identity operations', async () => {
  const [apiSource, clientSource] = await Promise.all([
    readFile(new URL('../../shared/engagement-profile-api.ts', import.meta.url), 'utf-8'),
    readFile(new URL('../../src/api/engagement-profile-client.ts', import.meta.url), 'utf-8'),
  ]);

  for (const source of [apiSource, clientSource]) {
    assert.doesNotMatch(
      source,
      /\b(?:createCustomer|editCustomer|archiveCustomer|unarchiveCustomer)\b/u,
    );
    assert.doesNotMatch(
      source,
      /\b(?:createContact|editContact|archiveContact|unarchiveContact)\b/u,
    );
    assert.doesNotMatch(source, /CustomerAresLookup|customerId|contactId/u);
  }
});
