import { v1 } from '@authzed/authzed-node';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  ServiceGrantError,
  desiredServiceGrants,
  reconcileServiceGrants,
  serviceGrantMemberships,
} from '../demo/reconcile-stage-service-grants.mts';
import type { ServiceGrantRpc } from '../demo/reconcile-stage-service-grants.mts';

const desired = desiredServiceGrants([{ actionKey: 'work.tasks.apply-command', provisioning: 'explicit' }]);
const memoryRelationships = (initial: readonly v1.Relationship[]) => {
  const stored = new Map(initial.map((relationship) => [v1.Relationship.toJsonString(relationship), relationship]));
  const writes: v1.WriteRelationshipsRequest[] = [];
  const rpc: ServiceGrantRpc = {
    readRelationships: (request) =>
      Effect.sync(() => {
        const filter = request.relationshipFilter;
        return [...stored.values()]
          .filter(
            (relationship) =>
              filter !== undefined &&
              relationship.resource?.objectType === filter.resourceType &&
              relationship.resource?.objectId === filter.optionalResourceId &&
              relationship.relation === filter.optionalRelation &&
              relationship.subject?.object?.objectType === filter.optionalSubjectFilter?.subjectType &&
              relationship.subject?.object?.objectId === filter.optionalSubjectFilter?.optionalSubjectId,
          )
          .map((relationship) => v1.ReadRelationshipsResponse.create({ relationship }));
      }),
    writeRelationships: (request) =>
      Effect.sync(() => {
        writes.push(request);
        for (const update of request.updates) {
          expect(update.operation).toBe(v1.RelationshipUpdate_Operation.TOUCH);
          if (update.relationship !== undefined) {
            stored.set(v1.Relationship.toJsonString(update.relationship), update.relationship);
          }
        }
        return v1.WriteRelationshipsResponse.create({});
      }),
  };
  return { rpc, writes };
};

it.effect('fails closed without any writes when one existing service membership is absent', () =>
  Effect.gen(function* membershipGap() {
    const state = memoryRelationships(serviceGrantMemberships().slice(1));
    const error = yield* reconcileServiceGrants(state.rpc, desired, 'apply').pipe(Effect.flip);
    expect(Schema.is(ServiceGrantError)(error)).toBe(true);
    expect(state.writes).toHaveLength(0);
  }),
);
it.effect('check is a read-only diff and verify refuses missing source grants', () =>
  Effect.gen(function* readOnlyDiff() {
    const state = memoryRelationships(serviceGrantMemberships());
    const result = yield* reconcileServiceGrants(state.rpc, desired, 'check');
    expect(result.missing).toBeGreaterThan(0);
    expect(state.writes).toHaveLength(0);
    expect(
      Schema.is(ServiceGrantError)(yield* reconcileServiceGrants(state.rpc, desired, 'verify').pipe(Effect.flip)),
    ).toBe(true);
    expect(state.writes).toHaveLength(0);
  }),
);
it.effect('applies only missing tuples, verifies them and is idempotent on repeated apply', () =>
  Effect.gen(function* applyAndVerify() {
    const state = memoryRelationships(serviceGrantMemberships());
    const first = yield* reconcileServiceGrants(state.rpc, desired, 'apply');
    expect(first.applied).toBeGreaterThan(0);
    expect(first.missing).toBe(0);
    expect(state.writes).toHaveLength(1);
    expect((yield* reconcileServiceGrants(state.rpc, desired, 'apply')).applied).toBe(0);
    expect((yield* reconcileServiceGrants(state.rpc, desired, 'verify')).missing).toBe(0);
    expect(state.writes).toHaveLength(1);
  }),
);
it.effect('a conditional membership never authorizes reconciliation', () =>
  Effect.gen(function* conditionalMembership() {
    const memberships = serviceGrantMemberships().map((relationship, index) =>
      index === 0
        ? v1.Relationship.create({
            ...relationship,
            optionalCaveat: { caveatName: 'conditional-membership' },
          })
        : relationship,
    );
    const state = memoryRelationships(memberships);
    expect(
      Schema.is(ServiceGrantError)(yield* reconcileServiceGrants(state.rpc, desired, 'apply').pipe(Effect.flip)),
    ).toBe(true);
    expect(state.writes).toHaveLength(0);
  }),
);

it.effect('rejects malformed desired relationships instead of issuing a broad authorization read', () =>
  Effect.gen(function* refusesUnscopedRead() {
    const state = memoryRelationships(serviceGrantMemberships());
    const error = yield* reconcileServiceGrants(
      state.rpc,
      [v1.Relationship.create({ relation: 'member' })],
      'apply',
    ).pipe(Effect.flip);
    expect(Schema.is(ServiceGrantError)(error)).toBe(true);
    expect(state.writes).toHaveLength(0);
  }),
);
