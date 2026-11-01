import { ONTOS_MODULE_CONTRACT_SCHEMA_VERSION } from './manifest-constants.ts';
import { Predicate, Result, Schema } from 'effect';
import { HttpApi } from 'effect/http-api';

import type { AnyActionRegistration } from '../actions/definition.ts';
import { isActionRegistration } from '../actions/definition.ts';
import type { AnyReadRegistration } from '../reads/definition.ts';
import { isReadRegistration } from '../reads/definition.ts';
import { TENANT_PERMISSION_KEYS } from '../permissions/context-permissions.ts';
import { BusinessPermissionDescriptorSchema, defineBusinessPermission } from '../permissions/business-permission.ts';
import type { BusinessPermissionDescriptor } from '../permissions/business-permission.ts';
import { ModuleEntrypointSchema } from './module-entrypoint.ts';
import { OntosShellContributionsSchema, validateShellContributions } from './shell-contribution.ts';
import type { OntosShellContributions } from './shell-contribution.ts';
import {
  OntosModuleIdSchema,
  OntosModuleRequirementsSchema,
  OntosOperationContractSchema,
  OntosOperationKeySchema,
  moduleDependencyDeclarationsIssue,
} from './module-dependency-contracts.ts';
import type { OntosModuleRequirements, OntosOperationContract } from './module-dependency-contracts.ts';

export {
  OntosCoreCapabilityRequirementSchema,
  OntosIntrinsicModuleRequirementSchema,
  OntosModuleIdSchema,
  OntosModuleRequirementsSchema,
  OntosOperationContractSchema,
  OntosOperationRequirementSchema,
  OntosRequiredOperationContractSchema,
} from './module-dependency-contracts.ts';
export type {
  OntosCoreCapabilityRequirement,
  OntosIntrinsicModuleRequirement,
  OntosModuleRequirements,
  OntosOperationContract,
  OntosOperationRequirement,
  OntosRequiredOperationContract,
} from './module-dependency-contracts.ts';

export { ONTOS_MODULE_CONTRACT_SCHEMA_VERSION } from './manifest-constants.ts';
export const ONTOS_MODULE_CONTRACT_PATH = '/.well-known/ontos-module-manifest.json' as const;
export const ONTOS_MODULE_CONTRACT_MAX_BYTES = 1024 * 1024;
export const ONTOS_MODULE_CONTRACT_TIMEOUT_MS = 5000;

const deploymentIdPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const moduleFederationBoundaryPattern = /^[A-Za-z][A-Za-z0-9]*$/u;
const schemaVersionPattern = /^[0-9]+$/u;
const nonEmptyString = Schema.String.check(Schema.isMinLength(1));

export const OntosDeploymentAppIdSchema = Schema.String.check(Schema.isPattern(deploymentIdPattern)).pipe(
  Schema.brand('OntosDeploymentAppId'),
  Schema.decodeTo(Schema.String),
);
export const OntosModuleKindSchema = Schema.Literals(['business_module', 'foundational_module', 'system_module']);
export const OntosModuleActivationStateSchema = Schema.Literals([
  'inactive',
  'active',
  'read_only',
  'suspended',
  'quarantined',
  'deprecated',
  'archived',
]);
export type OntosModuleId = typeof OntosModuleIdSchema.Type;
export type OntosDeploymentAppId = typeof OntosDeploymentAppIdSchema.Type;
export type OntosModuleKind = typeof OntosModuleKindSchema.Type;
export type OntosModuleActivationState = typeof OntosModuleActivationStateSchema.Type;

const OntosAccessFilteringSchema = Schema.Literals(['legal_entity_scope', 'resource_permission', 'tenant_scope']);
const OntosModuleFederationBoundaryIdSchema = Schema.String.check(
  Schema.isPattern(moduleFederationBoundaryPattern),
).pipe(Schema.brand('OntosModuleFederationBoundaryId'), Schema.decodeTo(Schema.String));

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

export const OntosActionContractSchema = Schema.Struct({
  actionKey: OntosModuleIdSchema,
  auditProfile: Schema.Literals(['minimal', 'sensitive', 'standard']),
  entrypoint: ModuleEntrypointSchema,
  idempotency: Schema.Literals(['optional', 'required']),
  legalEntityScope: Schema.Literals(['forbidden', 'optional', 'required']),
  owningModuleId: OntosModuleIdSchema,
  schemaVersion: Schema.String.check(Schema.isPattern(schemaVersionPattern)),
});

export const OntosApiContractSchema = Schema.Struct({
  key: OntosModuleIdSchema,
  operationKeys: Schema.Array(OntosOperationKeySchema),
});

export const OntosComponentContractSchema = Schema.Struct({
  expose: nonEmptyString,
  key: OntosModuleIdSchema,
  mfBoundaryId: OntosModuleFederationBoundaryIdSchema,
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
  accessFiltering: OntosAccessFilteringSchema,
  key: OntosModuleIdSchema,
  owningModuleId: OntosModuleIdSchema,
  requestFilters: Schema.optionalKey(Schema.Array(Schema.Literals(['includeArchived', 'role']))),
  resourceType: OntosModuleIdSchema,
  tenantPermission: Schema.optionalKey(Schema.Literals(TENANT_PERMISSION_KEYS)),
});

export const OntosReportDescriptorSchema = Schema.Struct({
  accessFiltering: OntosAccessFilteringSchema,
  dimensions: Schema.Array(nonEmptyString),
  key: OntosModuleIdSchema,
  label: nonEmptyString,
  owningModuleId: OntosModuleIdSchema,
  resourceTypes: Schema.Array(OntosModuleIdSchema),
});

export const OntosOutboxSubscriptionContractSchema = Schema.Struct({
  consumerModuleKey: OntosModuleIdSchema,
  entrypoint: Schema.Struct({
    access: Schema.Literal('background'),
    authorization: Schema.Struct({
      kind: Schema.Literal('owner_local_background'),
    }),
    entrypointKey: OntosModuleIdSchema,
    moduleKey: OntosModuleIdSchema,
    role: Schema.Literal('worker'),
    scope: Schema.Literal('tenant'),
  }),
  producerModuleKey: OntosModuleIdSchema,
  topic: OntosModuleIdSchema,
  workerKey: OntosModuleIdSchema,
});

export const OntosSerializedPublicSurfaceSchema = Schema.Struct({
  actions: Schema.Array(OntosActionContractSchema),
  api: Schema.Array(OntosApiContractSchema),
  businessPermissions: Schema.optionalKey(Schema.Array(BusinessPermissionDescriptorSchema)),
  components: Schema.Array(OntosComponentContractSchema),
  events: Schema.Array(OntosPublicEventContractSchema),
  operationContracts: Schema.optionalKey(Schema.Array(OntosOperationContractSchema).check(Schema.isMaxLength(4096))),
  reports: Schema.Array(OntosReportDescriptorSchema),
  resourceTypes: Schema.Array(OntosResourceTypeSchema),
  search: Schema.Array(OntosSearchDescriptorSchema),
  shellContributions: OntosShellContributionsSchema,
});

export const OntosSerializedModuleManifestSchema = Schema.Struct({
  activation: OntosModuleActivationSchema,
  module: OntosModuleIdentitySchema,
  publicSurface: OntosSerializedPublicSurfaceSchema,
  requirements: Schema.optionalKey(OntosModuleRequirementsSchema),
}).check(
  Schema.makeFilter((manifest) =>
    moduleDependencyDeclarationsIssue({
      api: manifest.publicSurface.api,
      moduleId: manifest.module.id,
      operationContracts: manifest.publicSurface.operationContracts,
      requirements: manifest.requirements,
    }),
  ),
);

export const OntosDeploymentIdentitySchema = Schema.Struct({
  appId: OntosDeploymentAppIdSchema,
  buildMarker: nonEmptyString.check(
    Schema.isMaxLength(200),
    Schema.isTrimmed(),
    Schema.makeFilter((value) =>
      value.isWellFormed() && value !== '.' && value !== '..'
        ? undefined
        : 'build marker must be well-formed text and must not be a URL dot segment',
    ),
  ),
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

export interface OntosAuthoredOperationContract {
  /** Local key in the owner's publicSurface.api record, normalized only by the public projection. */
  readonly apiKey: string;
  readonly operationKey: string;
  readonly registration: AnyActionRegistration | AnyReadRegistration;
}

/** V0 accepts directly callable React-style component values. */
export type OntosManifestComponentValue = (...arguments_: never[]) => void;

export interface OntosAuthoredPublicEvent<
  PayloadSchema extends Schema.ConstraintDecoder<unknown> = Schema.ConstraintDecoder<unknown>,
> extends Omit<OntosPublicEventContract, 'payloadContract'> {
  readonly payloadSchema: PayloadSchema;
}

export interface OntosAuthoredPublicSurface {
  readonly actions: readonly OntosManifestActionValue[];
  readonly api: Readonly<Record<string, HttpApi.Constraint>>;
  readonly businessPermissions?: readonly BusinessPermissionDescriptor[];
  readonly components: Readonly<Record<string, OntosManifestComponentValue>>;
  readonly events: readonly OntosAuthoredPublicEvent[];
  readonly operationContracts?: readonly OntosAuthoredOperationContract[];
  readonly reports: readonly OntosReportDescriptor[];
  readonly resourceTypes: readonly OntosResourceType[];
  readonly search: readonly OntosSearchDescriptor[];
  readonly shellContributions: OntosShellContributions;
}

export interface OntosModuleManifestInput {
  readonly activation: OntosModuleActivation;
  readonly module: OntosModuleIdentity;
  readonly publicSurface: OntosAuthoredPublicSurface;
  readonly requirements?: OntosModuleRequirements;
}

/** Owner-authored backend declaration consumed by the existing runtime registration, without UI values. */
export type OntosRuntimeManifestInput = Pick<OntosModuleManifestInput, 'module' | 'requirements'> & {
  readonly publicSurface: Pick<
    OntosAuthoredPublicSurface,
    'actions' | 'api' | 'operationContracts' | 'shellContributions'
  >;
};

export type OntosModuleManifest<Input extends OntosModuleManifestInput = OntosModuleManifestInput> = Readonly<Input>;

class OntosModuleManifestValidationError extends Schema.TaggedError<OntosModuleManifestValidationError>()(
  'OntosModuleManifestValidationError',
  { message: Schema.String },
) {}

const invalidManifest = (message: string): OntosModuleManifestValidationError =>
  new OntosModuleManifestValidationError({ message });

const exactDecode = <S extends Schema.ConstraintDecoder<unknown>, Value>(schema: S, value: Value): S['Type'] =>
  Result.getOrThrow(Schema.decodeUnknownResult(schema, { onExcessProperty: 'error' })(value));

const assertExactKeys = <Value extends object>(value: Value, keys: readonly string[], label: string): void => {
  const allowed = new Set(keys);
  for (const key of Reflect.ownKeys(value)) {
    if (!Predicate.isString(key) || !allowed.has(key)) {
      throw invalidManifest(`${label} contains unsupported private field ${String(key)}`);
    }
  }
};

const freezePlain = <Value extends object>(value: Value): Readonly<Value> => {
  for (const nested of Object.values(value)) {
    if (Array.isArray(nested)) {
      for (const item of nested) {
        if (Predicate.isObjectKeyword(item) && item !== null) {
          freezePlain(item);
        }
      }
      Object.freeze(nested);
    } else if (Predicate.isObjectKeyword(nested) && nested !== null) {
      freezePlain(nested);
    }
  }
  return Object.freeze(value);
};

const assertUnique = (values: readonly string[], label: string): void => {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      throw invalidManifest(`duplicate ${label} ${value}`);
    }
    seen.add(value);
  }
};

const assertOwner = (owner: string, expected: string, label: string): void => {
  if (owner !== expected) {
    throw invalidManifest(`${label} must be owned by manifest module ${expected}`);
  }
};

/** Canonical identity shared by authored operation bindings and the deployment API projection. */
export const canonicalOntosPublicApiKey = (moduleId: string, localKey: string): string =>
  `${moduleId}.${localKey
    .replaceAll(/(?<lower>[a-z0-9])(?<upper>[A-Z])/gu, '$<lower>-$<upper>')
    .replaceAll('_', '-')
    .toLowerCase()}`;

const apiOperationKeys = (api: HttpApi.Constraint): readonly string[] => {
  if (!HttpApi.isHttpApi(api)) {
    throw invalidManifest('public operation contracts require a real Effect HttpApi');
  }
  return Object.values(api.groups).flatMap((group) =>
    Object.values(group.endpoints).map((endpoint) =>
      group.topLevel ? endpoint.identifier : `${group.identifier}.${endpoint.identifier}`,
    ),
  );
};

/** Owner-authored safe claim only; actual handler/default-factory dispatch is independently verified. */
export const projectOntosModuleOperationContracts = (
  manifest: OntosRuntimeManifestInput,
): readonly OntosOperationContract[] => {
  const actions = new Set(manifest.publicSurface.actions);
  const contracts = (manifest.publicSurface.operationContracts ?? []).map((binding) => {
    assertExactKeys(binding, ['apiKey', 'operationKey', 'registration'], 'public operation binding');
    const { registration } = binding;
    if (!isActionRegistration(registration) && !isReadRegistration(registration)) {
      throw invalidManifest('public operation contracts must reference genuine Action or Read registrations');
    }
    assertOwner(registration.descriptor.owningModuleKey, manifest.module.id, 'public operation');
    if (isActionRegistration(registration) && !actions.has(registration)) {
      throw invalidManifest('public Action contract must reference the same registered manifest Action');
    }
    if (!Object.hasOwn(manifest.publicSurface.api, binding.apiKey)) {
      throw invalidManifest('public operation contract references an undeclared local API key');
    }
    return exactDecode(OntosOperationContractSchema, {
      apiKey: canonicalOntosPublicApiKey(manifest.module.id, binding.apiKey),
      entrypoint: registration.descriptor.entrypoint,
      operationKey: binding.operationKey,
      schemaVersion: registration.descriptor.schemaVersion,
    });
  });
  const declarations = {
    api: Object.entries(manifest.publicSurface.api).map(([key, api]) => ({
      key: canonicalOntosPublicApiKey(manifest.module.id, key),
      operationKeys: apiOperationKeys(api),
    })),
    moduleId: manifest.module.id,
    operationContracts: contracts,
    requirements: manifest.requirements,
  };
  if (manifest.requirements !== undefined) {
    Object.assign(declarations, { requirements: exactDecode(OntosModuleRequirementsSchema, manifest.requirements) });
  }
  const issue = moduleDependencyDeclarationsIssue(declarations);
  if (issue !== undefined) {
    throw invalidManifest(issue);
  }
  return Object.freeze(
    contracts
      .map((contract) => freezePlain({ ...contract, entrypoint: { ...contract.entrypoint } }))
      .toSorted((left, right) => left.entrypoint.entrypointKey.localeCompare(right.entrypoint.entrypointKey)),
  );
};

/** Private registration keeps an independent immutable metadata snapshot, including structural inputs. */
export const copyOntosModuleRequirements = (input: OntosModuleRequirements): OntosModuleRequirements => {
  const requirements = exactDecode(OntosModuleRequirementsSchema, input);
  return freezePlain({
    ...requirements,
    coreCapabilities: requirements.coreCapabilities.map((value) => ({ ...value })),
    intrinsic: requirements.intrinsic.map((value) => ({
      ...value,
      requiredOperations: value.requiredOperations.map((operation) => ({ ...operation })),
    })),
    operations: requirements.operations.map((value) => ({
      ...value,
      evidence: [...value.evidence],
      provider: { ...value.provider },
    })),
  });
};

export const validateOntosModuleManifestFields = <Input extends object, PublicSurface extends object>(
  input: Input,
  publicSurface: PublicSurface,
): void => {
  assertExactKeys(input, ['activation', 'module', 'publicSurface', 'requirements'], 'manifest');
  assertExactKeys(
    publicSurface,
    [
      'actions',
      'api',
      'businessPermissions',
      'components',
      'events',
      'operationContracts',
      'reports',
      'resourceTypes',
      'search',
      'shellContributions',
    ],
    'manifest public surface',
  );
};

export const validateOntosModuleExecutableReferences = <ActionValue, ApiValue, ComponentValue, EventPayloadSchema>(
  actions: readonly ActionValue[],
  apiValues: readonly ApiValue[],
  componentValues: readonly ComponentValue[],
  eventPayloadSchemas: readonly EventPayloadSchema[],
  moduleId: string,
): void => {
  for (const action of actions) {
    if (!isActionRegistration(action)) {
      throw invalidManifest('manifest Actions must be real values created by defineAction');
    }
    assertOwner(action.descriptor.owningModuleKey, moduleId, 'Action');
    if (!action.descriptor.actionKey.startsWith(`${moduleId}.`)) {
      throw invalidManifest('Action key must be prefixed by its owning module ID');
    }
  }
  if (apiValues.some((value) => !HttpApi.isHttpApi(value))) {
    throw invalidManifest('public API entries must reference real Effect HttpApi values');
  }
  if (componentValues.some((value) => !Predicate.isFunction(value))) {
    throw invalidManifest('public component entries must reference callable component values');
  }
  if (eventPayloadSchemas.some((value) => !Schema.isSchema(value))) {
    throw invalidManifest('public event payloadSchema must be an Effect Schema value');
  }
};

const validateSearchDescriptorReferences = (
  descriptor: typeof OntosSearchDescriptorSchema.Type,
  moduleId: string,
  resourceSet: ReadonlySet<string>,
): void => {
  assertOwner(descriptor.owningModuleId, moduleId, 'search descriptor');
  if (!resourceSet.has(descriptor.resourceType)) {
    throw invalidManifest(`search descriptor references undeclared resource type ${descriptor.resourceType}`);
  }
  if ((descriptor.accessFiltering === 'tenant_scope') !== (descriptor.tenantPermission !== undefined)) {
    throw invalidManifest('tenant-scoped search requires exactly one explicit Tenant permission declaration');
  }
  if (
    descriptor.requestFilters !== undefined &&
    new Set(descriptor.requestFilters).size !== descriptor.requestFilters.length
  ) {
    throw invalidManifest('search request filter declarations must be unique');
  }
};

/**
 * Defines the owner-authored contract. Executable values remain direct references in this
 * in-process value and are never part of the serializable deployment contract.
 */
export const defineOntosModuleManifest = <const Input extends OntosModuleManifestInput>(
  input: Input,
): OntosModuleManifest<Input> => {
  validateOntosModuleManifestFields(input, input.publicSurface);
  exactDecode(OntosModuleIdentitySchema, input.module);
  exactDecode(OntosModuleActivationSchema, input.activation);
  if (input.module.kind !== 'business_module') {
    throw invalidManifest('V0 MicroVertical deployments may define only one business_module');
  }
  if (!input.activation.supportedStates.includes(input.activation.defaultState)) {
    throw invalidManifest('activation defaultState must be included in supportedStates');
  }
  assertUnique(input.activation.supportedStates, 'activation state');

  validateOntosModuleExecutableReferences(
    input.publicSurface.actions,
    Object.values(input.publicSurface.api),
    Object.values(input.publicSurface.components),
    input.publicSurface.events.map(({ payloadSchema }) => payloadSchema),
    input.module.id,
  );
  const actionKeys = input.publicSurface.actions.map(({ descriptor }) => descriptor.actionKey);
  assertUnique(actionKeys, 'Action key');
  projectOntosModuleOperationContracts(input);

  const businessPermissions = (input.publicSurface.businessPermissions ?? []).map(defineBusinessPermission);
  assertUnique(
    businessPermissions.map(({ key }) => key),
    'business permission code',
  );

  const resources = input.publicSurface.resourceTypes.map((resource) => exactDecode(OntosResourceTypeSchema, resource));
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
        throw invalidManifest(`public event references undeclared resource type ${resourceType}`);
      }
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

  const search = input.publicSurface.search.map((descriptor) => exactDecode(OntosSearchDescriptorSchema, descriptor));
  assertUnique(
    search.map(({ key }) => key),
    'search descriptor key',
  );
  for (const descriptor of search) {
    validateSearchDescriptorReferences(descriptor, input.module.id, resourceSet);
  }

  const reports = input.publicSurface.reports.map((descriptor) => exactDecode(OntosReportDescriptorSchema, descriptor));
  assertUnique(
    reports.map(({ key }) => key),
    'report descriptor key',
  );
  for (const descriptor of reports) {
    assertOwner(descriptor.owningModuleId, input.module.id, 'report descriptor');
    for (const resourceType of descriptor.resourceTypes) {
      if (!resourceSet.has(resourceType)) {
        throw invalidManifest(`report descriptor references undeclared resource type ${resourceType}`);
      }
    }
  }

  assertUnique(Object.keys(input.publicSurface.api), 'API key');
  assertUnique(Object.keys(input.publicSurface.components), 'component key');
  const componentKeys = new Set(Object.keys(input.publicSurface.components).map((key) => `${input.module.id}.${key}`));
  const apiKeys = new Set(Object.keys(input.publicSurface.api).map((key) => `${input.module.id}.${key}`));
  const shellContributions = validateShellContributions(input.publicSurface.shellContributions, {
    actionKeys: new Set(actionKeys),
    apiKeys,
    componentKeys,
    moduleId: input.module.id,
    reportKeys: new Set(reports.map(({ key }) => key)),
    resourceTypeKeys: resourceSet,
    searchKeys: new Set(search.map(({ key }) => key)),
  });

  const publicSurface = {
    ...input.publicSurface,
    actions: Object.freeze([...input.publicSurface.actions]),
    api: Object.freeze({ ...input.publicSurface.api }),
    businessPermissions: Object.freeze(businessPermissions),
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
      resources.map((value) => freezePlain({ ...value, capabilities: { ...value.capabilities } })),
    ),
    search: Object.freeze(search.map((value) => freezePlain({ ...value }))),
    shellContributions: freezePlain({
      mediaAttachments: [...shellContributions.mediaAttachments],
      navigation: [...shellContributions.navigation],
      pages: [...shellContributions.pages],
      publicComponents: [...shellContributions.publicComponents],
      reports: [...shellContributions.reports],
      resourceDetails: [...shellContributions.resourceDetails],
      search: [...shellContributions.search],
      timelines: [...shellContributions.timelines],
    }),
  };
  if (input.publicSurface.operationContracts !== undefined) {
    Object.assign(publicSurface, {
      operationContracts: Object.freeze(
        input.publicSurface.operationContracts.map((binding) => Object.freeze({ ...binding })),
      ),
    });
  }
  const manifest = {
    ...input,
    activation: freezePlain({ ...input.activation, supportedStates: [...input.activation.supportedStates] }),
    module: freezePlain({ ...input.module }),
    publicSurface: Object.freeze(publicSurface),
  };
  if (input.requirements !== undefined) {
    Object.assign(manifest, { requirements: copyOntosModuleRequirements(input.requirements) });
  }
  return Object.freeze(manifest);
};

export const decodeOntosModuleDeploymentContract = <Value>(value: Value): OntosModuleDeploymentContract =>
  exactDecode(OntosModuleDeploymentContractSchema, value);
