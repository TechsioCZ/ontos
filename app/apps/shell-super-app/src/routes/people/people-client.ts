import { Effect, Match, Random, Schema } from 'effect';
import { HttpClient, HttpClientRequest } from 'effect/http';
import type { Cause } from 'effect';

import {
  listCompanyPeople,
  listCompanyPeopleRoleCatalog,
  listTenantPeople,
  listTenantPeopleRoleCatalog,
} from '../../api/auth-client.ts';
import type { IdentityClientError } from '../../api/auth-client.ts';
import {
  PEOPLE_PATHS,
  InvitePeopleResponseSchema,
  SetPeopleCompanyMembershipResponseSchema,
  SetPeopleRoleResponseSchema,
} from '../../../shared/people-api.ts';
import type {
  InvitePeopleRequest,
  PeopleList,
  PeopleListRequest,
  PeopleRoleCatalog,
  SetPeopleCompanyMembershipRequest,
  SetPeopleRoleRequest,
} from '../../../shared/people-api.ts';

export type PeopleOutcome<A> =
  | { readonly status: 'ok'; readonly value: A }
  | { readonly message: string; readonly status: 'failed' };

const failedStatus = 'failed' as const;
const READ_TIMEOUT = '30 seconds' as const;

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
      return { message: failureMessage(response.status), status: failedStatus } as const;
    }
    const value = yield* Schema.decodeEffect(schema)(yield* response.json);
    return { status: 'ok', value } as const;
  }).pipe(
    Effect.timeout(READ_TIMEOUT),
    Effect.orElseSucceed(() => ({ message: failureMessage(503), status: failedStatus }) as const),
  );

const failed = (status: number) => ({ message: failureMessage(status), status: failedStatus });

const failureFromError = (error: IdentityClientError | Cause.TimeoutError) =>
  Match.value(error).pipe(
    Match.tag('ShellAuthenticationRequiredProblem', () => failed(401)),
    Match.tag('ShellTargetForbiddenProblem', () => failed(403)),
    Match.tag('ShellPolicyConflictProblem', () => failed(409)),
    Match.tag('ShellInvalidRequestProblem', 'ShellPolicyUnprocessableProblem', () => failed(422)),
    Match.orElse(() => failed(503)),
  );

/** Reads go through the generated people administration client, including its declared identity failures. */
const generatedRead = <A>(
  effect: Effect.Effect<A, IdentityClientError, HttpClient.HttpClient>,
): Effect.Effect<PeopleOutcome<A>, never, HttpClient.HttpClient> =>
  effect.pipe(
    Effect.timeout(READ_TIMEOUT),
    Effect.match({
      onFailure: (error) => failureFromError(error),
      onSuccess: (value): PeopleOutcome<A> => ({ status: 'ok', value }),
    }),
  );

export const loadPeople = (
  scope: 'company' | 'tenant',
  request: PeopleListRequest,
): Effect.Effect<PeopleOutcome<PeopleList>, never, HttpClient.HttpClient> =>
  generatedRead(scope === 'company' ? listCompanyPeople(request) : listTenantPeople(request));
export const changeCompanyMembership = (request: SetPeopleCompanyMembershipRequest) =>
  call(PEOPLE_PATHS.companyMembership, request, SetPeopleCompanyMembershipResponseSchema, true);
export const changeScopedRole = (scope: 'company' | 'tenant', request: SetPeopleRoleRequest) =>
  call(
    scope === 'company' ? PEOPLE_PATHS.companyRole : PEOPLE_PATHS.tenantRole,
    request,
    SetPeopleRoleResponseSchema,
    true,
  );

/** Hard stop for a runaway cursor; a company directory this large needs server-side search, not more pages. */
const MAX_PEOPLE_PAGES = 20;

/**
 * The whole governed scoped directory, page by page, so the table can search, filter and sort locally and a deep
 * link finds its person on any page. It never falls back to a legacy or ungoverned identity read.
 */
export const loadAllPeople = (scope: 'company' | 'tenant') => {
  const page: (
    offset: number,
    before: readonly PeopleList['items'][number][],
    pages: number,
  ) => Effect.Effect<PeopleOutcome<PeopleList>, never, HttpClient.HttpClient> = Effect.fn('People.loadAllPage')(
    function* loadAllPage(offset, before, pages) {
      const outcome = yield* loadPeople(scope, { limit: 100, offset });
      if (outcome.status === failedStatus) {
        return outcome;
      }
      const items = [...before, ...outcome.value.items];
      const { nextOffset } = outcome.value;
      if (nextOffset === null) {
        return { status: 'ok' as const, value: { ...outcome.value, items } };
      }
      if (nextOffset <= offset || pages + 1 >= MAX_PEOPLE_PAGES) {
        return { message: 'Správa lidí vrátila neplatné stránkování.', status: failedStatus };
      }
      return yield* page(nextOffset, items, pages + 1);
    },
  );
  return Effect.suspend(() => page(0, [], 0)).pipe(
    Effect.timeout(READ_TIMEOUT),
    Effect.orElseSucceed(() => ({
      message: 'Seznam lidí je nedostupný. Zkusíme ho načíst znovu automaticky.',
      status: failedStatus,
    })),
  );
};

export const invitePerson = (request: InvitePeopleRequest) =>
  call(PEOPLE_PATHS.companyInvite, request, InvitePeopleResponseSchema, true);

export const loadRoleCatalog = (
  scope: 'company' | 'tenant',
): Effect.Effect<PeopleOutcome<PeopleRoleCatalog>, never, HttpClient.HttpClient> =>
  generatedRead(scope === 'company' ? listCompanyPeopleRoleCatalog() : listTenantPeopleRoleCatalog());
