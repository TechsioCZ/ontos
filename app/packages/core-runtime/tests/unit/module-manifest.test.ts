import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
} from 'effect/unstable/httpapi';

import { defineAction } from '../../src/actions/definition.ts';
import {
  ONTOS_MODULE_CONTRACT_SCHEMA_VERSION,
  decodeOntosModuleDeploymentContract,
  defineOntosModuleManifest,
  validateOntosModuleExecutableReferences,
  validateOntosModuleManifestFields,
} from '../../src/modules/manifest.ts';
import { defineTenantModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import {
  defineVerticalRuntimeRegistration,
  extractVerticalRuntimeSafeDescriptors,
  getVerticalRuntimeActions,
  getVerticalRuntimeEntrypoints,
} from '../../src/modules/runtime-registration.ts';

const componentValue = () => null;
const UnitId = Schema.String.pipe(Schema.brand('UnitId'));

const createAction = (owner = 'property.registry') =>
  defineAction(
    {
      accessEvidencePolicy: {
        captureMode: 'metadata_only',
        policyKey: `${owner}.read.v1`,
      },
      actionKey: `${owner}.create-unit`,
      auditProfile: 'standard',
      domainErrorSchema: Schema.Never,
      domainEvents: {},
      entrypoint: defineTenantModuleEntrypoint({
        access: 'write',
        authorization: {
          kind: 'action_execution',
          provisioning: 'tenant_membership_default',
        },
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
    ({ name }) => Effect.succeed({ id: name })
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

it('defines a valid empty manifest, preserves literals, and freezes its public shape', () => {
  const manifest = defineOntosModuleManifest(emptyManifestInput());
  const literal: 'property.registry' = manifest.module.id;

  expect(literal).toBe('property.registry');
  expect(Object.keys(manifest)).toEqual([
    'activation',
    'module',
    'publicSurface',
  ]);
  expect(Object.isFrozen(manifest)).toBe(true);
  expect(Object.isFrozen(manifest.activation.supportedStates)).toBe(true);
  expect(Object.isFrozen(manifest.publicSurface.actions)).toBe(true);
  expect(() =>
    Object.defineProperty(manifest.publicSurface.actions, 0, {
      value: 'private',
    })
  ).toThrow();
});

it.effect(
  'accepts populated typed surfaces and keeps executable values out of safe descriptors',
  () =>
    Effect.gen(function* verifySafeDescriptors() {
      const action = createAction();
      const apiValue = HttpApi.make('PropertyApi').add(
        HttpApiGroup.make('property').add(
          HttpApiEndpoint.get('listUnits', '/units')
        )
      );
      const parameterizedApiValue = HttpApi.make('PropertyDetailApi').add(
        HttpApiGroup.make('propertyDetail').add(
          HttpApiEndpoint.get('getUnit', '/units/:unitId', {
            headers: {},
            params: { unitId: UnitId },
            query: {},
          })
        )
      );
      const manifest = defineOntosModuleManifest({
        ...emptyManifestInput(),
        publicSurface: {
          actions: [action],
          api: {
            PropertyClient: apiValue,
            PropertyDetail: parameterizedApiValue,
          },
          components: { PropertyUnitCard: componentValue },
          events: [
            {
              key: 'property.unit-created',
              owningModuleId: 'property.registry',
              payloadSchema: Schema.Struct({ unitId: UnitId }),
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
          shellContributions:
            emptyManifestInput().publicSurface.shellContributions,
        },
      });
      const registration = defineVerticalRuntimeRegistration({
        actions: [action],
        entrypoints: {
          api: { resource: () => Promise.resolve(apiValue) },
          components: {
            dashboard: () => Promise.resolve(componentValue),
          },
          pages: {},
          reports: {},
          search: {},
        },
        manifest,
        outboxWorkers: [],
      });
      const descriptors = extractVerticalRuntimeSafeDescriptors(registration);

      expect(manifest.publicSurface.actions[0]).toBe(action);
      expect(manifest.publicSurface.api.PropertyClient).toBe(apiValue);
      expect(manifest.publicSurface.api.PropertyDetail).toBe(
        parameterizedApiValue
      );
      expect(manifest.publicSurface.components.PropertyUnitCard).toBe(
        componentValue
      );
      expect(Object.keys(registration)).toEqual(['moduleId']);
      expect(getVerticalRuntimeActions(registration)[0]).toBe(action);
      const loadDashboard =
        getVerticalRuntimeEntrypoints(registration).components['dashboard'];
      expect(loadDashboard).toBeDefined();
      if (loadDashboard === undefined) {
        throw new Error('Expected assertion to hold');
      }
      expect(yield* Effect.promise(loadDashboard)).toBe(componentValue);
      expect(descriptors).toEqual({
        actions: [
          {
            actionKey: 'property.registry.create-unit',
            auditProfile: 'standard',
            entrypoint: action.descriptor.entrypoint,
            idempotency: 'required',
            legalEntityScope: 'optional',
            owningModuleId: 'property.registry',
            schemaVersion: '1',
          },
        ],
        moduleId: 'property.registry',
        outboxSubscriptions: [],
        shellContributions:
          emptyManifestInput().publicSurface.shellContributions,
      });
    })
);

it('rejects invalid identities, private fields, duplicates, cross-owner values, and undeclared references', () => {
  expect(() =>
    defineOntosModuleManifest({
      ...emptyManifestInput(),
      module: { ...emptyManifestInput().module, id: 'property-registry' },
    })
  ).toThrow();
  const privateRoutesInput = {
    ...emptyManifestInput(),
    privateRoutes: [],
  };
  expect(() =>
    validateOntosModuleManifestFields(
      privateRoutesInput,
      privateRoutesInput.publicSurface
    )
  ).toThrow();
  const dependenciesInput = {
    ...emptyManifestInput(),
    dependencies: { core: [], externalSystems: [], modules: [] },
  };
  expect(() =>
    validateOntosModuleManifestFields(
      dependenciesInput,
      dependenciesInput.publicSurface
    )
  ).toThrow();
  expect(() =>
    defineOntosModuleManifest({
      ...emptyManifestInput(),
      activation: {
        ...emptyManifestInput().activation,
        supportedStates: ['inactive', 'inactive'],
      },
    })
  ).toThrow();
  expect(() =>
    defineOntosModuleManifest({
      ...emptyManifestInput(),
      publicSurface: {
        ...emptyManifestInput().publicSurface,
        actions: [createAction('billing.invoice')],
      },
    })
  ).toThrow();
  expect(() =>
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
    })
  ).toThrow();
  expect(() =>
    validateOntosModuleExecutableReferences(
      [
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
      [],
      [],
      [],
      'property.registry'
    )
  ).toThrow(/real values created by defineAction/u);
  expect(() =>
    validateOntosModuleExecutableReferences(
      [],
      [42],
      [],
      [],
      'property.registry'
    )
  ).toThrow(/real Effect HttpApi/u);
  expect(() =>
    validateOntosModuleExecutableReferences(
      [],
      [],
      ['not-a-component'],
      [],
      'property.registry'
    )
  ).toThrow(/callable component/u);
  expect(() =>
    validateOntosModuleExecutableReferences(
      [],
      [],
      [],
      [{}],
      'property.registry'
    )
  ).toThrow(/Effect Schema value/u);
});

it('deployment contract decoding is exact and versioned', () => {
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
        shellContributions:
          emptyManifestInput().publicSurface.shellContributions,
      },
    },
    runtime: { outboxSubscriptions: [] },
    schemaVersion: ONTOS_MODULE_CONTRACT_SCHEMA_VERSION,
  };

  expect(decodeOntosModuleDeploymentContract(contract)).toEqual(contract);
  expect(contract.schemaVersion).toBe('2');
  expect(() =>
    decodeOntosModuleDeploymentContract({
      ...contract,
      sourcePath: './private.ts',
    })
  ).toThrow();
  expect(() =>
    decodeOntosModuleDeploymentContract({
      ...contract,
      manifest: {
        ...contract.manifest,
        dependencies: { core: [], externalSystems: [], modules: [] },
      },
    })
  ).toThrow();
  expect(() =>
    decodeOntosModuleDeploymentContract({ ...contract, schemaVersion: '0' })
  ).toThrow();
  expect(() =>
    decodeOntosModuleDeploymentContract({ ...contract, schemaVersion: '999' })
  ).toThrow();
});
