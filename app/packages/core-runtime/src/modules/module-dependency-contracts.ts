import type { InstalledModuleCatalog } from './catalog.ts';
import type { TenantModuleStateUnsatisfiedDependencyError } from './tenant-module-state-unsatisfied-dependency-error.ts';
import { unsatisfiedTenantModuleDependency as unsatisfiedDependency } from './tenant-module-state-unsatisfied-dependency-error.ts';
import { Effect, Schema } from 'effect';

import { AccessKeySyntaxSchema, WorkloadKeySchema } from '../authorization/access-key-syntax.ts';
import { CoreOperationRouteSchema, RequirementCallerSchema } from '../sdk/index.ts';
import type { AnyDeclaredCall, DeclaredCalls } from '../sdk/index.ts';
import { ModuleEntrypointSchema } from './module-entrypoint.ts';
import type { OntosRegisteredWorkloadCall } from './registered-workload-calls.ts';

/** Required compatibility claim; providers advertise it only with executed closure enforcement. */
export const ONTOS_MODULE_DEPENDENCY_CONTRACT_CAPABILITY = Object.freeze({
  id: 'ontos.module-dependency-contracts',
  version: '1',
} as const);

export const OntosModuleIdSchema = Schema.String.check(
  Schema.isPattern(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*)+$/u),
).pipe(Schema.brand('OntosModuleId'), Schema.decodeTo(Schema.String));

const exactVersion = Schema.NonEmptyString;
export const OntosOperationKeySchema = Schema.NonEmptyString.pipe(
  Schema.brand('OntosOperationKey'),
  Schema.decodeTo(Schema.String),
);
const boundedIdentities = Schema.Array(OntosModuleIdSchema).check(Schema.isMinLength(1), Schema.isMaxLength(128));

/** An exact owner-authored operation version, independent of the deployment document format. */
export const OntosRequiredOperationContractSchema = Schema.Struct({
  entrypointKey: OntosModuleIdSchema,
  schemaVersion: exactVersion,
});

export const OntosIntrinsicModuleRequirementSchema = Schema.Struct({
  moduleId: OntosModuleIdSchema,
  requiredOperations: Schema.Array(OntosRequiredOperationContractSchema).check(Schema.isMaxLength(4096)),
});

export const OntosCoreCapabilityRequirementSchema = Schema.Struct({
  id: Schema.NonEmptyString,
  version: Schema.String.check(Schema.isPattern(/^[0-9]+(?:\.[0-9]+){0,2}$/u)),
});

/**
 * Conditions and evidence meanings are data owned by the consumer, never executable selectors.
 * `callers` are the caller identities a call to a vertical provider may carry (see
 * `RequirementCallerSchema` in `@app/core-runtime/sdk`): required and non-empty for a vertical
 * provider that a declared call uses, and absent for a Core provider (`core.*`), which Core runs
 * in-process with the execution's own principal.
 */
export const OntosOperationRequirementSchema = Schema.Struct({
  callers: Schema.optionalKey(Schema.Array(RequirementCallerSchema)),
  condition: OntosModuleIdSchema,
  entrypointKey: OntosModuleIdSchema,
  evidence: boundedIdentities,
  key: OntosModuleIdSchema,
  provider: Schema.Struct({
    entrypointKey: OntosModuleIdSchema,
    moduleId: OntosModuleIdSchema,
    schemaVersion: exactVersion,
  }),
});

export const OntosModuleRequirementsSchema = Schema.Struct({
  coreCapabilities: Schema.Array(OntosCoreCapabilityRequirementSchema).check(Schema.isMaxLength(128)),
  intrinsic: Schema.Array(OntosIntrinsicModuleRequirementSchema).check(Schema.isMaxLength(256)),
  operations: Schema.Array(OntosOperationRequirementSchema).check(Schema.isMaxLength(4096)),
  schemaVersion: Schema.Literal('1'),
});

/**
 * The registered workloads an operation admits (its `accessWorkload` workloads and its `accessActor`
 * `subjectWorkloads`) and the declaration they run under. Present only when the operation declares both. The calling
 * module's reviewed manifest is the only source of registered-workload rules; the Shell keeps a call only while the
 * installed receiver declares it, and this carrier is how a receiving operation declares it.
 */
export const OntosOperationWorkloadCarrierSchema = Schema.Struct({
  declarationKey: AccessKeySyntaxSchema,
  workloads: Schema.NonEmptyArray(WorkloadKeySchema).check(Schema.isUnique()),
});

/** Safe compatibility claim. The owner must separately prove its mounted receiving/runtime binding. */
export const OntosOperationContractSchema = Schema.Struct({
  apiKey: OntosModuleIdSchema,
  entrypoint: ModuleEntrypointSchema,
  operationKey: OntosOperationKeySchema,
  schemaVersion: exactVersion,
  workloadCarrier: Schema.optionalKey(OntosOperationWorkloadCarrierSchema),
});

export type OntosRequiredOperationContract = typeof OntosRequiredOperationContractSchema.Type;
export type OntosIntrinsicModuleRequirement = typeof OntosIntrinsicModuleRequirementSchema.Type;
export type OntosCoreCapabilityRequirement = typeof OntosCoreCapabilityRequirementSchema.Type;
export type OntosOperationRequirement = typeof OntosOperationRequirementSchema.Type;
export type OntosModuleRequirements = typeof OntosModuleRequirementsSchema.Type;
export type OntosOperationContract = typeof OntosOperationContractSchema.Type;

const unique = (values: readonly string[]): boolean => new Set(values).size === values.length;
const owns = (moduleId: string, key: string): boolean => key.startsWith(`${moduleId}.`);

/** A provider whose module id is a Core module: Core itself satisfies it, never the composition. */
export const isCoreOperationProvider = (provider: { readonly moduleId: string }): boolean =>
  provider.moduleId.startsWith('core.');

/**
 * Core runs a Core provider in-process with the execution's own principal, so its requirement names no
 * caller. A vertical provider's `callers`, when declared, list each caller kind at most once, so Core
 * always selects exactly one and never has to choose between two.
 */
const requirementCallersIssue = (requirement: OntosOperationRequirement): string | undefined => {
  const { callers } = requirement;
  if (callers === undefined) {
    return undefined;
  }
  if (isCoreOperationProvider(requirement.provider)) {
    return `operation requirement ${requirement.key} on a Core provider must not declare callers`;
  }
  if (callers.length === 0) {
    return `operation requirement ${requirement.key} must declare at least one caller or none at all`;
  }
  return unique(callers.map(({ kind }) => kind))
    ? undefined
    : `operation requirement ${requirement.key} declares a caller kind more than once`;
};

export const sameOperationProvider = (
  left: Readonly<OntosOperationRequirement['provider']>,
  right: Readonly<OntosOperationRequirement['provider']>,
): boolean =>
  left.moduleId === right.moduleId &&
  left.entrypointKey === right.entrypointKey &&
  left.schemaVersion === right.schemaVersion;

/** What the definition-time check of an operation's declared calls reads. */
interface DeclaredCallsCheck {
  readonly calls: DeclaredCalls;
  readonly consumerEntrypointKey: string;
  readonly consumerKind: 'action' | 'read' | 'worker';
  readonly registeredWorkloadCalls: readonly OntosRegisteredWorkloadCall[];
  readonly requirements: OntosModuleRequirements | undefined;
}

const requirementCallersIssues = (
  label: string,
  requirement: OntosOperationRequirement,
  registeredWorkloadCalls: readonly OntosRegisteredWorkloadCall[],
): readonly string[] => {
  if (isCoreOperationProvider(requirement.provider)) {
    return requirement.callers === undefined
      ? []
      : [`${label}: requirement ${requirement.key} names a Core provider and must declare no callers`];
  }
  const callers = requirement.callers ?? [];
  if (callers.length === 0) {
    return [`${label}: requirement ${requirement.key} must declare the callers a call to its provider may carry`];
  }
  return callers.flatMap((caller) =>
    caller.kind === 'person' ||
    registeredWorkloadCalls.some(
      (call) =>
        call.declarationKey === caller.declarationKey && call.entrypointKey === requirement.provider.entrypointKey,
    )
      ? []
      : [
          `${label}: ${caller.kind} caller ${caller.declarationKey} of requirement ${requirement.key} has no registeredWorkloadCalls entry for ${requirement.provider.entrypointKey}`,
        ],
  );
};

const writeCallIssues = (label: string, declared: AnyDeclaredCall, check: DeclaredCallsCheck): readonly string[] => {
  if (declared.operation.kind !== 'write') {
    return declared.recovery === undefined ? [] : [`${label}: only a write call names a recovery`];
  }
  const recovery =
    declared.recovery !== undefined && Object.hasOwn(check.calls, declared.recovery)
      ? check.calls[declared.recovery]
      : undefined;
  return [
    ...(check.consumerKind === 'read' ? [`${label}: a read declares only read calls`] : []),
    ...(recovery?.operation.kind === 'read'
      ? []
      : [`${label}: a write call names a read call of the same calls as its recovery`]),
  ];
};

const declaredCallIssues = (name: string, declared: AnyDeclaredCall, check: DeclaredCallsCheck): readonly string[] => {
  const label = `${check.consumerEntrypointKey} call ${name}`;
  const { operation } = declared;
  const issues = [...writeCallIssues(label, declared, check)];
  if (isCoreOperationProvider(operation.provider) !== Schema.is(CoreOperationRouteSchema)(operation.route)) {
    issues.push(`${label}: a Core provider is reached in-process and a vertical provider over its module route`);
  }
  const requirement = check.requirements?.operations.find(({ key }) => key === declared.requirementKey);
  if (requirement === undefined) {
    return [...issues, `${label}: requirement ${declared.requirementKey} is not declared by the module`];
  }
  if (requirement.entrypointKey !== check.consumerEntrypointKey) {
    issues.push(`${label}: requirement ${requirement.key} belongs to entrypoint ${requirement.entrypointKey}`);
  }
  if (!sameOperationProvider(requirement.provider, operation.provider)) {
    issues.push(`${label}: requirement ${requirement.key} names another provider than the called operation`);
  }
  return [...issues, ...requirementCallersIssues(label, requirement, check.registeredWorkloadCalls)];
};

/**
 * Every declared call names a requirement of the same module whose entrypoint is the declaring
 * operation's and whose provider is the reference's; a vertical provider's requirement lists its
 * callers, each registered or workload caller backed by a `registeredWorkloadCalls` entry for the
 * provider's entrypoint; a Core provider's lists none. A read declares only read calls, and a write
 * call's recovery names a read call of the same calls. Every issue, in declaration order.
 */
export const declaredCallsIssues = (check: DeclaredCallsCheck): readonly string[] =>
  Object.entries(check.calls).flatMap(([name, declared]) => declaredCallIssues(name, declared, check));

const requirementsIssue = (moduleId: string, requirements: OntosModuleRequirements): string | undefined => {
  if (
    !unique(requirements.intrinsic.map((requirement) => requirement.moduleId)) ||
    !unique(requirements.coreCapabilities.map((capability) => capability.id)) ||
    !unique(requirements.operations.map((requirement) => requirement.key))
  ) {
    return 'module requirements contain duplicate intrinsic, capability, or operation identities';
  }
  for (const intrinsic of requirements.intrinsic) {
    if (
      intrinsic.moduleId === moduleId ||
      !unique(intrinsic.requiredOperations.map((operation) => operation.entrypointKey)) ||
      intrinsic.requiredOperations.some((operation) => !owns(intrinsic.moduleId, operation.entrypointKey))
    ) {
      return 'intrinsic requirements must name distinct foreign modules and their exact owned operation contracts';
    }
  }
  const branches: string[] = [];
  for (const requirement of requirements.operations) {
    if (
      !owns(moduleId, requirement.key) ||
      !owns(moduleId, requirement.entrypointKey) ||
      !owns(moduleId, requirement.condition) ||
      !owns(requirement.provider.moduleId, requirement.provider.entrypointKey) ||
      !unique(requirement.evidence)
    ) {
      return 'operation requirements must preserve consumer/provider ownership and unique evidence meanings';
    }
    const callersIssue = requirementCallersIssue(requirement);
    if (callersIssue !== undefined) {
      return callersIssue;
    }
    branches.push(
      // These schema-validated dotted identifiers cannot contain the separator.
      `${requirement.entrypointKey}|${requirement.condition}|${requirement.provider.moduleId}|${requirement.provider.entrypointKey}`,
    );
  }
  return unique(branches)
    ? undefined
    : 'operation requirements contain duplicate or conflicting branch/provider claims';
};

/** Shared validation for authored projection and the exact serialized deployment contract. */
export const moduleDependencyDeclarationsIssue = (input: {
  readonly api: readonly { readonly key: string; readonly operationKeys: readonly string[] }[];
  readonly moduleId: string;
  readonly operationContracts: readonly OntosOperationContract[] | undefined;
  readonly requirements: OntosModuleRequirements | undefined;
}): string | undefined => {
  if (!unique(input.api.map((api) => api.key))) {
    return 'public API identities must remain unique after canonical normalization';
  }
  if (input.requirements !== undefined) {
    const issue = requirementsIssue(input.moduleId, input.requirements);
    if (issue !== undefined) {
      return issue;
    }
  }
  const claims = input.operationContracts ?? [];
  if (
    // The canonical API identity excludes this separator, including when an operation identifier contains it.
    !unique(claims.map((claim) => `${claim.apiKey}|${claim.operationKey}`)) ||
    !unique(claims.map((claim) => claim.entrypoint.entrypointKey))
  ) {
    return 'public operation contracts contain duplicate or conflicting operation bindings';
  }
  for (const claim of claims) {
    if (
      claim.entrypoint.moduleKey !== input.moduleId ||
      !owns(input.moduleId, claim.entrypoint.entrypointKey) ||
      claim.entrypoint.role === 'worker' ||
      claim.entrypoint.scope !== 'tenant' ||
      !input.api.some((api) => api.key === claim.apiKey && api.operationKeys.includes(claim.operationKey))
    ) {
      return 'public operation contracts must bind an actual declared API operation to its owning entrypoint';
    }
  }
  return undefined;
};

interface DerivedModuleIntrinsicRequirements {
  readonly dependencies: readonly string[];
  readonly requiredCoreCapabilities: readonly OntosCoreCapabilityRequirement[];
}

/** Derive installation requirements only from the observed owner declaration. */
export const deriveModuleIntrinsicRequirements = (
  requirements?: OntosModuleRequirements,
): DerivedModuleIntrinsicRequirements => ({
  dependencies: (requirements?.intrinsic ?? []).map(({ moduleId }) => moduleId).toSorted(),
  requiredCoreCapabilities: (requirements?.coreCapabilities ?? [])
    .map(({ id, version }) => ({ id, version }))
    .toSorted((left, right) => left.id.localeCompare(right.id)),
});

/** Exact public operation versions are independent from deployment format and build identity. */
export const providesRequiredOperationContracts = (
  provided: readonly OntosOperationContract[] | undefined,
  required: readonly OntosRequiredOperationContract[],
): boolean =>
  required.every(
    (operation) =>
      provided?.some(
        ({ entrypoint, schemaVersion }) =>
          entrypoint.entrypointKey === operation.entrypointKey && schemaVersion === operation.schemaVersion,
      ) === true,
  );

/** Resolve only intrinsic declarations; conditional operation relationships never enter this closure. */
export const tenantModuleIntrinsicDependencyClosure = Effect.fn('TenantModuleState.intrinsicDependencyClosure')(
  function* intrinsicDependencyClosure(catalog: InstalledModuleCatalog, moduleKey: string) {
    const required = new Set<string>();
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = Effect.fnUntraced(function* visitIntrinsicDependency(
      key: string,
    ): Effect.fn.Return<void, TenantModuleStateUnsatisfiedDependencyError> {
      if (visiting.has(key)) {
        return yield* unsatisfiedDependency();
      }
      if (visited.has(key)) {
        return yield* Effect.void;
      }
      const contract = catalog.getByModuleId(key);
      if (contract === undefined) {
        return yield* unsatisfiedDependency();
      }
      visiting.add(key);
      yield* Effect.forEach(
        contract.manifest.requirements?.intrinsic ?? [],
        Effect.fnUntraced(function* visitRequirement(requirement) {
          const provider = catalog.getByModuleId(requirement.moduleId);
          if (
            provider === undefined ||
            !providesRequiredOperationContracts(
              provider.manifest.publicSurface.operationContracts,
              requirement.requiredOperations,
            )
          ) {
            return yield* unsatisfiedDependency();
          }
          required.add(requirement.moduleId);
          yield* visit(requirement.moduleId);
          return yield* Effect.void;
        }),
        { concurrency: 1, discard: true },
      );
      visiting.delete(key);
      visited.add(key);
      return yield* Effect.void;
    });
    yield* visit(moduleKey);
    return [...required].toSorted();
  },
);

/**
 * The modules activating `moduleKey` installs with it: its manifest's `activation.installsWith`, and theirs in turn,
 * never the module itself. Each must be published and able to be active; otherwise the activation is refused.
 */
export const tenantModuleInstallsWithClosure = Effect.fn('TenantModuleState.installsWithClosure')(
  function* installsWithClosure(catalog: InstalledModuleCatalog, moduleKey: string) {
    const found = new Set<string>();
    const pending = [moduleKey];
    for (let key = pending.shift(); key !== undefined; key = pending.shift()) {
      const contract = catalog.getByModuleId(key);
      if (contract === undefined) {
        return yield* unsatisfiedDependency();
      }
      for (const companion of contract.manifest.activation.installsWith ?? []) {
        if (companion !== moduleKey && !found.has(companion)) {
          if (catalog.getByModuleId(companion)?.manifest.activation.supportedStates.includes('active') !== true) {
            return yield* unsatisfiedDependency();
          }
          found.add(companion);
          pending.push(companion);
        }
      }
    }
    return [...found].toSorted();
  },
);
