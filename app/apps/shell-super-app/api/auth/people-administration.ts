/* oxlint-disable effect-native/no-threaded-correlation-parameter -- This ingress adapter passes the persisted Core command/read transport identity, not ambient tracing; remove-when: Core accepts ingress transport identity as a service. */
import {
  ActionRuntime,
  invitePersonAction,
  PeopleDirectoryResultSchema,
  ReadRuntime,
  peopleDirectoryRead,
  setCompanyMembershipAction,
} from '@app/core-runtime';
import type { TrustedPrincipalContext } from '@app/core-runtime';
import { Effect, Schema } from 'effect';

import type {
  InvitePeopleRequest,
  PeopleListRequest,
  SetPeopleCompanyMembershipRequest,
} from '../../shared/people-api.ts';

interface PeopleCommandContext {
  readonly principal: TrustedPrincipalContext;
  readonly transport: { readonly correlationId: string; readonly idempotencyKey: string };
}

/*
 * "Lidé" organisation data of the Shell: the directory of the selected scope and the two writes that
 * describe a person's relationship to a company — the invitation that mints their login and the
 * affiliation/status an administrator records.
 *
 * No direct SQL / graph writes here: the Core registrations own authorization and evidence.
 *
 * Rights are deliberately absent from this module. A person's roles and their role assignments are
 * authority, and authority is only ever written through the canonical access-intent commands behind
 * the access-administration BFF (`api/access-admin/people.ts`, `AccessPeopleCommands`). This module
 * therefore publishes no role read and no role write: the Shell people surface reads roles and
 * assignments from that BFF and nowhere else.
 */

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

export const invitePeoplePerson = Effect.fn('invitePeoplePerson')(function* invitePeoplePerson(
  context: PeopleCommandContext,
  payload: InvitePeopleRequest,
) {
  const runtime = yield* ActionRuntime;
  const result = yield* runtime.runAction({ ...context, payload, registration: invitePersonAction });
  return yield* Schema.encodeEffect(invitePersonAction.descriptor.resultSchema)(result);
});
