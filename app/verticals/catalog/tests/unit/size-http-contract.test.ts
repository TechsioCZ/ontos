import { describe, expect, it } from 'effect-rstest';

import { mapAssertSizeEquivalenceActionProblem } from '../../api/assert-size-equivalence-action-problems.ts';
import { mapReplaceProductSizesActionProblem } from '../../api/replace-product-sizes-action-problems.ts';
import { CatalogPersistenceUnavailable } from '../../src/persistence/errors.ts';
import { SizePersistenceConflict } from '../../src/persistence/size-usage-persistence.ts';

describe('Size Action HTTP contracts', () => {
  it('maps invalid, missing, stale, retired, and unavailable outcomes without leaking details', () => {
    const cases = [
      [mapReplaceProductSizesActionProblem, 'INVALID_INPUT', 400],
      [mapReplaceProductSizesActionProblem, 'NOT_FOUND', 404],
      [mapReplaceProductSizesActionProblem, 'REVISION', 409],
      [mapReplaceProductSizesActionProblem, 'RETIRED', 422],
      [mapReplaceProductSizesActionProblem, 'ACTION_INVOCATION_ID', 409],
      [mapAssertSizeEquivalenceActionProblem, 'INVALID_INPUT', 400],
      [mapAssertSizeEquivalenceActionProblem, 'NOT_FOUND', 404],
      [mapAssertSizeEquivalenceActionProblem, 'RETIRED', 422],
      [mapAssertSizeEquivalenceActionProblem, 'ACTION_INVOCATION_ID', 409],
    ] as const;
    for (const [map, conflict, status] of cases) {
      const problem = map(
        new SizePersistenceConflict({
          code: 'size_persistence_conflict',
          conflict,
          reason: 'private Size detail',
        }),
      );
      expect(problem.status).toBe(status);
      expect(JSON.stringify(problem)).not.toContain('private Size detail');
    }
    for (const map of [mapReplaceProductSizesActionProblem, mapAssertSizeEquivalenceActionProblem] as const) {
      const problem = map(
        new CatalogPersistenceUnavailable({
          code: 'catalog_persistence_unavailable',
          reason: 'private storage detail',
        }),
      );
      expect(problem).toMatchObject({ code: 'catalog_persistence_unavailable', retryable: true, status: 503 });
      expect(JSON.stringify(problem)).not.toContain('private storage detail');
    }
  });
});
