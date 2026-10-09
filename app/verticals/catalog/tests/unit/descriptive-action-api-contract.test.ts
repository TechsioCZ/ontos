import { expect, it } from 'effect-rstest';

import { mapSetProductLocalizedFactsActionProblem } from '../../api/set-product-localized-facts-action-problems.ts';
import { mapRemoveProductLocalizedFactsActionProblem } from '../../api/remove-product-localized-facts-action-problems.ts';
import { mapSetVariantLocalizedFactsActionProblem } from '../../api/set-variant-localized-facts-action-problems.ts';
import { mapRemoveVariantLocalizedFactsActionProblem } from '../../api/remove-variant-localized-facts-action-problems.ts';
import { mapAssignCatalogMediaActionProblem } from '../../api/assign-catalog-media-action-problems.ts';
import { mapReorderCatalogMediaActionProblem } from '../../api/reorder-catalog-media-action-problems.ts';
import { mapRemoveCatalogMediaActionProblem } from '../../api/remove-catalog-media-action-problems.ts';
import { LocalizedFactsConflict } from '../../src/actions/localized-facts-action-support.ts';
import { LocalizedFactsNotFound } from '../../src/actions/localized-facts-not-found.ts';
import { LocalizedFactsPersistenceUnavailable } from '../../src/persistence/localized-product-facts-persistence.ts';
import { CatalogMediaConflict } from '../../src/actions/catalog-media-conflict.ts';
import { CatalogMediaNotFound } from '../../src/actions/catalog-media-action-support.ts';
import { CatalogPersistenceUnavailable } from '../../src/persistence/errors.ts';

it('maps localized-fact Action failures to redacted, typed 409/404/503 responses', () => {
  const mappers = [
    mapSetProductLocalizedFactsActionProblem,
    mapRemoveProductLocalizedFactsActionProblem,
    mapSetVariantLocalizedFactsActionProblem,
    mapRemoveVariantLocalizedFactsActionProblem,
  ] as const;
  for (const mapProblem of mappers) {
    const conflict = mapProblem(
      new LocalizedFactsConflict({ code: 'localized_facts_conflict', reason: 'private revision detail' }),
    );
    const missing = mapProblem(
      new LocalizedFactsNotFound({ code: 'localized_facts_not_found', reason: 'private tenant detail' }),
    );
    const unavailable = mapProblem(
      new LocalizedFactsPersistenceUnavailable({
        code: 'localized_facts_persistence_unavailable',
        reason: 'private storage detail',
      }),
    );
    expect(conflict).toMatchObject({ code: 'localized_facts_conflict', status: 409 });
    expect(missing).toMatchObject({ code: 'localized_facts_not_found', status: 404 });
    expect(unavailable).toMatchObject({
      code: 'localized_facts_persistence_unavailable',
      retryable: true,
      status: 503,
    });
    expect(JSON.stringify([conflict, missing, unavailable])).not.toContain('private');
  }
});

it('maps media-assignment Action failures without exposing owner Resource details', () => {
  const mappers = [
    mapAssignCatalogMediaActionProblem,
    mapReorderCatalogMediaActionProblem,
    mapRemoveCatalogMediaActionProblem,
  ] as const;
  for (const mapProblem of mappers) {
    const conflict = mapProblem(
      new CatalogMediaConflict({ code: 'catalog_media_conflict', reason: 'private order detail' }),
    );
    const missing = mapProblem(
      new CatalogMediaNotFound({ code: 'catalog_media_not_found', reason: 'private Resource detail' }),
    );
    const unavailable = mapProblem(
      new CatalogPersistenceUnavailable({ code: 'catalog_persistence_unavailable', reason: 'private storage detail' }),
    );
    expect(conflict).toMatchObject({ code: 'catalog_media_conflict', status: 409 });
    expect(missing).toMatchObject({ code: 'catalog_media_not_found', status: 404 });
    expect(unavailable).toMatchObject({ code: 'catalog_persistence_unavailable', retryable: true, status: 503 });
    expect(JSON.stringify([conflict, missing, unavailable])).not.toContain('private');
  }
});
