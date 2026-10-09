import { describe, expect, it } from 'effect-rstest';

import type {
  PricingMaterialOwnerSetState,
  PricingMaterialStateSnapshot,
  PricingScheduledMaterialRevision,
  PricingScheduledMaterialState,
} from '../../src/services/scheduled-material-state-detection.service.ts';
import {
  assessPricingScheduleAcknowledgement,
  detectPricingMaterialStateChange,
  selectScheduledMaterialStateAt,
} from '../../src/services/scheduled-material-state-detection.service.ts';

const january: PricingScheduledMaterialRevision = {
  effectivePeriod: { effectiveFrom: '2026-01-01T00:00:00.000Z', effectiveTo: '2026-02-01T00:00:00.000Z' },
  revisionRef: 'price-revision:1',
};
const march: PricingScheduledMaterialRevision = {
  effectivePeriod: { effectiveFrom: '2026-03-01T00:00:00.000Z', effectiveTo: null },
  revisionRef: 'price-revision:2',
};
const priceSchedule: PricingScheduledMaterialState = {
  exactKeyRef: 'PRICE:variant-a:CZ:B2C:CZK:NO_GROUP',
  revisions: [january, march],
};

const ownerSet = (
  family: PricingMaterialOwnerSetState['family'],
  revision = 'set:1',
): PricingMaterialOwnerSetState => ({
  currentRevisionRefs: [`${family}:revision:1`],
  family,
  ownerSetRevisionRef: revision,
  predicateRef: `${family}:exact-predicate`,
  status: 'PRESENT',
});

const snapshot = (
  observedAt: string,
  exactKeySchedules: readonly PricingScheduledMaterialState[] = [priceSchedule],
  ownerSets: readonly PricingMaterialOwnerSetState[] = [
    ownerSet('QUANTITY_TIER'),
    ownerSet('DISCOUNT'),
    ownerSet('COMMERCIAL_FEE'),
    ownerSet('ZERO_FLOOR'),
    ownerSet('PROMOTION'),
  ],
): PricingMaterialStateSnapshot => ({ exactKeySchedules, observedAt, ownerSets });

describe('scheduled material state detection', () => {
  it('selects before, at, and after a half-open revision boundary', () => {
    const contiguous = {
      ...priceSchedule,
      revisions: [
        january,
        {
          ...march,
          effectivePeriod: { effectiveFrom: '2026-02-01T00:00:00.000Z', effectiveTo: null },
        },
      ],
    };

    expect(selectScheduledMaterialStateAt(contiguous, '2026-01-31T23:59:59.999Z')).toMatchObject({
      current: { revisionRef: 'price-revision:1' },
      outcome: 'CURRENT',
    });
    expect(selectScheduledMaterialStateAt(contiguous, '2026-02-01T00:00:00.000Z')).toMatchObject({
      current: { revisionRef: 'price-revision:2' },
      outcome: 'CURRENT',
    });
    expect(selectScheduledMaterialStateAt(contiguous, '2027-01-01T00:00:00.000Z')).toMatchObject({
      current: { revisionRef: 'price-revision:2' },
      outcome: 'CURRENT',
    });
  });

  it('preserves a finite end and gap instead of extending Current to the next future start', () => {
    expect(selectScheduledMaterialStateAt(priceSchedule, '2026-01-31T23:59:59.999Z').outcome).toBe('CURRENT');
    expect(selectScheduledMaterialStateAt(priceSchedule, '2026-02-01T00:00:00.000Z')).toEqual({
      exactKeyRef: priceSchedule.exactKeyRef,
      outcome: 'ABSENT',
    });
    expect(selectScheduledMaterialStateAt(priceSchedule, '2026-02-28T23:59:59.999Z').outcome).toBe('ABSENT');
    expect(selectScheduledMaterialStateAt(priceSchedule, '2026-03-01T00:00:00.000Z')).toMatchObject({
      current: { revisionRef: 'price-revision:2' },
      outcome: 'CURRENT',
    });
  });

  it('uses the same half-open boundary rule for contractual successor Revisions', () => {
    const contractualSchedule: PricingScheduledMaterialState = {
      exactKeyRef: 'CONTRACTUAL_DISCOUNT:counterparty-a:variant-a:CZK',
      revisions: [
        {
          effectivePeriod: { effectiveFrom: '2026-01-01T00:00:00.000Z', effectiveTo: '2026-02-01T00:00:00.000Z' },
          revisionRef: 'contractual-discount:1',
        },
        {
          effectivePeriod: { effectiveFrom: '2026-02-01T00:00:00.000Z', effectiveTo: null },
          revisionRef: 'contractual-discount:2',
        },
      ],
    };

    expect(selectScheduledMaterialStateAt(contractualSchedule, '2026-01-31T23:59:59.999Z')).toMatchObject({
      current: { revisionRef: 'contractual-discount:1' },
      outcome: 'CURRENT',
    });
    expect(selectScheduledMaterialStateAt(contractualSchedule, '2026-02-01T00:00:00.000Z')).toMatchObject({
      current: { revisionRef: 'contractual-discount:2' },
      outcome: 'CURRENT',
    });
  });

  it('detects a scheduled successor and a newly overlapping exact-key collision', () => {
    expect(
      detectPricingMaterialStateChange(snapshot('2026-01-31T23:59:59.999Z'), snapshot('2026-03-01T00:00:00.000Z')),
    ).toEqual({
      detail: 'EXACT_KEY_STATE_CHANGED',
      exactKeyRef: priceSchedule.exactKeyRef,
      outcome: 'MATERIAL_CHANGE',
      reason: 'PRICE_SCHEDULE_BOUNDARY_CROSSED',
    });

    const collision: PricingScheduledMaterialState = {
      ...priceSchedule,
      revisions: [
        january,
        { effectivePeriod: january.effectivePeriod, revisionRef: 'price-revision:collision' },
        march,
      ],
    };
    expect(
      detectPricingMaterialStateChange(
        snapshot('2026-01-15T00:00:00.000Z'),
        snapshot('2026-01-15T00:00:00.000Z', [collision]),
      ),
    ).toEqual({
      detail: 'EXACT_KEY_COLLISION',
      exactKeyRef: priceSchedule.exactKeyRef,
      outcome: 'MATERIAL_CHANGE',
      reason: 'EXACT_PRICE_KEY_OR_SET_CHANGED',
    });
  });

  it('detects a Group Price inserted after exact-key absence proof', () => {
    const groupKey = 'GROUP_PRICE:variant-a:CZ:B2C:CZK:group-a';
    const absent: PricingScheduledMaterialState = { exactKeyRef: groupKey, revisions: [] };
    const inserted: PricingScheduledMaterialState = {
      exactKeyRef: groupKey,
      revisions: [{ effectivePeriod: january.effectivePeriod, revisionRef: 'group-price:1' }],
    };
    expect(
      detectPricingMaterialStateChange(
        snapshot('2026-01-15T00:00:00.000Z', [priceSchedule, absent]),
        snapshot('2026-01-15T00:00:00.000Z', [priceSchedule, inserted]),
      ),
    ).toEqual({
      detail: 'GROUP_PRICE_INSERTED_AFTER_PROVEN_ABSENCE',
      exactKeyRef: groupKey,
      outcome: 'MATERIAL_CHANGE',
      reason: 'EXACT_PRICE_KEY_OR_SET_CHANGED',
    });
  });

  it.each(['QUANTITY_TIER', 'DISCOUNT', 'COMMERCIAL_FEE', 'ZERO_FLOOR', 'PROMOTION'] as const)(
    'detects a changed %s Current set even while the used Price revision is unchanged',
    (family) => {
      const before = snapshot('2026-01-15T00:00:00.000Z');
      const afterSets = before.ownerSets.map((set) => (set.family === family ? ownerSet(family, 'set:2') : set));
      const reasonByFamily = {
        COMMERCIAL_FEE: 'COMMERCIAL_FEE_SET_CHANGED',
        DISCOUNT: 'DISCOUNT_SET_CHANGED',
        PROMOTION: 'PROMOTION_OR_ALLOCATION_CHANGED',
        QUANTITY_TIER: 'QUANTITY_TIER_SET_CHANGED',
        ZERO_FLOOR: 'ZERO_FLOOR_SCOPE_OR_COVERAGE_CHANGED',
      } as const;
      expect(detectPricingMaterialStateChange(before, snapshot(before.observedAt, [priceSchedule], afterSets))).toEqual(
        {
          detail: 'MATERIAL_SET_CHANGED',
          family,
          outcome: 'MATERIAL_CHANGE',
          predicateRef: `${family}:exact-predicate`,
          reason: reasonByFamily[family],
        },
      );
    },
  );

  it('keeps the result unchanged for reordered but identical complete sets', () => {
    const before = snapshot('2026-01-15T00:00:00.000Z');
    const reordered = before.ownerSets.map((set) =>
      set.status === 'PRESENT' ? { ...set, currentRevisionRefs: [...set.currentRevisionRefs].toReversed() } : set,
    );
    expect(detectPricingMaterialStateChange(before, snapshot(before.observedAt, [priceSchedule], reordered))).toEqual({
      outcome: 'UNCHANGED',
    });
  });

  it('makes an acknowledgement stale for schedule, target interval, or payload drift', () => {
    const acknowledgement = {
      exactKeyRef: priceSchedule.exactKeyRef,
      intendedPayloadFingerprint: 'payload:1',
      presentedFuture: [march],
      presentedScheduleRevisionRef: 'schedule:1',
      targetEffectivePeriod: january.effectivePeriod,
      targetRevisionRef: january.revisionRef,
    };
    const presented = {
      current: january,
      exactKeyRef: priceSchedule.exactKeyRef,
      future: [march],
      scheduleRevisionRef: 'schedule:1',
    };
    expect(assessPricingScheduleAcknowledgement(acknowledgement, presented, 'payload:1')).toEqual({
      outcome: 'ACKNOWLEDGEMENT_CURRENT',
    });
    expect(
      assessPricingScheduleAcknowledgement(
        acknowledgement,
        { ...presented, scheduleRevisionRef: 'schedule:2' },
        'payload:1',
      ),
    ).toEqual({ outcome: 'ACKNOWLEDGEMENT_STALE', reason: 'PRESENTED_SCHEDULE_CHANGED' });
    expect(
      assessPricingScheduleAcknowledgement(
        acknowledgement,
        {
          ...presented,
          future: [
            { ...march, effectivePeriod: { ...march.effectivePeriod, effectiveFrom: '2026-04-01T00:00:00.000Z' } },
          ],
        },
        'payload:1',
      ),
    ).toEqual({ outcome: 'ACKNOWLEDGEMENT_STALE', reason: 'PRESENTED_SCHEDULE_CHANGED' });
    expect(
      assessPricingScheduleAcknowledgement(
        acknowledgement,
        {
          ...presented,
          current: { ...january, effectivePeriod: { ...january.effectivePeriod, effectiveTo: null } },
        },
        'payload:1',
      ),
    ).toEqual({ outcome: 'ACKNOWLEDGEMENT_STALE', reason: 'TARGET_INTERVAL_CHANGED' });
    expect(assessPricingScheduleAcknowledgement(acknowledgement, presented, 'payload:2')).toEqual({
      outcome: 'ACKNOWLEDGEMENT_STALE',
      reason: 'INTENDED_PAYLOAD_CHANGED',
    });
  });

  it('makes an acknowledgement stale when a boundary changes the targeted revision', () => {
    const acknowledgement = {
      exactKeyRef: priceSchedule.exactKeyRef,
      intendedPayloadFingerprint: 'payload:1',
      presentedFuture: [march],
      presentedScheduleRevisionRef: 'schedule:1',
      targetEffectivePeriod: january.effectivePeriod,
      targetRevisionRef: january.revisionRef,
    };
    expect(
      assessPricingScheduleAcknowledgement(
        acknowledgement,
        { current: march, exactKeyRef: priceSchedule.exactKeyRef, future: [], scheduleRevisionRef: 'schedule:1' },
        'payload:1',
      ),
    ).toEqual({ outcome: 'ACKNOWLEDGEMENT_STALE', reason: 'TARGET_REVISION_CHANGED' });
  });
});
