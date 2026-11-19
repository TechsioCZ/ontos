import { describe, expect, it } from 'effect-rstest';

import { communicationsApiContract } from '../../shared/api.ts';
import { communicationsRegistration } from '../../vertical.registration.ts';
import { communicationsManifest } from '../../vertical.manifest.ts';

describe('Communications module contract', () => {
  it('is the API-only business module communications.core', () => {
    expect(communicationsManifest.module).toMatchObject({
      id: 'communications.core',
      implementedAs: 'ultramodern_microvertical',
      kind: 'business_module',
    });
    expect(communicationsManifest.publicSurface.shellContributions.pages).toEqual([]);
    expect(communicationsManifest.publicSurface.shellContributions.navigation).toEqual([]);
    expect(communicationsManifest.publicSurface.components).toEqual({});
  });

  it('carries the template revision Actions and no Read API before the later lanes add theirs', () => {
    expect(
      communicationsManifest.publicSurface.actions
        .map((action) => action.descriptor.actionKey)
        .toSorted((left, right) => left.localeCompare(right)),
    ).toEqual([
      'communications.core.activate-template-revision',
      'communications.core.deactivate-template-revision',
      'communications.core.invalidate-template-revision',
      'communications.core.prepare-template-revision',
    ]);
    expect(communicationsManifest.publicSurface.api).toEqual({});
    expect(communicationsRegistration.moduleId).toBe('communications.core');
  });

  it('serves its API below the deployment prefix', () => {
    expect(communicationsApiContract.apiPrefix).toBe('/communications-api');
    expect(communicationsApiContract.ownerId).toBe('communications');
  });
});
