/**
 * Agent operators: which person principals may operate an agent principal (`principal:{agent}#operate`).
 * A person may connect an agent only while `operate` holds, i.e. the operator relation AND the operator's
 * tenant access. Writes go through the same SpiceDB RPC port the other demo grant helpers use.
 */
import {
  ObjectReference,
  Relationship,
  RelationshipUpdate,
  RelationshipUpdate_Operation,
  SubjectReference,
} from '@authzed/authzed-node/v1/core';
import {
  CheckPermissionRequest,
  CheckPermissionResponse_Permissionship,
  Consistency,
  ReadRelationshipsRequest,
  RelationshipFilter,
  WriteRelationshipsRequest,
} from '@authzed/authzed-node/v1/permissions';
import { openSpiceDbRpc } from './spicedb-transaction-guard.ts';
import { Effect } from 'effect';

import { IdentityPersistenceUnavailableError } from '../auth/principal-management-errors.ts';
import { loadSpiceDbConfig } from './config.ts';
import type { SpiceDbRpc } from './spicedb-rpc.ts';

const unavailable = (cause: unknown) =>
  Object.defineProperty(
    new IdentityPersistenceUnavailableError({
      code: 'identity_persistence_unavailable',
      reason: 'Agent operators are temporarily unavailable',
    }),
    'cause',
    { configurable: true, value: cause },
  );
const fullyConsistent = Consistency.create({ requirement: { fullyConsistent: true, oneofKind: 'fullyConsistent' } });
const principalObject = (principalId: string) =>
  ObjectReference.create({ objectId: principalId, objectType: 'principal' });

/** Pure: which operator relations to add and remove to reach `desired`. */
export const operatorChanges = (current: readonly string[], desired: readonly string[]) => {
  const wanted = new Set(desired);
  const existing = new Set(current);
  return { add: [...wanted].filter((id) => !existing.has(id)), remove: [...existing].filter((id) => !wanted.has(id)) };
};

export interface PrincipalOperators {
  /** `principal:{agent}#operate@principal:{operator}` (operator relation AND operator's tenant access). */
  readonly canOperate: (
    agentPrincipalId: string,
    operatorPrincipalId: string,
  ) => Effect.Effect<boolean, IdentityPersistenceUnavailableError>;
  readonly operatorsOf: (
    agentPrincipalId: string,
  ) => Effect.Effect<readonly string[], IdentityPersistenceUnavailableError>;
  /** Writes `principal:{agent}#tenant@tenant:{tenantId}` and makes `operatorPrincipalIds` the complete operator set. */
  readonly replaceOperators: (input: {
    readonly agentPrincipalId: string;
    readonly operatorPrincipalIds: readonly string[];
    readonly tenantId: string;
  }) => Effect.Effect<{ readonly added: number; readonly removed: number }, IdentityPersistenceUnavailableError>;
}

const makeOperators = (rpc: SpiceDbRpc): PrincipalOperators => {
  const operatorsOf = (agentPrincipalId: string) =>
    rpc
      .readRelationships(
        ReadRelationshipsRequest.create({
          consistency: fullyConsistent,
          relationshipFilter: RelationshipFilter.create({
            optionalRelation: 'operator',
            optionalResourceId: agentPrincipalId,
            resourceType: 'principal',
          }),
        }),
      )
      .pipe(
        Effect.map((responses) =>
          responses.flatMap(({ relationship }) =>
            relationship?.subject?.object === undefined ? [] : [relationship.subject.object.objectId],
          ),
        ),
        Effect.mapError(unavailable),
      );

  return {
    canOperate: (agentPrincipalId, operatorPrincipalId) =>
      rpc
        .checkPermission(
          CheckPermissionRequest.create({
            consistency: fullyConsistent,
            permission: 'operate',
            resource: principalObject(agentPrincipalId),
            subject: SubjectReference.create({ object: principalObject(operatorPrincipalId) }),
          }),
        )
        .pipe(
          Effect.map((response) => response.permissionship === CheckPermissionResponse_Permissionship.HAS_PERMISSION),
          Effect.mapError(unavailable),
        ),
    operatorsOf,
    replaceOperators: Effect.fn('PrincipalOperators.replaceOperators')(function* replaceOperators(input) {
      const current = yield* operatorsOf(input.agentPrincipalId);
      const { add, remove } = operatorChanges(current, input.operatorPrincipalIds);
      const resource = principalObject(input.agentPrincipalId);
      const relationUpdate = (
        operation: RelationshipUpdate_Operation,
        relation: string,
        objectId: string,
        objectType: string,
      ) =>
        RelationshipUpdate.create({
          operation,
          relationship: Relationship.create({
            relation,
            resource,
            subject: SubjectReference.create({ object: ObjectReference.create({ objectId, objectType }) }),
          }),
        });
      const updates = [
        relationUpdate(RelationshipUpdate_Operation.TOUCH, 'tenant', input.tenantId, 'tenant'),
        ...add.map((id) => relationUpdate(RelationshipUpdate_Operation.TOUCH, 'operator', id, 'principal')),
        ...remove.map((id) => relationUpdate(RelationshipUpdate_Operation.DELETE, 'operator', id, 'principal')),
      ];
      yield* rpc.writeRelationships(WriteRelationshipsRequest.create({ updates })).pipe(Effect.mapError(unavailable));
      return { added: add.length, removed: remove.length };
    }),
  };
};

/** Scoped SpiceDB connection for agent operator grants, closed when the scope ends. */
export const openPrincipalOperators = Effect.acquireRelease(
  loadSpiceDbConfig().pipe(
    Effect.mapError(unavailable),
    Effect.flatMap((configuration) =>
      Effect.try({ catch: unavailable, try: () => openSpiceDbRpc(configuration, 10_000) }),
    ),
  ),
  (rpc) => Effect.sync(() => rpc.close()),
).pipe(Effect.map(makeOperators));
