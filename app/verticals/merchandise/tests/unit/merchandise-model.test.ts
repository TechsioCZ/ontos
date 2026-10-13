import { expect, it } from 'effect-rstest';
import { sameSku } from '../../shared/domain/merchandise-model.ts';
import { productResourceDescriptor } from '../../shared/resources/product.ts';

it('owns its primary resource type', () => {
  expect(productResourceDescriptor.owningModuleId).toBe('demo.merchandise');
});

it('treats SKUs that differ only in case or outer spaces as the same product', () => {
  expect(sameSku('ms-ergo', 'MS-ERGO')).toBe(true);
  expect(sameSku(' KAB-1 ', 'KAB-1')).toBe(true);
  expect(sameSku('KAB-1', 'KAB-2')).toBe(false);
});
