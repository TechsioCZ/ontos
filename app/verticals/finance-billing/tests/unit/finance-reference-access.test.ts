import { describe, expect, it } from 'effect-rstest';
import { referenceAccessFromComposition } from '../../src/routes/[lang]/finance/sales-pipeline-readable.ts';

describe('Invoice references in the selected legal entity', () => {
  it('allows catalog references for a commercial legal entity', () => {
    expect(
      referenceAccessFromComposition({
        navigation: [{ moduleId: 'demo.sales-pipeline' }, { moduleId: 'demo.merchandise' }],
        state: 'available',
      }),
    ).toEqual({ opportunitiesReadable: true, productsReadable: true });
  });

  it('does not request the merchandise catalog for a rental legal entity', () => {
    expect(
      referenceAccessFromComposition({
        navigation: [{ moduleId: 'demo.sales-pipeline' }, { moduleId: 'property.portfolio' }],
        state: 'available',
      }),
    ).toEqual({ opportunitiesReadable: true, productsReadable: false });
  });

  it('keeps pipeline and catalog permissions independent', () => {
    expect(
      referenceAccessFromComposition({
        navigation: [{ moduleId: 'demo.merchandise' }],
        state: 'available',
      }),
    ).toEqual({ opportunitiesReadable: false, productsReadable: true });
    expect(referenceAccessFromComposition({ navigation: [], state: 'available' })).toEqual({
      opportunitiesReadable: false,
      productsReadable: false,
    });
  });

  it('lets the provider enforce permissions when composition is inconclusive', () => {
    expect(referenceAccessFromComposition({ navigation: [], state: 'unavailable' })).toEqual({
      opportunitiesReadable: true,
      productsReadable: true,
    });
  });
});
