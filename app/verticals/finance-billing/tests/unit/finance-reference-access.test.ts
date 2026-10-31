import { describe, expect, it } from 'effect-rstest';
import {
  objectAccessFromModules,
  referenceAccessFromModules,
} from '../../src/routes/[lang]/finance/sales-pipeline-readable.ts';

describe('Invoice references in the selected legal entity', () => {
  it('allows catalog references for a commercial legal entity', () => {
    expect(referenceAccessFromModules(new Set(['demo.sales-pipeline', 'demo.merchandise']))).toEqual({
      opportunitiesReadable: true,
      productsReadable: true,
    });
  });

  it('does not request the merchandise catalog for a rental legal entity', () => {
    expect(referenceAccessFromModules(new Set(['demo.sales-pipeline', 'property.portfolio']))).toEqual({
      opportunitiesReadable: true,
      productsReadable: false,
    });
  });

  it('keeps pipeline and catalog permissions independent', () => {
    expect(referenceAccessFromModules(new Set(['demo.merchandise']))).toEqual({
      opportunitiesReadable: false,
      productsReadable: true,
    });
    expect(referenceAccessFromModules(new Set())).toEqual({ opportunitiesReadable: false, productsReadable: false });
  });

  it('lets the provider enforce permissions when the shell pinned no navigation', () => {
    expect(referenceAccessFromModules()).toEqual({ opportunitiesReadable: true, productsReadable: true });
  });

  it('offers rental objects only when their modules are in the navigation', () => {
    expect(objectAccessFromModules(new Set(['property.portfolio']))).toEqual({
      contractsReadable: false,
      propertiesReadable: true,
    });
    expect(objectAccessFromModules()).toEqual({ contractsReadable: true, propertiesReadable: true });
  });
});
