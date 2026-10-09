import { expect, it } from 'effect-rstest';

import { mapCreateAttributeDefinitionActionProblem } from '../../api/create-attribute-definition-action-problems.ts';
import { mapCreateControlledAttributeValueActionProblem } from '../../api/create-controlled-attribute-value-action-problems.ts';
import { mapReactivateControlledAttributeValueActionProblem } from '../../api/reactivate-controlled-attribute-value-action-problems.ts';
import { mapRenameAttributeDefinitionActionProblem } from '../../api/rename-attribute-definition-action-problems.ts';
import { mapRenameControlledAttributeValueActionProblem } from '../../api/rename-controlled-attribute-value-action-problems.ts';
import { mapRetireControlledAttributeValueActionProblem } from '../../api/retire-controlled-attribute-value-action-problems.ts';
import {
  executeCreateAttributeDefinition,
  executeCreateControlledAttributeValue,
  executeReactivateControlledAttributeValue,
  executeRenameAttributeDefinition,
  executeRenameControlledAttributeValue,
  executeRetireControlledAttributeValue,
  executeProductCategoryClassification,
  executeProductCategoryHistory,
} from '@app/catalog/api/client';
import {
  AttributePersistenceConflict,
  AttributePersistenceNotFound,
} from '../../src/persistence/attribute-persistence.ts';
import { CatalogPersistenceUnavailable } from '../../src/persistence/errors.ts';

const mappers = [
  mapCreateAttributeDefinitionActionProblem,
  mapCreateControlledAttributeValueActionProblem,
  mapReactivateControlledAttributeValueActionProblem,
  mapRenameAttributeDefinitionActionProblem,
  mapRenameControlledAttributeValueActionProblem,
  mapRetireControlledAttributeValueActionProblem,
] as const;

it('publishes Attribute Actions and Category reads through the supported Catalog client surface', () => {
  for (const client of [
    executeCreateAttributeDefinition,
    executeCreateControlledAttributeValue,
    executeReactivateControlledAttributeValue,
    executeRenameAttributeDefinition,
    executeRenameControlledAttributeValue,
    executeRetireControlledAttributeValue,
    executeProductCategoryClassification,
    executeProductCategoryHistory,
  ]) {
    expect(client).toBeDefined();
  }
});

it('maps Attribute business failures to redacted, typed HTTP statuses', () => {
  for (const map of mappers) {
    for (const conflict of ['IDENTITY', 'ACTION_INVOCATION_ID', 'REVISION', 'INVALID_STATE'] as const) {
      const result = map(
        new AttributePersistenceConflict({
          code: 'attribute_persistence_conflict',
          conflict,
          reason: 'private persistence detail',
        }),
      );
      expect(result).toMatchObject({ code: 'attribute_persistence_conflict', status: 409 });
      expect(JSON.stringify(result)).not.toContain('private persistence detail');
    }
    expect(
      map(
        new AttributePersistenceConflict({
          code: 'attribute_persistence_conflict',
          conflict: 'INVALID_INPUT',
          reason: 'private persistence detail',
        }),
      ),
    ).toMatchObject({ code: 'attribute_invalid_input', status: 422 });
    expect(
      map(
        new AttributePersistenceNotFound({
          code: 'attribute_persistence_not_found',
          reason: 'private persistence detail',
          resource: 'CONTROLLED_VALUE',
        }),
      ),
    ).toMatchObject({ code: 'attribute_persistence_not_found', status: 404 });
    expect(
      map(
        new CatalogPersistenceUnavailable({
          code: 'catalog_persistence_unavailable',
          reason: 'private persistence detail',
        }),
      ),
    ).toMatchObject({ code: 'catalog_persistence_unavailable', retryable: true, status: 503 });
  }
});
