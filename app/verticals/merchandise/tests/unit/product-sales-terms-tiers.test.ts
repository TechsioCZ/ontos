import { expect, it } from 'effect-rstest';
import { tiersAtMinimum } from '../../src/routes/[lang]/provoz/produkty/product-sales-terms-draft.ts';
import type { TierDraft } from '../../src/routes/[lang]/provoz/produkty/product-sales-terms-draft.ts';

const tier = (key: number, from: string, net: string): TierDraft => ({
  grossText: net,
  key,
  minimumText: from,
  netText: net,
});

const tiers = [tier(0, '1', '100'), tier(1, '10', '90'), tier(2, '50', '80')];

it('moves the rows below a raised minimum up to it and keeps the price the new minimum reaches', () => {
  expect(tiersAtMinimum(tiers, 1, 3)).toEqual([tier(0, '3', '100'), tier(1, '10', '90'), tier(2, '50', '80')]);
  expect(tiersAtMinimum(tiers, 1, 10)).toEqual([tier(1, '10', '90'), tier(2, '50', '80')]);
  expect(tiersAtMinimum(tiers, 1, 12)).toEqual([tier(1, '12', '90'), tier(2, '50', '80')]);
  expect(tiersAtMinimum(tiers, 1, 100)).toEqual([tier(2, '100', '80')]);
});

it('takes the row at the old minimum down with a lowered one', () => {
  const raised = [tier(1, '12', '90'), tier(2, '50', '80')];
  expect(tiersAtMinimum(raised, 12, 1)).toEqual([tier(1, '1', '90'), tier(2, '50', '80')]);
  const above = [tier(2, '50', '80')];
  expect(tiersAtMinimum(above, 12, 1)).toBe(above);
});

it('leaves the rows alone at the minimum they were written for, so a row typed below it shows its error', () => {
  const typed = [tier(0, '3', '100'), tier(1, '2', '90')];
  expect(tiersAtMinimum(typed, 3, 3)).toBe(typed);
  expect(tiersAtMinimum(tiers, 1, null)).toBe(tiers);
  expect(tiersAtMinimum(tiers, null, 3)).toBe(tiers);
});
