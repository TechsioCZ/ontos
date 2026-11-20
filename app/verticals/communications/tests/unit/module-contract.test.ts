import { describe, expect, it } from 'effect-rstest';

import { communicationsApiContract } from '../../shared/api.ts';
import { languagePolicyOperation } from '../../shared/apis/language-policy.ts';
import { privacyOwnerCoverageOperation } from '../../shared/apis/privacy-owner-coverage.ts';
import { privacyOwnerExecutionOutcomeOperation } from '../../shared/apis/privacy-owner-execution-outcome.ts';
import { recordOwnerExecutionEvidenceAction } from '../../src/actions/record-owner-execution-evidence.action.ts';
import { privacyOwnerExecutionOutcomeRead } from '../../src/api/privacy-owner-execution-outcome.read.ts';
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
      'communications.core.record-owner-execution-evidence',
      'communications.core.set-language-policy',
      'communications.core.submit-communication-request',
    ]);
    expect(Object.keys(communicationsManifest.publicSurface.api)).toEqual([
      'language-policy',
      'message-history-detail',
      'message-history-list',
      'privacy-owner-coverage',
      'privacy-owner-execution-outcome',
    ]);
    expect(communicationsManifest.publicSurface.operationContracts?.map((contract) => contract.operationKey)).toEqual([
      'languagePolicy.execute',
      'messageHistoryDetail.execute',
      'messageHistoryList.execute',
      'privacyOwnerCoverage.execute',
      'privacyOwnerExecutionOutcome.execute',
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

  it('publishes the Privacy owner coverage Read as a typed operation of exactly this owner, and no Action that could dispose of data', () => {
    expect(privacyOwnerCoverageOperation).toMatchObject({
      kind: 'read',
      provider: {
        entrypointKey: 'communications.core.api.privacy-owner-coverage',
        moduleId: 'communications.core',
        schemaVersion: '1',
      },
    });
    const actionKeys = communicationsManifest.publicSurface.actions.map((action) => action.descriptor.actionKey);
    expect(actionKeys.filter((key) => /delete|purge|anonymi[sz]e|erase|shred|cleanup/iu.test(key))).toEqual([]);
  });

  it('publishes the owner execution receipt Read at tenant scope for Privacy only, and an evidence Action that only records', () => {
    expect(privacyOwnerExecutionOutcomeOperation).toMatchObject({
      kind: 'read',
      provider: {
        entrypointKey: 'communications.core.api.privacy-owner-execution-outcome',
        moduleId: 'communications.core',
        schemaVersion: '1',
      },
    });
    expect(privacyOwnerExecutionOutcomeRead.descriptor).toMatchObject({
      accessActor: { callers: ['privacy'], subject: 'identity' },
      accessDeclaration: {
        key: 'communications.core.privacy-owner-execution-outcome.read',
        kind: 'read',
        selectors: ['all'],
      },
      legalEntityScope: 'optional',
    });
    expect(recordOwnerExecutionEvidenceAction.descriptor).toMatchObject({
      accessDeclaration: {
        key: 'communications.core.owner-execution-evidence.record',
        kind: 'action',
        risk: 'critical',
      },
      entrypoint: { authorization: { kind: 'protected' } },
      legalEntityScope: 'forbidden',
    });
    // the dispatch consumer declares exactly the Privacy dispatch it receives and the one report it makes
    expect(communicationsManifest.originatorActions).toEqual(['privacy.core.dispatch-privacy-measure']);
    expect(communicationsManifest.requirements?.operations).toEqual([
      expect.objectContaining({
        entrypointKey: 'communications.core.receive-privacy-measure',
        key: 'communications.core.requirement.privacy-report-owner-outcome',
        provider: {
          entrypointKey: 'privacy.core.record-owner-execution-outcome',
          moduleId: 'privacy.core',
          schemaVersion: '1',
        },
      }),
    ]);
  });

  it('serves its API below the deployment prefix', () => {
    expect(communicationsApiContract.apiPrefix).toBe('/communications-api');
    expect(communicationsApiContract.ownerId).toBe('communications');
  });
});
