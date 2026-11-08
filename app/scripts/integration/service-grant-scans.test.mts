import { v1 } from '@authzed/authzed-node';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  RETIRED_STAGE_SERVICE_GRANT_REMEDIATION,
  ServiceGrantError,
  readMissingServiceGrants,
  refuseRetiredStageServiceGrants,
} from '../demo/reconcile-stage-service-grants.mts';
import type { ServiceGrantRpc } from '../demo/reconcile-stage-service-grants.mts';

/**
 * The retired stage service grants are gone; what remains is a bounded, read-only scan. This proof runs over an
 * in-memory engine, so it never needs a live sandbox and can never write.
 */
const revision = v1.ZedToken.create({ token: 'rev-1' });

const matches = (relationship: v1.Relationship, filter: v1.RelationshipFilter): boolean => {
  const prefix = filter.optionalResourceIdPrefix ?? '';
  const subject = filter.optionalSubjectFilter;
  return (
    relationship.resource?.objectType === filter.resourceType &&
    (filter.optionalRelation === '' || relationship.relation === filter.optionalRelation) &&
    (filter.optionalResourceId === '' || relationship.resource?.objectId === filter.optionalResourceId) &&
    (prefix === '' || (relationship.resource?.objectId ?? '').startsWith(prefix)) &&
    (subject === undefined ||
      (relationship.subject?.object?.objectType === subject.subjectType &&
        (subject.optionalSubjectId === '' || relationship.subject?.object?.objectId === subject.optionalSubjectId)))
  );
};

const memoryRpc = (stored: readonly v1.Relationship[]) => {
  const reads: v1.ReadRelationshipsRequest[] = [];
  const writes: v1.WriteRelationshipsRequest[] = [];
  const rpc: ServiceGrantRpc = {
    readRelationships: (request) =>
      Effect.sync(() => {
        reads.push(request);
        const filter = request.relationshipFilter ?? v1.RelationshipFilter.create({ resourceType: '' });
        const rows = stored.filter((relationship) => matches(relationship, filter));
        const limited = request.optionalLimit === 1 ? rows.slice(0, 1) : rows;
        return limited.map((relationship) => v1.ReadRelationshipsResponse.create({ readAt: revision, relationship }));
      }),
    writeRelationships: (request) =>
      Effect.sync(() => {
        writes.push(request);
        return v1.WriteRelationshipsResponse.create({});
      }),
  };
  return { reads, rpc, writes };
};

/** One scoped relationship the scan can look for; the retired service membership is gone with the policy. */
const oneDesired = () =>
  v1.Relationship.create({
    relation: 'member',
    resource: { objectId: 'legal-entity-1', objectType: 'legal_entity' },
    subject: { object: { objectId: 'principal-1', objectType: 'principal' } },
  });

it.effect('scans missing service grants read-only, at one revision, without writing', () =>
  Effect.gen(function* scansReadOnly() {
    const state = memoryRpc([oneDesired()]);
    expect(yield* readMissingServiceGrants(state.rpc, [oneDesired()])).toEqual([]);
    expect(state.writes).toHaveLength(0);
    expect(state.reads.length).toBeGreaterThan(0);
    expect(state.reads.every(({ optionalLimit }) => optionalLimit === 1 || optionalLimit === 256)).toBe(true);
  }),
);

it.effect('refuses the retired legacy stage policy in every mode and never writes', () =>
  Effect.gen(function* refusesApply() {
    const error = yield* refuseRetiredStageServiceGrants('apply').pipe(Effect.flip);
    expect(Schema.is(ServiceGrantError)(error)).toBe(true);
    expect(error.reason).toContain(RETIRED_STAGE_SERVICE_GRANT_REMEDIATION);
    expect(error.reason).toContain('canonical Roles and Assignments');
  }),
);
