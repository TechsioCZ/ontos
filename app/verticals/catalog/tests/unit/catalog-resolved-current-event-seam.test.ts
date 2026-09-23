import { describe, expect, it } from 'effect-rstest';

import type { CatalogCurrentResolution } from '../../src/domain/catalog-source-resolution.ts';
import { decideCatalogResolvedCurrentChange } from '../../src/persistence/catalog-resolved-current-event-seam.ts';

const valuesEqual = (left: string, right: string): boolean => left === right;
const current = (value: string): CatalogCurrentResolution<string> => ({
  source: 'BASE',
  status: 'CURRENT',
  value,
});
const absent: CatalogCurrentResolution<string> = {
  reason: 'No usable accepted authoritative base is available',
  status: 'ABSENT',
};
const indeterminate: CatalogCurrentResolution<string> = {
  reason: 'Usable accepted bases come from incomparable sources',
  status: 'INDETERMINATE',
};

describe('Catalog resolved Current change gate', () => {
  it('is a typed no-emit when either side is unresolved', () => {
    expect(decideCatalogResolvedCurrentChange({ next: current('80 cm'), previous: null, valuesEqual }).kind).toBe(
      'UNPROVEN',
    );
    expect(
      decideCatalogResolvedCurrentChange({ next: current('80 cm'), previous: indeterminate, valuesEqual }).kind,
    ).toBe('UNPROVEN');
    expect(
      decideCatalogResolvedCurrentChange({ next: indeterminate, previous: current('80 cm'), valuesEqual }).kind,
    ).toBe('UNPROVEN');
  });

  it('does not claim a change for an equal resolved value or two absences', () => {
    expect(
      decideCatalogResolvedCurrentChange({ next: current('80 cm'), previous: current('80 cm'), valuesEqual }).kind,
    ).toBe('UNCHANGED');
    expect(decideCatalogResolvedCurrentChange({ next: absent, previous: absent, valuesEqual }).kind).toBe('UNCHANGED');
  });

  it('claims a change only when the resolved Current value moved', () => {
    expect(
      decideCatalogResolvedCurrentChange({ next: current('95 cm'), previous: current('80 cm'), valuesEqual }),
    ).toMatchObject({
      kind: 'CHANGED',
    });
    expect(decideCatalogResolvedCurrentChange({ next: absent, previous: current('80 cm'), valuesEqual })).toMatchObject(
      {
        kind: 'CHANGED',
      },
    );
    expect(decideCatalogResolvedCurrentChange({ next: current('80 cm'), previous: absent, valuesEqual })).toMatchObject(
      {
        kind: 'CHANGED',
      },
    );
  });
});
