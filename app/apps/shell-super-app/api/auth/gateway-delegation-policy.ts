import type { ModuleEntrypointAccess } from '@app/core-runtime/module-entrypoint';
import { RegisteredGatewayWorkloadSchema } from '@app/core-runtime/auth/system-principal-context-provenance';
import type { FiniteGatewayOperationTarget } from '@app/core-runtime/auth/system-principal-context-provenance';
import type { ShellInstalledCatalog } from '../modules/installed-module-catalog.ts';
import type { ModuleCredentialEnrolment } from '@app/core-runtime/auth/module-credentials';
import { GatewayAudienceSchema } from '@app/shared-contracts';
import { Effect, Option, Schema } from 'effect';

import { ShellInstalledModuleCatalog } from '../modules/installed-module-catalog.ts';
import { delegationForbidden, delegationUnavailable } from './gateway-delegation-errors.ts';
import { GatewayDelegationPolicyUnavailable } from './gateway-delegation-policy-unavailable.ts';
import { ModuleCredentialEnrolmentSource } from './module-credential-enrolment.service.ts';
import type { AttestedModuleCredential } from './module-credential-enrolment.service.ts';

export { GatewayDelegationPolicyUnavailable } from './gateway-delegation-policy-unavailable.ts';
export {
  ModuleCredentialEnrolmentSource,
  ModuleCredentialEnrolmentSourceLive,
} from './module-credential-enrolment.service.ts';

const nonEmpty = Schema.String.check(Schema.isMinLength(1));
const sourceActionKeySchema = nonEmpty.pipe(Schema.brand('GatewaySourceActionKey'), Schema.decodeTo(Schema.String));
const workerKeySchema = nonEmpty.pipe(Schema.brand('GatewayWorkerKey'), Schema.decodeTo(Schema.String));
const workloadFields = RegisteredGatewayWorkloadSchema.fields;

/**
 * One module credential's binding: the key's provider id, the module it belongs to, and the build and release that
 * module runs. The platform derives it from its own enrolment and the installed release; nothing configures it.
 */
export const GatewayModuleBindingSchema = Schema.Struct({
  compositionRevision: Schema.String.check(Schema.isPattern(/^[\da-f]{64}$/u)),
  providerKeyId: nonEmpty.pipe(Schema.brand('GatewayModuleCredentialId')),
  registeredWorkloads: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        allowHistoricalDeliveryRecovery: Schema.optionalKey(Schema.Boolean),
        allowRecoverySource: Schema.optionalKey(Schema.Boolean),
        audience: GatewayAudienceSchema,
        declarationKey: workloadFields.declarationKey,
        entrypointKey: workloadFields.entrypointKey,
        jobKey: workloadFields.jobKey.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/u)),
        legalEntityScope: Schema.Literals(['forbidden', 'optional', 'required']),
        recoveryOf: Schema.optionalKey(
          Schema.Struct({
            actionKey: sourceActionKeySchema,
            jobKey: workloadFields.jobKey,
          }),
        ),
        schemaVersion: nonEmpty,
        sourceActionKey: Schema.optionalKey(sourceActionKeySchema),
        sourceWorkloadKey: Schema.optionalKey(workloadFields.workloadKey),
        workerKey: Schema.optionalKey(workerKeySchema),
        workloadKey: workloadFields.workloadKey,
      }),
    ),
  ),
  sourceAppId: GatewayAudienceSchema,
  sourceBuildMarker: nonEmpty,
});
export type GatewayModuleBinding = typeof GatewayModuleBindingSchema.Type;

const bindingsSchema = Schema.Array(GatewayModuleBindingSchema).check(
  Schema.makeFilter((bindings) =>
    new Set(bindings.map((binding) => binding.providerKeyId)).size === bindings.length
      ? undefined
      : 'Module credentials must have one deployment binding',
  ),
);

/**
 * The bindings of the installed release. A credential binds only what its issuing host attested with the key: its
 * module, that module's build marker and the composition revision of the issuing host's release. It binds while the
 * installed release has exactly that build of that module at exactly that revision, and nothing otherwise, so during a
 * deploy overlap only the keys issued for the release that holds the authority bind; an older or newer host's keys,
 * a key without an attestation and a key of a module this release does not install all bind nothing.
 */
export const deriveGatewayModuleBindings = (
  enrolment: readonly Pick<AttestedModuleCredential, 'appId' | 'attestation' | 'providerKeyId'>[],
  installed: {
    readonly composition: { readonly revision: string };
    readonly contracts: readonly { readonly deployment: { readonly appId: string; readonly buildMarker: string } }[];
  },
) =>
  Schema.decodeUnknownEffect(bindingsSchema)(
    enrolment.flatMap((credential) => {
      if (Option.isNone(credential.attestation)) {
        return [];
      }
      const attested = credential.attestation.value;
      const contract = installed.contracts.find((candidate) => candidate.deployment.appId === credential.appId);
      return contract === undefined ||
        attested.appId !== credential.appId ||
        attested.buildMarker !== contract.deployment.buildMarker ||
        attested.compositionRevision !== installed.composition.revision
        ? []
        : [
            {
              compositionRevision: attested.compositionRevision,
              providerKeyId: credential.providerKeyId,
              sourceAppId: credential.appId,
              sourceBuildMarker: attested.buildMarker,
            },
          ];
    }),
  ).pipe(Effect.mapError((cause) => new GatewayDelegationPolicyUnavailable({ cause })));

/**
 * The bindings for this request, derived from the platform's attested enrolment and the installed release, so they
 * always name the release that is live now. An unreadable enrolment or release fails the load; it is never "none".
 */
export const loadGatewayModuleBindings = Effect.gen(function* loadDerivedGatewayModuleBindings() {
  const enrolment = yield* (yield* ModuleCredentialEnrolmentSource).loadAttested;
  // An unreadable release keeps its own failure, so a refusal names which of the two it could not read.
  const installed = yield* (yield* ShellInstalledModuleCatalog).load;
  return yield* deriveGatewayModuleBindings(enrolment, installed);
});

/** Whether the verified credential is a module credential, which may never issue a subject's context. */
export const isGatewayModuleCredential = (
  enrolment: readonly Pick<ModuleCredentialEnrolment, 'providerKeyId'>[],
  providerKeyId: string,
): boolean => enrolment.some((credential) => credential.providerKeyId === providerKeyId);

/**
 * Refuses a verified key that is any enrolled module credential, installed module or not: it may only issue through
 * the delegated endpoint. An unreadable enrolment fails as unavailable; it is never read as "no module key". Every
 * API-key entry point other than the delegated endpoint admits its verified key through this check.
 */
export const admitIntegrationCredentialFrom = (source: typeof ModuleCredentialEnrolmentSource.Service) =>
  Effect.fn('GatewayDelegationPolicy.admitIntegrationCredential')(function* admitIntegrationCredential(
    providerKeyId: string,
  ) {
    const enrolment = yield* source.load.pipe(Effect.mapError(delegationUnavailable('module_enrolment_unavailable')));
    if (isGatewayModuleCredential(enrolment, providerKeyId)) {
      return yield* delegationForbidden('module_credential_not_admitted')();
    }
    return yield* Effect.void;
  });

/** The same check against the enrolment source of the current context. */
export const admitIntegrationCredential = Effect.fn('GatewayDelegationPolicy.admitIntegrationCredentialInContext')(
  function* admitIntegrationCredentialInContext(providerKeyId: string) {
    return yield* admitIntegrationCredentialFrom(yield* ModuleCredentialEnrolmentSource)(providerKeyId);
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
