import { Effect, Match, Option, Random, Schema } from 'effect';
import { HttpClient, HttpClientRequest } from 'effect/http';
import type { Cause } from 'effect';

import {
  assignAccessRole,
  listAccessPeople,
  listAccessPeopleOptions,
  listCompanyPeople,
  listTenantPeople,
  revokeAccessAssignment,
} from '../../api/auth-client.ts';
import type { AccessAdministrationClientError, IdentityClientError } from '../../api/auth-client.ts';
import { AccessScopeTargetSchema } from '../../../shared/access-admin-api.ts';
import type {
  AccessPeopleMutationResponse,
  AssignAccessRolePayload,
  ListAccessPeopleResponse,
  RevokeAccessAssignmentPayload,
} from '../../../shared/access-admin-api.ts';
import {
  PEOPLE_PATHS,
  InvitePeopleResponseSchema,
  SetPeopleCompanyMembershipResponseSchema,
} from '../../../shared/people-api.ts';
import type {
  InvitePeopleRequest,
  PeopleList,
  PeopleListRequest,
  SetPeopleCompanyMembershipRequest,
} from '../../../shared/people-api.ts';
import type { PeopleAccessView, PendingPeopleChange } from './people-model.ts';

export type PeopleOutcome<A> =
  | { readonly status: 'ok'; readonly value: A }
  | { readonly message: string; readonly status: 'failed' };

const failedStatus = 'failed' as const;
const READ_TIMEOUT = '30 seconds' as const;
const ACCESS_PAGE_LIMIT = 100;
/** Hard stop for a runaway cursor; a tenant this large needs server-side paging, not more pages. */
const MAX_ACCESS_PAGES = 20;

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
  body: Readonly<Record<string, never>> | PeopleListRequest | SetPeopleCompanyMembershipRequest | InvitePeopleRequest,
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

/*
 * Roles and role assignments are authority, so they are read and written only through the canonical
 * access-administration contract (`AccessPeopleCommands` behind `AccessPeopleBff`). This surface never
 * names a role key, never writes a graph relationship itself, and never treats a commit response as
 * confirmation: the canonical read must report the assignment afterwards.
 */

const accessFailure = (error: AccessAdministrationClientError): PeopleOutcome<never> =>
  Match.value(error).pipe(
    Match.tag('AccessAdminAuthenticationRequired', () => failed(401)),
    Match.tag('AccessAdminForbidden', () => failed(403)),
    Match.tag('AccessAdminConflict', () => failed(409)),
    Match.tag('AccessAdminInvalidRequest', 'AccessAdminUnprocessable', () => failed(422)),
    Match.orElse(() => failed(503)),
  );

const accessOutcome = <A>(effect: Effect.Effect<A, AccessAdministrationClientError>): Effect.Effect<PeopleOutcome<A>> =>
  effect.pipe(
    Effect.match({
      onFailure: (error): PeopleOutcome<A> => accessFailure(error),
      onSuccess: (value): PeopleOutcome<A> => ({ status: 'ok', value }),
    }),
  );

type AccessPerson = ListAccessPeopleResponse['items'][number];
type AccessScopeTarget = typeof AccessScopeTargetSchema.Type;

/** The exact access scope a request names: the selected company, or the tenant context. */
const accessScopeTarget = (
  scope: 'company' | 'tenant',
  legalEntityId: string | undefined,
): Option.Option<AccessScopeTarget> =>
  Schema.decodeUnknownOption(AccessScopeTargetSchema)(
    scope === 'company' && legalEntityId !== undefined ? { kind: 'company', legalEntityId } : { kind: 'tenant' },
  );

/** The two canonical access reads this surface makes; a test supplies a scripted port, the app the live one. */
export interface PeopleAccessReadPort {
  readonly list: typeof listAccessPeople;
  readonly options: typeof listAccessPeopleOptions;
}
const liveAccessReadPort: PeopleAccessReadPort = { list: listAccessPeople, options: listAccessPeopleOptions };

/**
 * The canonical role choices and role assignments of one scope, read page by page from the access
 * administration BFF. Roles a person holds are canonical assignments; nothing is derived from a
 * legacy role cache.
 */
export const loadPeopleAccess = (
  scope: 'company' | 'tenant',
  legalEntityId: string | undefined,
  port: PeopleAccessReadPort = liveAccessReadPort,
): Effect.Effect<PeopleOutcome<PeopleAccessView>, never, HttpClient.HttpClient> => {
  const target = accessScopeTarget(scope, legalEntityId);
  if (Option.isNone(target)) {
    return Effect.succeed({ message: failureMessage(422), status: failedStatus });
  }
  // `exactOptionalPropertyTypes` forbids an explicit undefined cursor, so the page payload is built per shape.
  const peoplePage = (cursor: string | undefined) =>
    cursor === undefined
      ? { limit: ACCESS_PAGE_LIMIT, scope: target.value }
      : { cursor, limit: ACCESS_PAGE_LIMIT, scope: target.value };
  const collect = (
    cursor: string | undefined,
    before: readonly AccessPerson[],
    pages: number,
  ): Effect.Effect<
    PeopleOutcome<{
      readonly items: readonly AccessPerson[];
      readonly revision: ListAccessPeopleResponse['revision'];
    }>
  > =>
    accessOutcome(port.list(peoplePage(cursor))).pipe(
      Effect.flatMap((outcome) => {
        if (outcome.status === failedStatus) {
          return Effect.succeed(outcome);
        }
        const items = [...before, ...outcome.value.items];
        const { nextCursor } = outcome.value;
        if (nextCursor === null) {
          return Effect.succeed({ status: 'ok' as const, value: { items, revision: outcome.value.revision } });
        }
        if (nextCursor === cursor || pages + 1 >= MAX_ACCESS_PAGES) {
          return Effect.succeed({
            message: 'Správa rolí vrátila neplatné stránkování.',
            status: failedStatus,
          } as const);
        }
        return collect(nextCursor, items, pages + 1);
      }),
    );
  return Effect.all(
    {
      options: accessOutcome(port.options({ limit: ACCESS_PAGE_LIMIT, scope: target.value })),
      people: collect(undefined, [], 0),
    },
    { concurrency: 1 },
  ).pipe(
    Effect.flatMap(({ options, people }): Effect.Effect<PeopleOutcome<PeopleAccessView>> => {
      if (options.status === failedStatus) {
        return Effect.succeed(options);
      }
      if (people.status === failedStatus) {
        return Effect.succeed(people);
      }
      return Effect.succeed({
        status: 'ok' as const,
        value: {
          options: options.value,
          people: { items: people.value.items, nextCursor: null, revision: people.value.revision },
        },
      });
    }),
    Effect.timeout(READ_TIMEOUT),
    Effect.orElseSucceed(() => ({ message: failureMessage(503), status: failedStatus })),
  );
};

/** One canonical role command: an assignment to write, or the exact assignment incarnation to revoke. */
export type PersonRoleCommand =
  | { readonly operation: 'assign'; readonly payload: AssignAccessRolePayload }
  | { readonly operation: 'revoke'; readonly payload: RevokeAccessAssignmentPayload };

const rolePendingChange = (
  command: PersonRoleCommand,
  response: AccessPeopleMutationResponse,
): PendingPeopleChange | undefined => {
  const { assignment } = response;
  return assignment === undefined
    ? undefined
    : {
        change: {
          incarnationId: assignment.incarnationId,
          present: command.operation === 'assign',
          principalId: assignment.principalId,
        },
        kind: 'role',
      };
};

/** The two canonical role writes; a test supplies a scripted port, the app the live one. */
export interface PersonRoleMutationPort {
  readonly assign: typeof assignAccessRole;
  readonly revoke: typeof revokeAccessAssignment;
}
const liveRoleMutationPort: PersonRoleMutationPort = { assign: assignAccessRole, revoke: revokeAccessAssignment };

/**
 * The one role write of this surface. The idempotency key names the command identity, so a retry
 * touches the same canonical assignment instead of forking a second one.
 */
export const changePersonRole = (
  command: PersonRoleCommand,
  port: PersonRoleMutationPort = liveRoleMutationPort,
): Effect.Effect<PeopleOutcome<PendingPeopleChange>, never, HttpClient.HttpClient> =>
  Effect.gen(function* changeRole() {
    const idempotencyKey = yield* newRequestToken;
    const mutation =
      command.operation === 'assign'
        ? port.assign(command.payload, { idempotencyKey })
        : port.revoke(command.payload, { idempotencyKey });
    const outcome = yield* accessOutcome(mutation);
    if (outcome.status === failedStatus) {
      return outcome;
    }
    const pending = rolePendingChange(command, outcome.value);
    return pending === undefined
      ? { message: 'Změnu role nelze ověřit. Obnovte seznam.', status: failedStatus }
      : { status: 'ok' as const, value: pending };
  }).pipe(
    Effect.timeout(READ_TIMEOUT),
    Effect.orElseSucceed(() => ({ message: failureMessage(503), status: failedStatus })),
  );
