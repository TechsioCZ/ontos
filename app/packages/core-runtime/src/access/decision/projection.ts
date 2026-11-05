import {
  assignmentObjectId,
  capabilityObjectId,
  grantObjectId,
  recordObjectId,
  roleBindingObjectId,
} from '../compiler/object-id.ts';
import type { Cell } from '../model.ts';
import type { AccessRecordTarget } from './contract.ts';

/**
 * Object identity of the v2 projection, derived from intent by the Core compiler. The decision
 * engine and the compiler must name the same objects, so this is the one place the decision path
 * asks for their IDs (lossless, scope-qualified, never hashed).
 */
export interface ProjectionScope {
  readonly scopeId: string;
  readonly tenantId: string;
}

export const projectionScopeOf = (scope: { readonly scopeId: string; readonly tenantId: string }): ProjectionScope => ({
  scopeId: scope.scopeId,
  tenantId: scope.tenantId,
});

export const capabilityObjectIdOf = (scope: ProjectionScope, capabilityKey: string): string =>
  capabilityObjectId(scope.tenantId, scope.scopeId, capabilityKey);

export interface ProjectedGrantCell extends Cell {
  readonly assignmentIncarnationId: string;
  readonly roleId: string;
}

export const grantObjectIdOf = (scope: ProjectionScope, cell: ProjectedGrantCell): string =>
  grantObjectId(scope.tenantId, scope.scopeId, cell.roleId, cell);

/** The immutable assignment incarnation whose witness the decision names (D30). */
export const assignmentObjectIdOf = (scope: ProjectionScope, cell: ProjectedGrantCell): string =>
  assignmentObjectId(scope.tenantId, scope.scopeId, cell.assignmentIncarnationId);

/** One binding per role and scope; the witness proves the assignment is a member of this binding. */
export const roleBindingObjectIdOf = (scope: ProjectionScope, cell: ProjectedGrantCell): string =>
  roleBindingObjectId(scope.tenantId, scope.scopeId, cell.roleId);

/**
 * One business record, named exactly as the owner's record projection names it (H3, D32). A raw
 * record key never becomes an object ID: the same key in another tenant, scope or module is another
 * object, so a target check can only prove the record inside the scope the decision was resolved in.
 */
export const recordObjectIdOf = (scope: ProjectionScope, target: AccessRecordTarget): string =>
  recordObjectId(scope.tenantId, scope.scopeId, target.moduleKey, target.recordKey);
