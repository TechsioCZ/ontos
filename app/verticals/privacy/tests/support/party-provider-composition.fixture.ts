import { defineRead, defineTenantModuleEntrypoint, defineVerticalRuntimeRegistration } from '@app/core-runtime';
import { makeOwnerApplicationCompositionFixture } from '@app/core-runtime/testing/module-contract';
import { PartyDetailApi, PartyDetailRequestSchema, PartyDetailResponseSchema } from '@app/party-registry/api';
import {
  SourcePersonAdmissionApi,
  SourcePersonAdmissionRequestSchema,
  SourcePersonAdmissionResponseSchema,
} from '@app/party-registry/apis/source-person-admission';
import { Effect } from 'effect';

import { privacyRegistration } from '../../vertical.registration.ts';

const partyModuleId = 'party.registry';
const answeredOutsideComposition = () =>
  Effect.die('The synthetic Party provider only publishes contracts; the test answers the owner call');

/**
 * Party's two published Read contracts that Privacy Subjects requires, under their real entrypoints,
 * schema versions and request/response shapes. It publishes contracts only, so the admitted composition
 * can satisfy Privacy's requirements without installing the real Party module.
 */
const partyDetailContract = defineRead(
  {
    accessDeclaration: {
      key: 'party.registry.party.read',
      kind: 'read',
      modes: ['run'],
      placement: { group: 'party-identity', level: 'basic' },
      risk: 'sensitive',
      selectors: ['all'],
    },
    accessKind: 'detail',
    accessTarget: (input) => ({ moduleKey: partyModuleId, recordKey: input.partyRef.resourceId }),
    entrypoint: defineTenantModuleEntrypoint({
      access: 'read',
      authorization: { kind: 'protected' },
      entrypointKey: 'party.registry.api.party-detail',
      moduleKey: partyModuleId,
      role: 'api',
    }),
    evidencePolicy: { captureMode: 'metadata_only', policyKey: 'party.registry.api.party-detail.evidence.v1' },
    inputSchema: PartyDetailRequestSchema,
    legalEntityScope: 'optional',
    owningModuleKey: partyModuleId,
    policies: [],
    readKey: 'party.registry.api.party-detail',
    resultSchema: PartyDetailResponseSchema,
    schemaVersion: '1',
  },
  answeredOutsideComposition,
  () => Effect.succeed({}),
);

const sourcePersonAdmissionContract = defineRead(
  {
    accessDeclaration: {
      key: 'party.registry.source-person-admission.read',
      kind: 'read',
      modes: ['run'],
      placement: { group: 'source-person-admission', level: 'basic' },
      risk: 'sensitive',
      selectors: ['all'],
    },
    accessKind: 'detail',
    accessTarget: (input) => ({ moduleKey: partyModuleId, recordKey: input.partyRef.resourceId }),
    entrypoint: defineTenantModuleEntrypoint({
      access: 'read',
      authorization: { kind: 'protected' },
      entrypointKey: 'party.registry.api.source-person-admission',
      moduleKey: partyModuleId,
      role: 'api',
    }),
    evidencePolicy: {
      captureMode: 'metadata_only',
      policyKey: 'party.registry.api.source-person-admission.evidence.v1',
    },
    inputSchema: SourcePersonAdmissionRequestSchema,
    legalEntityScope: 'optional',
    owningModuleKey: partyModuleId,
    policies: [],
    readKey: 'party.registry.api.source-person-admission',
    resultSchema: SourcePersonAdmissionResponseSchema,
    schemaVersion: '1',
  },
  answeredOutsideComposition,
  () => Effect.succeed({}),
);

const syntheticPartyProvider = defineVerticalRuntimeRegistration({
  actions: [],
  manifest: {
    module: {
      description: 'Synthetic Party provider publishing only the Read contracts Privacy Subjects requires.',
      displayName: 'Party Registry (synthetic provider)',
      id: partyModuleId,
      implementedAs: 'ultramodern_microvertical',
      kind: 'business_module',
    },
    publicSurface: {
      actions: [],
      api: { 'party-detail': PartyDetailApi, 'source-person-admission': SourcePersonAdmissionApi },
      operationContracts: [
        { apiKey: 'party-detail', operationKey: 'partyDetail.execute', registration: partyDetailContract },
        {
          apiKey: 'source-person-admission',
          operationKey: 'sourcePersonAdmission.execute',
          registration: sourcePersonAdmissionContract,
        },
      ],
      shellContributions: {
        mediaAttachments: [],
        navigation: [],
        pages: [],
        publicComponents: [],
        reports: [],
        resourceDetails: [],
        search: [],
        timelines: [],
      },
    },
  },
  outboxWorkers: [],
  reads: [partyDetailContract, sourcePersonAdmissionContract],
});

/** The actual Privacy owner composed with the synthetic Party provider of its Subject-read contracts. */
export const privacySubjectsPartyProviderComposition = makeOwnerApplicationCompositionFixture({
  additionalOwners: [{ appId: 'party-registry', ownerRegistration: syntheticPartyProvider }],
  ownerRegistration: privacyRegistration,
});
