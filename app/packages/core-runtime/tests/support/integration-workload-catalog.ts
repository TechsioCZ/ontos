import { Effect, Schema } from 'effect';

import { defineAction } from '../../src/actions/definition.ts';
import { buildInstalledModuleCatalog } from '../../src/modules/catalog.ts';
import { decodeOntosModuleDeploymentContract, defineOntosModuleManifest } from '../../src/modules/manifest.ts';
import { defineTenantModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import {
  defineVerticalRuntimeRegistration,
  extractVerticalRuntimeSafeDescriptors,
} from '../../src/modules/runtime-registration.ts';

/*
 * The installed contracts a connector-partner workload registration reads: a partner module whose admission Action
 * admits the partner's workload and which declares its own job as a system workload and its own server's read as an
 * internal workload, and a module, kept inactive in the Tenant, whose read Action admits another workload of the same
 * namespace.
 */
export const PARTNER_MODULE = 'partner.ingress';
export const DORMANT_MODULE = 'partner.dormant';
export const PARTNER_ADMISSION_WORKLOAD = 'partner.ingress.admit-sync';
export const PARTNER_READ_WORKLOAD = 'partner.ingress.read-catalog';
export const PARTNER_SYSTEM_WORKLOAD = 'partner.ingress.execute-job';
export const PARTNER_INTERNAL_WORKLOAD = 'partner.ingress.read-own-facts';
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
  readonly internalWorkloads: readonly string[];
  readonly moduleId: string;
  readonly systemWorkloads: readonly string[];
}) => {
  const activation = {
    defaultState: 'inactive' as const,
    preservesHistoryWhenInactive: true as const,
    scope: 'tenant' as const,
    supportedStates: ['inactive' as const, 'active' as const],
  };
  const module = {
    description: `${input.moduleId} module`,
    displayName: input.moduleId,
    id: input.moduleId,
    implementedAs: 'ultramodern_microvertical' as const,
    kind: 'business_module' as const,
  };
  const shellContributions = {
    mediaAttachments: [],
    navigation: [],
    pages: [],
    publicComponents: [],
    reports: [],
    resourceDetails: [],
    search: [],
    timelines: [],
  };
  const manifest = defineOntosModuleManifest({
    activation,
    internalWorkloads: input.internalWorkloads,
    module,
    publicSurface: {
      actions: input.actions,
      api: {},
      components: {},
      events: [],
      reports: [],
      resourceTypes: [],
      search: [],
      shellContributions,
    },
  });
  const registration = defineVerticalRuntimeRegistration({ actions: input.actions, manifest, outboxWorkers: [] });
  const { actions } = extractVerticalRuntimeSafeDescriptors(registration);
  const contract = decodeOntosModuleDeploymentContract({
    deployment: { appId: input.appId, buildMarker: 'integration-workload-registration' },
    manifest: {
      activation,
      internalWorkloads: input.internalWorkloads,
      module,
      originatorActions: [],
      publicSurface: {
        actions,
        api: [],
        components: [],
        events: [],
        reports: [],
        resourceTypes: [],
        search: [],
        shellContributions,
      },
      systemWorkloads: input.systemWorkloads,
    },
    runtime: { outboxSubscriptions: [] },
    schemaVersion: '2',
  });
  return { contract, expectedAppId: contract.deployment.appId };
};

export const integrationWorkloadCatalog = () =>
  buildInstalledModuleCatalog([
    publishedContract({
      actions: [
        workloadAction(PARTNER_MODULE, 'admit-sync', [PARTNER_ADMISSION_WORKLOAD]),
        workloadAction(PARTNER_MODULE, 'read-catalog', [PARTNER_READ_WORKLOAD]),
        workloadAction(PARTNER_MODULE, 'read-own-facts', [PARTNER_INTERNAL_WORKLOAD]),
      ],
      appId: 'partner-ingress',
      internalWorkloads: [PARTNER_INTERNAL_WORKLOAD],
      moduleId: PARTNER_MODULE,
      systemWorkloads: [PARTNER_SYSTEM_WORKLOAD],
    }),
    publishedContract({
      actions: [workloadAction(DORMANT_MODULE, 'read-source', [DORMANT_WORKLOAD])],
      appId: 'partner-dormant',
      internalWorkloads: [],
      moduleId: DORMANT_MODULE,
      systemWorkloads: [],
    }),
  ]);
