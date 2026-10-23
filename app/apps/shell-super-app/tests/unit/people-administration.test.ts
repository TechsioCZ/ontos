import {
  ActionAlreadyCommitted,
  ActionRuntime,
  PersonInvitationIdentityProvider,
  TrustedPrincipalContextSchema,
} from '@app/core-runtime';
import { Effect, Match, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  invitePeoplePerson,
  setPeopleCompanyMembership,
  setPeopleScopedRole,
} from '../../api/auth/people-administration.ts';
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

it.effect('keeps tenant role scope absent from trusted context and never infers scope from roleKey', () =>
  Effect.gen(function* testRole() {
    const { legalEntityId: _company, ...tenantPrincipal } = principal;
    const role = { roleKey: 'admin', scope: { _tag: 'tenant' }, tenantId: principal.tenantId } as const;
    const payload = { operation: 'assign', principalRef, reason: 'Správa tenantu', roleKey: 'admin' } as const;
    const double = makeActionRuntimeDouble([
      actionSuccess({ operation: 'assign', principalRef, projection: 'pending', role }),
    ]);
    const result = yield* setPeopleScopedRole({ principal: tenantPrincipal, transport }, payload).pipe(
      Effect.provideService(ActionRuntime, double.runtime),
    );
    expect(
      Match.value(result.role.scope).pipe(
        Match.tag('tenant', () => true),
        Match.orElse(() => false),
      ),
    ).toBe(true);
    expect(double.principals).toEqual([tenantPrincipal]);
    expect(double.payloads).toEqual([payload]);
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
      setPeopleScopedRole(
        { principal, transport },
        { operation: 'revoke', principalRef, reason: 'Odchod', roleKey: 'admin' },
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
  }),
);
