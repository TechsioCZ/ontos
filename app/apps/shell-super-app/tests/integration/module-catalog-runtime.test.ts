import {
  OntosModuleDeploymentContractSchema,
  defineAction,
  defineOntosModuleManifest,
  defineOutboxWorker,
  defineTenantModuleEntrypoint,
  defineVerticalRuntimeRegistration,
  extractVerticalRuntimeSafeDescriptors,
  getVerticalRuntimeActions,
  getVerticalRuntimeOutboxWorkers,
} from '@app/core-runtime';
import { makeEffectHttpApiClient } from '@modern-js/plugin-bff/effect-client';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from 'effect/unstable/httpapi';

import { deriveDeploymentAllowlist } from '../../api/modules/deployment-allowlist.ts';
import { makeInstalledModuleCatalogLoader } from '../../api/modules/installed-module-catalog.ts';
import type { ModuleContractFetch } from '../../api/modules/installed-module-catalog.ts';
import { matchInstalledOutboxMessagesOnce } from '../../api/modules/installed-outbox-matcher.ts';

const contract = (
  appId: string,
  moduleId: string,
  overrides: {
    readonly actions?: readonly object[];
    readonly api?: readonly object[];
    readonly components?: readonly object[];
    readonly outboxSubscriptions?: readonly object[];
    readonly shellContributions?: object;
  } = {},
) => ({
  deployment: { appId, buildMarker: `${appId}-independent-build` },
  manifest: {
    activation: {
      defaultState: 'inactive',
      preservesHistoryWhenInactive: true,
      scope: 'tenant',
      supportedStates: ['inactive', 'active', 'read_only', 'suspended', 'quarantined', 'deprecated', 'archived'],
    },
    module: {
      description: `${moduleId} independently deployed module`,
      displayName: moduleId,
      id: moduleId,
      implementedAs: 'ultramodern_microvertical',
      kind: 'business_module',
    },
    publicSurface: {
      actions: overrides.actions ?? [],
      api: overrides.api ?? [{ key: `${moduleId}.api`, operationKeys: ['read'] }],
      components: overrides.components ?? [
        {
          expose: './Dashboard',
          key: `${moduleId}.dashboard`,
          mfBoundaryId: appId === 'property-registry' ? 'verticalPropertyRegistry' : 'verticalDocumentsCenter',
        },
      ],
      events: [],
      reports: [],
      resourceTypes: [],
      search: [],
      shellContributions: overrides.shellContributions ?? {
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
  runtime: { outboxSubscriptions: overrides.outboxSubscriptions ?? [] },
  schemaVersion: '2',
});
const PropertyApi = HttpApi.make('PropertyApi').add(
  HttpApiGroup.make('property').add(HttpApiEndpoint.get('listUnits', '/units')),
);
const PropertyRegistryUnitIdSchema = Schema.String.pipe(Schema.brand('PropertyRegistryUnitId'));
const DocumentsCenterDocumentIdSchema = Schema.String.pipe(Schema.brand('DocumentsCenterDocumentId'));
const PropertyAction = defineAction(
  {
    accessEvidencePolicy: {
      captureMode: 'metadata_only',
      policyKey: 'property.registry.rename-unit.access.v1',
    },
    actionKey: 'property.registry.rename-unit',
    auditProfile: 'standard',
    domainErrorSchema: Schema.Never,
    domainEvents: {},
    entrypoint: defineTenantModuleEntrypoint({
      access: 'write',
      authorization: {
        kind: 'action_execution',
        provisioning: 'tenant_membership_default',
      },
      entrypointKey: 'property.registry.rename-unit',
      moduleKey: 'property.registry',
      role: 'action',
    }),
    idempotency: 'required',
    legalEntityScope: 'optional',
    owningModuleKey: 'property.registry',
    payloadSchema: Schema.Struct({ unitId: PropertyRegistryUnitIdSchema }),
    policies: [],
    resultSchema: Schema.Struct({ renamed: Schema.Boolean }),
    schemaVersion: '1',
  },
  () => Effect.succeed({ renamed: true }),
);
const PropertyOutboxWorker = defineOutboxWorker(
  {
    consumerModuleKey: 'property.registry',
    entrypoint: defineTenantModuleEntrypoint({
      access: 'background',
      authorization: { kind: 'owner_local_background' },
      entrypointKey: 'property.registry.index-document',
      moduleKey: 'property.registry',
      role: 'worker',
    }),
    leaseDurationMs: 30_000,
    payloadSchema: Schema.Struct({
      documentId: DocumentsCenterDocumentIdSchema,
    }),
    producerModuleKey: 'documents.center',
    retryPolicy: {
      initialBackoffMs: 1000,
      maxAttempts: 5,
      maxBackoffMs: 60_000,
      multiplier: 2,
    },
    topic: 'documents.center.document-created',
    workerKey: 'property.registry.index-document',
  },
  () => Effect.void,
);
const PropertyDashboard = () => null;
const propertyManifest = defineOntosModuleManifest({
  activation: {
    defaultState: 'inactive',
    preservesHistoryWhenInactive: true,
    scope: 'tenant',
    supportedStates: ['inactive', 'active'],
  },
  module: {
    description: 'Property registry independently deployed module',
    displayName: 'Property Registry',
    id: 'property.registry',
    implementedAs: 'ultramodern_microvertical',
    kind: 'business_module',
  },
  publicSurface: {
    actions: [PropertyAction],
    api: { PropertyClient: PropertyApi },
    components: { PropertyDashboard },
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
const propertyRuntimeRegistration = defineVerticalRuntimeRegistration({
  actions: [PropertyAction],
  manifest: propertyManifest,
  outboxWorkers: [PropertyOutboxWorker],
});
const propertySafeRuntime = extractVerticalRuntimeSafeDescriptors(propertyRuntimeRegistration);
const ContractDocumentJsonSchema = Schema.fromJsonString(OntosModuleDeploymentContractSchema);
const makeContractFetch =
  (documents: ReadonlyMap<string, unknown>, requests: Map<string, number>): ModuleContractFetch =>
  (input) => {
    const { url } = new Request(input);
    const document = documents.get(url);
    if (document === undefined) {
      return Promise.resolve(new Response(null, { status: 404 }));
    }
    requests.set(url, (requests.get(url) ?? 0) + 1);
    const encodedDocument = Schema.encodeUnknownSync(ContractDocumentJsonSchema)(document);
    return Promise.resolve(
      new Response(encodedDocument, {
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
it.effect(
  'keeps discovered metadata separate from one complete owner-local runtime',
  Effect.fnUntraced(function* runIntegration1() {
    const propertyUrl = 'https://property-registry.test/.well-known/ontos-module-manifest.json';
    const documentsUrl = 'https://documents-center.test/.well-known/ontos-module-manifest.json';
    const requests = new Map<string, number>();
    const contractFetch = makeContractFetch(
      new Map([
        [
          propertyUrl,
          contract('property-registry', 'property.registry', {
            actions: propertySafeRuntime.actions,
            api: [
              {
                key: 'property.registry.api',
                operationKeys: ['property.listUnits'],
              },
            ],
            components: [
              {
                expose: './Dashboard',
                key: 'property.registry.dashboard',
                mfBoundaryId: 'verticalPropertyRegistry',
              },
            ],
            outboxSubscriptions: propertySafeRuntime.outboxSubscriptions,
          }),
        ],
        [documentsUrl, contract('documents-center', 'documents.center')],
      ]),
      requests,
    );
    const allowlist = yield* deriveDeploymentAllowlist({
      environment: 'development',
      overlay: {
        environment: 'development',
        ontosModuleManifests: {
          'documents-center': documentsUrl,
          'property-registry': propertyUrl,
        },
        schemaVersion: 1,
      },
      topology: {
        verticals: [
          { id: 'property-registry', kind: 'vertical' },
          { id: 'documents-center', kind: 'vertical' },
        ],
      },
    });
    const loader = makeInstalledModuleCatalogLoader(allowlist, contractFetch);
    const first = yield* loader;
    const second = yield* loader;
    expect(first).toBe(second);
    expect(requests.get(propertyUrl)).toBe(1);
    expect(requests.get(documentsUrl)).toBe(1);
    expect(first.getByDeploymentAppId('property-registry')?.manifest.module.id).toBe('property.registry');
    expect(first.getByModuleId('property.registry')?.deployment.appId).toBe('property-registry');
    expect(first.moduleIds).toEqual(['documents.center', 'property.registry']);
    const tenantStates = [
      { moduleKey: 'property.registry', state: 'active' },
      { moduleKey: 'documents.center', state: 'inactive' },
    ] as const;
    expect(
      tenantStates
        .filter(({ moduleKey, state }) => state === 'active' && first.moduleIds.includes(moduleKey))
        .map(({ moduleKey }) => moduleKey),
    ).toEqual(['property.registry']);
    expect(getVerticalRuntimeActions(propertyRuntimeRegistration)[0]).toBe(PropertyAction);
    expect(getVerticalRuntimeOutboxWorkers(propertyRuntimeRegistration)[0]).toBe(PropertyOutboxWorker);
    expect(Object.keys(propertyRuntimeRegistration)).toEqual(['moduleId']);
    let matchedSubscriptions: readonly object[] = [];
    yield* matchInstalledOutboxMessagesOnce(first, (input) => {
      matchedSubscriptions = input.subscriptions;
      return Effect.succeed({ deliveriesCreated: 1, messagesMatched: 1 });
    });
    expect(matchedSubscriptions).toEqual(propertySafeRuntime.outboxSubscriptions);
    const propertyClientReference = makeEffectHttpApiClient(PropertyApi, {
      baseUrl: new URL('/api', propertyUrl),
    });
    expect(Effect.isEffect(propertyClientReference)).toBe(true);
    expect(first.getByModuleId('property.registry')?.manifest.publicSurface.components).toEqual([
      {
        expose: './Dashboard',
        key: 'property.registry.dashboard',
        mfBoundaryId: 'verticalPropertyRegistry',
      },
    ]);
    const serialized = yield* Schema.encodeUnknownEffect(ContractDocumentJsonSchema)(
      first.getByModuleId('property.registry'),
    );
    expect(serialized.includes('payloadSchema')).toBe(false);
    expect(serialized.includes('leaseDurationMs')).toBe(false);
    expect(serialized.includes('PropertyDashboard')).toBe(false);
    expect(serialized.includes('handler')).toBe(false);
  }),
);
