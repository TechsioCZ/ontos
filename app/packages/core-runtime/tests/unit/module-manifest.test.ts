import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { Hex } from 'effect/encoding';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from 'effect/http-api';

import { defineAction } from '../../src/actions/definition.ts';
import {
  ONTOS_MODULE_CONTRACT_SCHEMA_VERSION,
  OntosModuleDeploymentContractSchema,
  decodeOntosModuleDeploymentContract,
  defineOntosModuleManifest,
  projectOntosModuleOperationContracts,
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
import { defineRead, isReadRegistration } from '../../src/reads/definition.ts';
import {
  applicationCompositionContentRevision,
  buildApplicationCompositionCatalog,
} from '../../src/modules/application-composition-catalog.ts';
import type { ApplicationCompositionModule } from '../../src/modules/application-composition.ts';
import { ONTOS_SHELL_CONTRIBUTION_ABI } from '../../src/modules/application-composition.ts';
import { toModuleAccessObjectId, toResourceAccessObjectId } from '../../src/permissions/context-access.ts';
import { toSpiceDbActionObjectId } from '../../src/permissions/service.ts';
import { CoreSearchResourceRefSchema } from '../../src/search/projection.ts';
import { makeApplicationCompositionSnapshotFixture } from '../../src/testing/module-contract.ts';

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
    ({ name }) => Effect.succeed({ id: name }),
  );

const emptyManifestInput = () => ({
  activation: {
    defaultState: 'inactive' as const,
    preservesHistoryWhenInactive: true,
    scope: 'tenant' as const,
    supportedStates: ['inactive', 'active', 'read_only', 'suspended', 'quarantined', 'deprecated', 'archived'] as const,
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

const createRead = (owner = 'property.registry', schemaVersion = 'read.v2') =>
  defineRead(
    {
      accessKind: 'detail',
      entrypoint: defineTenantModuleEntrypoint({
        access: 'read',
        authorization: { kind: 'context_permission', permission: 'module.access' },
        entrypointKey: `${owner}.api.lookup`,
        moduleKey: owner,
        role: 'api',
      }),
      evidencePolicy: { captureMode: 'metadata_only', policyKey: `${owner}.lookup.evidence.v1` },
      inputSchema: Schema.Struct({}),
      legalEntityScope: 'required',
      owningModuleKey: owner,
      permissionTarget: 'module',
      policies: [],
      readKey: `${owner}.api.lookup`,
      resultSchema: Schema.String,
      schemaVersion,
    },
    () => Effect.succeed({ evidence: { resultCount: 1 }, result: 'current' }),
    () => Effect.succeed({}),
    () => ({ kind: 'module', moduleId: owner }),
  );

const operationApi = () =>
  HttpApi.make('PropertyOperations').add(HttpApiGroup.make('property').add(HttpApiEndpoint.get('lookup', '/lookup')));

const operationRequirement = () => ({
  condition: 'property.registry.condition.party-backed',
  entrypointKey: 'property.registry.api.lookup',
  evidence: ['party.registry.current-profile'],
  key: 'property.registry.requires.party-current',
  provider: { entrypointKey: 'party.registry.api.party-detail', moduleId: 'party.registry', schemaVersion: '1' },
});

const requirements = () => ({
  coreCapabilities: [{ id: 'ontos.core.operation-admission', version: '1' }],
  intrinsic: [],
  operations: [operationRequirement()],
  schemaVersion: '1' as const,
});

it('projects exact genuine Read versions without turning deployment format or build identity into operation semantics', () => {
  const read = createRead();
  const input = {
    ...emptyManifestInput(),
    publicSurface: {
      ...emptyManifestInput().publicSurface,
      api: { PropertyClient: operationApi() },
      operationContracts: [{ apiKey: 'PropertyClient', operationKey: 'property.lookup', registration: read }],
    },
    requirements: requirements(),
  };
  const manifest = defineOntosModuleManifest(input);
  const runtime = defineVerticalRuntimeRegistration({ actions: [], manifest, outboxWorkers: [], reads: [read] });
  const safe = extractVerticalRuntimeSafeDescriptors(runtime);
  expect(safe.operationContracts).toEqual([
    {
      apiKey: 'property.registry.property-client',
      entrypoint: read.descriptor.entrypoint,
      operationKey: 'property.lookup',
      schemaVersion: 'read.v2',
    },
  ]);
  expect(safe.requirements).toEqual(input.requirements);
  expect(safe.moduleId).toBe('property.registry');
  expect(ONTOS_MODULE_CONTRACT_SCHEMA_VERSION).toBe('2');
  expect(Object.isFrozen(safe.operationContracts)).toBe(true);
  expect(Object.isFrozen(safe.operationContracts[0]?.entrypoint.authorization)).toBe(true);
  expect(Object.isFrozen(safe.requirements?.operations[0]?.evidence)).toBe(true);
  expect(JSON.stringify(safe)).not.toContain('inputSchema');
  input.requirements.operations[0]?.evidence.push('party.registry.mutated');
  expect(safe.requirements?.operations[0]?.evidence).toEqual(['party.registry.current-profile']);
});

it.effect('preserves business refs and grant targets across two validated deployment build identities', () =>
  Effect.gen(function* twoDeploymentIdentities() {
    // Genuine Core serialization/catalog lifecycle, not two compiled production-owner releases.
    const action = createAction();
    const read = createRead();
    const base = emptyManifestInput();
    const manifest = defineOntosModuleManifest({
      ...base,
      publicSurface: {
        ...base.publicSurface,
        actions: [action],
        api: { records: operationApi() },
        operationContracts: [{ apiKey: 'records', operationKey: 'property.lookup', registration: read }],
        resourceTypes: [
          {
            capabilities: {
              graphVisible: false,
              linkable: true,
              mediaAttachable: false,
              searchable: false,
              timelineVisible: false,
            },
            description: 'A unit owned by this test capability.',
            key: 'property.registry.unit',
            label: 'Unit',
            owningModuleId: 'property.registry',
          },
        ],
      },
    });
    const runtime = defineVerticalRuntimeRegistration({
      actions: [action],
      manifest,
      outboxWorkers: [],
      reads: [read],
    });
    const safe = extractVerticalRuntimeSafeDescriptors(runtime);
    const shellOnly = yield* makeApplicationCompositionSnapshotFixture([]);
    const tenantId = '10000000-0000-4000-8000-000000000001';
    const legalEntityId = '20000000-0000-4000-8000-000000000001';
    const oldRef = yield* Schema.decodeUnknownEffect(CoreSearchResourceRefSchema, { onExcessProperty: 'error' })({
      moduleId: manifest.module.id,
      resourceId: 'unit-retained-before-rebuild',
      resourceType: manifest.publicSurface.resourceTypes[0].key,
      tenantId,
    });
    const builds = yield* Effect.forEach(
      ['property-build-a', 'property-build-b'],
      Effect.fn(function* validateBuild(buildMarker) {
        const document = yield* Schema.decodeUnknownEffect(OntosModuleDeploymentContractSchema)({
          deployment: { appId: 'property-registry', buildMarker },
          manifest: {
            activation: manifest.activation,
            module: manifest.module,
            publicSurface: {
              ...base.publicSurface,
              actions: safe.actions,
              api: [{ key: 'property.registry.records', operationKeys: ['property.lookup'] }],
              components: [],
              operationContracts: safe.operationContracts,
              resourceTypes: manifest.publicSurface.resourceTypes,
            },
          },
          runtime: { outboxSubscriptions: safe.outboxSubscriptions },
          schemaVersion: ONTOS_MODULE_CONTRACT_SCHEMA_VERSION,
        });
        const contractDocument = yield* Schema.encodeEffect(Schema.fromJsonString(OntosModuleDeploymentContractSchema))(
          document,
        );
        const contractDigest = Hex.encode(sha256(utf8ToBytes(contractDocument)));
        const module: ApplicationCompositionModule = {
          allowedContributions: [],
          backend: { baseUrl: 'https://property-registry.backend.example/', transport: 'node-http' },
          contract: {
            sha256: contractDigest,
            url: 'https://property-registry.example/.well-known/ontos-module-manifest.json',
          },
          contractDocument,
          dependencies: [],
          deployment: document.deployment,
          federation: { execution: 'server' },
          moduleId: document.manifest.module.id,
          publicContract: { id: document.manifest.module.id, sha256: contractDigest, version: document.schemaVersion },
          requiredCoreCapabilities: [],
          requiredShellAbi: ONTOS_SHELL_CONTRIBUTION_ABI,
          sharedSingletons: [],
        };
        const candidate = { ...shellOnly.composition, modules: [module] };
        const composition = { ...candidate, revision: yield* applicationCompositionContentRevision(candidate) };
        const catalog = yield* buildApplicationCompositionCatalog(composition);
        const installed = catalog.getByModuleId(document.manifest.module.id);
        const installedAction = installed?.manifest.publicSurface.actions[0];
        const installedResource = installed?.manifest.publicSurface.resourceTypes[0];
        if (installed === undefined || installedAction === undefined || installedResource === undefined) {
          return yield* Effect.die('Each actual decoded catalog must contain its genuine Action and owned resource');
        }
        expect(installed.manifest.module.id).toBe(oldRef.moduleId);
        expect(installedResource.key).toBe(oldRef.resourceType);
        return {
          catalog,
          composition,
          installed,
          module,
          targets: {
            action: toSpiceDbActionObjectId(installedAction.actionKey),
            module: toModuleAccessObjectId(tenantId, legalEntityId, installed.manifest.module.id),
            resource: toResourceAccessObjectId(tenantId, legalEntityId, {
              moduleId: installed.manifest.module.id,
              resourceId: oldRef.resourceId,
              resourceType: installedResource.key,
            }),
          },
        };
      }),
    );
    const [before, after] = builds;
    if (before === undefined || after === undefined) {
      return yield* Effect.die('Both distinct deployment inputs must produce validated catalogs');
    }
    expect(before.installed.deployment.buildMarker).not.toBe(after.installed.deployment.buildMarker);
    expect(before.module.contractDocument).not.toBe(after.module.contractDocument);
    expect(before.module.contract.sha256).not.toBe(after.module.contract.sha256);
    expect(before.module.publicContract.sha256).not.toBe(after.module.publicContract.sha256);
    expect(before.composition.revision).not.toBe(after.composition.revision);
    expect(before.module.publicContract.id).toBe(after.module.publicContract.id);
    expect(before.installed.manifest).toEqual(after.installed.manifest);
    expect(before.installed.manifest.publicSurface.operationContracts?.[0]?.schemaVersion).toBe('read.v2');
    expect(before.targets.module).toBeDefined();
    expect(before.targets.resource).toBeDefined();
    expect(after.targets).toEqual(before.targets);
    expect(
      after.catalog
        .getByModuleId(before.installed.manifest.module.id)
        ?.manifest.publicSurface.resourceTypes.some(({ key }) => key === oldRef.resourceType),
    ).toBe(true);
    expect(toResourceAccessObjectId(oldRef.tenantId, legalEntityId, oldRef)).toBe(after.targets.resource);
    const oldRevision = yield* Effect.flip(
      buildApplicationCompositionCatalog({ ...after.composition, revision: before.composition.revision }),
    );
    expect(oldRevision.reason).toMatch(/revision/u);
    const spliced = {
      ...after.composition,
      modules: [{ ...after.module, contract: before.module.contract, publicContract: before.module.publicContract }],
    };
    const digestMismatch = yield* Effect.flip(
      buildApplicationCompositionCatalog({
        ...spliced,
        revision: yield* applicationCompositionContentRevision(spliced),
      }),
    );
    expect(digestMismatch.reason).toMatch(/digest|contract/u);
    return yield* Effect.void;
  }),
);

it('requires real private Read storage rather than copied markers, prototypes or descriptors', () => {
  const read = createRead();
  const target = { descriptor: read.descriptor };
  const copied = Object.assign(target, read);
  Object.setPrototypeOf(copied, Object.getPrototypeOf(read));
  Object.freeze(copied);
  expect(isReadRegistration(read)).toBe(true);
  expect(isReadRegistration({ descriptor: read.descriptor })).toBe(false);
  expect(isReadRegistration(copied)).toBe(false);
  expect(() =>
    defineOntosModuleManifest({
      ...emptyManifestInput(),
      publicSurface: {
        ...emptyManifestInput().publicSurface,
        api: { records: operationApi() },
        operationContracts: [{ apiKey: 'records', operationKey: 'property.lookup', registration: copied }],
      },
    }),
  ).toThrow(/genuine/u);
});

it('keeps safe requirement metadata immutable even when the runtime receives an unfrozen structural manifest', () => {
  const read = createRead();
  const input = { ...emptyManifestInput(), requirements: requirements() };
  const runtime = defineVerticalRuntimeRegistration({ actions: [], manifest: input, outboxWorkers: [], reads: [read] });
  const safe = extractVerticalRuntimeSafeDescriptors(runtime);
  input.requirements.operations[0]?.evidence.push('party.registry.changed-after-registration');
  expect(safe.requirements?.operations[0]?.evidence).toEqual(['party.registry.current-profile']);
  expect(Object.isFrozen(safe.requirements?.operations[0]?.provider)).toBe(true);
});

it('keeps owner-local Actions out of public operation claims unless an exact owner API binding is declared', () => {
  const action = createAction();
  const manifest = defineOntosModuleManifest({
    ...emptyManifestInput(),
    publicSurface: { ...emptyManifestInput().publicSurface, actions: [action] },
  });
  expect(projectOntosModuleOperationContracts(manifest)).toEqual([]);
  expect(() =>
    defineOntosModuleManifest({
      ...emptyManifestInput(),
      publicSurface: {
        ...emptyManifestInput().publicSurface,
        actions: [action],
        api: { records: operationApi() },
        operationContracts: [{ apiKey: 'records', operationKey: 'privateManagement.execute', registration: action }],
      },
    }),
  ).toThrow(/actual declared API operation/u);
});

it('rejects foreign, duplicate, undeclared API and conflicting versioned operation bindings', () => {
  const read = createRead();
  const binding = { apiKey: 'records', operationKey: 'property.lookup', registration: read };
  const input = {
    ...emptyManifestInput(),
    publicSurface: {
      ...emptyManifestInput().publicSurface,
      api: { records: operationApi() },
      operationContracts: [binding],
    },
  };
  expect(() =>
    defineOntosModuleManifest({
      ...input,
      publicSurface: {
        ...input.publicSurface,
        operationContracts: [{ ...binding, registration: createRead('other.owner') }],
      },
    }),
  ).toThrow(/owned/u);
  expect(() =>
    defineOntosModuleManifest({
      ...input,
      publicSurface: {
        ...input.publicSurface,
        operationContracts: [{ ...binding, apiKey: 'property.registry.records' }],
      },
    }),
  ).toThrow(/local API key/u);
  expect(() =>
    defineOntosModuleManifest({
      ...input,
      publicSurface: { ...input.publicSurface, operationContracts: [binding, binding] },
    }),
  ).toThrow(/duplicate/u);
  expect(() =>
    defineOntosModuleManifest({
      ...input,
      publicSurface: {
        ...input.publicSurface,
        operationContracts: [binding, { ...binding, registration: createRead('property.registry', '2') }],
      },
    }),
  ).toThrow(/conflicting/u);
});

it('preserves identical genuine runtime projections when backend and UI views share one owner declaration', () => {
  const action = createAction();
  const read = createRead();
  const base = emptyManifestInput();
  const runtimeManifest = {
    module: base.module,
    publicSurface: {
      actions: [action],
      api: { records: operationApi() },
      operationContracts: [{ apiKey: 'records', operationKey: 'property.lookup', registration: read }],
      shellContributions: base.publicSurface.shellContributions,
    },
    requirements: {
      ...requirements(),
      intrinsic: [{ moduleId: 'party.registry', requiredOperations: [] }],
    },
  };
  const uiManifest = defineOntosModuleManifest({
    ...base,
    ...runtimeManifest,
    publicSurface: { ...base.publicSurface, ...runtimeManifest.publicSurface, components: { Card: componentValue } },
  });
  const backend = defineVerticalRuntimeRegistration({
    actions: [action],
    manifest: runtimeManifest,
    outboxWorkers: [],
    reads: [read],
  });
  const ui = defineVerticalRuntimeRegistration({
    actions: [action],
    manifest: uiManifest,
    outboxWorkers: [],
    reads: [read],
  });
  expect(extractVerticalRuntimeSafeDescriptors(backend)).toEqual(extractVerticalRuntimeSafeDescriptors(ui));
  expect(extractVerticalRuntimeSafeDescriptors(backend).requirements).toEqual(runtimeManifest.requirements);
  expect(getVerticalRuntimeActions(backend)[0]).toBe(action);
  expect(getVerticalRuntimeActions(ui)[0]).toBe(action);
  expect(() =>
    defineVerticalRuntimeRegistration({
      actions: [action],
      manifest: runtimeManifest,
      outboxWorkers: [],
      reads: [createRead()],
    }),
  ).toThrow(/same private runtime registration/u);
});

it('binds public claims and conditional requirements to the exact private runtime registration values', () => {
  const read = createRead();
  const manifest = defineOntosModuleManifest({
    ...emptyManifestInput(),
    publicSurface: {
      ...emptyManifestInput().publicSurface,
      api: { records: operationApi() },
      operationContracts: [{ apiKey: 'records', operationKey: 'property.lookup', registration: read }],
    },
    requirements: requirements(),
  });
  expect(() => defineVerticalRuntimeRegistration({ actions: [], manifest, outboxWorkers: [] })).toThrow(
    /actual registered/u,
  );
  expect(() =>
    defineVerticalRuntimeRegistration({ actions: [], manifest, outboxWorkers: [], reads: [createRead()] }),
  ).toThrow(/same private runtime registration/u);
  expect(() =>
    defineVerticalRuntimeRegistration({ actions: [], manifest, outboxWorkers: [], reads: [read, read] }),
  ).toThrow(/duplicate/u);
  expect(() =>
    defineVerticalRuntimeRegistration({ actions: [], manifest, outboxWorkers: [], reads: [createRead('other.owner')] }),
  ).toThrow(/owner-local/u);
});

it('rejects conflicting owner conditions, provider identities, capabilities, intrinsic contracts and duplicate evidence', () => {
  const input = { ...emptyManifestInput(), requirements: requirements() };
  const invalidRequirements = [
    { ...requirements(), operations: [{ ...operationRequirement(), condition: 'other.owner.branch' }] },
    {
      ...requirements(),
      operations: [
        {
          ...operationRequirement(),
          provider: { ...operationRequirement().provider, entrypointKey: 'other.owner.api.lookup' },
        },
      ],
    },
    {
      ...requirements(),
      operations: [
        { ...operationRequirement(), evidence: ['party.registry.current-profile', 'party.registry.current-profile'] },
      ],
    },
    { ...requirements(), operations: [operationRequirement(), operationRequirement()] },
    {
      ...requirements(),
      operations: [operationRequirement(), { ...operationRequirement(), key: 'property.registry.requires.other-key' }],
    },
    {
      ...requirements(),
      coreCapabilities: [
        { id: 'ontos.core.operation-admission', version: '1' },
        { id: 'ontos.core.operation-admission', version: '2' },
      ],
    },
    { ...requirements(), intrinsic: [{ moduleId: 'property.registry', requiredOperations: [] }] },
    {
      ...requirements(),
      intrinsic: [
        {
          moduleId: 'party.registry',
          requiredOperations: [{ entrypointKey: 'other.owner.api.lookup', schemaVersion: '1' }],
        },
      ],
    },
  ];
  for (const invalid of invalidRequirements) {
    expect(() => defineOntosModuleManifest({ ...input, requirements: invalid })).toThrow();
  }
});

it('validates declaration versions and safe operation provenance again when decoding serialized deployment data', () => {
  const read = createRead();
  const manifest = defineOntosModuleManifest({
    ...emptyManifestInput(),
    publicSurface: {
      ...emptyManifestInput().publicSurface,
      api: { records: operationApi() },
      operationContracts: [{ apiKey: 'records', operationKey: 'property.lookup', registration: read }],
    },
    requirements: requirements(),
  });
  const contract = {
    deployment: { appId: 'property-registry', buildMarker: 'unrelated-build-revision' },
    manifest: {
      activation: manifest.activation,
      module: manifest.module,
      publicSurface: {
        ...emptyManifestInput().publicSurface,
        actions: [],
        api: [{ key: 'property.registry.records', operationKeys: ['property.lookup'] }],
        components: [],
        operationContracts: projectOntosModuleOperationContracts(manifest),
      },
      requirements: manifest.requirements,
    },
    runtime: { outboxSubscriptions: [] },
    schemaVersion: ONTOS_MODULE_CONTRACT_SCHEMA_VERSION,
  };
  expect(
    decodeOntosModuleDeploymentContract(contract).manifest.publicSurface.operationContracts?.[0]?.schemaVersion,
  ).toBe('read.v2');
  expect(() =>
    decodeOntosModuleDeploymentContract({
      ...contract,
      manifest: { ...contract.manifest, requirements: { ...requirements(), schemaVersion: '2' } },
    }),
  ).toThrow();
  expect(() =>
    decodeOntosModuleDeploymentContract({
      ...contract,
      manifest: { ...contract.manifest, requirements: { ...requirements(), handler: () => {} } },
    }),
  ).toThrow();
  expect(() =>
    decodeOntosModuleDeploymentContract({
      ...contract,
      manifest: {
        ...contract.manifest,
        publicSurface: {
          ...contract.manifest.publicSurface,
          operationContracts: [
            ...contract.manifest.publicSurface.operationContracts,
            ...contract.manifest.publicSurface.operationContracts,
          ],
        },
      },
    }),
  ).toThrow(/duplicate/u);
});

it('defines a valid empty manifest, preserves literals, and freezes its public shape', () => {
  const manifest = defineOntosModuleManifest(emptyManifestInput());
  const literal: 'property.registry' = manifest.module.id;

  expect(literal).toBe('property.registry');
  expect(Object.keys(manifest)).toEqual(['activation', 'module', 'publicSurface']);
  expect(Object.isFrozen(manifest)).toBe(true);
  expect(Object.isFrozen(manifest.activation.supportedStates)).toBe(true);
  expect(Object.isFrozen(manifest.publicSurface.actions)).toBe(true);
  expect(() =>
    Object.defineProperty(manifest.publicSurface.actions, 0, {
      value: 'private',
    }),
  ).toThrow();
});

it.effect('accepts populated typed surfaces and keeps executable values out of safe descriptors', () =>
  Effect.gen(function* verifySafeDescriptors() {
    const action = createAction();
    const apiValue = HttpApi.make('PropertyApi').add(
      HttpApiGroup.make('property').add(HttpApiEndpoint.get('listUnits', '/units')),
    );
    const parameterizedApiValue = HttpApi.make('PropertyDetailApi').add(
      HttpApiGroup.make('propertyDetail').add(
        HttpApiEndpoint.get('getUnit', '/units/:unitId', {
          params: { unitId: UnitId },
        }),
      ),
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
        shellContributions: emptyManifestInput().publicSurface.shellContributions,
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
    expect(manifest.publicSurface.api.PropertyDetail).toBe(parameterizedApiValue);
    expect(manifest.publicSurface.components.PropertyUnitCard).toBe(componentValue);
    expect(Object.keys(registration)).toEqual(['moduleId']);
    expect(getVerticalRuntimeActions(registration)[0]).toBe(action);
    const loadDashboard = getVerticalRuntimeEntrypoints(registration).components['dashboard'];
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
      operationContracts: [],
      outboxSubscriptions: [],
      shellContributions: emptyManifestInput().publicSurface.shellContributions,
    });
  }),
);

it('rejects invalid identities, private fields, duplicates, cross-owner values, and undeclared references', () => {
  expect(() =>
    defineOntosModuleManifest({
      ...emptyManifestInput(),
      module: { ...emptyManifestInput().module, id: 'property-registry' },
    }),
  ).toThrow();
  const privateRoutesInput = {
    ...emptyManifestInput(),
    privateRoutes: [],
  };
  expect(() => validateOntosModuleManifestFields(privateRoutesInput, privateRoutesInput.publicSurface)).toThrow();
  const dependenciesInput = {
    ...emptyManifestInput(),
    dependencies: { core: [], externalSystems: [], modules: [] },
  };
  expect(() => validateOntosModuleManifestFields(dependenciesInput, dependenciesInput.publicSurface)).toThrow();
  expect(() =>
    defineOntosModuleManifest({
      ...emptyManifestInput(),
      activation: {
        ...emptyManifestInput().activation,
        supportedStates: ['inactive', 'inactive'],
      },
    }),
  ).toThrow();
  expect(() =>
    defineOntosModuleManifest({
      ...emptyManifestInput(),
      publicSurface: {
        ...emptyManifestInput().publicSurface,
        actions: [createAction('billing.invoice')],
      },
    }),
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
    }),
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
      'property.registry',
    ),
  ).toThrow(/real values created by defineAction/u);
  expect(() => validateOntosModuleExecutableReferences([], [42], [], [], 'property.registry')).toThrow(
    /real Effect HttpApi/u,
  );
  expect(() => validateOntosModuleExecutableReferences([], [], ['not-a-component'], [], 'property.registry')).toThrow(
    /callable component/u,
  );
  expect(() => validateOntosModuleExecutableReferences([], [], [], [{}], 'property.registry')).toThrow(
    /Effect Schema value/u,
  );
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
        shellContributions: emptyManifestInput().publicSurface.shellContributions,
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
    }),
  ).toThrow();
  expect(() =>
    decodeOntosModuleDeploymentContract({
      ...contract,
      manifest: {
        ...contract.manifest,
        dependencies: { core: [], externalSystems: [], modules: [] },
      },
    }),
  ).toThrow();
  expect(() => decodeOntosModuleDeploymentContract({ ...contract, schemaVersion: '0' })).toThrow();
  expect(() => decodeOntosModuleDeploymentContract({ ...contract, schemaVersion: '999' })).toThrow();
});
