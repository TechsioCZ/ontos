/* oxlint-disable effect-native/no-threaded-correlation-parameter -- This ingress adapter passes the persisted Core command/read transport identity, not ambient tracing; remove-when: Core accepts ingress transport identity as a service. */
import {
  ActionRuntime,
  invitePersonAction,
  PeopleDirectoryResultSchema,
  ReadRuntime,
  RoleCatalogResultSchema,
  roleCatalogRead,
  peopleDirectoryRead,
  setCompanyMembershipAction,
  setScopedRoleMembershipAction,
} from '@app/core-runtime';
import type { TrustedPrincipalContext } from '@app/core-runtime';
import { Effect, Schema } from 'effect';

import type {
  InvitePeopleRequest,
  PeopleListRequest,
  SetPeopleCompanyMembershipRequest,
  SetPeopleRoleRequest,
} from '../../shared/people-api.ts';

interface PeopleCommandContext {
  readonly principal: TrustedPrincipalContext;
  readonly transport: { readonly correlationId: string; readonly idempotencyKey: string };
}

/** No direct SQL / graph writes here: the Core registrations own authorization and evidence. */
export const listPeople = Effect.fn('PeopleAdministration.listPeople')(function* listPeople(
  principal: TrustedPrincipalContext,
  input: PeopleListRequest,
  correlationId: string,
) {
  const runtime = yield* ReadRuntime;
  const result = yield* runtime.runRead({
    input,
    principal,
    registration: peopleDirectoryRead,
    transport: { correlationId },
  });
  return yield* Schema.encodeEffect(PeopleDirectoryResultSchema)(result);
});

export const setPeopleCompanyMembership = Effect.fn('PeopleAdministration.setPeopleCompanyMembership')(
  function* setPeopleCompanyMembership(context: PeopleCommandContext, payload: SetPeopleCompanyMembershipRequest) {
    const runtime = yield* ActionRuntime;
    const result = yield* runtime.runAction({ ...context, payload, registration: setCompanyMembershipAction });
    const membership = yield* Schema.encodeEffect(setCompanyMembershipAction.descriptor.resultSchema)(result);
    // SQL committed is not projection complete. A separate governed read must confirm the new state.
    return { membership, projection: 'pending' as const };
  },
);

export const setPeopleScopedRole = Effect.fn('PeopleAdministration.setPeopleScopedRole')(function* setPeopleScopedRole(
  context: PeopleCommandContext,
  payload: SetPeopleRoleRequest,
) {
  const runtime = yield* ActionRuntime;
  return yield* runtime.runAction({ ...context, payload, registration: setScopedRoleMembershipAction });
});

export const invitePeoplePerson = Effect.fn('invitePeoplePerson')(function* invitePeoplePerson(
  context: PeopleCommandContext,
  payload: InvitePeopleRequest,
) {
  const runtime = yield* ActionRuntime;
  const result = yield* runtime.runAction({ ...context, payload, registration: invitePersonAction });
  return yield* Schema.encodeEffect(invitePersonAction.descriptor.resultSchema)(result);
});

export const listPeopleRoleCatalog = Effect.fn('PeopleAdministration.listRoleCatalog')(function* listRoleCatalog(
  principal: TrustedPrincipalContext,
  correlationId: string,
) {
  const runtime = yield* ReadRuntime;
  const result = yield* runtime.runRead({
    input: {},
    principal,
    registration: roleCatalogRead,
    transport: { correlationId },
  });
  return yield* Schema.encodeEffect(RoleCatalogResultSchema)(result);
});
