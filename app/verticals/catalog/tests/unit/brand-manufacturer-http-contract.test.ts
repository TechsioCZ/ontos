import { describe, expect, it } from 'effect-rstest';

import { BrandActionError } from '../../shared/actions/brand-mutations.ts';
import { ManufacturerActionError } from '../../shared/actions/manufacturer-mutations.ts';
import { mapCreateBrandActionProblem } from '../../api/create-brand-action-problems.ts';
import { mapRenameBrandActionProblem } from '../../api/rename-brand-action-problems.ts';
import { mapRetireBrandActionProblem } from '../../api/retire-brand-action-problems.ts';
import { mapReactivateBrandActionProblem } from '../../api/reactivate-brand-action-problems.ts';
import { mapSetProductBrandActionProblem } from '../../api/set-product-brand-action-problems.ts';
import { mapSetProductManufacturerActionProblem } from '../../api/set-product-manufacturer-action-problems.ts';
import { mapChangeProductManufacturerActionProblem } from '../../api/change-product-manufacturer-action-problems.ts';
import { mapRemoveProductManufacturerActionProblem } from '../../api/remove-product-manufacturer-action-problems.ts';
import { ManufacturerPersistenceUnavailable } from '../../src/persistence/manufacturer-persistence.ts';
import { ManufacturerTargetForbidden } from '../../src/persistence/manufacturer-target-forbidden.ts';

describe('Brand and Manufacturer Action HTTP contracts', () => {
  it('keeps Brand conflict, absence, invalid state, and outage distinct and redacted', () => {
    for (const map of [
      mapCreateBrandActionProblem,
      mapRenameBrandActionProblem,
      mapRetireBrandActionProblem,
      mapReactivateBrandActionProblem,
      mapSetProductBrandActionProblem,
    ] as const) {
      for (const [code, status] of [
        ['brand_stale', 409],
        ['brand_not_found', 404],
        ['brand_invalid', 422],
        ['brand_unavailable', 503],
      ] as const) {
        const problem = map(new BrandActionError({ code, reason: 'private brand evidence' }));
        expect(problem).toMatchObject({ code, status });
        expect(JSON.stringify(problem)).not.toContain('private brand evidence');
      }
    }
  });

  it('keeps Manufacturer conflicts, denial, and Core lookup outage distinct and redacted', () => {
    for (const map of [
      mapSetProductManufacturerActionProblem,
      mapChangeProductManufacturerActionProblem,
      mapRemoveProductManufacturerActionProblem,
    ] as const) {
      const conflict = map(new ManufacturerActionError({ code: 'manufacturer_conflict', reason: 'private relation' }));
      expect(conflict).toMatchObject({ code: 'manufacturer_conflict', status: 409 });
      expect(JSON.stringify(conflict)).not.toContain('private relation');

      expect(
        map(new ManufacturerActionError({ code: 'manufacturer_not_found', reason: 'private target' })),
      ).toMatchObject({
        code: 'manufacturer_not_found',
        status: 404,
      });

      const unavailable = map(
        new ManufacturerPersistenceUnavailable({
          code: 'manufacturer_persistence_unavailable',
          reason: 'private Core target lookup',
        }),
      );
      expect(unavailable).toMatchObject({
        code: 'manufacturer_persistence_unavailable',
        retryable: true,
        status: 503,
      });
      expect(JSON.stringify(unavailable)).not.toContain('private Core target lookup');

      expect(map(new ManufacturerTargetForbidden({}))).toMatchObject({
        code: 'manufacturer_target_forbidden',
        status: 403,
      });
    }
  });
});
