import { expect, it } from 'effect-rstest';

import {
  completePriceGroupContainmentProjectionRoutine,
  readPriceGroupContainmentProjectionIntentRoutine,
} from '../../src/persistence/containment-projection-routines.ts';

import {
  createDefinitionRevisionRoutine,
  createPriceGroupRoutine,
  readCurrentDefinitionRoutine,
  readDefinitionRevisionRoutine,
  retirePriceGroupRoutine,
  validateCompatibilityRoutine,
} from '../../src/persistence/scoped-routine.ts';

const routines = [
  createPriceGroupRoutine,
  createDefinitionRevisionRoutine,
  retirePriceGroupRoutine,
  readCurrentDefinitionRoutine,
  readDefinitionRevisionRoutine,
  validateCompatibilityRoutine,
  readPriceGroupContainmentProjectionIntentRoutine,
  completePriceGroupContainmentProjectionRoutine,
] as const;

it('declares an exact immutable tenant-only owner routine allowlist', () => {
  expect(routines.map(({ name }) => name)).toEqual([
    'create_price_group_with_complete_schedule',
    'create_definition_revision_with_continuity',
    'retire_price_group',
    'read_current_definition_with_retirement',
    'read_definition_revision_with_retirement',
    'validate_compatibility',
    'read_price_group_containment_projection_intent',
    'complete_price_group_containment_projection',
  ]);
  for (const routine of routines) {
    expect(Object.isFrozen(routine)).toBe(true);
    expect(routine.ownerModuleKey).toBe('pricing.price-group-catalog');
    expect(routine.schema).toBe('price_group_catalog');
    expect(routine.parameters[0]).toEqual({ source: 'tenantId', type: 'uuid' });
  }
  expect(validateCompatibilityRoutine.parameters).toEqual([
    { source: 'tenantId', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'bigint' },
    { source: 'input', type: 'timestamptz' },
    { source: 'input', type: 'jsonb' },
  ]);
});
