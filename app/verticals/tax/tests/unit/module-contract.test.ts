import { describe, expect, it } from 'effect-rstest';
import { taxApi } from '../../shared/api.ts';
import { getTaxReadiness } from '../../src/api/tax-client.ts';
import { taxManifest } from '../../vertical.manifest.ts';
import { taxRegistration } from '../../vertical.registration.ts';

describe('Tax module contract', () => {
  it('publishes only the headless Tax foundation surface', () => {
    expect(taxManifest.module.id).toBe('commerce.tax');
    expect(Object.keys(taxManifest.publicSurface.api)).toEqual([]);
    expect(taxManifest.publicSurface.actions).toEqual([]);
    expect(taxManifest.publicSurface.resourceTypes).toEqual([]);
    expect(taxManifest.publicSurface.shellContributions.navigation).toEqual([]);
    expect(taxManifest.publicSurface.shellContributions.pages).toEqual([]);
    expect(taxRegistration.moduleId).toBe(taxManifest.module.id);
    expect(Object.keys(taxApi.groups)).toEqual(['foundation']);
    expect(getTaxReadiness).toBeDefined();
  });
});
