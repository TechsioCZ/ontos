import { describe, expect, it } from 'effect-rstest';

import { communicationsApiContract } from '../../shared/api.ts';
import { languagePolicyOperation } from '../../shared/apis/language-policy.ts';
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

  it('carries the template revision Actions, the language mode Action, the history Reads, the request intake and no later lane', () => {
    expect(
      communicationsManifest.publicSurface.actions
        .map((action) => action.descriptor.actionKey)
        .toSorted((left, right) => left.localeCompare(right)),
    ).toEqual([
      'communications.core.activate-template-revision',
      'communications.core.deactivate-template-revision',
      'communications.core.invalidate-template-revision',
      'communications.core.prepare-template-revision',
      'communications.core.set-language-policy',
      'communications.core.submit-communication-request',
    ]);
    expect(Object.keys(communicationsManifest.publicSurface.api)).toEqual([
      'language-policy',
      'message-history-detail',
      'message-history-list',
    ]);
    expect(communicationsManifest.publicSurface.operationContracts?.map((contract) => contract.operationKey)).toEqual([
      'languagePolicy.execute',
      'messageHistoryDetail.execute',
      'messageHistoryList.execute',
    ]);
    expect(communicationsRegistration.moduleId).toBe('communications.core');
  });

  it('publishes the language mode Read as a typed Core SDK operation of exactly this owner', () => {
    expect(languagePolicyOperation).toMatchObject({
      kind: 'read',
      provider: {
        entrypointKey: 'communications.core.api.language-policy',
        moduleId: 'communications.core',
        schemaVersion: '1',
      },
      route: { path: '/reads/language-policy' },
    });
  });

  it('serves its API below the deployment prefix', () => {
    expect(communicationsApiContract.apiPrefix).toBe('/communications-api');
    expect(communicationsApiContract.ownerId).toBe('communications');
  });
});
