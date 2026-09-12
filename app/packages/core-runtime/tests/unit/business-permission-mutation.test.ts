import { v1 } from '@authzed/authzed-node';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { BusinessPermissionCodeSchema } from '../../src/permissions/business-permission.ts';
import {
  BusinessPermissionMutationUnavailable,
  makeBusinessPermissionRelationshipMutation,
} from '../../src/permissions/business-permission-mutation.ts';

const permission = Schema.decodeSync(BusinessPermissionCodeSchema)('counterparty.access.manage');
const tenantId = '20000000-0000-4000-8000-000000000001';
const legalEntityId = '30000000-0000-4000-8000-000000000001';
const principalId = '40000000-0000-4000-8000-000000000001';

it.effect('writes the exact legal-entity and grantee relationships idempotently for a grant', () =>
  Effect.gen(function* grantBusinessPermission() {
    const requests: v1.WriteRelationshipsRequest[] = [];
    const service = makeBusinessPermissionRelationshipMutation({
      writeRelationships: (request) =>
        Effect.sync(() => {
          requests.push(request);
          return v1.WriteRelationshipsResponse.create({});
        }),
    });
    yield* service.mutate({
      operation: 'grant',
      permission,
      principal: { principalId, tenantId },
      target: {
        counterpartyId: 'counterparty-one',
        kind: 'counterparty',
        legalEntityId,
        tenantId,
      },
    });
    expect(requests).toHaveLength(1);
    expect(
      requests[0]?.updates.map(({ operation, relationship }) => ({
        operation,
        relation: relationship?.relation,
        resourceType: relationship?.resource?.objectType,
        subjectType: relationship?.subject?.object?.objectType,
      })),
    ).toEqual([
      {
        operation: v1.RelationshipUpdate_Operation.TOUCH,
        relation: 'legal_entity',
        resourceType: 'business_permission',
        subjectType: 'legal_entity',
      },
      {
        operation: v1.RelationshipUpdate_Operation.TOUCH,
        relation: 'grantee',
        resourceType: 'business_permission',
        subjectType: 'principal',
      },
    ]);
  }),
);

it.effect('uses an idempotent delete and retains the scope relationship for revoke recovery', () =>
  Effect.gen(function* revokeBusinessPermission() {
    const requests: v1.WriteRelationshipsRequest[] = [];
    const service = makeBusinessPermissionRelationshipMutation({
      writeRelationships: (request) =>
        Effect.sync(() => {
          requests.push(request);
          return v1.WriteRelationshipsResponse.create({});
        }),
    });
    yield* service.mutate({
      operation: 'revoke',
      permission,
      principal: { principalId, tenantId },
      target: {
        counterpartyId: 'counterparty-one',
        kind: 'counterparty',
        legalEntityId,
        tenantId,
      },
    });
    expect(requests[0]?.updates).toHaveLength(1);
    expect(requests[0]?.updates[0]?.operation).toBe(v1.RelationshipUpdate_Operation.DELETE);
    expect(requests[0]?.updates[0]?.relationship?.relation).toBe('grantee');
  }),
);

it.effect('fails closed before transport for cross-tenant or untrusted storefront input', () =>
  Effect.gen(function* rejectUntrustedScope() {
    let calls = 0;
    const service = makeBusinessPermissionRelationshipMutation({
      writeRelationships: () => {
        calls += 1;
        return Effect.succeed(v1.WriteRelationshipsResponse.create({}));
      },
    });
    const crossTenant = yield* Effect.flip(
      service.mutate({
        operation: 'grant',
        permission,
        principal: { principalId, tenantId: '50000000-0000-4000-8000-000000000001' },
        target: {
          counterpartyId: 'counterparty-one',
          kind: 'counterparty',
          legalEntityId,
          tenantId,
        },
      }),
    );
    const untrustedStorefront = yield* Effect.flip(
      service.mutate({
        operation: 'grant',
        permission,
        principal: { principalId, tenantId },
        target: {
          counterpartyId: 'counterparty-one',
          kind: 'counterparty_storefront',
          legalEntityId,
          storefrontId: 'store-one',
          tenantId,
        },
      }),
    );
    expect(crossTenant).toBeInstanceOf(BusinessPermissionMutationUnavailable);
    expect(untrustedStorefront).toBeInstanceOf(BusinessPermissionMutationUnavailable);
    expect(calls).toBe(0);
  }),
);

it.effect('sanitizes relationship client diagnostics', () =>
  Effect.gen(function* sanitizeDiagnostics() {
    const service = makeBusinessPermissionRelationshipMutation({
      writeRelationships: () =>
        Effect.fail(
          Object.defineProperty(
            new BusinessPermissionMutationUnavailable({
              reason: 'The business permission relationship mutation could not be completed safely',
            }),
            'cause',
            { value: new Error('secret-spicedb-key') },
          ),
        ),
    });
    const failure = yield* Effect.flip(
      service.mutate({
        operation: 'grant',
        permission,
        principal: { principalId, tenantId },
        target: {
          counterpartyId: 'counterparty-one',
          kind: 'counterparty',
          legalEntityId,
          tenantId,
        },
      }),
    );
    expect(`${failure._tag}:${failure.reason}`).not.toContain('secret-spicedb-key');
    expect(failure.reason).toBe('The business permission relationship mutation could not be completed safely');
  }),
);
