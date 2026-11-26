import { Effect, Schema } from 'effect';

import { defineAction } from '../actions/definition.ts';
import { buildInstalledModuleCatalog } from '../modules/catalog.ts';
import { decodeOntosModuleDeploymentContract, defineOntosModuleManifest } from '../modules/manifest.ts';
import { defineTenantModuleEntrypoint } from '../modules/module-entrypoint.ts';
import {
  defineVerticalRuntimeRegistration,
  extractVerticalRuntimeSafeDescriptors,
} from '../modules/runtime-registration.ts';
import { makeModuleContractFixture } from './module-contract.ts';

/*
 * The installed contracts a connector-partner workload registration reads: a partner module whose admission Action
 * admits the partner's workload and which declares its own job as a system workload, and a module, kept inactive in
 * the Tenant, whose read Action admits another workload of the same namespace.
 */
export const PARTNER_MODULE = 'partner.ingress';
export const DORMANT_MODULE = 'partner.dormant';
export const PARTNER_ADMISSION_WORKLOAD = 'partner.ingress.admit-sync';
export const PARTNER_READ_WORKLOAD = 'partner.ingress.read-catalog';
export const PARTNER_SYSTEM_WORKLOAD = 'partner.ingress.execute-job';
export const DORMANT_WORKLOAD = 'partner.dormant.read-source';

const workloadAction = (moduleKey: string, slug: string, workloads: readonly [string, ...string[]]) =>
  defineAction(
    {
      accessEvidencePolicy: { captureMode: 'metadata_only', policyKey: `${moduleKey}.${slug}.v1` },
      accessWorkload: { reason: 'connector partner ingress only', workloads },
      actionKey: `${moduleKey}.${slug}`,
      auditProfile: 'standard',
      domainErrorSchema: Schema.Never,
      domainEvents: {},
      entrypoint: defineTenantModuleEntrypoint({
        access: 'write',
        authorization: { kind: 'protected' },
        entrypointKey: `${moduleKey}.${slug}`,
        moduleKey,
        role: 'action',
      }),
      idempotency: 'required',
      legalEntityScope: 'required',
      owningModuleKey: moduleKey,
      payloadSchema: Schema.Struct({ name: Schema.String }),
      policies: [],
      resultSchema: Schema.Struct({ id: Schema.String }),
      schemaVersion: '1',
    },
    ({ name }) => Effect.succeed({ id: name }),
  );

const publishedContract = (input: {
  readonly actions: readonly ReturnType<typeof workloadAction>[];
  readonly appId: string;
  readonly moduleId: string;
  readonly systemWorkloads: readonly string[];
}) => {
  const fixture = makeModuleContractFixture({
    appId: input.appId,
    buildMarker: 'integration-workload-registration',
    moduleId: input.moduleId,
  });
  const manifest = defineOntosModuleManifest({
    activation: fixture.manifest.activation,
    module: { ...fixture.manifest.module, id: input.moduleId },
    publicSurface: {
      actions: input.actions,
      api: {},
      components: {},
      events: [],
      reports: [],
      resourceTypes: [],
      search: [],
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
  });
  const registration = defineVerticalRuntimeRegistration({ actions: input.actions, manifest, outboxWorkers: [] });
  const { actions } = extractVerticalRuntimeSafeDescriptors(registration);
  const contract = decodeOntosModuleDeploymentContract({
    ...fixture,
    manifest: {
      ...fixture.manifest,
      publicSurface: { ...fixture.manifest.publicSurface, actions },
      systemWorkloads: input.systemWorkloads,
    },
  });
  return { contract, expectedAppId: contract.deployment.appId };
};

export const integrationWorkloadCatalog = () =>
  buildInstalledModuleCatalog([
    publishedContract({
      actions: [
        workloadAction(PARTNER_MODULE, 'admit-sync', [PARTNER_ADMISSION_WORKLOAD]),
        workloadAction(PARTNER_MODULE, 'read-catalog', [PARTNER_READ_WORKLOAD]),
      ],
      appId: 'partner-ingress',
      moduleId: PARTNER_MODULE,
      systemWorkloads: [PARTNER_SYSTEM_WORKLOAD],
    }),
    publishedContract({
      actions: [workloadAction(DORMANT_MODULE, 'read-source', [DORMANT_WORKLOAD])],
      appId: 'partner-dormant',
      moduleId: DORMANT_MODULE,
      systemWorkloads: [],
    }),
  ]);
