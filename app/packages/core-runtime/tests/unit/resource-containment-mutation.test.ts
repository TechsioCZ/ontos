import { v1 } from '@authzed/authzed-node';
import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  makeResourceContainmentRelationshipMutation,
  ResourceContainmentMutationUnavailable,
} from '../../src/permissions/resource-containment-mutation.ts';

const relationship = (suffix: string) => ({
  container: { objectId: `catalog_${suffix}`, objectType: 'business_permission' },
  relation: 'containing_catalog',
  resource: { objectId: `group_${suffix}`, objectType: 'business_permission' },
});

it.effect('touches a non-empty containment set atomically in one idempotent request', () =>
  Effect.gen(function* touchAtomicContainmentSet() {
    const requests: v1.WriteRelationshipsRequest[] = [];
    const service = makeResourceContainmentRelationshipMutation({
      writeRelationships: (request) =>
        Effect.sync(() => {
          requests.push(request);
          return v1.WriteRelationshipsResponse.create({});
        }),
    });
    yield* service.touch({ relationships: [relationship('read'), relationship('retire')] });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.updates).toHaveLength(2);
    expect(requests[0]?.updates.every(({ operation }) => operation === v1.RelationshipUpdate_Operation.TOUCH)).toBe(
      true,
    );
    expect(
      requests[0]?.updates.map(({ relationship: written }) => ({
        relation: written?.relation,
        resource: written?.resource,
        subject: written?.subject?.object,
      })),
    ).toEqual([
      {
        relation: 'containing_catalog',
        resource: v1.ObjectReference.create({ objectId: 'group_read', objectType: 'business_permission' }),
        subject: v1.ObjectReference.create({ objectId: 'catalog_read', objectType: 'business_permission' }),
      },
      {
        relation: 'containing_catalog',
        resource: v1.ObjectReference.create({ objectId: 'group_retire', objectType: 'business_permission' }),
        subject: v1.ObjectReference.create({ objectId: 'catalog_retire', objectType: 'business_permission' }),
      },
    ]);
  }),
);

it.effect('fails closed before transport for duplicates or invalid topology identities', () =>
  Effect.gen(function* rejectInvalidTopology() {
    let calls = 0;
    const service = makeResourceContainmentRelationshipMutation({
      writeRelationships: () => {
        calls += 1;
        return Effect.succeed(v1.WriteRelationshipsResponse.create({}));
      },
    });
    const duplicate = relationship('read');
    const duplicateFailure = yield* Effect.flip(service.touch({ relationships: [duplicate, duplicate] }));
    const invalidFailure = yield* Effect.flip(
      service.touch({ relationships: [{ ...relationship('read'), relation: 'Invalid relation' }] }),
    );
    const granteeFailure = yield* Effect.flip(
      service.touch({
        relationships: [
          {
            container: { objectId: 'principal_one', objectType: 'principal' },
            relation: 'grantee',
            resource: relationship('read').resource,
          },
        ],
      }),
    );
    expect(duplicateFailure).toBeInstanceOf(ResourceContainmentMutationUnavailable);
    expect(invalidFailure).toBeInstanceOf(ResourceContainmentMutationUnavailable);
    expect(granteeFailure).toBeInstanceOf(ResourceContainmentMutationUnavailable);
    expect(calls).toBe(0);
  }),
);
