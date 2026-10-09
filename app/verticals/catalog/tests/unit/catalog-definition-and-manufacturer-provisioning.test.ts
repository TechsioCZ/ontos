import { describe, expect, it } from 'effect-rstest';

import { changeProductManufacturerAction } from '../../src/actions/change-product-manufacturer.action.ts';
import { createPackageDefinitionAction } from '../../src/actions/create-package-definition.action.ts';
import { createProductUnitAction } from '../../src/actions/create-product-unit.action.ts';
import { removeProductManufacturerAction } from '../../src/actions/remove-product-manufacturer.action.ts';
import { retirePackageDefinitionAction } from '../../src/actions/retire-package-definition.action.ts';
import { retireProductUnitAction } from '../../src/actions/retire-product-unit.action.ts';
import { revisePackageDefinitionAction } from '../../src/actions/revise-package-definition.action.ts';
import { reviseProductUnitAction } from '../../src/actions/revise-product-unit.action.ts';
import { setProductManufacturerAction } from '../../src/actions/set-product-manufacturer.action.ts';
import { setProductUnitTargetDivisibilityAction } from '../../src/actions/set-product-unit-target-divisibility.action.ts';

const definitionActions = [
  createPackageDefinitionAction,
  revisePackageDefinitionAction,
  retirePackageDefinitionAction,
  createProductUnitAction,
  reviseProductUnitAction,
  retireProductUnitAction,
  setProductUnitTargetDivisibilityAction,
] as const;

const productEditorActions = [
  setProductManufacturerAction,
  changeProductManufacturerAction,
  removeProductManufacturerAction,
] as const;

describe('Catalog definition and manufacturer provisioning (#477)', () => {
  it('requires narrow executor grants for shared definition writes', () => {
    expect(definitionActions.map(({ descriptor }) => descriptor.actionKey)).toEqual([
      'commerce.catalog.create-package-definition',
      'commerce.catalog.revise-package-definition',
      'commerce.catalog.retire-package-definition',
      'commerce.catalog.create-product-unit',
      'commerce.catalog.revise-product-unit',
      'commerce.catalog.retire-product-unit',
      'commerce.catalog.set-product-unit-target-divisibility',
    ]);
    for (const { descriptor } of definitionActions) {
      expect(descriptor.entrypoint.authorization).toEqual({ kind: 'action_execution', provisioning: 'explicit' });
      expect(descriptor.entrypoint.access).toBe('write');
      expect(descriptor.idempotency).toBe('required');
      expect(descriptor.legalEntityScope).toBe('forbidden');
    }
  });

  it('requires narrow executor grants for Product Manufacturer assignment writes', () => {
    expect(productEditorActions.map(({ descriptor }) => descriptor.actionKey)).toEqual([
      'commerce.catalog.set-product-manufacturer',
      'commerce.catalog.change-product-manufacturer',
      'commerce.catalog.remove-product-manufacturer',
    ]);
    for (const { descriptor } of productEditorActions) {
      expect(descriptor.entrypoint.authorization).toEqual({ kind: 'action_execution', provisioning: 'explicit' });
      expect(descriptor.entrypoint.access).toBe('write');
      expect(descriptor.idempotency).toBe('required');
      expect(descriptor.legalEntityScope).toBe('forbidden');
    }
  });
});
