import { expect, it } from '@rstest/core';
import { seedAssetsState } from '../../scripts/seed/assets.mts';

it('all seeded approved depreciation entries and their history were recorded in the past', () => {
  for (const asset of seedAssetsState().assets) {
    for (const plan of asset.depreciationPlans ?? []) {
      for (const entry of plan.entries) {
        expect(entry.at.slice(0, 10) <= '2026-10-20').toBe(true);
        expect(entry.period <= (plan.interval === 'yearly' ? '2026' : '2026-10')).toBe(true);
        expect(plan.history).toContainEqual(expect.objectContaining({ at: entry.at, change: 'entry_recorded', note: entry.period }));
      }
    }
  }
});

it('the partial 2026 rack write uses the damage document date, without changing approved totals', () => {
  const rack = seedAssetsState().assets.find((asset) => asset.inventoryNumber === 'VYB-008')!;
  const plan = rack.depreciationPlans![0]!;
  expect(plan.entries.find((entry) => entry.period === '2026')).toMatchObject({
    at: '2026-04-30T14:00:00Z', amountMinor: 3_500_000, documentRef: 'PS-2026-04', partial: true,
  });
  expect(plan.entries.reduce((sum, entry) => sum + entry.amountMinor, 0)).toBe(11_475_000);
  expect(seedAssetsState()).toEqual(seedAssetsState());
});
