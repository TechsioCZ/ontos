import { expect, it } from 'effect-rstest';
import { opportunityResourceDescriptor } from '../../shared/resources/opportunity.ts';

it('owns its primary resource type', () => {
  expect(opportunityResourceDescriptor.owningModuleId).toBe('demo.sales-pipeline');
});
