import { Effect } from 'effect';

import {
  assignmentObjectId,
  capabilityObjectId,
  capabilitySlotRelation,
  grantObjectId,
  roleBindingObjectId,
} from '../../../packages/core-runtime/src/access/compiler/object-id.ts';
import type {
  AccessCheckItem,
  AccessCheckPermissionship,
  DecisionCheckPort,
} from '../../../packages/core-runtime/src/access/decision/engine.ts';
import { holderSubjectOf } from '../../../packages/core-runtime/src/access/decision/selector.ts';
import type {
  AccessScopeId,
  AssignmentIncarnationId,
  RoleId,
  TenantId,
} from '../../../packages/core-runtime/src/access/ids.ts';
import type { Cell, Holder } from '../../../packages/core-runtime/src/access/model.ts';
import { refuseInsideDatabaseTransaction } from '../../../packages/core-runtime/src/db/transaction-io-guard.ts';

interface DeclaredRoleProjection {
  readonly assignments: readonly { readonly holder: Holder; readonly incarnationId: AssignmentIncarnationId }[];
  readonly cells: readonly Cell[];
  readonly roleId: RoleId;
  readonly scopeId: AccessScopeId;
  readonly tenantId: TenantId;
}

const sameSubject = (left: AccessCheckItem['subject'], right: AccessCheckItem['subject']): boolean =>
  left.type === right.type && left.id === right.id && left.relation === right.relation;

/** Controlled engine transport, not SpiceDB: every assignee inherits every cell of the declared role. */
export const makeDeclaredRoleProjectionCheck = (
  input: DeclaredRoleProjection,
  calls: { calls: number },
): DecisionCheckPort => {
  const assignments = input.assignments.map((assignment) => ({
    id: assignmentObjectId(input.tenantId, input.scopeId, assignment.incarnationId),
    subject: holderSubjectOf(assignment.holder),
  }));
  const grants = input.cells.map((cell) => ({
    capability: capabilityObjectId(input.tenantId, input.scopeId, cell.capabilityKey),
    id: grantObjectId(input.tenantId, input.scopeId, input.roleId, cell),
    permission: cell.mode === 'approve' ? 'human_use' : 'use',
    slot: capabilitySlotRelation(cell),
  }));
  const binding = roleBindingObjectId(input.tenantId, input.scopeId, input.roleId);
  const answer = (item: AccessCheckItem): AccessCheckPermissionship => {
    if (item.resource.type === 'access_grant') {
      return grants.some((grant) => grant.id === item.resource.id && grant.permission === item.permission) &&
        assignments.some((assignment) => sameSubject(assignment.subject, item.subject))
        ? 'has'
        : 'none';
    }
    if (item.resource.type === 'access_capability') {
      return grants.some(
        (grant) =>
          grant.capability === item.resource.id &&
          grant.slot === item.permission &&
          item.subject.type === 'access_grant' &&
          item.subject.id === grant.id &&
          item.subject.relation === undefined,
      )
        ? 'has'
        : 'none';
    }
    if (item.resource.type === 'access_assignment') {
      return item.permission === 'eligible' &&
        assignments.some(
          (assignment) => assignment.id === item.resource.id && sameSubject(assignment.subject, item.subject),
        )
        ? 'has'
        : 'none';
    }
    if (item.resource.type === 'access_role_binding') {
      return item.resource.id === binding &&
        item.permission === 'member' &&
        item.subject.type === 'access_assignment' &&
        item.subject.relation === 'holder' &&
        assignments.some((assignment) => assignment.id === item.subject.id)
        ? 'has'
        : 'none';
    }
    return 'none';
  };
  return Object.freeze({
    checkBulk: (items: readonly AccessCheckItem[]) =>
      refuseInsideDatabaseTransaction('spicedb', 'owner-runner-declared-projection').pipe(
        Effect.andThen(
          Effect.sync(() => {
            calls.calls += 1;
          }),
        ),
        Effect.as(items.map((item) => ({ permissionship: answer(item) }))),
      ),
  });
};
