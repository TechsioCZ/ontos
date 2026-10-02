import type { PricingInstantSchema } from '@app/pricing-contracts/domain/currency-support';
import { describe, expect, it } from 'effect-rstest';

import type {
  PricingMaterialOwnerSetState,
  PricingMaterialStateSnapshot,
  PricingScheduledMaterialState,
} from '../../src/services/scheduled-material-state-detection.service.ts';
import {
  detectPricingMaterialStateChange,
  selectScheduledMaterialStateAt,
} from '../../src/services/scheduled-material-state-detection.service.ts';

type PricingInstant = typeof PricingInstantSchema.Type;

const januaryRevision = {
  effectivePeriod: {
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    effectiveTo: '2026-02-01T00:00:00.000Z',
  },
  revisionRef: 'price-revision:1',
} as const;
const marchRevision = {
  effectivePeriod: { effectiveFrom: '2026-03-01T00:00:00.000Z', effectiveTo: null },
  revisionRef: 'price-revision:2',
} as const;

const schedule = (
  exactKeyRef = 'PRICE:variant-a:CZ:B2C:CZK:NO_GROUP',
  revisions: PricingScheduledMaterialState['revisions'] = [januaryRevision, marchRevision],
): PricingScheduledMaterialState => ({ exactKeyRef, revisions });

const ownerSet = (
  family: PricingMaterialOwnerSetState['family'],
  ownerSetRevisionRef = `${family}:set:1`,
  currentRevisionRefs: readonly string[] = [`${family}:revision:1`],
): PricingMaterialOwnerSetState => ({
  currentRevisionRefs,
  family,
  ownerSetRevisionRef,
  predicateRef: `${family}:candidate:exact`,
  status: 'PRESENT',
});

const allOwnerSets = (): readonly PricingMaterialOwnerSetState[] => [
  ownerSet('QUANTITY_TIER'),
  ownerSet('DISCOUNT'),
  ownerSet('COMMERCIAL_FEE'),
  ownerSet('ZERO_FLOOR'),
  ownerSet('PROMOTION'),
];

const snapshot = ({
  exactKeySchedules = [schedule()],
  observedAt = '2026-01-15T00:00:00.000Z',
  ownerSets = allOwnerSets(),
}: {
  readonly exactKeySchedules?: readonly PricingScheduledMaterialState[];
  readonly observedAt?: PricingInstant;
  readonly ownerSets?: readonly PricingMaterialOwnerSetState[];
} = {}): PricingMaterialStateSnapshot => ({ exactKeySchedules, observedAt, ownerSets });

describe('issue #787 scheduled material-change acceptance', () => {
  it('does not confuse ordinary owner latency with stale state', () => {
    expect(
      detectPricingMaterialStateChange(
        snapshot({ observedAt: '2026-01-15T00:00:00.100Z' }),
        snapshot({ observedAt: '2026-01-15T00:00:09.900Z' }),
      ),
    ).toEqual({ outcome: 'UNCHANGED' });
  });

  it('selects the exact revision before and at a boundary while preserving a real gap', () => {
    const contiguous = schedule('PRICE:contiguous', [
      januaryRevision,
      {
        effectivePeriod: { effectiveFrom: '2026-02-01T00:00:00.000Z', effectiveTo: null },
        revisionRef: 'price-revision:successor',
      },
    ]);

    expect(selectScheduledMaterialStateAt(contiguous, '2026-01-31T23:59:59.999Z')).toMatchObject({
      current: { revisionRef: januaryRevision.revisionRef },
      outcome: 'CURRENT',
    });
    expect(selectScheduledMaterialStateAt(contiguous, '2026-02-01T00:00:00.000Z')).toMatchObject({
      current: { revisionRef: 'price-revision:successor' },
      outcome: 'CURRENT',
    });
    expect(selectScheduledMaterialStateAt(schedule(), '2026-02-15T00:00:00.000Z')).toEqual({
      exactKeyRef: schedule().exactKeyRef,
      outcome: 'ABSENT',
    });
    expect(selectScheduledMaterialStateAt(schedule(), '2026-03-01T00:00:00.000Z')).toMatchObject({
      current: { revisionRef: marchRevision.revisionRef },
      outcome: 'CURRENT',
    });
  });

  it.each([
    'PRICE:variant-b:CZ:B2C:CZK:NO_GROUP',
    'PRICE:variant-a:CZ:B2C:CZK:GROUP-A',
    'PRICE:variant-a:SK:B2C:CZK:NO_GROUP',
    'PRICE:variant-a:CZ:B2B:CZK:NO_GROUP',
    'PRICE:variant-a:CZ:B2C:EUR:NO_GROUP',
    'PRICE:variant-a:CZ:B2C:CZK:NO_GROUP:quantity-2',
  ])('treats a changed exact purchase/key dimension as material: %s', (changedKey) => {
    expect(
      detectPricingMaterialStateChange(snapshot(), snapshot({ exactKeySchedules: [schedule(changedKey)] })),
    ).toMatchObject({
      detail: 'EXACT_KEY_STATE_CHANGED',
      outcome: 'MATERIAL_CHANGE',
      reason: 'EXACT_PRICE_KEY_OR_SET_CHANGED',
    });
  });

  it('detects a Current revision change between the retained read and final fence', () => {
    expect(
      detectPricingMaterialStateChange(
        snapshot(),
        snapshot({
          exactKeySchedules: [
            schedule(schedule().exactKeyRef, [{ ...januaryRevision, revisionRef: 'price-revision:changed-at-fence' }]),
          ],
        }),
      ),
    ).toMatchObject({
      detail: 'EXACT_KEY_STATE_CHANGED',
      outcome: 'MATERIAL_CHANGE',
      reason: 'EXACT_PRICE_KEY_OR_SET_CHANGED',
    });
  });

  it('detects a G-price insertion after proven absence and an exact-key collision', () => {
    const groupKey = 'GROUP_PRICE:variant-a:CZ:B2C:CZK:group-a';
    const absentGroup = schedule(groupKey, []);
    const insertedGroup = schedule(groupKey, [januaryRevision]);
    expect(
      detectPricingMaterialStateChange(
        snapshot({ exactKeySchedules: [schedule(), absentGroup] }),
        snapshot({ exactKeySchedules: [schedule(), insertedGroup] }),
      ),
    ).toMatchObject({
      detail: 'GROUP_PRICE_INSERTED_AFTER_PROVEN_ABSENCE',
      exactKeyRef: groupKey,
      outcome: 'MATERIAL_CHANGE',
      reason: 'EXACT_PRICE_KEY_OR_SET_CHANGED',
    });

    const collision = schedule(schedule().exactKeyRef, [
      januaryRevision,
      { ...januaryRevision, revisionRef: 'price-revision:collision' },
      marchRevision,
    ]);
    expect(detectPricingMaterialStateChange(snapshot(), snapshot({ exactKeySchedules: [collision] }))).toMatchObject({
      detail: 'EXACT_KEY_COLLISION',
      exactKeyRef: schedule().exactKeyRef,
      outcome: 'MATERIAL_CHANGE',
      reason: 'EXACT_PRICE_KEY_OR_SET_CHANGED',
    });
  });

  it.each(['QUANTITY_TIER', 'DISCOUNT', 'COMMERCIAL_FEE', 'PROMOTION', 'ZERO_FLOOR'] as const)(
    'invalidates on a changed %s complete set even when the used Price revision is unchanged',
    (family) => {
      const previous = snapshot();
      const currentSets = previous.ownerSets.map((set) =>
        set.family === family ? ownerSet(family, `${family}:set:2`, [`${family}:revision:2`]) : set,
      );

      const reasonByFamily = {
        COMMERCIAL_FEE: 'COMMERCIAL_FEE_SET_CHANGED',
        DISCOUNT: 'DISCOUNT_SET_CHANGED',
        PROMOTION: 'PROMOTION_OR_ALLOCATION_CHANGED',
        QUANTITY_TIER: 'QUANTITY_TIER_SET_CHANGED',
        ZERO_FLOOR: 'ZERO_FLOOR_SCOPE_OR_COVERAGE_CHANGED',
      } as const;
      expect(detectPricingMaterialStateChange(previous, snapshot({ ownerSets: currentSets }))).toEqual({
        detail: 'MATERIAL_SET_CHANGED',
        family,
        outcome: 'MATERIAL_CHANGE',
        predicateRef: `${family}:candidate:exact`,
        reason: reasonByFamily[family],
      });
    },
  );

  it('fails indeterminate when the owner cannot prove a complete Current set', () => {
    const previous = snapshot();
    const currentSets = previous.ownerSets.map((set) =>
      set.family === 'DISCOUNT'
        ? ({ family: 'DISCOUNT', predicateRef: set.predicateRef, status: 'UNVERIFIABLE' } as const)
        : set,
    );
    expect(detectPricingMaterialStateChange(previous, snapshot({ ownerSets: currentSets }))).toEqual({
      outcome: 'INDETERMINATE',
      predicateRef: 'DISCOUNT:candidate:exact',
      reason: 'OWNER_STATE_UNVERIFIABLE',
    });
  });
});
