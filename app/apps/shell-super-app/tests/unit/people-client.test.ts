import { inProcessFetch, serveApi } from '@app/shared-contracts/testing/http-double';
import { HttpApi, HttpApiGroup } from '@modern-js/bff-effect/effect-client';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import type { HttpServerRequest } from '@modern-js/bff-effect/effect-edge';
import { Effect } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { expect, it } from 'effect-rstest';

import { ShellAuthenticationApi } from '../../shared/browser-api.ts';
import type {
  InvitePeopleResponseSchema,
  PeopleList,
  PeopleListRequest,
  SetPeopleCompanyMembershipResponse,
} from '../../shared/people-api.ts';
import {
  changeCompanyMembership,
  invitePerson,
  loadAllPeople,
  loadPeople,
} from '../../src/routes/people/people-client.ts';

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
const { endpoints } = ShellAuthenticationApi.groups.peopleAdministration;
const PeopleApi = HttpApi.make('peopleClientTest')
  .add(
    HttpApiGroup.make('peopleAdministration')
      .add(endpoints.listCompanyPeople)
      .add(endpoints.invitePerson)
      .add(endpoints.setPeopleCompanyMembership),
  )
  .prefix('/shell-super-app-api');

type Forbidden = typeof forbiddenProblem;
interface PeopleScript {
  readonly invite?: Effect.Effect<typeof InvitePeopleResponseSchema.Type, Forbidden>;
  readonly list?: (payload: PeopleListRequest) => Effect.Effect<PeopleList, Forbidden>;
  readonly membership?: Effect.Effect<SetPeopleCompanyMembershipResponse, Forbidden>;
}
interface PeopleRequest {
  readonly body: unknown;
  readonly idempotencyKey: string | undefined;
  readonly pathname: string;
}

const makePeopleBff = (script: PeopleScript) => {
  const requests: PeopleRequest[] = [];
  const record = <A, E>(request: HttpServerRequest.HttpServerRequest, answer: Effect.Effect<A, E>) =>
    Effect.gen(function* recordRequest() {
      const body = yield* request.json.pipe(Effect.orDie);
      requests.push({
        body,
        idempotencyKey: request.headers['idempotency-key'],
        pathname: new URL(request.originalUrl, 'http://shell.test').pathname,
      });
      return yield* answer;
    });
  const handlers = HttpApiBuilder.group(PeopleApi, 'peopleAdministration', (group) =>
    group
      .handle('listCompanyPeople', ({ payload, request }) =>
        record(request, script.list?.(payload) ?? Effect.die('Unexpected people list request')),
      )
      .handle('invitePerson', ({ request }) =>
        record(request, script.invite ?? Effect.die('Unexpected invitation request')),
      )
      .handle('setPeopleCompanyMembership', ({ request }) =>
        record(request, script.membership ?? Effect.die('Unexpected membership request')),
      ),
  );
  return { layer: inProcessFetch(serveApi(PeopleApi, handlers)), requests };
};

it.live('uses selected-company membership transport and preserves pending instead of claiming success', () =>
  Effect.gen(function* testMembership() {
    const membership = {
      affiliation: 'external',
      legalEntityId,
      principalRef,
      revision: 1,
      status: 'invited',
    } as const;
    const bff = makePeopleBff({ membership: Effect.succeed({ membership, projection: 'pending' }) });
    yield* Effect.gen(function* checkMembership() {
      const outcome = yield* changeCompanyMembership({
        affiliation: 'external',
        expectedRevision: 0,
        principalRef,
        reason: 'Pozvání',
        status: 'invited',
      });
      expect(outcome).toEqual({ status: 'ok', value: { membership, projection: 'pending' } });
      expect(bff.requests[0]?.pathname).toBe('/shell-super-app-api/auth/identity/people/company-membership');
    }).pipe(Effect.provide(bff.layer));
  }).pipe(Effect.provide(FetchHttpClient.layer)),
);

it.live('does not use fake data or fall back to old account reads when governed people read fails', () =>
  Effect.gen(function* testReadFailure() {
    const bff = makePeopleBff({ list: () => Effect.fail(forbiddenProblem) });
    yield* Effect.gen(function* checkDeniedRead() {
      const outcome = yield* loadPeople('company', { limit: 50, offset: 0 });
      expect(outcome).toEqual({ message: 'K této správě nemáte oprávnění.', status: 'failed' });
      expect(bff.requests).toHaveLength(1);
      expect(bff.requests[0]?.pathname).toBe('/shell-super-app-api/auth/identity/people/list');
    }).pipe(Effect.provide(bff.layer));
  }).pipe(Effect.provide(FetchHttpClient.layer)),
);

it.live('invites with email and explicit affiliation, never a principal ID, and preserves queued delivery', () =>
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
    const bff = makePeopleBff({ invite: Effect.succeed(result) });
    yield* Effect.gen(function* checkInvitation() {
      const payload = { affiliation: 'employee', displayName: 'Jana', email: 'jana@example.test' } as const;
      expect(yield* invitePerson(payload)).toEqual({ status: 'ok', value: result });
      const [request] = bff.requests;
      expect(request?.pathname).toBe('/shell-super-app-api/auth/identity/people/invite');
      expect(request?.body).toEqual(payload);
      expect(request?.idempotencyKey !== undefined).toBe(true);
      expect(bff.requests).toHaveLength(1);
    }).pipe(Effect.provide(bff.layer));
  }).pipe(Effect.provide(FetchHttpClient.layer)),
);

it.live('collects every page of the governed scoped directory for local search and deep links', () =>
  Effect.gen(function* deepLinkedPerson() {
    const first = {
      items: [],
      nextOffset: 100,
      scope: { _tag: 'company', legalEntityId } as const,
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
    } as const;
    const bff = makePeopleBff({
      list: ({ offset }) => Effect.succeed(offset === 0 ? first : { ...first, items: [person], nextOffset: null }),
    });
    yield* Effect.gen(function* checkPages() {
      const outcome = yield* loadAllPeople('company');
      expect(outcome.status).toBe('ok');
      if (outcome.status === 'ok') {
        expect(outcome.value.items).toEqual([person]);
        expect(outcome.value.nextOffset).toBeNull();
      }
      expect(bff.requests).toHaveLength(2);
      expect(bff.requests[1]?.body).toEqual({ limit: 100, offset: 100 });
    }).pipe(Effect.provide(bff.layer));
  }).pipe(Effect.provide(FetchHttpClient.layer)),
);

it.live('stops on denied access instead of inventing people', () =>
  Effect.gen(function* deniedPersonLink() {
    const bff = makePeopleBff({ list: () => Effect.fail(forbiddenProblem) });
    yield* Effect.gen(function* checkDeniedRead() {
      expect((yield* loadAllPeople('company')).status).toBe('failed');
      expect(bff.requests).toHaveLength(1);
    }).pipe(Effect.provide(bff.layer));
  }).pipe(Effect.provide(FetchHttpClient.layer)),
);
