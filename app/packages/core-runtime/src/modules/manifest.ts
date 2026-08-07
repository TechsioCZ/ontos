import { Schema } from 'effect';
import { HttpApi } from 'effect/unstable/httpapi';
import type { AnyActionRegistration } from '../actions/definition.ts';
import { isActionRegistration } from '../actions/definition.ts';

export const ONTOS_MODULE_CONTRACT_SCHEMA_VERSION = '0' as const;
export const ONTOS_MODULE_CONTRACT_PATH = '/.well-known/ontos-module-manifest.json' as const;
export const ONTOS_MODULE_CONTRACT_MAX_BYTES = 1024 * 1024;
export const ONTOS_MODULE_CONTRACT_TIMEOUT_MS = 5000;

const dottedIdentifierPattern =
  /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*)+$/u;
const deploymentIdPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const moduleFederationBoundaryPattern = /^[A-Za-z][A-Za-z0-9]*$/u;
const schemaVersionPattern = /^[0-9]+$/u;
const nonEmptyString = Schema.String.check(Schema.isMinLength(1));

export const OntosModuleIdSchema = Schema.String.check(Schema.isPattern(dottedIdentifierPattern));
export const OntosDeploymentAppIdSchema = Schema.String.check(
  Schema.isPattern(deploymentIdPattern),
);
export const OntosModuleKindSchema = Schema.Literals([
  'business_module',
  'foundational_module',
  'system_module',
]);
export const OntosModuleActivationStateSchema = Schema.Literals([
  'inactive',
  'active',
  'read_only',
  'suspended',
  'quarantined',
  'deprecated',
  'archived',
]);
export const OntosModuleDependencyModeSchema = Schema.Literals([
  'must_be_active_first',
  'enable_together_when_available',
  'optional_enhancement',
  'integration_required_for_api',
]);
export const OntosCoreCapabilitySchema = Schema.Literals([
  'core.identity',
  'core.authz',
  'core.modules',
  'core.actions',
  'core.audit',
  'core.events',
  'core.outbox',
  'core.search',
]);

export type OntosModuleId = typeof OntosModuleIdSchema.Type;
export type OntosDeploymentAppId = typeof OntosDeploymentAppIdSchema.Type;
export type OntosModuleKind = typeof OntosModuleKindSchema.Type;
export type OntosModuleActivationState = typeof OntosModuleActivationStateSchema.Type;
export type OntosModuleDependencyMode = typeof OntosModuleDependencyModeSchema.Type;
export type OntosCoreCapability = typeof OntosCoreCapabilitySchema.Type;

export const OntosModuleIdentitySchema = Schema.Struct({
  description: nonEmptyString,
  displayName: nonEmptyString,
  id: OntosModuleIdSchema,
  implementedAs: Schema.Literal('ultramodern_microvertical'),
  kind: OntosModuleKindSchema,
});

export const OntosModuleActivationSchema = Schema.Struct({
  defaultState: OntosModuleActivationStateSchema,
  preservesHistoryWhenInactive: Schema.Boolean,
  scope: Schema.Literal('tenant'),
  supportedStates: Schema.Array(OntosModuleActivationStateSchema),
});

export const OntosModuleDependencySchema = Schema.Struct({
  activation: OntosModuleDependencyModeSchema,
  id: OntosModuleIdSchema,
  reason: nonEmptyString,
  required: Schema.Boolean,
});

export const OntosExternalSystemDependencySchema = Schema.Struct({
  id: OntosModuleIdSchema,
  reason: nonEmptyString,
  required: Schema.Boolean,
});

export const OntosModuleDependenciesSchema = Schema.Struct({
  core: Schema.Array(OntosCoreCapabilitySchema),
  externalSystems: Schema.Array(OntosExternalSystemDependencySchema),
  modules: Schema.Array(OntosModuleDependencySchema),
});

export const OntosActionContractSchema = Schema.Struct({
  actionKey: OntosModuleIdSchema,
  auditProfile: Schema.Literals(['minimal', 'sensitive', 'standard']),
  idempotency: Schema.Literals(['optional', 'required']),
  owningModuleId: OntosModuleIdSchema,
  schemaVersion: Schema.String.check(Schema.isPattern(schemaVersionPattern)),
});

export const OntosApiContractSchema = Schema.Struct({
  key: OntosModuleIdSchema,
  operationKeys: Schema.Array(nonEmptyString),
});

export const OntosComponentContractSchema = Schema.Struct({
  expose: nonEmptyString,
  key: OntosModuleIdSchema,
  mfBoundaryId: Schema.String.check(Schema.isPattern(moduleFederationBoundaryPattern)),
});

export const OntosResourceTypeSchema = Schema.Struct({
  capabilities: Schema.Struct({
    graphVisible: Schema.Boolean,
    linkable: Schema.Boolean,
    mediaAttachable: Schema.Boolean,
    searchable: Schema.Boolean,
    timelineVisible: Schema.Boolean,
  }),
  description: nonEmptyString,
  key: OntosModuleIdSchema,
  label: nonEmptyString,
  owningModuleId: OntosModuleIdSchema,
});

export const OntosPublicEventContractSchema = Schema.Struct({
  key: OntosModuleIdSchema,
  owningModuleId: OntosModuleIdSchema,
  payloadContract: nonEmptyString,
  referencesResourceTypes: Schema.Array(OntosModuleIdSchema),
  tense: Schema.Literal('past'),
  visibility: Schema.Literal('public_module_event'),
});

export const OntosSearchDescriptorSchema = Schema.Struct({
  accessFiltering: Schema.Literals(['legal_entity_scope', 'resource_permission', 'tenant_scope']),
  key: OntosModuleIdSchema,
  owningModuleId: OntosModuleIdSchema,
  resourceType: OntosModuleIdSchema,
});

export const OntosReportDescriptorSchema = Schema.Struct({
  accessFiltering: Schema.Literals(['legal_entity_scope', 'resource_permission', 'tenant_scope']),
  dimensions: Schema.Array(nonEmptyString),
  key: OntosModuleIdSchema,
  label: nonEmptyString,
  owningModuleId: OntosModuleIdSchema,
  resourceTypes: Schema.Array(OntosModuleIdSchema),
});

export const OntosOutboxSubscriptionContractSchema = Schema.Struct({
  consumerModuleKey: OntosModuleIdSchema,
  producerModuleKey: OntosModuleIdSchema,
  topic: OntosModuleIdSchema,
  workerKey: OntosModuleIdSchema,
});

export const OntosSerializedPublicSurfaceSchema = Schema.Struct({
  actions: Schema.Array(OntosActionContractSchema),
  api: Schema.Array(OntosApiContractSchema),
  components: Schema.Array(OntosComponentContractSchema),
  events: Schema.Array(OntosPublicEventContractSchema),
  reports: Schema.Array(OntosReportDescriptorSchema),
  resourceTypes: Schema.Array(OntosResourceTypeSchema),
  search: Schema.Array(OntosSearchDescriptorSchema),
});

export const OntosSerializedModuleManifestSchema = Schema.Struct({
  activation: OntosModuleActivationSchema,
  dependencies: OntosModuleDependenciesSchema,
  module: OntosModuleIdentitySchema,
  publicSurface: OntosSerializedPublicSurfaceSchema,
});

export const OntosDeploymentIdentitySchema = Schema.Struct({
  appId: OntosDeploymentAppIdSchema,
  buildMarker: nonEmptyString,
});

export const OntosModuleDeploymentContractSchema = Schema.Struct({
  deployment: OntosDeploymentIdentitySchema,
  manifest: OntosSerializedModuleManifestSchema,
  runtime: Schema.Struct({
    outboxSubscriptions: Schema.Array(OntosOutboxSubscriptionContractSchema),
  }),
  schemaVersion: Schema.Literal(ONTOS_MODULE_CONTRACT_SCHEMA_VERSION),
});

export type OntosModuleIdentity = typeof OntosModuleIdentitySchema.Type;
export type OntosModuleActivation = typeof OntosModuleActivationSchema.Type;
export type OntosModuleDependency = typeof OntosModuleDependencySchema.Type;
export type OntosExternalSystemDependency = typeof OntosExternalSystemDependencySchema.Type;
export type OntosModuleDependencies = typeof OntosModuleDependenciesSchema.Type;
export type OntosActionContract = typeof OntosActionContractSchema.Type;
export type OntosApiContract = typeof OntosApiContractSchema.Type;
export type OntosComponentContract = typeof OntosComponentContractSchema.Type;
export type OntosResourceType = typeof OntosResourceTypeSchema.Type;
export type OntosPublicEventContract = typeof OntosPublicEventContractSchema.Type;
export type OntosSearchDescriptor = typeof OntosSearchDescriptorSchema.Type;
export type OntosReportDescriptor = typeof OntosReportDescriptorSchema.Type;
export type OntosOutboxSubscriptionContract = typeof OntosOutboxSubscriptionContractSchema.Type;
export type OntosSerializedModuleManifest = typeof OntosSerializedModuleManifestSchema.Type;
export type OntosModuleDeploymentContract = typeof OntosModuleDeploymentContractSchema.Type;

export type OntosManifestActionValue = AnyActionRegistration;

/** V0 accepts directly callable React-style component values. */
export type OntosManifestComponentValue = (...arguments_: never[]) => unknown;

export interface OntosAuthoredPublicEvent<
  PayloadSchema extends Schema.ConstraintDecoder<unknown, never> = Schema.ConstraintDecoder<
    unknown,
    never
  >,
> extends Omit<OntosPublicEventContract, 'payloadContract'> {
  readonly payloadSchema: PayloadSchema;
}

export interface OntosAuthoredPublicSurface {
  readonly actions: readonly OntosManifestActionValue[];
  readonly api: Readonly<Record<string, HttpApi.AnyWithProps>>;
  readonly components: Readonly<Record<string, OntosManifestComponentValue>>;
  readonly events: readonly OntosAuthoredPublicEvent[];
  readonly reports: readonly OntosReportDescriptor[];
  readonly resourceTypes: readonly OntosResourceType[];
  readonly search: readonly OntosSearchDescriptor[];
}

export interface OntosModuleManifestInput {
  readonly activation: OntosModuleActivation;
  readonly dependencies: OntosModuleDependencies;
  readonly module: OntosModuleIdentity;
  readonly publicSurface: OntosAuthoredPublicSurface;
}

export type OntosModuleManifest<Input extends OntosModuleManifestInput = OntosModuleManifestInput> =
  Readonly<Input>;

const exactDecode = <S extends Schema.ConstraintDecoder<unknown, never>>(
  schema: S,
  value: unknown,
): S['Type'] => Schema.decodeUnknownSync(schema, { onExcessProperty: 'error' })(value);

const assertExactKeys = (value: object, keys: readonly string[], label: string): void => {
  const allowed = new Set(keys);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new TypeError(`${label} contains unsupported private field ${String(key)}`);
    }
  }
};

const freezePlain = <Value extends object>(value: Value): Readonly<Value> => {
  for (const nested of Object.values(value)) {
    if (Array.isArray(nested)) {
      for (const item of nested) {
        if (typeof item === 'object' && item !== null) {
          freezePlain(item);
        }
      }
      Object.freeze(nested);
    } else if (typeof nested === 'object' && nested !== null) {
      freezePlain(nested);
    }
  }
  return Object.freeze(value);
};

const assertUnique = (values: readonly string[], label: string): void => {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      throw new TypeError(`duplicate ${label} ${value}`);
    }
    seen.add(value);
  }
};

const assertOwner = (owner: string, expected: string, label: string): void => {
  if (owner !== expected) {
    throw new TypeError(`${label} must be owned by manifest module ${expected}`);
  }
};

/**
 * Defines the owner-authored contract. Executable values remain direct references in this
 * in-process value and are never part of the serializable deployment contract.
 */
export const defineOntosModuleManifest = <const Input extends OntosModuleManifestInput>(
  input: Input,
): OntosModuleManifest<Input> => {
  assertExactKeys(input, ['activation', 'dependencies', 'module', 'publicSurface'], 'manifest');
  assertExactKeys(
    input.publicSurface,
    ['actions', 'api', 'components', 'events', 'reports', 'resourceTypes', 'search'],
    'manifest public surface',
  );
  exactDecode(OntosModuleIdentitySchema, input.module);
  exactDecode(OntosModuleActivationSchema, input.activation);
  exactDecode(OntosModuleDependenciesSchema, input.dependencies);
  if (input.module.kind !== 'business_module') {
    throw new TypeError('V0 MicroVertical deployments may define only one business_module');
  }
  if (!input.activation.supportedStates.includes(input.activation.defaultState)) {
    throw new TypeError('activation defaultState must be included in supportedStates');
  }
  assertUnique(input.activation.supportedStates, 'activation state');
  assertUnique(input.dependencies.core, 'Core dependency');
  assertUnique(
    input.dependencies.modules.map(({ id }) => id),
    'module dependency',
  );
  assertUnique(
    input.dependencies.externalSystems.map(({ id }) => id),
    'external dependency',
  );
  for (const dependency of input.dependencies.modules) {
    if (dependency.id === input.module.id) {
      throw new TypeError('a module cannot depend on itself');
    }
  }

  const actionKeys = input.publicSurface.actions.map(({ descriptor }) => descriptor.actionKey);
  assertUnique(actionKeys, 'Action key');
  for (const action of input.publicSurface.actions) {
    if (!isActionRegistration(action)) {
      throw new TypeError('manifest Actions must be real values created by defineAction');
    }
    assertOwner(action.descriptor.owningModuleKey, input.module.id, 'Action');
    if (!action.descriptor.actionKey.startsWith(`${input.module.id}.`)) {
      throw new TypeError('Action key must be prefixed by its owning module ID');
    }
  }

  const resources = input.publicSurface.resourceTypes.map((resource) =>
    exactDecode(OntosResourceTypeSchema, resource),
  );
  const resourceKeys = resources.map(({ key }) => key);
  assertUnique(resourceKeys, 'resource type key');
  for (const resource of resources) {
    assertOwner(resource.owningModuleId, input.module.id, 'resource type');
  }
  const resourceSet = new Set(resourceKeys);

  const events = input.publicSurface.events.map((event) => {
    assertExactKeys(
      event,
      ['key', 'owningModuleId', 'payloadSchema', 'referencesResourceTypes', 'tense', 'visibility'],
      'public event',
    );
    const descriptor = exactDecode(OntosPublicEventContractSchema, {
      key: event.key,
      owningModuleId: event.owningModuleId,
      payloadContract: event.key,
      referencesResourceTypes: event.referencesResourceTypes,
      tense: event.tense,
      visibility: event.visibility,
    });
    assertOwner(descriptor.owningModuleId, input.module.id, 'public event');
    for (const resourceType of descriptor.referencesResourceTypes) {
      if (!resourceSet.has(resourceType)) {
        throw new TypeError(`public event references undeclared resource type ${resourceType}`);
      }
    }
    if (!Schema.isSchema(event.payloadSchema)) {
      throw new TypeError('public event payloadSchema must be an Effect Schema value');
    }
    return Object.freeze({
      ...event,
      referencesResourceTypes: Object.freeze([...event.referencesResourceTypes]),
    });
  });
  assertUnique(
    events.map(({ key }) => key),
    'public event key',
  );

  const search = input.publicSurface.search.map((descriptor) =>
    exactDecode(OntosSearchDescriptorSchema, descriptor),
  );
  assertUnique(
    search.map(({ key }) => key),
    'search descriptor key',
  );
  for (const descriptor of search) {
    assertOwner(descriptor.owningModuleId, input.module.id, 'search descriptor');
    if (!resourceSet.has(descriptor.resourceType)) {
      throw new TypeError(
        `search descriptor references undeclared resource type ${descriptor.resourceType}`,
      );
    }
  }

  const reports = input.publicSurface.reports.map((descriptor) =>
    exactDecode(OntosReportDescriptorSchema, descriptor),
  );
  assertUnique(
    reports.map(({ key }) => key),
    'report descriptor key',
  );
  for (const descriptor of reports) {
    assertOwner(descriptor.owningModuleId, input.module.id, 'report descriptor');
    for (const resourceType of descriptor.resourceTypes) {
      if (!resourceSet.has(resourceType)) {
        throw new TypeError(
          `report descriptor references undeclared resource type ${resourceType}`,
        );
      }
    }
  }

  assertUnique(Object.keys(input.publicSurface.api), 'API key');
  assertUnique(Object.keys(input.publicSurface.components), 'component key');
  if (Object.values(input.publicSurface.api).some((value) => !HttpApi.isHttpApi(value))) {
    throw new TypeError('public API entries must reference real Effect HttpApi values');
  }
  if (Object.values(input.publicSurface.components).some((value) => typeof value !== 'function')) {
    throw new TypeError('public component entries must reference callable component values');
  }

  const manifest = {
    activation: freezePlain({
      ...input.activation,
      supportedStates: [...input.activation.supportedStates],
    }),
    dependencies: freezePlain({
      core: [...input.dependencies.core],
      externalSystems: input.dependencies.externalSystems.map((value) => ({ ...value })),
      modules: input.dependencies.modules.map((value) => ({ ...value })),
    }),
    module: freezePlain({ ...input.module }),
    publicSurface: Object.freeze({
      actions: Object.freeze([...input.publicSurface.actions]),
      api: Object.freeze({ ...input.publicSurface.api }),
      components: Object.freeze({ ...input.publicSurface.components }),
      events: Object.freeze(events),
      reports: Object.freeze(
        reports.map((value) =>
          freezePlain({
            ...value,
            dimensions: [...value.dimensions],
            resourceTypes: [...value.resourceTypes],
          }),
        ),
      ),
      resourceTypes: Object.freeze(
        resources.map((value) =>
          freezePlain({ ...value, capabilities: { ...value.capabilities } }),
        ),
      ),
      search: Object.freeze(search.map((value) => freezePlain({ ...value }))),
    }),
  } as unknown as Input;
  return Object.freeze(manifest);
};

export const decodeOntosModuleDeploymentContract = (
  value: unknown,
): OntosModuleDeploymentContract => exactDecode(OntosModuleDeploymentContractSchema, value);
