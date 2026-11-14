import { Effect, Option } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  assignmentObjectId,
  grantObjectId,
  roleBindingObjectId,
} from '../../packages/core-runtime/src/access/compiler/object-id.ts';
import type { AccessCheckItem } from '../../packages/core-runtime/src/access/decision/engine.ts';
import {
  AccessScopeIdSchema,
  AssignmentIncarnationIdSchema,
  CapabilityKeySchema,
  PrincipalIdSchema,
  RoleIdSchema,
  TenantIdSchema,
} from '../../packages/core-runtime/src/access/ids.ts';
import type { Cell } from '../../packages/core-runtime/src/access/model.ts';
import { makeDeclaredRoleProjectionCheck } from '../integration/support/declared-role-projection.ts';

const uid = (value: number) => `00000000-0000-4000-8000-${value.toString().padStart(12, '0')}`;
const tenantId = TenantIdSchema.make(uid(1));
const scopeId = AccessScopeIdSchema.make(uid(2));
const roleId = RoleIdSchema.make(uid(3));
const assignments = [4, 6].map((value) => ({
  holder: { _tag: 'Principal' as const, principalId: PrincipalIdSchema.make(uid(value)) },
  incarnationId: AssignmentIncarnationIdSchema.make(uid(value + 1)),
}));
const cells: readonly Cell[] = (['run', 'propose', 'approve'] as const).map((mode) => ({
  capabilityKey: CapabilityKeySchema.make('commerce.catalog.brand.create'),
  mode,
  selector: { _tag: 'all' },
}));
const projection = { assignments, cells, roleId, scopeId, tenantId };
const grantQueries = (): readonly AccessCheckItem[] =>
  assignments.flatMap(({ holder }) =>
    cells.map((cell) => ({
      permission: cell.mode === 'approve' ? 'human_use' : 'use',
      resource: { id: grantObjectId(tenantId, scopeId, roleId, cell), type: 'access_grant' },
      subject: { id: holder.principalId, type: 'principal' as const },
    })),
  );

it.effect('every assignee inherits every cell of the same declared role', () =>
  Effect.gen(function* sharedRoleGrants() {
    const calls = { calls: 0 };
    const results = yield* makeDeclaredRoleProjectionCheck(projection, calls).checkBulk(grantQueries());
    expect(results.map(({ permissionship }) => permissionship)).toEqual(['has', 'has', 'has', 'has', 'has', 'has']);
    expect(calls.calls).toBe(1);
  }),
);

it.effect('unknown holders, grants, relations and permissions do not inherit a role cell', () =>
  Effect.gen(function* unknownRoleAuthority() {
    const query = Option.getOrThrow(Option.fromUndefinedOr(grantQueries()[0]));
    const queries: readonly AccessCheckItem[] = [
      { ...query, subject: { id: uid(99), type: 'principal' } },
      { ...query, resource: { ...query.resource, id: 'foreign-grant' } },
      { ...query, permission: 'foreign-use' },
      { ...query, subject: { ...query.subject, relation: 'holder' } },
    ];
    const results = yield* makeDeclaredRoleProjectionCheck(projection, { calls: 0 }).checkBulk(queries);
    expect(results.map(({ permissionship }) => permissionship)).toEqual(['none', 'none', 'none', 'none']);
  }),
);

it.effect('assignment eligibility correlates the exact assignee and the exact role binding', () =>
  Effect.gen(function* exactRoleAssignment() {
    const first = Option.getOrThrow(Option.fromUndefinedOr(assignments[0]));
    const second = Option.getOrThrow(Option.fromUndefinedOr(assignments[1]));
    const assignmentId = assignmentObjectId(tenantId, scopeId, first.incarnationId);
    const eligible: AccessCheckItem = {
      permission: 'eligible',
      resource: { id: assignmentId, type: 'access_assignment' },
      subject: { id: first.holder.principalId, type: 'principal' },
    };
    const member: AccessCheckItem = {
      permission: 'member',
      resource: { id: roleBindingObjectId(tenantId, scopeId, roleId), type: 'access_role_binding' },
      subject: { id: assignmentId, relation: 'holder', type: 'access_assignment' },
    };
    const results = yield* makeDeclaredRoleProjectionCheck(projection, { calls: 0 }).checkBulk([
      eligible,
      member,
      { ...eligible, subject: { id: second.holder.principalId, type: 'principal' } },
      { ...member, subject: { ...member.subject, id: 'foreign-assignment' } },
      { ...member, resource: { ...member.resource, id: 'foreign-role' } },
    ]);
    expect(results.map(({ permissionship }) => permissionship)).toEqual(['has', 'has', 'none', 'none', 'none']);
  }),
);
