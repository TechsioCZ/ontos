import { OntosRegisteredWorkloadCallSchema } from '@app/core-runtime';
import type { ModuleEntrypointAccess } from '@app/core-runtime/module-entrypoint';
import type { FiniteGatewayOperationTarget } from '@app/core-runtime/auth/system-principal-context-provenance';
import type { ShellInstalledCatalog } from '../modules/installed-module-catalog.ts';
import { GatewayAudienceSchema } from '@app/shared-contracts';
import { Config, Effect, Option, Schema } from 'effect';

import { ShellInstalledModuleCatalog } from '../modules/installed-module-catalog.ts';
import { delegationForbidden, delegationUnavailable } from './gateway-delegation-errors.ts';
import { withRegisteredWorkloadCalls } from './gateway-registered-workload-calls.ts';

const nonEmpty = Schema.String.check(Schema.isMinLength(1));

/**
 * One deployment credential per calling module: its provider key id and the app, build and release it attests.
 * `sourceAppId` is any topology app; the installed catalog check at issuance decides whether that app is actually part
 * of the admitted composition. The credential carries identity only.
 */
export const GatewayModuleCredentialBindingSchema = Schema.Struct({
  compositionRevision: Schema.String.check(Schema.isPattern(/^[\da-f]{64}$/u)),
  providerKeyId: nonEmpty.pipe(Schema.brand('GatewayModuleCredentialId')),
  sourceAppId: GatewayAudienceSchema,
  sourceBuildMarker: nonEmpty,
});
export type GatewayModuleCredentialBinding = typeof GatewayModuleCredentialBindingSchema.Type;

/**
 * A credential's binding with the registered-workload calls its installed module's reviewed manifest declares and
 * its receivers still take (`withRegisteredWorkloadCalls`).
 */
export const GatewayModuleBindingSchema = Schema.Struct({
  compositionRevision: Schema.String.check(Schema.isPattern(/^[\da-f]{64}$/u)),
  providerKeyId: nonEmpty.pipe(Schema.brand('GatewayModuleCredentialId')),
  registeredWorkloads: Schema.optionalKey(Schema.Array(OntosRegisteredWorkloadCallSchema)),
  sourceAppId: GatewayAudienceSchema,
  sourceBuildMarker: nonEmpty,
});
export type GatewayModuleBinding = typeof GatewayModuleBindingSchema.Type;

const oneBindingPerCredential = Schema.makeFilter((bindings: readonly { readonly providerKeyId: string }[]) =>
  new Set(bindings.map((binding) => binding.providerKeyId)).size === bindings.length
    ? undefined
    : 'Module credentials must have one deployment binding',
);
const credentialBindingsSchema = Schema.Array(GatewayModuleCredentialBindingSchema).check(oneBindingPerCredential);
const bindingsSchema = Schema.Array(GatewayModuleBindingSchema).check(oneBindingPerCredential);
export class GatewayDelegationPolicyUnavailable extends Schema.TaggedError<GatewayDelegationPolicyUnavailable>()(
  'GatewayDelegationPolicyUnavailable',
  { cause: Schema.Defect() },
) {}

/**
 * Issuer-owned deployment credential enrollment; request headers cannot supply this mapping. The variable is
 * required: an absent or malformed value fails the load, so no module key can be served as a subject's key.
 * A deployment with no module enrolled sets it to `[]`. It carries identity only; a `registeredWorkloads` key in it
 * is ignored.
 */
export const loadGatewayModuleCredentialBindings = Config.schema(
  Schema.fromJsonString(credentialBindingsSchema),
  'ONTOS_GATEWAY_MODULE_BINDINGS',
).pipe(Effect.mapError((cause) => new GatewayDelegationPolicyUnavailable({ cause })));

/**
 * The enrolled credentials with their registered-workload calls. A binding's calls come only from the installed
 * contract of exactly its app, build and release, so an unreadable release fails the load; it is never "no calls".
 */
export const loadGatewayModuleBindings = Effect.gen(function* loadManifestSourcedGatewayModuleBindings() {
  const credentials = yield* loadGatewayModuleCredentialBindings;
  const installed = yield* (yield* ShellInstalledModuleCatalog).load;
  return yield* Schema.decodeUnknownEffect(bindingsSchema)(
    credentials.map((credential) => withRegisteredWorkloadCalls(credential, installed)),
  ).pipe(Effect.mapError((cause) => new GatewayDelegationPolicyUnavailable({ cause })));
});

/** Whether the verified credential is a module deployment credential, which may never issue a subject's context. */
export const isGatewayModuleCredential = (
  bindings: readonly Pick<GatewayModuleCredentialBinding, 'providerKeyId'>[],
  providerKeyId: string,
): boolean => bindings.some((binding) => binding.providerKeyId === providerKeyId);

/**
 * Refuses a verified key that is a module deployment credential, which may only issue through the delegated
 * endpoint. An unreadable enrolment fails as unavailable; it is never read as "no module key".
 */
export const admitIntegrationCredential = Effect.fn('GatewayDelegationPolicy.admitIntegrationCredential')(
  function* admitIntegrationCredential(providerKeyId: string) {
    const bindings = yield* loadGatewayModuleCredentialBindings.pipe(Effect.mapError(delegationUnavailable));
    if (isGatewayModuleCredential(bindings, providerKeyId)) {
      return yield* delegationForbidden();
    }
    return yield* Effect.void;
  },
);

/** The module binding attests exactly the source token's app, build and release, and the request names the same release. */
export const bindingAttestsSource = (
  binding: GatewayModuleBinding,
  source: { readonly aud: string; readonly compositionRevision: string; readonly targetBuildMarker: string },
  requestedCompositionRevision: string,
): boolean =>
  binding.sourceAppId === source.aud &&
  binding.sourceBuildMarker === source.targetBuildMarker &&
  binding.compositionRevision === source.compositionRevision &&
  requestedCompositionRevision === source.compositionRevision;

export type GatewayRegisteredWorkloadRule = NonNullable<GatewayModuleBinding['registeredWorkloads']>[number];
type InstalledContract = ShellInstalledCatalog['contracts'][number];

/** Lifecycle authority comes from the exact advertised operation, never from a caller's mode. */
export const gatewayPublishedOperationAccess = (
  contract: InstalledContract,
  entrypointKey: string,
  schemaVersion: string,
): ModuleEntrypointAccess | undefined => {
  const action = contract.manifest.publicSurface.actions.find(
    (candidate) => candidate.entrypoint.entrypointKey === entrypointKey && candidate.schemaVersion === schemaVersion,
  );
  const operation = contract.manifest.publicSurface.operationContracts?.find(
    (candidate) => candidate.entrypoint.entrypointKey === entrypointKey && candidate.schemaVersion === schemaVersion,
  );
  if (action !== undefined && operation !== undefined && action.entrypoint.access !== operation.entrypoint.access) {
    return undefined;
  }
  return action?.entrypoint.access ?? operation?.entrypoint.access;
};

/** Select one deployed version for an already approved finite capability. */
export const resolvePublishedFiniteGatewayTarget = (
  destination: InstalledContract,
  approved: FiniteGatewayOperationTarget,
) => {
  if (destination.deployment.appId !== approved.appId || destination.manifest.module.id !== approved.moduleId) {
    return Option.none();
  }
  const { actions, operationContracts } = destination.manifest.publicSurface;
  const versions = new Set<string>();
  for (const operation of [...actions, ...(operationContracts ?? [])]) {
    if (operation.entrypoint.entrypointKey === approved.entrypointKey) {
      versions.add(operation.schemaVersion);
    }
  }
  const [schemaVersion] = versions;
  if (
    versions.size !== 1 ||
    schemaVersion === undefined ||
    gatewayPublishedOperationAccess(destination, approved.entrypointKey, schemaVersion) !== approved.access
  ) {
    return Option.none();
  }
  return Option.some(Object.freeze({ ...approved, schemaVersion }));
};

/** Derived only from the authenticated incoming operation and its one requested branch declaration. */
export interface GatewayConditionalOperationWitness {
  readonly requirementKey: string;
  readonly sourceEntrypointKey: string;
  readonly sourceSchemaVersion: string;
}

type ConditionalConsumer = Pick<GatewayConditionalOperationWitness, 'requirementKey' | 'sourceEntrypointKey'>;
const conditionalProviderAllows = (
  source: InstalledContract,
  destination: InstalledContract,
  rule: GatewayRegisteredWorkloadRule,
  witness: ConditionalConsumer,
): boolean => {
  const requirements =
    source.manifest.requirements?.operations.filter((requirement) => requirement.key === witness.requirementKey) ?? [];
  const [requirement] = requirements;
  return (
    requirements.length === 1 &&
    requirement !== undefined &&
    requirement.entrypointKey === witness.sourceEntrypointKey &&
    requirement.provider.moduleId === destination.manifest.module.id &&
    requirement.provider.entrypointKey === rule.entrypointKey &&
    requirement.provider.schemaVersion === rule.schemaVersion
  );
};
const conditionalOperationAllows = (
  source: InstalledContract,
  destination: InstalledContract,
  rule: GatewayRegisteredWorkloadRule,
  witness: GatewayConditionalOperationWitness,
): boolean =>
  gatewayPublishedOperationAccess(source, witness.sourceEntrypointKey, witness.sourceSchemaVersion) !== undefined &&
  conditionalProviderAllows(source, destination, rule, witness);

const receivingOperationContractAllows = (
  destination: InstalledContract,
  rule: GatewayRegisteredWorkloadRule,
  legalEntityId: string | undefined,
): boolean => {
  const target = destination.manifest.publicSurface.actions.find(
    (action) => action.entrypoint.entrypointKey === rule.entrypointKey && action.schemaVersion === rule.schemaVersion,
  );
  const read = destination.manifest.publicSurface.operationContracts?.find(
    (operation) =>
      operation.entrypoint.entrypointKey === rule.entrypointKey && operation.schemaVersion === rule.schemaVersion,
  );
  const receivingActionAllows =
    target === undefined ||
    (target.accessDeclaration?.key === rule.declarationKey &&
      target.legalEntityScope === rule.legalEntityScope &&
      target.accessWorkload?.workloads.some((key) => key === rule.workloadKey) === true);
  const scopeAllows =
    rule.legalEntityScope === 'optional' ||
    (rule.legalEntityScope === 'forbidden' ? legalEntityId === undefined : legalEntityId !== undefined);
  return (target !== undefined || read !== undefined) && receivingActionAllows && scopeAllows;
};

/** One exact intrinsic or authenticated conditional requirement must match the receiver's public operation. */
export const gatewayRegisteredOperationContractAllows = (
  source: InstalledContract,
  destination: InstalledContract,
  rule: GatewayRegisteredWorkloadRule,
  legalEntityId: string | undefined,
  conditionalWitness?: GatewayConditionalOperationWitness,
): boolean => {
  const intrinsic = source.manifest.requirements?.intrinsic.some(
    (requirement) =>
      requirement.moduleId === destination.manifest.module.id &&
      requirement.requiredOperations.some(
        (operation) => operation.entrypointKey === rule.entrypointKey && operation.schemaVersion === rule.schemaVersion,
      ),
  );
  const sourceAllows =
    conditionalWitness === undefined
      ? intrinsic === true
      : conditionalOperationAllows(source, destination, rule, conditionalWitness);
  return sourceAllows && receivingOperationContractAllows(destination, rule, legalEntityId);
};

/** Native delivery facts identify a registered worker; workers do not advertise a schema version. */
export interface GatewayConditionalWorkerWitness {
  readonly consumerModuleKey: string;
  readonly producerModuleKey: string;
  readonly requirementKey: string;
  readonly topic: string;
  readonly workerKey: string;
}
export const gatewayRegisteredWorkerOperationContractAllows = (
  source: InstalledContract,
  destination: InstalledContract,
  rule: GatewayRegisteredWorkloadRule,
  legalEntityId: string | undefined,
  witness: GatewayConditionalWorkerWitness,
): boolean => {
  if (
    rule.workerKey !== witness.workerKey ||
    rule.sourceActionKey !== undefined ||
    rule.sourceWorkloadKey !== undefined
  ) {
    return false;
  }
  const subscriptions = source.runtime.outboxSubscriptions.filter(
    (subscription) =>
      subscription.workerKey === witness.workerKey &&
      subscription.consumerModuleKey === witness.consumerModuleKey &&
      subscription.producerModuleKey === witness.producerModuleKey &&
      subscription.topic === witness.topic &&
      subscription.consumerModuleKey === source.manifest.module.id &&
      subscription.entrypoint.entrypointKey === subscription.workerKey &&
      subscription.entrypoint.moduleKey === subscription.consumerModuleKey,
  );
  const [subscription] = subscriptions;
  return (
    subscriptions.length === 1 &&
    subscription !== undefined &&
    conditionalProviderAllows(source, destination, rule, {
      requirementKey: witness.requirementKey,
      sourceEntrypointKey: subscription.entrypoint.entrypointKey,
    }) &&
    receivingOperationContractAllows(destination, rule, legalEntityId)
  );
};

/** The ledger records the Action key; this witness checks its current public contract, not a historical version. */
export interface GatewayConditionalAdmissionWitness {
  readonly admissionActionKey: string;
  readonly requirementKey: string;
}
export const gatewayRegisteredAdmissionOperationContractAllows = (
  source: InstalledContract,
  destination: InstalledContract,
  rule: GatewayRegisteredWorkloadRule,
  legalEntityId: string | undefined,
  witness: GatewayConditionalAdmissionWitness,
): boolean => {
  if (
    rule.sourceActionKey !== witness.admissionActionKey ||
    rule.workerKey !== undefined ||
    rule.sourceWorkloadKey !== undefined
  ) {
    return false;
  }
  const actions = source.manifest.publicSurface.actions.filter(
    (action) => action.actionKey === witness.admissionActionKey,
  );
  const [action] = actions;
  return (
    actions.length === 1 &&
    action !== undefined &&
    conditionalProviderAllows(source, destination, rule, {
      requirementKey: witness.requirementKey,
      sourceEntrypointKey: action.entrypoint.entrypointKey,
    }) &&
    receivingOperationContractAllows(destination, rule, legalEntityId)
  );
};
