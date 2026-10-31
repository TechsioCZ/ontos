import { Schema } from 'effect';

import { ModuleEntrypointSchema } from './module-entrypoint.ts';

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

/** Conditions and evidence meanings are data owned by the consumer, never executable selectors. */
export const OntosOperationRequirementSchema = Schema.Struct({
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

/** Safe compatibility claim. The owner must separately prove its mounted receiving/runtime binding. */
export const OntosOperationContractSchema = Schema.Struct({
  apiKey: OntosModuleIdSchema,
  entrypoint: ModuleEntrypointSchema,
  operationKey: OntosOperationKeySchema,
  schemaVersion: exactVersion,
});

export type OntosRequiredOperationContract = typeof OntosRequiredOperationContractSchema.Type;
export type OntosIntrinsicModuleRequirement = typeof OntosIntrinsicModuleRequirementSchema.Type;
export type OntosCoreCapabilityRequirement = typeof OntosCoreCapabilityRequirementSchema.Type;
export type OntosOperationRequirement = typeof OntosOperationRequirementSchema.Type;
export type OntosModuleRequirements = typeof OntosModuleRequirementsSchema.Type;
export type OntosOperationContract = typeof OntosOperationContractSchema.Type;

const unique = (values: readonly string[]): boolean => new Set(values).size === values.length;
const owns = (moduleId: string, key: string): boolean => key.startsWith(`${moduleId}.`);

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
