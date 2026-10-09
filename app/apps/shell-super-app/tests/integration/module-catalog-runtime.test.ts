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
import { makeEffectHttpApiClient } from '@modern-js/bff-effect/effect-client';
import { DateTime, Effect, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { expect, it } from 'effect-rstest';
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from 'effect/unstable/httpapi';

import { makeInstalledModuleCatalogLoader } from '../../api/modules/installed-module-catalog.ts';
import { matchInstalledOutboxMessagesOnce } from '../../api/modules/installed-outbox-matcher.ts';
import { makeCompositionSnapshot, sealComposition } from '../fixtures/application-composition.ts';

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
it.effect(
  'keeps discovered metadata separate from one complete owner-local runtime',
  Effect.fnUntraced(function* runIntegration1() {
    const propertyContract = contract('property-registry', 'property.registry', {
      actions: propertySafeRuntime.actions,
      api: [{ key: 'property.registry.api', operationKeys: ['property.listUnits'] }],
      components: [
        { expose: './Dashboard', key: 'property.registry.dashboard', mfBoundaryId: 'verticalPropertyRegistry' },
      ],
      outboxSubscriptions: propertySafeRuntime.outboxSubscriptions,
    });
    const documentsContract = contract('documents-center', 'documents.center');
    const snapshot = yield* makeCompositionSnapshot([propertyContract, documentsContract]);
    const loader = makeInstalledModuleCatalogLoader(Effect.succeed(snapshot));
    const first = yield* loader;
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
    let matchedRevision = '';
    yield* matchInstalledOutboxMessagesOnce(first, (input) => {
      matchedRevision = input.compositionRevision;
      return Effect.succeed({ deliveriesCreated: 1, messagesMatched: 1 });
    });
    expect(matchedRevision).toBe(snapshot.composition.revision);
    expect(first.outboxSubscriptions).toEqual(propertySafeRuntime.outboxSubscriptions);
    const propertyClientReference = makeEffectHttpApiClient(PropertyApi, {
      baseUrl: new URL('https://property-registry.test/api'),
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

it.effect('retains every approved Outbox subscription when a consumer deployment is offline', () =>
  Effect.gen(function* approvedOutboxSubscriptions() {
    const snapshot = yield* makeCompositionSnapshot([
      contract('property-registry', 'property.registry', {
        outboxSubscriptions: propertySafeRuntime.outboxSubscriptions,
      }),
      contract('documents-center', 'documents.center'),
    ]);
    const catalog = yield* makeInstalledModuleCatalogLoader(Effect.succeed(snapshot));
    let submittedRevision = '';
    yield* matchInstalledOutboxMessagesOnce(catalog, ({ compositionRevision }) => {
      submittedRevision = compositionRevision;
      return Effect.succeed({ deliveriesCreated: 1, messagesMatched: 1 });
    });
    expect(submittedRevision).toBe(snapshot.composition.revision);
    expect(catalog.outboxSubscriptions).toEqual(propertySafeRuntime.outboxSubscriptions);
    expect(catalog.moduleIds).toEqual(['documents.center', 'property.registry']);
  }),
);

it.effect('does not submit any message for matching when authority expires or the bundle becomes contradictory', () =>
  Effect.gen(function* matchingRequiresCompleteAuthority() {
    const snapshot = yield* makeCompositionSnapshot([
      contract('property-registry', 'property.registry', {
        outboxSubscriptions: propertySafeRuntime.outboxSubscriptions,
      }),
      contract('documents-center', 'documents.center'),
    ]);
    const now = yield* TestClock.testClockWith((clock) => clock.currentTimeMillis);
    let matches = 0;
    const match = () => {
      matches += 1;
      return Effect.succeed({ deliveriesCreated: 1, messagesMatched: 1 });
    };
    const expired = { ...snapshot, observedAt: DateTime.makeUnsafe(now - 1000), validUntil: DateTime.makeUnsafe(now) };
    yield* Effect.flip(
      makeInstalledModuleCatalogLoader(Effect.succeed(expired)).pipe(
        Effect.flatMap((catalog) => matchInstalledOutboxMessagesOnce(catalog, match)),
      ),
    );
    const [module] = snapshot.composition.modules;
    if (module === undefined) {
      throw new Error('missing fixture module');
    }
    const contradictory = {
      ...snapshot,
      composition: sealComposition({
        ...snapshot.composition,
        modules: [{ ...module, moduleId: 'other.module' }, ...snapshot.composition.modules.slice(1)],
      }),
    };
    yield* Effect.flip(
      makeInstalledModuleCatalogLoader(Effect.succeed(contradictory)).pipe(
        Effect.flatMap((catalog) => matchInstalledOutboxMessagesOnce(catalog, match)),
      ),
    );
    expect(matches).toBe(0);
    yield* makeInstalledModuleCatalogLoader(Effect.succeed(snapshot)).pipe(
      Effect.flatMap((catalog) => matchInstalledOutboxMessagesOnce(catalog, match)),
    );
    expect(matches).toBe(1);
  }),
);
