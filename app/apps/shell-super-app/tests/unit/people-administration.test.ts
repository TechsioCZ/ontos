import { NodeCrypto } from '@effect/platform-node';
import {
  ActionAlreadyCommitted,
  ActionRuntime,
  PersonInvitationIdentityProvider,
  TrustedPrincipalContextSchema,
} from '@app/core-runtime';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { invitePeoplePerson, setPeopleCompanyMembership } from '../../api/auth/people-administration.ts';
import { actionCoreFailure, actionSuccess, makeActionRuntimeDouble } from '../support/action-runtime-double.ts';

const principal = Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
  authBindingId: '00000000-0000-4000-8000-000000000005',
  authContextRef: 'better-auth-session:people-test',
  authenticationNamespaceId: 'test.staff.better-auth.v1',
  authMethod: 'session',
  legalEntityId: '00000000-0000-4000-8000-000000000002',
  principalId: '00000000-0000-4000-8000-000000000003',
  tenantId: '00000000-0000-4000-8000-000000000001',
});
const principalRef = { principalId: '00000000-0000-4000-8000-000000000004', tenantId: principal.tenantId };
const transport = { correlationId: 'people-command', idempotencyKey: 'unique-command' };
const membership = {
  affiliation: 'external',
  legalEntityId: '00000000-0000-4000-8000-000000000002',
  principalRef,
  revision: 1,
  status: 'invited',
} as const;

it.effect('runs company membership through the sensitive Core Action and returns pending, not projected success', () =>
  Effect.gen(function* testMembership() {
    const double = makeActionRuntimeDouble([actionSuccess(membership)]);
    const payload = {
      affiliation: 'external',
      expectedRevision: 0,
      principalRef,
      reason: 'Pozvání kolegy',
      status: 'invited',
    } as const;
    const result = yield* setPeopleCompanyMembership({ principal, transport }, payload).pipe(
      Effect.provideService(ActionRuntime, double.runtime),
    );
    expect(result).toEqual({ membership, projection: 'pending' });
    expect(double.payloads).toEqual([payload]);
    expect(double.principals).toEqual([principal]);
  }),
);

it.effect('does not turn ActionAlreadyCommitted into a second success or rerun a sensitive mutation', () =>
  Effect.gen(function* testCommitted() {
    const committed = new ActionAlreadyCommitted({
      code: 'action_already_committed',
      invocationId: '00000000-0000-4000-8000-000000000005',
      reason: 'Already committed',
    });
    const double = makeActionRuntimeDouble([actionCoreFailure(committed)]);
    const failure = yield* Effect.flip(
      setPeopleCompanyMembership(
        { principal, transport },
        { affiliation: 'external', expectedRevision: 1, principalRef, reason: 'Odchod', status: 'departed' },
      ).pipe(Effect.provideService(ActionRuntime, double.runtime)),
    );
    expect(failure).toEqual(committed);
    expect(double.invocationCount()).toBe(1);
  }),
);

it.effect('runs the real invite Action with trusted selected company and returns only durable pending intent', () =>
  Effect.gen(function* inviteCoreBoundary() {
    const invitation = {
      delivery: 'pending',
      invitationId: '00000000-0000-4000-8000-000000000009',
      membership,
      principalRef,
    } as const;
    const double = makeActionRuntimeDouble([actionSuccess(invitation)]);
    const payload = { affiliation: 'external', displayName: 'Jana', email: 'jana@example.test' } as const;
    const outcome = yield* invitePeoplePerson({ principal, transport }, payload).pipe(
      Effect.provideService(PersonInvitationIdentityProvider, {
        fromTransaction: () => ({
          provision: () => Effect.die('Action runtime double must not invoke native identity writer'),
        }),
      }),
      Effect.provideService(ActionRuntime, double.runtime),
    );
    expect(outcome).toEqual(invitation);
    expect(double.payloads).toEqual([payload]);
    expect(double.principals).toEqual([principal]);
    expect(double.invocationCount()).toBe(1);
  }).pipe(Effect.provide(NodeCrypto.layer)),
);
