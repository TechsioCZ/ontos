import { v1 } from '@authzed/authzed-node';
import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  ContextPermissionMutationUnavailable,
  makeContextPermissionRelationshipMutation,
} from '../../src/permissions/context-permission-mutation.ts';
import { toContextPermissionAccessObjectId } from '../../src/permissions/context-access.ts';

const tenantId = '20000000-0000-4000-8000-000000000001';
const legalEntityId = '30000000-0000-4000-8000-000000000001';
const principalId = '40000000-0000-4000-8000-000000000001';
const target = { moduleId: 'inventory.stock', permission: 'rates.read' } as const;

it.effect('touches the exact tenant and grantee relationships idempotently for a grant', () =>
  Effect.gen(function* grantContextPermission() {
    const requests: v1.WriteRelationshipsRequest[] = [];
    const service = makeContextPermissionRelationshipMutation({
      writeRelationships: (request) =>
        Effect.sync(() => {
          requests.push(request);
          return v1.WriteRelationshipsResponse.create({});
        }),
    });
    yield* service.mutate({
      legalEntityId,
      operation: 'grant',
      principal: { principalId, tenantId },
      target,
      tenantId,
    });

    const expectedResourceId = toContextPermissionAccessObjectId(tenantId, legalEntityId, target);
    expect(requests).toHaveLength(1);
    expect(
      requests[0]?.updates.map(({ operation, relationship }) => ({
        operation,
        relation: relationship?.relation,
        resourceId: relationship?.resource?.objectId,
        resourceType: relationship?.resource?.objectType,
        subjectId: relationship?.subject?.object?.objectId,
        subjectType: relationship?.subject?.object?.objectType,
      })),
    ).toEqual([
      {
        operation: v1.RelationshipUpdate_Operation.TOUCH,
        relation: 'tenant',
        resourceId: expectedResourceId,
        resourceType: 'context_permission',
        subjectId: tenantId,
        subjectType: 'tenant',
      },
      {
        operation: v1.RelationshipUpdate_Operation.TOUCH,
        relation: 'grantee',
        resourceId: expectedResourceId,
        resourceType: 'context_permission',
        subjectId: principalId,
        subjectType: 'principal',
      },
    ]);
  }),
);

it.effect('deletes only the exact grantee relationship for a revoke', () =>
  Effect.gen(function* revokeContextPermission() {
    const requests: v1.WriteRelationshipsRequest[] = [];
    const service = makeContextPermissionRelationshipMutation({
      writeRelationships: (request) =>
        Effect.sync(() => {
          requests.push(request);
          return v1.WriteRelationshipsResponse.create({});
        }),
    });
    yield* service.mutate({
      operation: 'revoke',
      principal: { principalId, tenantId },
      target,
      tenantId,
    });

    const expectedResourceId = toContextPermissionAccessObjectId(tenantId, undefined, target);
    expect(
      requests[0]?.updates.map(({ operation, relationship }) => ({
        operation,
        relation: relationship?.relation,
        resourceId: relationship?.resource?.objectId,
        resourceType: relationship?.resource?.objectType,
        subjectId: relationship?.subject?.object?.objectId,
        subjectType: relationship?.subject?.object?.objectType,
      })),
    ).toEqual([
      {
        operation: v1.RelationshipUpdate_Operation.DELETE,
        relation: 'grantee',
        resourceId: expectedResourceId,
        resourceType: 'context_permission',
        subjectId: principalId,
        subjectType: 'principal',
      },
    ]);
  }),
);

it.effect('fails closed before transport for cross-tenant or invalid context scope', () =>
  Effect.gen(function* rejectInvalidScope() {
    let calls = 0;
    const service = makeContextPermissionRelationshipMutation({
      writeRelationships: () => {
        calls += 1;
        return Effect.succeed(v1.WriteRelationshipsResponse.create({}));
      },
    });
    const crossTenant = yield* Effect.flip(
      service.mutate({
        operation: 'grant',
        principal: {
          principalId,
          tenantId: '50000000-0000-4000-8000-000000000001',
        },
        target,
        tenantId,
      }),
    );
    const invalidTarget = yield* Effect.flip(
      service.mutate({
        operation: 'grant',
        principal: { principalId, tenantId },
        target: { moduleId: '', permission: target.permission },
        tenantId,
      }),
    );

    expect(crossTenant).toBeInstanceOf(ContextPermissionMutationUnavailable);
    expect(invalidTarget).toBeInstanceOf(ContextPermissionMutationUnavailable);
    expect(calls).toBe(0);
  }),
);

it.effect('sanitizes relationship client diagnostics', () =>
  Effect.gen(function* sanitizeDiagnostics() {
    const service = makeContextPermissionRelationshipMutation({
      writeRelationships: () =>
        Effect.fail(
          Object.defineProperty(
            new ContextPermissionMutationUnavailable({
              reason: 'The context permission relationship mutation could not be completed safely',
            }),
            'cause',
            { value: new Error('secret-spicedb-key') },
          ),
        ),
    });
    const failure = yield* Effect.flip(
      service.mutate({
        operation: 'grant',
        principal: { principalId, tenantId },
        target,
        tenantId,
      }),
    );

    expect(`${failure._tag}:${failure.reason}`).not.toContain('secret-spicedb-key');
    expect(failure.reason).toBe(
      'The context permission relationship mutation could not be completed safely',
    );
  }),
);
