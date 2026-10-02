import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { PricingAcceptedLegacyCurrencySupportReferenceSchema } from '../../src/domain/accepted-order-handoff.ts';

const LegacyHistoryFixtureSchema = Schema.Array(PricingAcceptedLegacyCurrencySupportReferenceSchema);
const LegacyHistoryFixtureWireSchema = Schema.toCodecJson(LegacyHistoryFixtureSchema);

const decodeLegacyHistory = Schema.decodeUnknownSync(LegacyHistoryFixtureSchema, {
  onExcessProperty: 'error',
});
const encodeLegacyHistory = Schema.encodeUnknownSync(LegacyHistoryFixtureWireSchema);
const decodeLegacyHistoryWire = Schema.decodeUnknownSync(LegacyHistoryFixtureWireSchema, {
  onExcessProperty: 'error',
});

const originalPartition = {
  effectivePeriod: {
    effectiveFrom: '2025-01-01T00:00:00.000Z',
    effectiveTo: '2025-07-01T00:00:00.000Z',
  },
  generation: 1,
  ownerScope: {
    ownerModuleId: 'legacy.pricing.currency-support',
    ownerRootRef: 'opaque:legacy-support/partition-a/tenant-a',
    predicateRef: 'pricing-currency-support:1',
    tenantId: 'tenant-a',
  },
  supportedCurrencies: ['EUR'],
  supportRevisionRef: 'pricing-currency-support:1',
  verificationRef: 'opaque:legacy-proof/shared-label',
} as const;

const secondPartition = {
  ...originalPartition,
  ownerScope: {
    ...originalPartition.ownerScope,
    ownerRootRef: 'opaque:legacy-support/partition-b/tenant-a',
  },
} as const;

describe('Pricing Accepted handoff qualified legacy history', () => {
  it('round-trips same-spelling generation and support refs as distinct partition-qualified facts', () => {
    const history = decodeLegacyHistory([originalPartition, secondPartition]);
    const roundTripped = decodeLegacyHistoryWire(encodeLegacyHistory(history));

    expect(roundTripped).toEqual(history);
    expect(roundTripped).toHaveLength(2);
    expect(roundTripped.map(({ ownerScope }) => ownerScope.ownerRootRef)).toEqual([
      'opaque:legacy-support/partition-a/tenant-a',
      'opaque:legacy-support/partition-b/tenant-a',
    ]);
    expect(new Set(roundTripped.map(({ supportRevisionRef }) => supportRevisionRef))).toEqual(
      new Set(['pricing-currency-support:1']),
    );
  });

  it('preserves original generalized currency, interval, source proof, and explicit corrective lineage', () => {
    const migrated = {
      ...originalPartition,
      correctiveMigrationLineage: {
        auditRef: 'opaque:migration-audit/legacy-support-a',
        migratedAt: '2026-09-28T10:00:00.000Z',
        migrationRef: 'opaque:migration/correct-legacy-support-v2',
        successorOwnerScope: {
          ownerModuleId: 'commerce.pricing',
          ownerRootRef: 'opaque:currency-support/tenant-a',
          predicateRef: 'opaque:currency-support/current/tenant-a',
          tenantId: 'tenant-a',
        },
        successorSupportRevisionRef: 'opaque:currency-support/revision-42',
      },
    } as const;

    const [roundTripped] = decodeLegacyHistoryWire(encodeLegacyHistory(decodeLegacyHistory([migrated])));

    expect(roundTripped).toEqual(migrated);
    expect(roundTripped?.ownerScope).toEqual(originalPartition.ownerScope);
    expect(roundTripped?.supportedCurrencies).toEqual(['EUR']);
    expect(roundTripped?.effectivePeriod).toEqual(originalPartition.effectivePeriod);
    expect(roundTripped?.supportRevisionRef).toBe('pricing-currency-support:1');
    expect(roundTripped?.verificationRef).toBe('opaque:legacy-proof/shared-label');
    expect(roundTripped?.correctiveMigrationLineage?.successorOwnerScope).not.toEqual(roundTripped?.ownerScope);
  });

  it('rejects migration lineage that relabels the legacy source as its own successor', () => {
    expect(() =>
      decodeLegacyHistory([
        {
          ...originalPartition,
          correctiveMigrationLineage: {
            auditRef: 'opaque:migration-audit/invalid-self-replacement',
            migratedAt: '2026-09-28T10:00:00.000Z',
            migrationRef: 'opaque:migration/invalid-self-replacement',
            successorOwnerScope: originalPartition.ownerScope,
            successorSupportRevisionRef: originalPartition.supportRevisionRef,
          },
        },
      ]),
    ).toThrow(/distinct successor/u);
  });

  it('rejects compatibility fixtures that reinterpret accepted history as Tenant Current', () => {
    expect(() =>
      decodeLegacyHistory([
        {
          ...originalPartition,
          evaluationMode: 'CURRENT_AT_OWNER_EVALUATION',
          ownerRevision: 'opaque:currency-support/current-revision-42',
        },
      ]),
    ).toThrow(/no excess property/u);
  });
});
