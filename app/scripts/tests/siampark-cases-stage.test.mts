import { toResourceAccessObjectId } from '@app/core-runtime';
import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';
import {
  stageCaseFingerprint,
  stageCaseGrants,
  stageCaseSpecs,
  validateStageCases,
} from '../demo/siampark-cases-stage.mts';
import { demoTenantId, rentalDemoLegalEntityId } from '../demo/fixture-ids.mts';

const owners = { external: '72000000-0000-4000-8000-000000000024', management: '72000000-0000-4000-8000-000000000021' };
const records = stageCaseSpecs.map((spec, index) => ({
  id: `case-${index}`,
  ownerEmployeeId: owners[spec.owner],
  title: spec.title,
}));
it.effect('builds only three exact external reader grants and the same resource containment edges', () =>
  Effect.gen(function* boundedGrants() {
    const grants = yield* stageCaseGrants(records, owners.external);
    expect(grants).toHaveLength(6);
    expect(grants.filter((edge) => edge.relation === 'reader')).toHaveLength(3);
    expect(grants.filter((edge) => edge.relation === 'module')).toHaveLength(3);
    expect(grants.every((edge) => edge.resource?.objectType === 'resource')).toBe(true);
    expect(grants.some((edge) => edge.resource?.objectId.includes('case-3') === true)).toBe(false);
    expect(
      grants
        .filter((edge) => edge.relation === 'reader')
        .every((edge) => edge.subject?.object?.objectId === '72000000-0000-4000-8000-000000000024'),
    ).toBe(true);
    const expectedResources = new Set(
      records.slice(0, 3).map((record) =>
        toResourceAccessObjectId(demoTenantId, rentalDemoLegalEntityId, {
          moduleId: 'demo.sales-pipeline',
          resourceId: record.id,
          resourceType: 'demo.sales-pipeline.opportunity',
        }),
      ),
    );
    expect(grants.every((edge) => expectedResources.has(edge.resource?.objectId))).toBe(true);
  }),
);
it.effect('never grants an ambiguous, missing or differently assigned fixture', () =>
  Effect.gen(function* rejectedGrants() {
    expect((yield* Effect.exit(stageCaseGrants(records.slice(1), owners.external)))._tag).toBe('Failure');
    expect((yield* Effect.exit(stageCaseGrants([...records, records[0]], owners.external)))._tag).toBe('Failure');
    expect((yield* Effect.exit(stageCaseGrants(records, 'different-owner')))._tag).toBe('Failure');
  }),
);
it.effect('rejects duplicates and wrong assignment without silently rewriting records', () =>
  Effect.gen(function* rejectConflicts() {
    expect((yield* Effect.exit(validateStageCases([...records, records[0]], owners, true)))._tag).toBe('Failure');
    expect(
      (yield* Effect.exit(
        validateStageCases(
          records.map((r) => ({ ...r, ownerEmployeeId: 'someone-else' })),
          owners,
          true,
        ),
      ))._tag,
    ).toBe('Failure');
    yield* validateStageCases([], owners, false);
    expect((yield* Effect.exit(validateStageCases([], owners, true)))._tag).toBe('Failure');
    yield* validateStageCases(records, owners, true);
  }),
);
it.effect('fingerprints the exact tenant, resources, source and records revision', () =>
  Effect.gen(function* fingerprints() {
    const plan = {
      company: rentalDemoLegalEntityId,
      crmRevision: 1,
      externalEmployeeId: owners.external,
      managementEmployeeId: owners.management,
      missing: [],
      records,
      revision: 1,
      seedDigest: 'seed-v1',
      step: 'grants' as const,
      tenant: demoTenantId,
      tuples: ['exact-read-edge'],
    };
    const fingerprint = yield* stageCaseFingerprint(plan);
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(yield* stageCaseFingerprint({ ...plan, revision: 2 })).not.toBe(fingerprint);
    expect(yield* stageCaseFingerprint({ ...plan, tuples: ['different-edge'] })).not.toBe(fingerprint);
    expect(yield* stageCaseFingerprint({ ...plan, seedDigest: 'seed-v2' })).not.toBe(fingerprint);
  }),
);
