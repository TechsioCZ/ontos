import type { OutboxWorkerHandlerContext } from '@app/core-runtime';
import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { communicationsApiContract } from '../../shared/api.ts';
import { builtInTemplateDefaultsOperation } from '../../shared/apis/built-in-template-defaults.ts';
import { templateRevisionListOperation } from '../../shared/apis/template-revision-list.ts';
import { communicationOutcomeFeedOperation } from '@app/communications-contracts/communication-outcome-feed';
import { languagePolicyOperation } from '../../shared/apis/language-policy.ts';
import { privacyOwnerCoverageOperation } from '@app/communications-contracts/privacy-owner-coverage';
import { privacyOwnerExecutionOutcomeOperation } from '@app/communications-contracts/privacy-owner-execution-outcome';
import { activateTemplateRevisionAction } from '../../src/actions/activate-template-revision.action.ts';
import { deactivateTemplateRevisionAction } from '../../src/actions/deactivate-template-revision.action.ts';
import { ingestProviderObservationAction } from '../../src/actions/ingest-provider-observation.action.ts';
import { invalidateTemplateRevisionAction } from '../../src/actions/invalidate-template-revision.action.ts';
import { prepareTemplateRevisionAction } from '../../src/actions/prepare-template-revision.action.ts';
import { recordOwnerExecutionEvidenceAction } from '../../src/actions/record-owner-execution-evidence.action.ts';
import { setLanguagePolicyAction } from '../../src/actions/set-language-policy.action.ts';
import { submitCommunicationRequestAction } from '../../src/actions/submit-communication-request.action.ts';
import { privacyOwnerCoverageRead } from '../../src/api/privacy-owner-coverage.read.ts';
import { OWNER_ASK_CONSUMERS, OWNER_ASKS, ownerAskRequirementKey } from '../../src/handoff/requirement-keys.ts';
import type { OwnerAsk } from '../../src/handoff/requirement-keys.ts';
import { workerOwnerCall } from '../../src/integrations/owner-call.ts';
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

  it('carries the template revision Actions, the language mode Action, the history Reads, the source outcome feed, the request intake and no later lane', () => {
    expect(
      communicationsManifest.publicSurface.actions
        .map((action) => action.descriptor.actionKey)
        .toSorted((left, right) => left.localeCompare(right)),
    ).toEqual([
      'communications.core.activate-template-revision',
      'communications.core.deactivate-template-revision',
      'communications.core.ingest-provider-observation',
      'communications.core.invalidate-template-revision',
      'communications.core.prepare-template-revision',
      'communications.core.record-owner-execution-evidence',
      'communications.core.set-language-policy',
      'communications.core.submit-communication-request',
    ]);
    expect(Object.keys(communicationsManifest.publicSurface.api)).toEqual([
      'built-in-template-defaults',
      'communication-outcome-feed',
      'language-policy',
      'message-history-detail',
      'message-history-list',
      'privacy-owner-coverage',
      'privacy-owner-execution-outcome',
      'template-revision-list',
    ]);
    expect(communicationsManifest.publicSurface.operationContracts?.map((contract) => contract.operationKey)).toEqual([
      'builtInTemplateDefaults.execute',
      'communicationOutcomeFeed.execute',
      'languagePolicy.execute',
      'messageHistoryDetail.execute',
      'messageHistoryList.execute',
      'privacyOwnerCoverage.execute',
      'privacyOwnerExecutionOutcome.execute',
      'templateRevisionList.execute',
    ]);
    expect(communicationsRegistration.moduleId).toBe('communications.core');
  });

  it('publishes the built-in template defaults review Read as a typed Core SDK operation of exactly this owner', () => {
    expect(builtInTemplateDefaultsOperation).toMatchObject({
      kind: 'read',
      provider: {
        entrypointKey: 'communications.core.api.built-in-template-defaults',
        moduleId: 'communications.core',
        schemaVersion: '1',
      },
      route: { path: '/reads/built-in-template-defaults' },
    });
  });

  it('publishes the template revision list Read as a typed Core SDK operation of exactly this owner', () => {
    expect(templateRevisionListOperation).toMatchObject({
      kind: 'read',
      provider: {
        entrypointKey: 'communications.core.api.template-revision-list',
        moduleId: 'communications.core',
        schemaVersion: '1',
      },
      route: { path: '/reads/template-revision-list' },
    });
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

  it('publishes the source outcome feed Read as a typed operation of exactly this owner', () => {
    expect(communicationOutcomeFeedOperation).toMatchObject({
      kind: 'read',
      provider: {
        entrypointKey: 'communications.core.api.communication-outcome-feed',
        moduleId: 'communications.core',
        schemaVersion: '1',
      },
      route: { path: '/reads/communication-outcome-feed' },
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
      accessActor: { callers: ['privacy'], subject: 'rights' },
      accessDeclaration: {
        key: 'communications.core.privacy-owner-execution-outcome.read',
        kind: 'read',
        selectors: [],
      },
      legalEntityScope: 'optional',
    });
    // the coverage Read is decided the same way: on the requester's own scope-wide grant, never on identity alone
    expect(privacyOwnerCoverageRead.descriptor).toMatchObject({
      accessActor: { callers: ['privacy'], subject: 'rights' },
      accessDeclaration: { key: 'communications.core.privacy-owner-coverage.read', kind: 'read', selectors: [] },
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
    // the dispatch consumer declares exactly the Privacy dispatch it receives and the one report it makes, from the
    // take-over worker and from the continuation worker of a later human-recorded confirmation, to the same Action only
    expect(communicationsManifest.originatorActions).toEqual(['privacy.core.dispatch-privacy-measure']);
    const outcomeProvider = {
      entrypointKey: 'privacy.core.record-owner-execution-outcome',
      moduleId: 'privacy.core',
      schemaVersion: '1',
    };
    const operations = communicationsManifest.requirements?.operations ?? [];
    expect(operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entrypointKey: 'communications.core.receive-privacy-measure',
          key: 'communications.core.requirement.privacy-report-owner-outcome',
          provider: outcomeProvider,
        }),
        expect.objectContaining({
          entrypointKey: 'communications.core.report-privacy-owner-outcome',
          key: 'communications.core.requirement.privacy-report-recorded-owner-outcome',
          provider: outcomeProvider,
        }),
      ]),
    );
    // the evidence Action's only message is the continuation of the same Privacy dispatch: identities and an attempt
    expect(Object.keys(recordOwnerExecutionEvidenceAction.descriptor.domainEvents)).toEqual([
      'communications.core.owner-execution-evidence-recorded.v1',
    ]);
  });

  it('[D-2] declares one operation requirement per consuming entrypoint and owner Read it asks, with the keys the adapters send', () => {
    const operations = communicationsManifest.requirements?.operations ?? [];
    const consumers = Object.values(OWNER_ASK_CONSUMERS);
    const asks = [
      'AUTH_ISSUANCE_SOURCE',
      'PRIVACY_PRE_VERIFICATION',
      'PRIVACY_SOURCE_PROCESSING',
    ] as const satisfies readonly OwnerAsk[];
    expect(communicationsManifest.requirements?.coreCapabilities).toEqual([
      { id: 'ontos.module-dependency-contracts', version: '1' },
    ]);
    expect(operations).toHaveLength(2 + asks.length * consumers.length);
    for (const ask of asks) {
      const { condition, provider } = OWNER_ASKS[ask];
      for (const consumer of consumers) {
        const key = ownerAskRequirementKey(consumer, ask);
        expect(operations.filter((operation) => operation.key === key)).toEqual([
          expect.objectContaining({ condition, entrypointKey: consumer, provider }),
        ]);
      }
    }
    // the published Reads asked, exactly as their owners publish them
    expect(
      [...new Set(asks.map((ask) => OWNER_ASKS[ask].provider.entrypointKey))].toSorted((left, right) =>
        left.localeCompare(right),
      ),
    ).toEqual([
      'commerce.customer-context.api.portal-auth-issuance-source',
      'privacy.core.api.pre-verification-eligibility',
      'privacy.core.api.source-processing-eligibility',
    ]);
  });

  it('[D-2] names the requirement of the asking worker itself, never one of another entrypoint', () => {
    const context: OutboxWorkerHandlerContext = {
      attemptNumber: 1,
      claimId: 'claim-1',
      compositionRevision: 'a'.repeat(64),
      consumerModuleKey: 'communications.core',
      deliveryId: 'delivery-1',
      domainEventId: 'event-1',
      legalEntityScope: 'forbidden',
      messageId: 'message-1',
      producerModuleKey: 'communications.core',
      tenantId: '00000000-0000-4000-8000-000000000001',
      tenantSequenceNo: 1n,
      topic: 'communications.core.message-intent-prepared.v1',
      workerKey: 'communications.core.prepare-message-handoff',
    };
    const question = { ask: 'AUTH_ISSUANCE_SOURCE', declarationKey: 'x.read', decodedRequest: {} } as const;
    expect(workerOwnerCall(context, OWNER_ASK_CONSUMERS.PREPARE_HANDOFF).subjectFor(question)).toMatchObject({
      operationRequirementKey: 'communications.core.requirement.prepare-handoff-auth-issuance-source',
    });
    expect(workerOwnerCall(context, OWNER_ASK_CONSUMERS.RECONCILE_EVIDENCE).subjectFor(question)).toMatchObject({
      operationRequirementKey: 'communications.core.requirement.reconcile-evidence-auth-issuance-source',
    });
  });

  it('[#1400 S13] declares no Action, Read or payload field a Tenant could use to switch optional notifications', () => {
    // FICTIONAL vocabulary of a notification switch or preference; the module must name none of it anywhere public
    const switchVocabulary = /notif|prefer|opt[-_]?in|opt[-_]?out|subscri|consent|marketing|switch|toggle|enabled/iu;
    const { actions, api, operationContracts } = communicationsManifest.publicSurface;
    const publicKeys = [
      ...actions.map((action) => action.descriptor.actionKey),
      ...Object.keys(api),
      ...(operationContracts ?? []).map((contract) => contract.operationKey),
    ];
    expect(publicKeys.filter((key) => switchVocabulary.test(key))).toEqual([]);
    // every public Action's own payload contract, checked to be exactly the published set so none escapes the scan
    const registrations = [
      activateTemplateRevisionAction,
      deactivateTemplateRevisionAction,
      ingestProviderObservationAction,
      invalidateTemplateRevisionAction,
      prepareTemplateRevisionAction,
      recordOwnerExecutionEvidenceAction,
      setLanguagePolicyAction,
      submitCommunicationRequestAction,
    ];
    expect(registrations.map(({ descriptor }) => descriptor.actionKey)).toEqual(
      actions.map(({ descriptor }) => descriptor.actionKey),
    );
    /** Every object key at any depth of the payload's JSON Schema: its property names and its definitions. */
    const payloadFields = registrations.flatMap(({ descriptor }) =>
      [
        ...JSON.stringify(Schema.toJsonSchemaDocument(descriptor.payloadSchema)).matchAll(
          /"(?<field>(?:[^"\\]|\\.)*)":/gu,
        ),
      ].map((match) => `${descriptor.actionKey}:${match.groups?.['field'] ?? ''}`),
    );
    // the scan really reads the payloads: the language mode Action's one field is found
    expect(payloadFields).toContain('communications.core.set-language-policy:mode');
    expect(payloadFields).toContain('communications.core.submit-communication-request:originalRecipients');
    expect(payloadFields.filter((field) => switchVocabulary.test(field.split(':').at(-1) ?? ''))).toEqual([]);
  });

  it('serves its API below the deployment prefix', () => {
    expect(communicationsApiContract.apiPrefix).toBe('/communications-api');
    expect(communicationsApiContract.ownerId).toBe('communications');
  });
});
