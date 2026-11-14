import { Effect, Schema } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { afterAll, beforeAll, beforeEach, expect, it, rstest } from 'effect-rstest';

import {
  changeCompanyMembership,
  invitePerson,
  loadAllPeople,
  loadPeople,
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
  return new URL(new Request(input).url).pathname;
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
const forbiddenProblem = {
  _tag: 'ShellTargetForbiddenProblem',
  detail: 'Fixture failure',
  status: 403,
  title: 'Fixture failure',
  type: 'about:blank',
} as const;
const forbiddenResponse = () =>
  Response.json(forbiddenProblem, {
    headers: { 'content-type': 'application/problem+json' },
    status: 403,
  });

it.layer(FetchHttpClient.layer)((test) => {
  test.effect('uses selected-company membership transport and preserves pending instead of claiming success', () =>
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
      expect(requestPath(fetch.mock.calls[0]?.[0])).toBe(
        '/shell-super-app-api/auth/identity/people/company-membership',
      );
    }),
  );

  test.effect('does not use fake data or fall back to old account reads when governed people read fails', () =>
    Effect.gen(function* testReadFailure() {
      fetch.mockResolvedValue(forbiddenResponse());
      const outcome = yield* loadPeople('company', { limit: 50, offset: 0 });
      expect(outcome).toEqual({ message: 'K této správě nemáte oprávnění.', status: 'failed' });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(requestPath(fetch.mock.calls[0]?.[0])).toBe('/shell-super-app-api/auth/identity/people/list');
    }),
  );

  test.effect('invites with email and explicit affiliation, never a principal ID, and preserves queued delivery', () =>
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
    }),
  );

  test.effect('collects every page of the governed scoped directory for local search and deep links', () =>
    Effect.gen(function* deepLinkedPerson() {
      const first = {
        items: [],
        nextOffset: 100,
        scope: { _tag: 'company', legalEntityId },
        tenantId: principalRef.tenantId,
      };
      // Organisation data only: no role assignment and no trailing membership projection on the wire.
      const person = {
        displayName: 'Jana',
        invitationDelivery: null,
        kind: 'human',
        principalRef,
        principalStatus: 'active',
        selectedCompanyMembership: null,
      };
      fetch.mockResolvedValueOnce(Response.json(first));
      fetch.mockResolvedValueOnce(Response.json({ ...first, items: [person], nextOffset: null }));
      const outcome = yield* loadAllPeople('company');
      expect(outcome.status).toBe('ok');
      if (outcome.status === 'ok') {
        expect(outcome.value.items).toEqual([person]);
        expect(outcome.value.nextOffset).toBeNull();
      }
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(yield* requestBody(fetch.mock.calls[1]?.[1])).toEqual({ limit: 100, offset: 100 });
    }),
  );

  test.effect('stops on denied access instead of inventing people', () =>
    Effect.gen(function* deniedPersonLink() {
      fetch.mockResolvedValue(forbiddenResponse());
      expect((yield* loadAllPeople('company')).status).toBe('failed');
      expect(fetch).toHaveBeenCalledTimes(1);
    }),
  );
});
