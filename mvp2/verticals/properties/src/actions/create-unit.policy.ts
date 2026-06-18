import { allowPolicy, denyPolicy } from '@mvp2/core-runtime';
import type { PolicyCheck } from '@mvp2/core-runtime';
import type { CreateUnitAction } from './create-unit.action.ts';

export const rejectCreateUnitNameEndingWithUnitPolicy: PolicyCheck<CreateUnitAction> = (value) =>
  value.endsWith('unit')
    ? denyPolicy({
        code: 'create_unit_name_ends_with_unit',
        policyKey: 'property.registry.createUnit.nameEndsWithUnit',
        reason: 'CreateUnitAction cannot use a value ending with "unit".',
      })
    : allowPolicy({
        policyKey: 'property.registry.createUnit.nameEndsWithUnit',
        reason: 'CreateUnitAction value does not end with "unit".',
      });
