import assert from 'node:assert/strict';
import test from 'node:test';
import { Effect, Schema } from 'effect';
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from 'effect/unstable/httpapi';
import { bindAction, defineAction, defineActionContract } from '../../src/actions/definition.ts';
import { defineTenantModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import {
  ONTOS_MODULE_CONTRACT_SCHEMA_VERSION,
  decodeOntosModuleDeploymentContract,
  defineOntosModuleManifest,
} from '../../src/modules/manifest.ts';
import {
  defineVerticalRuntimeRegistration,
  extractVerticalRuntimeSafeDescriptors,
  getVerticalRuntimeActions,
  getVerticalRuntimeEntrypoints,
} from '../../src/modules/runtime-registration.ts';

const componentValue = () => null;

const createAction = (owner = 'property.registry') =>
  defineAction(
    {
      accessEvidencePolicy: { captureMode: 'metadata_only', policyKey: `${owner}.read.v1` },
      actionKey: `${owner}.create-unit`,
      auditProfile: 'standard',
      domainErrorSchema: Schema.Never,
      domainEvents: {},
      entrypoint: defineTenantModuleEntrypoint({
        access: 'write',
        entrypointKey: `${owner}.create-unit`,
        moduleKey: owner,
        role: 'action',
      }),
      idempotency: 'required',
      legalEntityScope: 'optional',
      owningModuleKey: owner,
      payloadSchema: Schema.Struct({ name: Schema.String }),
      policies: [],
      resultSchema: Schema.Struct({ id: Schema.String }),
      schemaVersion: '1',
    },
    ({ name }) => Effect.succeed({ id: name }),
  );

const emptyManifestInput = () => ({
  activation: {
    defaultState: 'inactive' as const,
    preservesHistoryWhenInactive: true,
    scope: 'tenant' as const,
    supportedStates: [
      'inactive',
      'active',
      'read_only',
      'suspended',
      'quarantined',
      'deprecated',
      'archived',
    ] as const,
  },
  module: {
    description: 'Property capability',
    displayName: 'Property Registry',
    id: 'property.registry' as const,
    implementedAs: 'ultramodern_microvertical' as const,
    kind: 'business_module' as const,
  },
  publicSurface: {
    actions: [] as const,
    api: {},
    components: {},
    events: [] as const,
    reports: [] as const,
    resourceTypes: [] as const,
    search: [] as const,
    shellContributions: {
      mediaAttachments: [] as const,
      navigation: [] as const,
      pages: [] as const,
      publicComponents: [] as const,
      reports: [] as const,
      resourceDetails: [] as const,
      search: [] as const,
      timelines: [] as const,
    },
  },
});

test('defines a valid empty manifest, preserves literals, and freezes its public shape', () => {
  const manifest = defineOntosModuleManifest(emptyManifestInput());
  const literal: 'property.registry' = manifest.module.id;

  assert.equal(literal, 'property.registry');
  assert.deepEqual(Object.keys(manifest), ['activation', 'module', 'publicSurface']);
  assert.equal(Object.isFrozen(manifest), true);
  assert.equal(Object.isFrozen(manifest.activation.supportedStates), true);
  assert.equal(Object.isFrozen(manifest.publicSurface.actions), true);
  assert.throws(
    () => (manifest.publicSurface.actions as unknown as unknown[]).push('private'),
    TypeError,
  );
});

test('accepts populated typed surfaces and keeps executable values out of safe descriptors', () => {
  const action = createAction();
  const apiValue = HttpApi.make('PropertyApi').add(
    HttpApiGroup.make('property').add(HttpApiEndpoint.get('listUnits', '/units')),
  );
  const manifest = defineOntosModuleManifest({
    ...emptyManifestInput(),
    publicSurface: {
      actions: [action],
      api: { PropertyClient: apiValue },
      components: { PropertyUnitCard: componentValue },
      events: [
        {
          key: 'property.unit-created',
          owningModuleId: 'property.registry',
          payloadSchema: Schema.Struct({ unitId: Schema.String }),
          referencesResourceTypes: ['property.unit'],
          tense: 'past',
          visibility: 'public_module_event',
        },
      ],
      reports: [
        {
          accessFiltering: 'legal_entity_scope',
          dimensions: ['legal_entity'],
          key: 'property.unit-inventory',
          label: 'Unit inventory',
          owningModuleId: 'property.registry',
          resourceTypes: ['property.unit'],
        },
      ],
      resourceTypes: [
        {
          capabilities: {
            graphVisible: true,
            linkable: true,
            mediaAttachable: true,
            searchable: true,
            timelineVisible: true,
          },
          description: 'A physical unit',
          key: 'property.unit',
          label: 'Unit',
          owningModuleId: 'property.registry',
        },
      ],
      search: [
        {
          accessFiltering: 'legal_entity_scope',
          key: 'property.unit-search',
          owningModuleId: 'property.registry',
          resourceType: 'property.unit',
        },
      ],
      shellContributions: emptyManifestInput().publicSurface.shellContributions,
    },
  });
  const registration = defineVerticalRuntimeRegistration({
    actions: [action],
    entrypoints: {
      api: { resource: () => apiValue },
      components: { dashboard: () => componentValue },
      pages: {},
      reports: {},
      search: {},
    },
    manifest,
    outboxWorkers: [],
  });
  const descriptors = extractVerticalRuntimeSafeDescriptors(registration);

  assert.equal(manifest.publicSurface.actions[0], action);
  assert.equal(manifest.publicSurface.api['PropertyClient'], apiValue);
  assert.equal(manifest.publicSurface.components['PropertyUnitCard'], componentValue);
  assert.deepEqual(Object.keys(registration), ['moduleId']);
  assert.equal(getVerticalRuntimeActions(registration)[0], action);
  assert.equal(
    getVerticalRuntimeEntrypoints(registration).components['dashboard']?.(),
    componentValue,
  );
  assert.deepEqual(descriptors, {
    actions: [
      {
        actionKey: 'property.registry.create-unit',
        auditProfile: 'standard',
        idempotency: 'required',
        legalEntityScope: 'optional',
        owningModuleId: 'property.registry',
        schemaVersion: '1',
      },
    ],
    moduleId: 'property.registry',
    outboxSubscriptions: [],
    shellContributions: emptyManifestInput().publicSurface.shellContributions,
  });
  assert.equal(JSON.stringify(descriptors).includes('handler'), false);
  assert.equal(JSON.stringify(descriptors).includes('dashboard'), false);
});

test('publishes an unbound Action contract but rejects owner runtime registration until binding', () => {
  const action = defineActionContract({
    accessEvidencePolicy: {
      captureMode: 'metadata_only',
      policyKey: 'property.registry.create-unit.access.v1',
    },
    actionKey: 'property.registry.create-unit',
    auditProfile: 'standard',
    domainErrorSchema: Schema.Never,
    domainEvents: {},
    entrypoint: defineTenantModuleEntrypoint({
      access: 'write',
      entrypointKey: 'property.registry.create-unit',
      moduleKey: 'property.registry',
      role: 'action',
    }),
    idempotency: 'required',
    legalEntityScope: 'required',
    owningModuleKey: 'property.registry',
    payloadSchema: Schema.Struct({ name: Schema.String }),
    policies: [],
    resultSchema: Schema.Struct({ id: Schema.String }),
    schemaVersion: '1',
  });
  const manifest = defineOntosModuleManifest({
    ...emptyManifestInput(),
    publicSurface: { ...emptyManifestInput().publicSurface, actions: [action] },
  });

  assert.equal(manifest.publicSurface.actions[0], action);
  assert.throws(
    () =>
      defineVerticalRuntimeRegistration({
        actions: [action],
        manifest,
        outboxWorkers: [],
      }),
    /must have one owner-local private binding/u,
  );

  bindAction(action, ({ name }) => Effect.succeed({ id: name }));
  const registration = defineVerticalRuntimeRegistration({
    actions: [action],
    manifest,
    outboxWorkers: [],
  });
  assert.equal(getVerticalRuntimeActions(registration)[0], action);
  assert.equal(
    JSON.stringify(extractVerticalRuntimeSafeDescriptors(registration)).includes('handler'),
    false,
  );
});

test('rejects invalid identities, private fields, duplicates, cross-owner values, and undeclared references', () => {
  assert.throws(() =>
    defineOntosModuleManifest({
      ...emptyManifestInput(),
      module: { ...emptyManifestInput().module, id: 'property-registry' },
    }),
  );
  assert.throws(() =>
    defineOntosModuleManifest({
      ...emptyManifestInput(),
      privateRoutes: [],
    } as never),
  );
  assert.throws(() =>
    defineOntosModuleManifest({
      ...emptyManifestInput(),
      dependencies: { core: [], externalSystems: [], modules: [] },
    } as never),
  );
  assert.throws(() =>
    defineOntosModuleManifest({
      ...emptyManifestInput(),
      activation: {
        ...emptyManifestInput().activation,
        supportedStates: ['inactive', 'inactive'],
      },
    }),
  );
  assert.throws(() =>
    defineOntosModuleManifest({
      ...emptyManifestInput(),
      publicSurface: {
        ...emptyManifestInput().publicSurface,
        actions: [createAction('billing.invoice')],
      },
    }),
  );
  assert.throws(() =>
    defineOntosModuleManifest({
      ...emptyManifestInput(),
      publicSurface: {
        ...emptyManifestInput().publicSurface,
        search: [
          {
            accessFiltering: 'tenant_scope',
            key: 'property.unit-search',
            owningModuleId: 'property.registry',
            resourceType: 'property.missing',
          },
        ],
      },
    }),
  );
  assert.throws(
    () =>
      defineOntosModuleManifest({
        ...emptyManifestInput(),
        publicSurface: {
          ...emptyManifestInput().publicSurface,
          actions: [
            {
              descriptor: {
                actionKey: 'property.registry.fake',
                auditProfile: 'minimal',
                idempotency: 'optional',
                legalEntityScope: 'optional',
                owningModuleKey: 'property.registry',
                schemaVersion: '1',
              },
            },
          ],
        },
      } as never),
    /real values created by defineAction/u,
  );
  assert.throws(
    () =>
      defineOntosModuleManifest({
        ...emptyManifestInput(),
        publicSurface: { ...emptyManifestInput().publicSurface, api: { FakeApi: 42 } },
      } as never),
    /real Effect HttpApi/u,
  );
  assert.throws(
    () =>
      defineOntosModuleManifest({
        ...emptyManifestInput(),
        publicSurface: {
          ...emptyManifestInput().publicSurface,
          components: { FakeComponent: 'not-a-component' },
        },
      } as never),
    /callable component/u,
  );
  assert.throws(
    () =>
      defineOntosModuleManifest({
        ...emptyManifestInput(),
        publicSurface: {
          ...emptyManifestInput().publicSurface,
          events: [
            {
              key: 'property.registry.fake-event',
              owningModuleId: 'property.registry',
              payloadSchema: {},
              referencesResourceTypes: [],
              tense: 'past',
              visibility: 'public_module_event',
            },
          ],
        },
      } as never),
    /Effect Schema value/u,
  );
});

test('deployment contract decoding is exact and versioned', () => {
  const contract = {
    deployment: { appId: 'property-registry', buildMarker: 'build-1' },
    manifest: {
      ...emptyManifestInput(),
      publicSurface: {
        actions: [],
        api: [],
        components: [],
        events: [],
        reports: [],
        resourceTypes: [],
        search: [],
        shellContributions: emptyManifestInput().publicSurface.shellContributions,
      },
    },
    runtime: { outboxSubscriptions: [] },
    schemaVersion: ONTOS_MODULE_CONTRACT_SCHEMA_VERSION,
  };

  assert.deepEqual(decodeOntosModuleDeploymentContract(contract), contract);
  assert.equal(contract.schemaVersion, '2');
  assert.throws(() =>
    decodeOntosModuleDeploymentContract({ ...contract, sourcePath: './private.ts' }),
  );
  assert.throws(() =>
    decodeOntosModuleDeploymentContract({
      ...contract,
      manifest: {
        ...contract.manifest,
        dependencies: { core: [], externalSystems: [], modules: [] },
      },
    }),
  );
  assert.throws(() => decodeOntosModuleDeploymentContract({ ...contract, schemaVersion: '0' }));
  assert.throws(() => decodeOntosModuleDeploymentContract({ ...contract, schemaVersion: '999' }));
});
