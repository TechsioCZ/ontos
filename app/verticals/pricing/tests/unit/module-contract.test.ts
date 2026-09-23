import { describe, expect, it } from 'effect-rstest';

import { pricingApi } from '../../shared/api.ts';
import { pricingManifest } from '../../vertical.manifest.ts';
import { pricingRegistration } from '../../vertical.registration.ts';

describe('Pricing module contract', () => {
  it('publishes one headless governed read under commerce.pricing', () => {
    expect(pricingManifest.module.id).toBe('commerce.pricing');
    expect(Object.keys(pricingManifest.publicSurface.api)).toEqual(['current-supported-currencies']);
    expect(pricingManifest.publicSurface.shellContributions.pages).toEqual([]);
    expect(pricingRegistration.moduleId).toBe(pricingManifest.module.id);
    expect(pricingApi).toBeDefined();
  });
});
