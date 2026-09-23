import { expect, it } from 'effect-rstest';

import {
  createPricingClient,
  createStorefrontRegistryClient,
  getPricingReadiness,
  getStorefrontRegistryReadiness,
} from '../../src/api/vertical-clients.ts';

it('re-exports the generated headless owner clients', () => {
  expect(createPricingClient).toBeTypeOf('function');
  expect(getPricingReadiness).toBeTypeOf('function');
  expect(createStorefrontRegistryClient).toBeTypeOf('function');
  expect(getStorefrontRegistryReadiness).toBeTypeOf('function');
});
