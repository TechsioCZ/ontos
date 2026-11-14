import { expect, it } from 'effect-rstest';
import { metricResourceDescriptor } from '../../shared/resources/metric.ts';

it('owns its primary resource type', () => {
  expect(metricResourceDescriptor.owningModuleId).toBe('demo.sales-insights');
});
