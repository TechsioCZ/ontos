import { Effect, Schema } from 'effect';
import { FetchHttpClient } from 'effect/unstable/http';
import { afterAll, beforeAll, beforeEach, expect, it, rstest } from 'effect-rstest';

import {
  changeCompanyMembership,
  changeScopedRole,
  loadPeople,
  loadPeopleForPerson,
  invitePerson,
} from '../../src/routes/people/people-client.ts';

const originalFetch = globalThis.fetch;
const fetch = rstest.fn<typeof globalThis.fetch>();
beforeAll(() => {
  globalThis.fetch = fetch;
});
afterAll(() => {
  globalThis.fetch = originalFetch;
});
beforeEach(() => {
  fetch.mockReset();
});
const requestPath = (input: RequestInfo | URL | undefined) => {
  if (input === undefined) {
    throw new Error('Missing people request');
  }
  // oxlint-disable-next-line effect-native/no-instanceof -- Native Fetch boundary accepts Request, string and URL; remove-when: Fetch mock is restricted to URL.
  return new URL(input instanceof Request ? input.url : input).pathname;
};
const requestBody = (init: RequestInit | undefined) =>
  Effect.tryPromise(() => new Response(init?.body).json()).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Json)),
  );
const principalRef = {
  principalId: '00000000-0000-4000-8000-000000000003',
  tenantId: '00000000-0000-4000-8000-000000000001',
};
const legalEntityId = '00000000-0000-4000-8000-000000000002';
const role = { roleKey: 'admin', scope: { _tag: 'tenant' }, tenantId: principalRef.tenantId };

it.effect('gives each deliberate sensitive command a fresh idempotency key and uses an explicit tenant endpoint', () =>
  Effect.gen(function* testKeys() {
    fetch.mockResolvedValue(Response.json({ operation: 'assign', principalRef, projection: 'pending', role }));
    const command = { operation: 'assign', principalRef, reason: 'Správa', roleKey: 'admin' } as const;
    expect((yield* changeScopedRole('tenant', command)).status).toBe('ok');
    fetch.mockResolvedValue(Response.json({ operation: 'assign', principalRef, projection: 'pending', role }));
    expect((yield* changeScopedRole('tenant', command)).status).toBe('ok');
    const { calls } = fetch.mock;
    expect(calls).toHaveLength(2);
    expect(requestPath(calls[0]?.[0])).toBe('/shell-super-app-api/auth/identity/people/tenant-role');
    const first = new Headers(calls[0]?.[1]?.headers).get('idempotency-key');
    const second = new Headers(calls[1]?.[1]?.headers).get('idempotency-key');
    expect(first).toMatch(/^[\da-f-]{36}$/u);
    expect(first).not.toBe(second);
    expect(yield* requestBody(calls[0]?.[1])).toEqual(command);
  }).pipe(Effect.provide(FetchHttpClient.layer)),
);

it.effect('uses selected-company membership transport and preserves pending instead of claiming success', () =>
  Effect.gen(function* testMembership() {
    const membership = {
      affiliation: 'external',
      legalEntityId,
      principalRef,
      revision: 1,
      status: 'invited',
    } as const;
    fetch.mockResolvedValue(Response.json({ membership, projection: 'pending' }));
    const outcome = yield* changeCompanyMembership({
      affiliation: 'external',
      expectedRevision: 0,
      principalRef,
      reason: 'Pozvání',
      status: 'invited',
    });
    expect(outcome).toEqual({ status: 'ok', value: { membership, projection: 'pending' } });
    expect(requestPath(fetch.mock.calls[0]?.[0])).toBe('/shell-super-app-api/auth/identity/people/company-membership');
  }).pipe(Effect.provide(FetchHttpClient.layer)),
);

it.effect('reports a committed retry as conflict and never automatically resubmits it', () =>
  Effect.gen(function* testConflict() {
    fetch.mockResolvedValue(Response.json({ detail: 'ActionAlreadyCommitted' }, { status: 409 }));
    const outcome = yield* changeScopedRole('company', {
      operation: 'revoke',
      principalRef,
      reason: 'Odchod',
      roleKey: 'admin',
    });
    expect(outcome.status).toBe('failed');
    expect(fetch).toHaveBeenCalledTimes(1);
  }).pipe(Effect.provide(FetchHttpClient.layer)),
);

it.effect('does not use fake data or fall back to old account reads when governed people read fails', () =>
  Effect.gen(function* testReadFailure() {
    fetch.mockResolvedValue(new Response(null, { status: 403 }));
    const outcome = yield* loadPeople('company', { limit: 50, offset: 0 });
    expect(outcome).toEqual({ message: 'K této správě nemáte oprávnění.', status: 'failed' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(requestPath(fetch.mock.calls[0]?.[0])).toBe('/shell-super-app-api/auth/identity/people/list');
  }).pipe(Effect.provide(FetchHttpClient.layer)),
);

it.effect('invites with email and explicit affiliation, never a principal ID, and preserves queued delivery', () =>
  Effect.gen(function* invitePersonTransport() {
    const membership = {
      affiliation: 'employee',
      legalEntityId,
      principalRef,
      revision: 1,
      status: 'invited',
    } as const;
    const result = {
      delivery: 'pending',
      invitationId: '00000000-0000-4000-8000-000000000009',
      membership,
      principalRef,
    } as const;
    fetch.mockResolvedValue(Response.json(result));
    const payload = { affiliation: 'employee', displayName: 'Jana', email: 'jana@example.test' } as const;
    expect(yield* invitePerson(payload)).toEqual({ status: 'ok', value: result });
    const [call] = fetch.mock.calls;
    expect(requestPath(call?.[0])).toBe('/shell-super-app-api/auth/identity/people/invite');
    expect(yield* requestBody(call?.[1])).toEqual(payload);
    expect(new Headers(call?.[1]?.headers).has('idempotency-key')).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  }).pipe(Effect.provide(FetchHttpClient.layer)),
);

it.effect('resolves person deep links on later pages using only the governed scoped directory', () =>
  Effect.gen(function* deepLinkedPerson() {
    const first = {
      items: [],
      nextOffset: 100,
      scope: { _tag: 'company', legalEntityId },
      tenantId: principalRef.tenantId,
    };
    const person = {
      displayName: 'Jana',
      invitationDelivery: null,
      kind: 'human',
      principalRef,
      principalStatus: 'active',
      roleAssignments: [],
      selectedCompanyMembership: null,
      selectedCompanyMembershipProjection: null,
    };
    fetch.mockResolvedValueOnce(Response.json(first));
    fetch.mockResolvedValueOnce(Response.json({ ...first, items: [person], nextOffset: null }));
    const outcome = yield* loadPeopleForPerson('company', principalRef.principalId);
    expect(outcome.status).toBe('ok');
    if (outcome.status === 'ok') {
      expect(outcome.value.items).toEqual([person]);
    }
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(yield* requestBody(fetch.mock.calls[1]?.[1])).toEqual({ limit: 100, offset: 100 });
  }).pipe(Effect.provide(FetchHttpClient.layer)),
);

it.effect('stops a deep-link lookup on denied access instead of inventing a person', () =>
  Effect.gen(function* deniedPersonLink() {
    fetch.mockResolvedValue(new Response(null, { status: 403 }));
    expect((yield* loadPeopleForPerson('company', principalRef.principalId)).status).toBe('failed');
    expect(fetch).toHaveBeenCalledTimes(1);
  }).pipe(Effect.provide(FetchHttpClient.layer)),
);
