import { Effect, Random, Schema } from 'effect';
import { HttpClient, HttpClientRequest } from 'effect/http';

import {
  PEOPLE_PATHS,
  PeopleRoleCatalogSchema,
  InvitePeopleResponseSchema,
  PeopleListResponseSchema,
  SetPeopleCompanyMembershipResponseSchema,
  SetPeopleRoleResponseSchema,
} from '../../../shared/people-api.ts';
import type {
  InvitePeopleRequest,
  PeopleList,
  PeopleListRequest,
  SetPeopleCompanyMembershipRequest,
  SetPeopleRoleRequest,
} from '../../../shared/people-api.ts';

export type PeopleOutcome<A> =
  | { readonly status: 'ok'; readonly value: A }
  | { readonly message: string; readonly status: 'failed' };

const failureMessage = (status: number) => {
  if (status === 401) {
    return 'Přihlášení vypršelo. Přihlaste se znovu.';
  }
  if (status === 403) {
    return 'K této správě nemáte oprávnění.';
  }
  if (status === 409) {
    return 'Požadavek už byl přijat nebo se údaje změnily. Obnovte seznam před další změnou.';
  }
  if (status === 400 || status === 422) {
    return 'Změnu nelze provést. Zkontrolujte údaje a zvolený rozsah.';
  }
  return 'Správa lidí je teď nedostupná. Zkuste to znovu.';
};

export const newRequestToken = Effect.gen(function* peopleRequestKey() {
  const words = yield* Effect.forEach([0, 1, 2, 3], () => Random.nextIntBetween(0, 0x1_00_00_00_00), {
    concurrency: 1,
  });
  const hex = words.map((word) => word.toString(16).padStart(8, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
});

const call = <A>(
  path: string,
  body:
    | Readonly<Record<string, never>>
    | PeopleListRequest
    | SetPeopleCompanyMembershipRequest
    | SetPeopleRoleRequest
    | InvitePeopleRequest,
  schema: Schema.Codec<A, unknown>,
  mutation: boolean,
) =>
  Effect.gen(function* peopleCall() {
    const idempotencyKey = mutation ? yield* newRequestToken : undefined;
    const client = yield* HttpClient.HttpClient;
    let request = HttpClientRequest.post(`/shell-super-app-api${path}`).pipe(
      HttpClientRequest.setHeader('accept', 'application/json'),
    );
    if (idempotencyKey !== undefined) {
      // Each deliberate command gets a fresh key. Never silently retry an ambiguous sensitive command.
      request = request.pipe(HttpClientRequest.setHeader('idempotency-key', idempotencyKey));
    }
    const response = yield* client.execute(yield* HttpClientRequest.bodyJson(request, body));
    if (response.status !== 200) {
      return { message: failureMessage(response.status), status: 'failed' } as const;
    }
    const value = yield* Schema.decodeEffect(schema)(yield* response.json);
    return { status: 'ok', value } as const;
  }).pipe(
    Effect.timeout('30 seconds'),
    Effect.orElseSucceed(() => ({ message: failureMessage(503), status: 'failed' }) as const),
  );

export const loadPeople = (scope: 'company' | 'tenant', request: PeopleListRequest) =>
  call(
    scope === 'company' ? PEOPLE_PATHS.companyList : PEOPLE_PATHS.tenantList,
    request,
    PeopleListResponseSchema,
    false,
  );
export const changeCompanyMembership = (request: SetPeopleCompanyMembershipRequest) =>
  call(PEOPLE_PATHS.companyMembership, request, SetPeopleCompanyMembershipResponseSchema, true);
export const changeScopedRole = (scope: 'company' | 'tenant', request: SetPeopleRoleRequest) =>
  call(
    scope === 'company' ? PEOPLE_PATHS.companyRole : PEOPLE_PATHS.tenantRole,
    request,
    SetPeopleRoleResponseSchema,
    true,
  );

/** A deep link searches only the same governed scope, never a legacy or ungoverned identity read. */
export const loadPeopleForPerson = (scope: 'company' | 'tenant', principalId: string) => {
  const page: (offset: number) => Effect.Effect<PeopleOutcome<PeopleList>, never, HttpClient.HttpClient> = Effect.fn(
    'People.findPersonPage',
  )(function* findPersonPage(offset: number) {
    const outcome = yield* loadPeople(scope, { limit: 100, offset });
    if (
      outcome.status === 'failed' ||
      outcome.value.items.some((person) => person.principalRef.principalId === principalId) ||
      outcome.value.nextOffset === null
    ) {
      return outcome;
    }
    if (outcome.value.nextOffset <= offset) {
      return { message: 'Správa lidí vrátila neplatné stránkování.', status: 'failed' as const };
    }
    return yield* page(outcome.value.nextOffset);
  });
  return Effect.suspend(() => page(0)).pipe(
    Effect.timeout('30 seconds'),
    Effect.orElseSucceed(() => ({
      message: 'Detail osoby je nedostupný. Obnovte stránku.',
      status: 'failed' as const,
    })),
  );
};

export const invitePerson = (request: InvitePeopleRequest) =>
  call(PEOPLE_PATHS.companyInvite, request, InvitePeopleResponseSchema, true);

export const loadRoleCatalog = (scope: 'company' | 'tenant') =>
  call(
    scope === 'company' ? PEOPLE_PATHS.companyRoleCatalog : PEOPLE_PATHS.tenantRoleCatalog,
    {},
    PeopleRoleCatalogSchema,
    false,
  );
