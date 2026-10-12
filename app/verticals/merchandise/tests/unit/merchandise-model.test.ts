import { expect, it } from 'effect-rstest';
import { productResourceDescriptor } from '../../shared/resources/product.ts';

it('owns its primary resource type', () => {
  expect(productResourceDescriptor.owningModuleId).toBe('demo.merchandise');
});
