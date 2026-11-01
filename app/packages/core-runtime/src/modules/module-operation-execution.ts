import { selfApiKeyBindingsRead, managedPrincipalsRead } from '../auth/principal-administration-reads.ts';
import { readPrincipalBinding } from '../auth/external-identity/read.ts';
import { legalEntityDetailRead } from '../generated-reads/legal-entity-detail.ts';
import type { TrustedPrincipalContext } from '../actions/context.ts';
import { readVerifiedGatewayCompositionRevision } from '../auth/system-principal-context-provenance.ts';
import { coreActionCatalog } from './actions/catalog.ts';
import {
  validateActiveApplicationCompositionSnapshot,
  loadInstalledModuleCatalogForRevision,
} from './active-application-composition.ts';
import type { ActiveApplicationCompositionServiceContract } from './active-application-composition.ts';
import { buildApplicationCompositionCatalog } from './application-composition-catalog.ts';
import { copyOntosModuleRequirements } from './manifest.ts';
import type { OntosDeploymentIdentitySchema } from './manifest.ts';
import {
  OntosModuleRequirementsSchema,
  OntosOperationContractSchema,
  tenantModuleIntrinsicDependencyClosure,
  providesRequiredOperationContracts,
} from './module-dependency-contracts.ts';
import { Context, Effect, Option, Schema } from 'effect';

import { isActionRegistration } from '../actions/definition.ts';
import type { AnyActionRegistration } from '../actions/definition.ts';
import { isReadRegistration } from '../reads/definition.ts';
import type { AnyReadRegistration } from '../reads/definition.ts';
import { isOutboxWorkerRegistration } from '../outbox/definition.ts';
import type { AnyOutboxWorkerRegistration } from '../outbox/definition.ts';
import type { InstalledModuleCatalog } from './catalog.ts';
import {
  extractVerticalRuntimeSafeDescriptors,
  getVerticalRuntimeActions,
  getVerticalRuntimeOutboxWorkers,
  getVerticalRuntimeReads,
} from './runtime-registration.ts';
import type { VerticalRuntimeRegistration } from './runtime-registration.ts';
import { ModuleOperationRequirementError } from './module-operation-requirement-error.ts';

interface ModuleOperationExecutionInput {
  readonly loadCatalog: Effect.Effect<InstalledModuleCatalog, ModuleOperationRequirementError>;
  readonly ownerRegistration?: VerticalRuntimeRegistration | undefined;
  readonly phase: 'execution' | 'recovery' | 'settlement';
  readonly registration: AnyActionRegistration | AnyReadRegistration | AnyOutboxWorkerRegistration;
  readonly revision: string;
  readonly scope: Readonly<{ readonly tenantId: string }>;
}

interface ExecutionLeaseMint {
  readonly purpose: 'module-operation-execution';
}
const executionLeaseToken: ExecutionLeaseMint = Object.freeze({ purpose: 'module-operation-execution' });

/** Core-private, execution-local authority. No public export exposes its tag or constructor. */
class ModuleOperationExecutionLease {
  #active = false;
  readonly input: ModuleOperationExecutionInput;

  constructor(input: ModuleOperationExecutionInput, token: ExecutionLeaseMint) {
    this.#active = token === executionLeaseToken;
    this.input = Object.freeze({ ...input, scope: Object.freeze({ ...input.scope }) });
    Object.freeze(this);
  }

  static owns(value: ModuleOperationExecutionLease): boolean {
    return #active in value;
  }

  get active(): boolean {
    return this.#active;
  }

  close(): void {
    this.#active = false;
  }
}

Object.freeze(ModuleOperationExecutionLease.prototype);
Object.freeze(ModuleOperationExecutionLease);
const ModuleOperationExecutionLeaseSchema = Schema.instanceOf(ModuleOperationExecutionLease).check(
  Schema.makeFilter((value) =>
    ModuleOperationExecutionLease.owns(value) ? undefined : 'Expected a genuine execution lease',
  ),
);
const ModuleOperationExecution = Context.Reference<Option.Option<ModuleOperationExecutionLease>>(
  '@app/core-runtime/modules/module-operation-execution/ModuleOperationExecution',
  { defaultValue: () => Option.none() },
);

const unavailable = (cause?: unknown) => {
  const error = new ModuleOperationRequirementError({
    code: 'module_operation_requirement_unavailable',
    reason: 'The required module operation could not be checked safely',
  });
  if (cause !== undefined) {
    Object.defineProperty(error, 'cause', { configurable: true, value: cause });
  }
  return error;
};

const unsatisfied = () =>
  new ModuleOperationRequirementError({
    code: 'module_operation_requirement_unsatisfied',
    reason: 'The required module operation is not supported by the admitted composition',
  });

/** Only genuine Core runtime boundaries import this private wrapper. Nested contexts shadow naturally. */
export const withModuleOperationExecution = <Value, Failure, Requirements>(
  input: ModuleOperationExecutionInput,
  effect: Effect.Effect<Value, Failure, Requirements>,
): Effect.Effect<Value, Failure, Requirements> =>
  Effect.suspend(() => {
    const lease = new ModuleOperationExecutionLease(input, executionLeaseToken);
    return effect.pipe(
      Effect.updateService(ModuleOperationExecution, () => Option.some(lease)),
      Effect.ensuring(Effect.sync(() => lease.close())),
    );
  });

/** Private implementation of the public key-only facade; it grants no provider authority. */
export const requireExecutingModuleOperation = Effect.fn('ModuleOperation.require')(function* requireOperation(
  requirementKey: string,
) {
  const selected = yield* Schema.decodeUnknownEffect(Schema.Option(ModuleOperationExecutionLeaseSchema))(
    yield* ModuleOperationExecution,
  ).pipe(Effect.mapError(unavailable));
  if (Option.isNone(selected)) {
    return yield* unavailable();
  }
  const lease = selected.value;
  if (!lease.active || lease.input.scope.tenantId.length === 0 || !/^[a-f0-9]{64}$/u.test(lease.input.revision)) {
    return yield* unavailable();
  }
  const { registration } = lease.input;
  if (
    !isActionRegistration(registration) &&
    !isReadRegistration(registration) &&
    !isOutboxWorkerRegistration(registration)
  ) {
    return yield* unavailable();
  }
  const catalog = yield* lease.input.loadCatalog;
  if (!lease.active) {
    return yield* unavailable();
  }
  const consumer = catalog.getByModuleId(lease.input.registration.descriptor.entrypoint.moduleKey);
  const requirement = consumer?.manifest.requirements?.operations.find(({ key }) => key === requirementKey);
  if (
    requirement === undefined ||
    requirement.entrypointKey !== lease.input.registration.descriptor.entrypoint.entrypointKey
  ) {
    return yield* unsatisfied();
  }
  const owner = lease.input.ownerRegistration;
  if (owner === undefined || owner.moduleId !== lease.input.registration.descriptor.entrypoint.moduleKey) {
    return yield* unavailable();
  }
  const registered = yield* Effect.try({
    catch: unavailable,
    try: () =>
      getVerticalRuntimeActions(owner).some((candidate) => candidate === registration) ||
      getVerticalRuntimeReads(owner).some((candidate) => candidate === registration) ||
      getVerticalRuntimeOutboxWorkers(owner).some((candidate) => candidate === registration),
  });
  if (!registered) {
    return yield* unavailable();
  }
  const provider = catalog.getByModuleId(requirement.provider.moduleId);
  if (
    provider === undefined ||
    !providesRequiredOperationContracts(provider.manifest.publicSurface.operationContracts, [requirement.provider])
  ) {
    return yield* unsatisfied();
  }
  return yield* Effect.void;
});

export type ModuleOperationRegistration = AnyActionRegistration | AnyReadRegistration | AnyOutboxWorkerRegistration;

/** This is the existing immutable Core catalog's identity check, never a module-prefix exemption. */
export const isGenuineCoreAction = (registration: ModuleOperationRegistration): boolean =>
  isActionRegistration(registration) && coreActionCatalog.some((descriptor) => descriptor === registration.descriptor);

export const readBoundOperationOwner = Effect.fn('ModuleOperation.readBoundOwner')(function* readBoundOwner(
  registration: ModuleOperationRegistration,
  ownerRegistration?: VerticalRuntimeRegistration,
) {
  if (ownerRegistration === undefined) {
    return yield* Effect.void;
  }
  const owner = yield* Effect.try({
    catch: unavailable,
    try: () => extractVerticalRuntimeSafeDescriptors(ownerRegistration),
  });
  if (owner.moduleId !== registration.descriptor.entrypoint.moduleKey) {
    return yield* unavailable();
  }
  return owner;
});

const coreReads = Object.freeze([
  selfApiKeyBindingsRead,
  managedPrincipalsRead,
  legalEntityDetailRead,
  readPrincipalBinding,
]);
/** Exact existing Core registration identities, independent of caller-chosen strings. */
export const isGenuineCoreOperation = (registration: ModuleOperationRegistration): boolean =>
  isGenuineCoreAction(registration) ||
  (isReadRegistration(registration) && coreReads.some((read) => read === registration));

const canonicalEmptyRequirements = { coreCapabilities: [], intrinsic: [], operations: [], schemaVersion: '1' } as const;
const requirementsJson = Schema.fromJsonString(OntosModuleRequirementsSchema);
const operationsJson = Schema.fromJsonString(Schema.Array(OntosOperationContractSchema));

const validateOwnerContractProjection = Effect.fn('ModuleOperation.validateOwnerContractProjection')(
  function* validateOwnerProjection(
    owner: ReturnType<typeof extractVerticalRuntimeSafeDescriptors>,
    catalog: InstalledModuleCatalog,
  ) {
    const observed = catalog.getByModuleId(owner.moduleId);
    if (observed === undefined) {
      return yield* unavailable();
    }
    const authoredRequirements = yield* Schema.encodeEffect(requirementsJson)(
      copyOntosModuleRequirements(owner.requirements ?? canonicalEmptyRequirements),
    ).pipe(Effect.mapError(unavailable));
    const observedRequirements = yield* Schema.encodeEffect(requirementsJson)(
      copyOntosModuleRequirements(observed.manifest.requirements ?? canonicalEmptyRequirements),
    ).pipe(Effect.mapError(unavailable));
    const authoredOperations = yield* Schema.encodeEffect(operationsJson)(
      owner.operationContracts.toSorted((a, b) => a.entrypoint.entrypointKey.localeCompare(b.entrypoint.entrypointKey)),
    ).pipe(Effect.mapError(unavailable));
    const observedOperations = yield* Schema.encodeEffect(operationsJson)(
      (observed.manifest.publicSurface.operationContracts ?? []).toSorted((a, b) =>
        a.entrypoint.entrypointKey.localeCompare(b.entrypoint.entrypointKey),
      ),
    ).pipe(Effect.mapError(unavailable));
    if (authoredRequirements !== observedRequirements || authoredOperations !== observedOperations) {
      return yield* unavailable();
    }
    return yield* Effect.void;
  },
);

interface ModuleOperationAdmission {
  readonly catalog?: InstalledModuleCatalog;
  readonly revision: string;
}
/** Reads the existing authority itself; callers never supply a supposedly trusted {R,catalog} pair. */
export const loadModuleOperationAdmission = Effect.fn('ModuleOperation.loadAdmission')(function* loadAdmission(
  authority: ActiveApplicationCompositionServiceContract,
  expectedDeployment: typeof OntosDeploymentIdentitySchema.Type,
  registration: ModuleOperationRegistration,
  principal: TrustedPrincipalContext,
  hostRegistration?: VerticalRuntimeRegistration,
): Effect.fn.Return<ModuleOperationAdmission, ModuleOperationRequirementError> {
  const snapshot = yield* authority.load.pipe(
    Effect.flatMap(validateActiveApplicationCompositionSnapshot),
    Effect.mapError(unavailable),
  );
  const genuineCore = isGenuineCoreOperation(registration);
  const host =
    genuineCore && hostRegistration !== undefined
      ? yield* Effect.try({ catch: unavailable, try: () => extractVerticalRuntimeSafeDescriptors(hostRegistration) })
      : undefined;
  const hostModuleId = host?.moduleId ?? registration.descriptor.entrypoint.moduleKey;
  const selected = snapshot.composition.modules.find(
    ({ deployment, moduleId }) =>
      moduleId === hostModuleId &&
      deployment.appId === expectedDeployment.appId &&
      deployment.buildMarker === expectedDeployment.buildMarker,
  );
  const shell = snapshot.composition.shell.deployment;
  const selectedCore =
    genuineCore &&
    host === undefined &&
    shell.appId === expectedDeployment.appId &&
    shell.buildMarker === expectedDeployment.buildMarker;
  const requestedRevision = readVerifiedGatewayCompositionRevision(principal);
  if (
    (selected === undefined && !selectedCore) ||
    (requestedRevision !== undefined && requestedRevision !== snapshot.composition.revision)
  ) {
    return yield* unavailable();
  }
  if (selectedCore) {
    return Object.freeze({ revision: snapshot.composition.revision });
  }
  const catalog = yield* buildApplicationCompositionCatalog(snapshot.composition).pipe(Effect.mapError(unavailable));
  if (genuineCore) {
    if (host === undefined) {
      return yield* unavailable();
    }
    yield* validateOwnerContractProjection(host, catalog);
    return Object.freeze({ revision: snapshot.composition.revision });
  }
  return Object.freeze({ catalog, revision: snapshot.composition.revision });
});

export const validateBoundOperationOwner = Effect.fn('ModuleOperation.validateBoundOwner')(function* validateBoundOwner(
  registration: ModuleOperationRegistration,
  catalog: InstalledModuleCatalog,
  ownerRegistration?: VerticalRuntimeRegistration,
) {
  const owner = yield* readBoundOperationOwner(registration, ownerRegistration);
  return owner === undefined ? yield* Effect.void : yield* validateOwnerContractProjection(owner, catalog);
});

export const operationIntrinsicDependencies = Effect.fn('ModuleOperation.intrinsicDependencies')(
  function* intrinsicDependencies(registration: ModuleOperationRegistration, catalog: InstalledModuleCatalog) {
    const { moduleKey } = registration.descriptor.entrypoint;
    const keys = yield* tenantModuleIntrinsicDependencyClosure(catalog, moduleKey).pipe(Effect.mapError(unavailable));
    return new Map([[moduleKey, keys]]);
  },
);

export const operationCatalogLoader = (
  authority: ActiveApplicationCompositionServiceContract | undefined,
  revision: string,
) =>
  authority === undefined
    ? Effect.fail(unavailable())
    : loadInstalledModuleCatalogForRevision(authority, revision).pipe(Effect.mapError(unavailable));

/** Unattested nested infrastructure cannot borrow an ancestor business operation. */
export const withoutModuleOperationExecution = <Value, Failure, Requirements>(
  effect: Effect.Effect<Value, Failure, Requirements>,
) => effect.pipe(Effect.updateService(ModuleOperationExecution, () => Option.none()));

interface OperationRuntimeBinding {
  readonly applicationComposition?: ActiveApplicationCompositionServiceContract | undefined;
  readonly expectedDeployment?: typeof OntosDeploymentIdentitySchema.Type | undefined;
  readonly ownerRegistration?: VerticalRuntimeRegistration | undefined;
}
interface OperationIntrinsicState {
  readonly earlyCompositionRevision?: string;
  readonly intrinsicDependencies: ReadonlyMap<string, readonly string[]>;
}
/** One intrinsic expansion before the existing state batch; unknown metadata never means empty. */
export const prepareOperationIntrinsicState = Effect.fn('ModuleOperation.prepareIntrinsicState')(
  function* prepareIntrinsicState(
    registration: ModuleOperationRegistration,
    principal: TrustedPrincipalContext,
    binding: OperationRuntimeBinding,
  ): Effect.fn.Return<OperationIntrinsicState, ModuleOperationRequirementError> {
    const empty = { intrinsicDependencies: new Map<string, readonly string[]>() };
    if (isGenuineCoreOperation(registration)) {
      return empty;
    }
    const owner = yield* readBoundOperationOwner(registration, binding.ownerRegistration);
    if (owner !== undefined && (owner.requirements?.intrinsic.length ?? 0) === 0) {
      return empty;
    }
    if (binding.applicationComposition === undefined || binding.expectedDeployment === undefined) {
      return yield* unavailable();
    }
    const admission = yield* loadModuleOperationAdmission(
      binding.applicationComposition,
      binding.expectedDeployment,
      registration,
      principal,
    );
    if (admission.catalog === undefined) {
      return yield* unavailable();
    }
    yield* validateBoundOperationOwner(registration, admission.catalog, binding.ownerRegistration);
    const intrinsicDependencies = yield* operationIntrinsicDependencies(registration, admission.catalog);
    return { earlyCompositionRevision: admission.revision, intrinsicDependencies };
  },
);
