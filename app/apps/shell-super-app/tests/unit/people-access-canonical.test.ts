import { Effect, Schema } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { expect, it } from 'effect-rstest';

import {
  AccessAdminConflictProblemSchema,
  AccessAdminForbiddenProblemSchema,
  AccessCompanyIdSchema,
  AccessHumanIdSchema,
  AccessRoleIdSchema,
  AccessRoleRevisionIdSchema,
  AccessAssignmentIdSchema,
  AccessPeopleRevisionSchema,
  AccessAssignmentSchema,
} from '../../shared/access-admin-api.ts';
import type {
  AccessPeopleMutationResponse,
  AssignAccessRolePayload,
  ListAccessPeopleOptionsResponse,
  ListAccessPeoplePayload,
  ListAccessPeopleResponse,
  RevokeAccessAssignmentPayload,
} from '../../shared/access-admin-api.ts';
import { changePersonRole, loadPeopleAccess } from '../../src/routes/people/people-client.ts';
import type { PeopleAccessReadPort, PersonRoleMutationPort } from '../../src/routes/people/people-client.ts';

/*
 * The canonical role path of the Shell people surface. Roles and role assignments are access intent, so
 * this surface reads them from the access administration BFF and writes them through `AccessPeopleCommands`
 * — never through a role key, never through a graph relationship of its own, and never by echoing a commit
 * response as if it were the authority's answer.
 *
 * The BFF is a scripted port here, so a failure of this module's wiring cannot hide behind the BFF's own
 * rules; the rules themselves are proved by the access administration suites.
 */

const companyId = AccessCompanyIdSchema.make('00000000-0000-4000-8000-000000000002');
const principalId = AccessHumanIdSchema.make('00000000-0000-4000-8000-000000000003');
const secondPrincipalId = AccessHumanIdSchema.make('00000000-0000-4000-8000-000000000004');
const roleId = AccessRoleIdSchema.make('00000000-0000-4000-8000-0000000000a1');
const roleRevisionId = AccessRoleRevisionIdSchema.make('00000000-0000-4000-8000-0000000000b1');
const incarnationId = AccessAssignmentIdSchema.make('00000000-0000-4000-8000-0000000000c1');
const revision = AccessPeopleRevisionSchema.make('people-revision-1');
const companyScope = { kind: 'company', legalEntityId: companyId } as const;

const accessRole = {
  capabilityKeys: [],
  latestRevisionId: roleRevisionId,
  name: 'Obchodník',
  risk: 'sensitive',
  roleId,
  scope: companyScope,
} as const;
const accessOptions: ListAccessPeopleOptionsResponse = {
  admissionCandidates: [],
  capabilities: [],
  managers: [],
  people: [],
  revision,
  roles: [accessRole],
  scopes: [{ label: 'Firma', scope: companyScope }],
  teams: [],
  writeAvailability: {
    canAdmitMember: false,
    canAssign: true,
    canDelegate: false,
    canEndMembership: false,
    canManageTeams: false,
    canRevokeDelegation: false,
    canTransferOwnership: false,
    canUnassign: true,
  },
};
const assignment = Schema.decodeUnknownSync(AccessAssignmentSchema)({
  incarnationId,
  principalId,
  roleId,
  roleName: 'Obchodník',
  scope: companyScope,
  status: 'active',
  validFrom: '2026-01-01T00:00:00.000Z',
  validUntil: null,
});
const accessPerson = (
  id: typeof principalId,
  assignments: ListAccessPeopleResponse['items'][number]['assignments'],
) => ({
  assignments,
  delegations: [],
  displayName: 'Jana Nováková',
  memberships: [],
  ownership: { administersScopes: [], soleAdministratorScopes: [] },
  principalId: id,
  suspended: false,
  teams: [],
});
const pageOf = (items: ListAccessPeopleResponse['items'], nextCursor: string | null): ListAccessPeopleResponse => ({
  items,
  nextCursor,
  revision,
});

const conflict = AccessAdminConflictProblemSchema.make({
  detail: 'stale',
  status: 409,
  title: 'Conflict',
  type: 'https://ontos.dev/problems/access-admin-conflict',
});
const forbidden = AccessAdminForbiddenProblemSchema.make({
  detail: 'not available',
  status: 403,
  title: 'Forbidden',
  type: 'https://ontos.dev/problems/access-admin-forbidden',
});

it.layer(FetchHttpClient.layer)((test) => {
  test.effect('reads the released role choices and every page of canonical assignments, never a role key', () =>
    Effect.gen(function* readCanonicalAccess() {
      const asked: ListAccessPeoplePayload[] = [];
      const port: PeopleAccessReadPort = {
        list: (payload) => {
          asked.push(payload);
          return Effect.succeed(
            payload.cursor === undefined
              ? pageOf([accessPerson(principalId, [assignment])], 'cursor-2')
              : pageOf([accessPerson(secondPrincipalId, [])], null),
          );
        },
        options: () => Effect.succeed(accessOptions),
      };
      const outcome = yield* loadPeopleAccess('company', companyId, port);
      expect(outcome).toEqual({
        status: 'ok',
        value: {
          options: accessOptions,
          people: {
            items: [accessPerson(principalId, [assignment]), accessPerson(secondPrincipalId, [])],
            nextCursor: null,
            revision,
          },
        },
      });
      expect(asked).toEqual([
        { limit: 100, scope: companyScope },
        { cursor: 'cursor-2', limit: 100, scope: companyScope },
      ]);
    }),
  );

  test.effect('a refused authority read is a denial, never a smaller or invented answer', () =>
    Effect.gen(function* refusedAccessRead() {
      const outcome = yield* loadPeopleAccess('company', companyId, {
        list: () => Effect.fail(forbidden),
        options: () => Effect.fail(forbidden),
      });
      expect(outcome).toEqual({ message: 'K této správě nemáte oprávnění.', status: 'failed' });
    }),
  );

  test.effect('an assign names the role identity, the screen revision and the role revision, with a fresh key', () =>
    Effect.gen(function* assignCanonicalRole() {
      const keys: string[] = [];
      let sent: AssignAccessRolePayload | undefined;
      const assign = (payload: AssignAccessRolePayload, options: { readonly idempotencyKey: string }) => {
        sent = payload;
        keys.push(options.idempotencyKey);
        return Effect.succeed<AccessPeopleMutationResponse>({
          assignment,
          revision: AccessPeopleRevisionSchema.make('people-revision-2'),
        });
      };
      const revoke = () => Effect.succeed<AccessPeopleMutationResponse>({ revision });
      const payload: AssignAccessRolePayload = {
        expectedRevision: revision,
        expectedRoleRevisionId: roleRevisionId,
        principalId,
        roleId,
        scope: companyScope,
      };
      const outcome = yield* changePersonRole({ operation: 'assign', payload }, { assign, revoke });
      expect(outcome).toEqual({
        status: 'ok',
        value: { change: { incarnationId, present: true, principalId }, kind: 'role' },
      });
      expect(sent).toEqual(payload);
      expect(keys).toHaveLength(1);
      expect(keys[0]).toMatch(/^[\da-f-]{36}$/u);
    }),
  );

  test.effect('a revoke names the exact assignment incarnation and the reason, never a role key', () =>
    Effect.gen(function* revokeCanonicalRole() {
      const keys: string[] = [];
      let sent: RevokeAccessAssignmentPayload | undefined;
      const revoke = (payload: RevokeAccessAssignmentPayload, options: { readonly idempotencyKey: string }) => {
        sent = payload;
        keys.push(options.idempotencyKey);
        return Effect.succeed<AccessPeopleMutationResponse>({
          assignment: { ...assignment, status: 'revoked' },
          revision: AccessPeopleRevisionSchema.make('people-revision-2'),
        });
      };
      const assign = () => Effect.succeed<AccessPeopleMutationResponse>({ revision });
      const payload: RevokeAccessAssignmentPayload = { expectedRevision: revision, incarnationId, reason: 'Odchod' };
      const outcome = yield* changePersonRole({ operation: 'revoke', payload }, { assign, revoke });
      expect(outcome).toEqual({
        status: 'ok',
        value: { change: { incarnationId, present: false, principalId }, kind: 'role' },
      });
      expect(sent).toEqual(payload);
      expect(keys[0]).toMatch(/^[\da-f-]{36}$/u);
    }),
  );

  test.effect('a commit response without the canonical assignment is never reported as a completed change', () =>
    Effect.gen(function* noAssignmentEcho() {
      const port: PersonRoleMutationPort = {
        assign: () =>
          Effect.succeed<AccessPeopleMutationResponse>({
            revision: AccessPeopleRevisionSchema.make('people-revision-2'),
          }),
        revoke: () => Effect.succeed<AccessPeopleMutationResponse>({ revision }),
      };
      const outcome = yield* changePersonRole(
        {
          operation: 'assign',
          payload: {
            expectedRevision: revision,
            expectedRoleRevisionId: roleRevisionId,
            principalId,
            roleId,
            scope: companyScope,
          },
        },
        port,
      );
      expect(outcome).toEqual({ message: 'Změnu role nelze ověřit. Obnovte seznam.', status: 'failed' });
    }),
  );

  test.effect('a conflict on the canonical write is reported as a conflict, never as a silent success', () =>
    Effect.gen(function* conflictedWrite() {
      const outcome = yield* changePersonRole(
        {
          operation: 'assign',
          payload: {
            expectedRevision: revision,
            expectedRoleRevisionId: roleRevisionId,
            principalId,
            roleId,
            scope: companyScope,
          },
        },
        {
          assign: () => Effect.fail(conflict),
          revoke: () => Effect.succeed<AccessPeopleMutationResponse>({ revision }),
        },
      );
      expect(outcome).toEqual({
        message: 'Požadavek už byl přijat nebo se údaje změnily. Obnovte seznam před další změnou.',
        status: 'failed',
      });
    }),
  );
});
