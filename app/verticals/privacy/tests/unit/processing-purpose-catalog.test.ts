import { describe, expect, it } from 'effect-rstest';
import { Effect, Exit } from 'effect';

import { readProcessingPurposes } from '../../src/api/processing-purposes.read.ts';
import { makeInMemoryProcessingPurposeRepository } from '../../src/domain/processing-purpose-catalog.ts';

const tenantId = '00000000-0000-4000-8000-000000000001';
const legalEntityId = '00000000-0000-4000-8000-000000000002';
const ownerId = '00000000-0000-4000-8000-000000000003';
const createInvocationId = '00000000-0000-4000-8000-000000000004';
const reviseInvocationId = '00000000-0000-4000-8000-000000000005';

describe('Processing Purpose catalog', () => {
  it.effect('creates a stable purpose identity with its first immutable version', () =>
    Effect.gen(function* createsPurpose() {
      const repository = makeInMemoryProcessingPurposeRepository();
      const purpose = yield* repository.create(tenantId, legalEntityId, createInvocationId, {
        businessCode: 'ACCOUNT_SECURITY',
        effectiveFrom: '2026-01-01T00:00:00Z',
        governanceOwnerId: ownerId,
        meaning: 'Protect the account from unauthorized access',
      });

      expect(purpose.purposeRef.tenantId).toBe(tenantId);
      expect(purpose.versions).toHaveLength(1);
      expect(purpose.versions[0]?.versionNumber).toBe(1);
    }),
  );

  it.effect('closes the former effective period when a material meaning version is added', () =>
    Effect.gen(function* versionsPurposeMeaning() {
      const repository = makeInMemoryProcessingPurposeRepository();
      const created = yield* repository.create(tenantId, legalEntityId, createInvocationId, {
        businessCode: 'ACCOUNT_SECURITY',
        effectiveFrom: '2026-01-01T00:00:00Z',
        governanceOwnerId: ownerId,
        meaning: 'Protect the account from unauthorized access',
      });
      const revised = yield* repository.addVersion(
        tenantId,
        legalEntityId,
        created.purposeRef.resourceId,
        reviseInvocationId,
        {
          effectiveFrom: '2026-06-01T00:00:00Z',
          meaning: 'Protect the account and detect account takeover attempts',
        },
      );

      expect(created.versions[0]?.effectiveTo).toBeNull();
      expect(revised.versions[0]?.effectiveTo).toBeNull();
      expect(revised.versions[1]?.effectiveTo).toBeNull();
      expect(revised.versions[1]?.versionNumber).toBe(2);
    }),
  );

  it.effect('resolves historical meaning without rewriting an earlier Purpose Version', () =>
    Effect.gen(function* readsHistoricalPurposeMeaning() {
      const repository = makeInMemoryProcessingPurposeRepository();
      const created = yield* repository.create(tenantId, legalEntityId, createInvocationId, {
        businessCode: 'ACCOUNT_SECURITY',
        effectiveFrom: '2026-01-01T00:00:00Z',
        governanceOwnerId: ownerId,
        meaning: 'Protect the account from unauthorized access',
      });
      yield* repository.addVersion(tenantId, legalEntityId, created.purposeRef.resourceId, reviseInvocationId, {
        effectiveFrom: '2026-06-01T00:00:00Z',
        meaning: 'Protect the account and detect account takeover attempts',
      });

      const historical = yield* readProcessingPurposes(
        { at: '2026-03-01T00:00:00Z', includeRetired: true, purposeRefs: [created.purposeRef] },
        tenantId,
        legalEntityId,
        repository,
      );
      const current = yield* readProcessingPurposes(
        { at: '2026-07-01T00:00:00Z', includeRetired: true, purposeRefs: [created.purposeRef] },
        tenantId,
        legalEntityId,
        repository,
      );

      expect(historical.items[0]?.effectiveVersion?.versionNumber).toBe(1);
      expect(current.items[0]?.effectiveVersion?.versionNumber).toBe(2);
      expect(historical.items[0]?.purpose.versions[0]?.effectiveTo).toBeNull();
    }),
  );

  it.effect('rejects non-monotonic versions and makes exact invocation replay idempotent', () =>
    Effect.gen(function* validatesVersionOrderingAndReplay() {
      const repository = makeInMemoryProcessingPurposeRepository();
      const created = yield* repository.create(tenantId, legalEntityId, createInvocationId, {
        businessCode: 'ACCOUNT_SECURITY',
        effectiveFrom: '2026-01-01T00:00:00Z',
        governanceOwnerId: ownerId,
        meaning: 'Protect the account from unauthorized access',
      });
      const input = {
        effectiveFrom: '2026-06-01T00:00:00Z',
        meaning: 'Protect the account and detect account takeover attempts',
      };
      const first = yield* repository.addVersion(
        tenantId,
        legalEntityId,
        created.purposeRef.resourceId,
        reviseInvocationId,
        input,
      );
      const replay = yield* repository.addVersion(
        tenantId,
        legalEntityId,
        created.purposeRef.resourceId,
        reviseInvocationId,
        input,
      );
      const stale = yield* Effect.exit(
        repository.addVersion(
          tenantId,
          legalEntityId,
          created.purposeRef.resourceId,
          '00000000-0000-4000-8000-000000000006',
          { ...input, effectiveFrom: '2026-05-01T00:00:00Z' },
        ),
      );

      expect(replay.versions).toHaveLength(first.versions.length);
      expect(Exit.isFailure(stale)).toBe(true);
    }),
  );
});
