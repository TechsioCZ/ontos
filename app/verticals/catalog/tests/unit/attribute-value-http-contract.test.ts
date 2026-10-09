import { describe, expect, it } from 'effect-rstest';

import { catalogAuthorityBundles, catalogPublicOperationContracts } from '../../shared/api.ts';
import { SetProductAttributeValuesActionApi } from '../../shared/apis/set-product-attribute-values-action.ts';
import { RemoveProductAttributeValuesActionApi } from '../../shared/apis/remove-product-attribute-values-action.ts';
import { SetVariantAttributeOverrideActionApi } from '../../shared/apis/set-variant-attribute-override-action.ts';
import { RemoveVariantAttributeOverrideActionApi } from '../../shared/apis/remove-variant-attribute-override-action.ts';
import { AttributeValuesConflict } from '../../src/persistence/attribute-values-persistence.ts';
import { CatalogPersistenceUnavailable } from '../../src/persistence/errors.ts';
import { CatalogOpenSelectionImpactUnavailable } from '../../src/persistence/catalog-open-selection-impact.ts';
import { ProductAttributeChangeConflict } from '../../shared/actions/attribute-value-mutations.ts';
import { mapSetProductAttributeValuesActionProblem } from '../../api/set-product-attribute-values-action-problems.ts';
import { mapRemoveProductAttributeValuesActionProblem } from '../../api/remove-product-attribute-values-action-problems.ts';
import { mapSetVariantAttributeOverrideActionProblem } from '../../api/set-variant-attribute-override-action-problems.ts';
import { mapRemoveVariantAttributeOverrideActionProblem } from '../../api/remove-variant-attribute-override-action-problems.ts';
import {
  executeSetProductAttributeValues,
  executeRemoveProductAttributeValues,
  executeSetVariantAttributeOverride,
  executeRemoveVariantAttributeOverride,
} from '@app/catalog/api/client';

const actions = [
  [
    'commerce.catalog.set-product-attribute-values',
    SetProductAttributeValuesActionApi,
    executeSetProductAttributeValues,
    'product',
  ],
  [
    'commerce.catalog.remove-product-attribute-values',
    RemoveProductAttributeValuesActionApi,
    executeRemoveProductAttributeValues,
    'product',
  ],
  [
    'commerce.catalog.set-variant-attribute-override',
    SetVariantAttributeOverrideActionApi,
    executeSetVariantAttributeOverride,
    'variant',
  ],
  [
    'commerce.catalog.remove-variant-attribute-override',
    RemoveVariantAttributeOverrideActionApi,
    executeRemoveVariantAttributeOverride,
    'variant',
  ],
] as const;
const mappers: readonly ((error: AttributeValuesConflict | CatalogPersistenceUnavailable) => object)[] = [
  mapSetProductAttributeValuesActionProblem,
  mapRemoveProductAttributeValuesActionProblem,
  mapSetVariantAttributeOverrideActionProblem,
  mapRemoveVariantAttributeOverrideActionProblem,
];

describe('Attribute Value HTTP Actions', () => {
  it('publishes four independent tenant-scoped Action transports with Product Editor authority', () => {
    for (const [key, api, client, businessTarget] of actions) {
      expect(api).toBeDefined();
      expect(client).toBeDefined();
      expect(catalogPublicOperationContracts[key]).toEqual({
        authorityBundle: 'PRODUCT_EDITOR',
        businessTarget,
        permission: key,
        permissionKind: 'action_execution',
        scope: 'tenant',
        version: '1',
      });
      expect(catalogAuthorityBundles.PRODUCT_EDITOR).toContain(key);
      expect(catalogAuthorityBundles.CATALOG_DEFINITION_MANAGER).not.toContain(key);
    }
  });

  it('maps stale, invalid, absent, and unavailable failures to redacted statuses', () => {
    for (const map of mappers) {
      for (const [conflict, status, code] of [
        ['BASIS_CHANGED', 409, 'attribute_values_conflict'],
        ['REVISION', 409, 'attribute_values_conflict'],
        ['IDENTITY_IMPACT', 409, 'attribute_values_conflict'],
        ['INVALID_INPUT', 422, 'attribute_values_ineligible'],
        ['INAPPLICABLE', 422, 'attribute_values_ineligible'],
        ['REQUIRED', 422, 'attribute_values_ineligible'],
        ['NOT_FOUND', 404, 'attribute_values_not_found'],
      ] as const) {
        const problem = map(
          new AttributeValuesConflict({
            code: 'attribute_values_conflict',
            conflict,
            reason: 'private subject detail',
          }),
        );
        expect(problem).toMatchObject({ code, status });
        expect(JSON.stringify(problem)).not.toContain('private subject detail');
      }
      const unavailable = map(
        new CatalogPersistenceUnavailable({
          code: 'catalog_persistence_unavailable',
          reason: 'private database detail',
        }),
      );
      expect(unavailable).toMatchObject({ code: 'catalog_persistence_unavailable', retryable: true, status: 503 });
      expect(JSON.stringify(unavailable)).not.toContain('private database detail');
    }
  });

  it('maps Product classification and unavailable impact without leaking evidence', () => {
    for (const map of [mapSetProductAttributeValuesActionProblem, mapRemoveProductAttributeValuesActionProblem]) {
      const classification = map(
        new ProductAttributeChangeConflict({
          code: 'product_attribute_change_conflict',
          reason: 'private realization detail',
        }),
      );
      const impact = map(
        new CatalogOpenSelectionImpactUnavailable({
          code: 'catalog_open_selection_impact_unavailable',
          reason: 'private selection detail',
        }),
      );
      expect(classification).toMatchObject({ code: 'attribute_values_ineligible', status: 422 });
      expect(impact).toMatchObject({ code: 'catalog_persistence_unavailable', retryable: true, status: 503 });
      expect(JSON.stringify([classification, impact])).not.toContain('private');
    }
  });
});
