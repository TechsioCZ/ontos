import { describe, expect, it } from 'effect-rstest';
import { storefrontRegistryManifest } from '../../vertical.manifest.ts';
import { storefrontRegistryRegistration } from '../../vertical.registration.ts';

describe('Storefront Registry module contract', () => {
  it('is headless and exposes its governed owner read and administration actions', () => {
    expect(storefrontRegistryManifest.module.id).toBe('commerce.storefront-registry');
    expect(Object.keys(storefrontRegistryManifest.publicSurface.api)).toEqual(['current-storefront-application']);
    expect(storefrontRegistryManifest.publicSurface.actions.map(({ descriptor }) => descriptor.actionKey)).toEqual([
      'commerce.storefront-registry.register-storefront-application',
      'commerce.storefront-registry.revise-storefront-application',
    ]);
    expect(storefrontRegistryManifest.publicSurface.shellContributions.navigation).toEqual([]);
    expect(storefrontRegistryManifest.publicSurface.shellContributions.pages).toEqual([]);
    expect(storefrontRegistryRegistration.moduleId).toBe(storefrontRegistryManifest.module.id);
  });
});
