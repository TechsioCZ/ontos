import { describe, expect, it } from 'effect-rstest';

import { priceListSaveResult } from '../../src/market-admin/assortment-section.tsx';

describe('market writes parked for approval', () => {
  it('adopts the committed market revision, or reports a plain save when the owner returns none', () => {
    expect(priceListSaveResult({ entityIds: [], marketRevision: 3, revision: 12 })).toBe(3);
    expect(priceListSaveResult({ entityIds: [], revision: 12 })).toBe('saved');
  });
});
