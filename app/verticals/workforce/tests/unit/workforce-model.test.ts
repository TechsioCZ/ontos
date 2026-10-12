import { expect, it } from 'effect-rstest';
import { employeeResourceDescriptor } from '../../shared/resources/employee.ts';

it('owns its primary resource type', () => {
  expect(employeeResourceDescriptor.owningModuleId).toBe('demo.workforce');
});
