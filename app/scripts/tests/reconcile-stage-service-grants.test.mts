import { v1 } from '@authzed/authzed-node';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  ServiceGrantError,
  assertServiceMembershipsCompatible,
  desiredServiceGrants,
  reconcileServiceGrants,
  serviceGrantMemberships,
  stageServicePrincipals,
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

it.effect('check reports initially absent service memberships without blocking apply; verify still fails closed', () =>
  Effect.gen(function* reportsUnprovisionedServices() {
    const state = memoryRelationships([]);
    expect((yield* reconcileServiceGrants(state.rpc, desired, 'check')).missing).toBeGreaterThan(0);
    const error = yield* reconcileServiceGrants(state.rpc, desired, 'verify').pipe(Effect.flip);
    expect(Schema.is(ServiceGrantError)(error)).toBe(true);
    if (Schema.is(ServiceGrantError)(error)) {
      expect(error.reason).toContain('membership is missing');
    }
    expect(state.writes).toHaveLength(0);
    expect(stageServicePrincipals()).toHaveLength(3);
    expect(
      stageServicePrincipals().every(
        ({ legalEntityId, tenantId }) =>
          legalEntityId === '71000000-0000-4000-8000-000000000024' &&
          tenantId === '70000000-0000-4000-8000-000000000020',
      ),
    ).toBe(true);
    expect(
      stageServicePrincipals().some(({ principalId }) => principalId === '563dd03a-7c67-5f4a-94eb-a4e42fe09919'),
    ).toBe(true);
  }),
);

it.effect(
  'allows missing memberships but rejects caveated membership before native provisioning can overwrite it',
  () =>
    Effect.gen(function* protectsExistingConstraints() {
      const missing = memoryRelationships([]);
      yield* assertServiceMembershipsCompatible(missing.rpc);
      expect(missing.writes).toHaveLength(0);
      const conditional = memoryRelationships(
        serviceGrantMemberships().map((membership) =>
          v1.Relationship.create({ ...membership, optionalCaveat: { caveatName: 'must-not-remove' } }),
        ),
      );
      const error = yield* assertServiceMembershipsCompatible(conditional.rpc).pipe(Effect.flip);
      expect(Schema.is(ServiceGrantError)(error)).toBe(true);
      if (Schema.is(ServiceGrantError)(error)) {
        expect(error.reason).toContain('caveat or expiration');
      }
      expect(conditional.writes).toHaveLength(0);
    }),
);
