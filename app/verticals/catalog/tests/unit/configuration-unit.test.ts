import { expect, it } from 'effect-rstest';

import { CONFIGURATION_UNIT_RESOURCE_TYPE } from '../../shared/domain/configuration-unit.ts';
import { getTableConfig } from 'drizzle-orm/pg-core';
import {
  configurationUnitRevisions,
  configurationUnits,
  productConfigurationChoices,
} from '../../src/database/schema.ts';

it('keeps Configuration Unit independent from purchase Quantity units', () => {
  expect(CONFIGURATION_UNIT_RESOURCE_TYPE).toBe('commerce.catalog.unit');
  expect(getTableConfig(configurationUnits).name).toBe('configuration_units');
  expect(getTableConfig(configurationUnitRevisions).name).toBe('configuration_unit_revisions');
  const choice = getTableConfig(productConfigurationChoices);
  expect(choice.columns.map((column) => column.name)).toContain('unit_revision');
  expect(
    choice.foreignKeys.find((key) => key.getName() === 'catalog_configuration_choices_unit_fk')?.reference()
      .foreignTable,
  ).toBe(configurationUnitRevisions);
});
