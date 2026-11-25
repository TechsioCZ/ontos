import { TrustedPrincipalContextSchema } from '@app/core-runtime/actions/principal-context';
import type { TrustedPrincipalContext } from '@app/core-runtime/actions/principal-context';
import { SymmyGatewayRouteScopeSchema } from '@app/shared-contracts';
import type { GatewayActorClaim, SymmyGatewayRouteScope } from '@app/shared-contracts';
import { Crypto, Effect, Schema } from 'effect';

import type { ShellInstalledCatalog } from '../modules/installed-module-catalog.ts';
import { readVerifiedGatewayAssertion } from './gateway-assertion-evidence.ts';
import type { VerifiedGatewayAssertion } from './gateway-assertion-evidence.ts';
import { delegationForbidden, delegationUnavailable } from './gateway-delegation-errors.ts';
import {
  gatewayPublishedOperationAccess,
  gatewayRegisteredOperationContractAllows,
} from './gateway-delegation-policy.ts';
import type { GatewayModuleBinding } from './gateway-delegation-policy.ts';
import { selectOnwardNativeReadReceiver } from './gateway-native-route-read-receiver.ts';
import {
  acquireSymmyRouteScopeProof,
  readSymmyRouteScope,
  selectSymmyIntakePrivacyReceiver,
} from './gateway-symmy-route-scope.ts';

const intakeRequirement = 'integration.symmy.requirement.customer-intake-privacy';
const intakeAction = 'integration.symmy.admit-symmy-job';
const privacyRead = 'privacy.core.api.source-processing-eligibility';
const privacyModule = 'privacy.core';
const privacyWorkload = 'privacy.core.source-processing-check';
const symmyAudience = 'symmy-integration';

interface NativeReadAdmissionInput {
  readonly actor: GatewayActorClaim;
  readonly audience: string;
  readonly binding: GatewayModuleBinding;
  readonly installed: ShellInstalledCatalog;
  readonly operationRequirementKey: string;
  readonly requestCorrelation: string;
  readonly requestHash: string;
  readonly source: VerifiedGatewayAssertion;
}
type VerifiedNativeReadSource = NonNullable<ReturnType<typeof readVerifiedGatewayAssertion>>;
type NativeReadRouteScope = NonNullable<VerifiedNativeReadSource['routeScope']>;
type NativeReadReceiver = NonNullable<NativeReadRouteScope['nativeReadReceiver']>;
type InstalledContract = ShellInstalledCatalog['contracts'][number];

interface NativeRouteReadEvidence {
  readonly actor: GatewayActorClaim;
  readonly audience: string;
  readonly compositionRevision: string;
  readonly moduleAccess: readonly { readonly access: 'read' | 'write'; readonly moduleKey: string }[];
  readonly principal: TrustedPrincipalContext;
  readonly routeScope: SymmyGatewayRouteScope;
  readonly sourceKey: string;
  readonly sourceValidity: { readonly expiresAt: number; readonly issuedAt: number };
}
const mintKey = Object.freeze({ kind: 'admitted_native_route_read' });
class AdmittedNativeRouteReadValue {
  readonly #evidence: NativeRouteReadEvidence | undefined;
  #consumed = false;
  constructor(key: typeof mintKey, evidence: NativeRouteReadEvidence) {
    this.#evidence =
      key === mintKey && evidence.routeScope.nativeReadReceiver !== undefined
        ? Object.freeze({
            ...evidence,
            actor: Object.freeze({ ...evidence.actor }),
            moduleAccess: Object.freeze(evidence.moduleAccess.map((item) => Object.freeze({ ...item }))),
            principal: Object.freeze({ ...evidence.principal }),
            routeScope: Object.freeze({
              ...evidence.routeScope,
              nativeReadReceiver: Object.freeze({ ...evidence.routeScope.nativeReadReceiver }),
              operations: Object.freeze(
                evidence.routeScope.operations.map((operation) => Object.freeze({ ...operation })),
              ),
            }),
            sourceValidity: Object.freeze({ ...evidence.sourceValidity }),
          })
        : undefined;
    Object.freeze(this);
  }
  static read(witness: AdmittedNativeRouteReadValue): NativeRouteReadEvidence | undefined {
    return #evidence in witness ? witness.#evidence : undefined;
  }
  static take(witness: AdmittedNativeRouteReadValue): NativeRouteReadEvidence | undefined {
    if (!(#evidence in witness) || witness.#consumed) {
      return undefined;
    }
    witness.#consumed = true;
    return witness.#evidence;
  }
}
export type AdmittedNativeRouteRead = AdmittedNativeRouteReadValue;
const witnessSchema = Schema.instanceOf(AdmittedNativeRouteReadValue);
export const readAdmittedNativeRouteRead = (witness: AdmittedNativeRouteRead): NativeRouteReadEvidence | undefined =>
  Schema.is(witnessSchema)(witness) ? AdmittedNativeRouteReadValue.read(witness) : undefined;
export const takeAdmittedNativeRouteRead = (witness: AdmittedNativeRouteRead): NativeRouteReadEvidence | undefined =>
  Schema.is(witnessSchema)(witness) ? AdmittedNativeRouteReadValue.take(witness) : undefined;

const nativeRouteIdentityMatches = (
  source: VerifiedNativeReadSource,
  signedRoute: NativeReadRouteScope,
  native: NativeReadReceiver,
): boolean =>
  source.workload === undefined &&
  source.principal.authMethod === 'system' &&
  source.principal.legalEntityId === undefined &&
  ['adminCustomers', 'customersBatch', 'customerGroupCustomersBatch'].includes(signedRoute.routeKey) &&
  signedRoute.legalEntityId !== undefined &&
  native.enrollmentLegalEntityId === signedRoute.legalEntityId &&
  signedRoute.principalId === source.principal.principalId &&
  signedRoute.tenantId === source.principal.tenantId;

const nativeCallingReleaseMatches = (
  input: NativeReadAdmissionInput,
  source: VerifiedNativeReadSource,
  native: NativeReadReceiver,
  consumer: InstalledContract,
  priorActorContract: InstalledContract | undefined,
): boolean =>
  input.actor.appId === input.binding.sourceAppId &&
  input.actor.buildMarker === input.binding.sourceBuildMarker &&
  input.actor.principalId !== source.principal.principalId &&
  input.actor.principalId !== native.originalPrincipalId &&
  source.sourceAppId === input.binding.sourceAppId &&
  source.providerKeyId === input.binding.providerKeyId &&
  source.sourceBuildMarker === input.binding.sourceBuildMarker &&
  source.compositionRevision === input.binding.compositionRevision &&
  source.compositionRevision === input.installed.composition.revision &&
  consumer.deployment.buildMarker === input.binding.sourceBuildMarker &&
  (source.sourceActor === undefined || priorActorContract?.deployment.buildMarker === source.sourceActor.buildMarker);

const requireOnwardReadEligibility = Effect.fn('GatewayDelegation.requireOnwardReadEligibility')(function* eligibility(
  input: NativeReadAdmissionInput,
  source: VerifiedNativeReadSource,
  signedRoute: NativeReadRouteScope,
  native: NativeReadReceiver,
) {
  const consumer = input.installed.contracts.find(
    (contract) => contract.deployment.appId === input.binding.sourceAppId,
  );
  const destination = input.installed.contracts.find((contract) => contract.deployment.appId === input.audience);
  const requirements =
    consumer?.manifest.requirements?.operations.filter(
      (requirement) => requirement.key === input.operationRequirementKey,
    ) ?? [];
  const [requirement] = requirements;
  const sourceOperations = signedRoute.operations.filter(
    (operation) =>
      operation.entrypointKey === requirement?.entrypointKey &&
      consumer !== undefined &&
      gatewayPublishedOperationAccess(consumer, operation.entrypointKey, operation.schemaVersion) === 'read',
  );
  const [sourceOperation] = sourceOperations;
  // Native route reads carry current binding evidence, never signed V4 recovery/delivery authority.
  const rules = (input.binding.registeredWorkloads ?? []).filter(
    (rule) =>
      requirement !== undefined &&
      destination !== undefined &&
      rule.audience === input.audience &&
      rule.entrypointKey === requirement.provider.entrypointKey &&
      rule.schemaVersion === requirement.provider.schemaVersion &&
      rule.sourceWorkloadKey === native.workloadKey &&
      rule.jobKey === 'integration.symmy.execute-symmy-job' &&
      rule.sourceActionKey === undefined &&
      rule.workerKey === undefined &&
      rule.recoveryOf === undefined &&
      rule.allowRecoverySource !== true &&
      rule.allowHistoricalDeliveryRecovery !== true,
  );
  const [rule] = rules;
  const priorActor = source.sourceActor;
  const priorActorContract =
    priorActor === undefined
      ? undefined
      : input.installed.contracts.find((contract) => contract.deployment.appId === priorActor.appId);
  if (
    consumer === undefined ||
    destination === undefined ||
    requirements.length !== 1 ||
    requirement === undefined ||
    sourceOperations.length !== 1 ||
    sourceOperation === undefined ||
    rules.length !== 1 ||
    rule === undefined ||
    !nativeRouteIdentityMatches(source, signedRoute, native) ||
    !nativeCallingReleaseMatches(input, source, native, consumer, priorActorContract) ||
    requirement.provider.moduleId !== destination.manifest.module.id ||
    gatewayPublishedOperationAccess(destination, rule.entrypointKey, rule.schemaVersion) !== 'read' ||
    !gatewayRegisteredOperationContractAllows(consumer, destination, rule, signedRoute.legalEntityId, {
      requirementKey: input.operationRequirementKey,
      sourceEntrypointKey: sourceOperation.entrypointKey,
      sourceSchemaVersion: sourceOperation.schemaVersion,
    })
  ) {
    return yield* delegationForbidden('conditional_requirement_refused')();
  }
  return { consumer, destination, rule };
});

const admitOnwardNativeRead = Effect.fn('GatewayDelegation.admitOnwardNativeRead')(function* admit(
  input: NativeReadAdmissionInput,
  source: VerifiedNativeReadSource,
  signedRoute: NativeReadRouteScope,
  native: NativeReadReceiver,
) {
  const { consumer, destination, rule } = yield* requireOnwardReadEligibility(input, source, signedRoute, native);
  const receiver = yield* selectOnwardNativeReadReceiver({
    principal: source.principal,
    routeScope: signedRoute,
    workloadKey: rule.workloadKey,
  });
  if (receiver.principalId === input.actor.principalId || receiver.principalId === native.originalPrincipalId) {
    return yield* delegationForbidden('workload_binding_not_active')();
  }
  const attemptId = yield* (yield* Crypto.Crypto)
    .randomUUIDv4()
    .pipe(Effect.mapError(delegationUnavailable('source_evidence_unavailable')));
  const principal = yield* Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)({
    authContextRef: `job:integration.symmy.route-read:run:${attemptId}`,
    authMethod: 'system',
    principalId: receiver.principalId,
    tenantId: source.principal.tenantId,
  }).pipe(Effect.mapError(delegationForbidden('source_evidence_malformed')));
  const routeScope = yield* Schema.decodeUnknownEffect(SymmyGatewayRouteScopeSchema)({
    ...signedRoute,
    nativeReadReceiver: {
      ...native,
      bindingIncarnation: receiver.bindingIncarnation,
      requestHash: input.requestHash,
      workloadKey: rule.workloadKey,
    },
    operations: [{ entrypointKey: rule.entrypointKey, schemaVersion: rule.schemaVersion }],
    principalId: receiver.principalId,
  }).pipe(Effect.mapError(delegationForbidden('source_evidence_malformed')));
  return new AdmittedNativeRouteReadValue(mintKey, {
    actor: input.actor,
    audience: input.audience,
    compositionRevision: source.compositionRevision,
    moduleAccess: [
      { access: 'read', moduleKey: consumer.manifest.module.id },
      { access: 'read', moduleKey: destination.manifest.module.id },
    ],
    principal,
    routeScope,
    sourceKey: source.sourceKey,
    sourceValidity: source.sourceValidity,
  });
});

const intakeCallingReleaseMatches = (input: NativeReadAdmissionInput, source: VerifiedNativeReadSource): boolean =>
  input.actor.appId === symmyAudience &&
  input.actor.appId === input.binding.sourceAppId &&
  input.actor.buildMarker === input.binding.sourceBuildMarker &&
  source.sourceAppId === input.binding.sourceAppId &&
  source.providerKeyId === input.binding.providerKeyId &&
  source.sourceBuildMarker === input.binding.sourceBuildMarker &&
  source.compositionRevision === input.binding.compositionRevision &&
  source.compositionRevision === input.installed.composition.revision;

type OperationRequirement = NonNullable<InstalledContract['manifest']['requirements']>['operations'][number];
const intakeDestinationContractAllows = (
  input: NativeReadAdmissionInput,
  consumer: InstalledContract | undefined,
  destination: InstalledContract | undefined,
  requirements: readonly OperationRequirement[],
): boolean => {
  const [requirement] = requirements;
  return (
    consumer?.deployment.buildMarker === input.binding.sourceBuildMarker &&
    consumer.manifest.module.id === 'integration.symmy' &&
    destination?.manifest.module.id === privacyModule &&
    input.audience === 'privacy' &&
    input.operationRequirementKey === intakeRequirement &&
    requirements.length === 1 &&
    requirement !== undefined &&
    requirement.entrypointKey === intakeAction &&
    requirement.provider.moduleId === privacyModule &&
    requirement.provider.entrypointKey === privacyRead &&
    requirement.provider.schemaVersion === '1' &&
    gatewayPublishedOperationAccess(consumer, intakeAction, '1') === 'write' &&
    gatewayPublishedOperationAccess(destination, privacyRead, '1') === 'read'
  );
};

const requireIntakeReadEligibility = Effect.fn('GatewayDelegation.requireIntakeReadEligibility')(function* eligibility(
  input: NativeReadAdmissionInput,
  source: VerifiedNativeReadSource | undefined,
  signedRoute: NativeReadRouteScope | undefined,
) {
  const consumer = input.installed.contracts.find((contract) => contract.deployment.appId === symmyAudience);
  const destination = input.installed.contracts.find((contract) => contract.deployment.appId === input.audience);
  const requirements =
    consumer?.manifest.requirements?.operations.filter(
      (requirement) => requirement.key === input.operationRequirementKey,
    ) ?? [];
  if (
    source === undefined ||
    signedRoute === undefined ||
    source.workload !== undefined ||
    signedRoute.nativeReadReceiver !== undefined ||
    (signedRoute.routeKey !== 'customersBatch' && signedRoute.routeKey !== 'customerGroupCustomersBatch') ||
    source.principal.authMethod !== 'api_key' ||
    source.principal.authenticationNamespaceId === undefined ||
    source.principal.legalEntityId === undefined ||
    signedRoute.legalEntityId !== source.principal.legalEntityId ||
    signedRoute.principalId !== source.principal.principalId ||
    signedRoute.tenantId !== source.principal.tenantId ||
    !signedRoute.operations.some(
      (operation) => operation.entrypointKey === intakeAction && operation.schemaVersion === '1',
    ) ||
    !intakeCallingReleaseMatches(input, source) ||
    !intakeDestinationContractAllows(input, consumer, destination, requirements)
  ) {
    return yield* delegationForbidden('conditional_requirement_refused')();
  }
  const routeRequest: Parameters<typeof acquireSymmyRouteScopeProof>[0]['routeRequest'] = {
    routeKey: signedRoute.routeKey,
  };
  return { routeRequest, signedRoute, source };
});

const admitIntakeNativeRead = Effect.fn('GatewayDelegation.admitIntakeNativeRead')(function* admit(
  input: NativeReadAdmissionInput,
  verifiedSource: VerifiedNativeReadSource | undefined,
  verifiedRoute: NativeReadRouteScope | undefined,
) {
  const { routeRequest, signedRoute, source } = yield* requireIntakeReadEligibility(
    input,
    verifiedSource,
    verifiedRoute,
  );
  const { legalEntityId: _company, ...tenantPrincipal } = source.principal;
  const proof = yield* acquireSymmyRouteScopeProof({
    compositionRevision: source.compositionRevision,
    principal: tenantPrincipal,
    requestCorrelation: input.requestCorrelation,
    routeRequest,
    sourcePurpose: 'admit',
  });
  const current = yield* readSymmyRouteScope(proof);
  if (
    current.routeId !== signedRoute.routeId ||
    current.routeRevision !== signedRoute.routeRevision ||
    current.mappingVersion !== signedRoute.mappingVersion ||
    current.sourceRouteId !== signedRoute.sourceRouteId ||
    current.sourceRouteRevision !== signedRoute.sourceRouteRevision ||
    current.sourceMappingVersion !== signedRoute.sourceMappingVersion ||
    current.legalEntityId !== signedRoute.legalEntityId ||
    current.tenantId !== signedRoute.tenantId
  ) {
    return yield* delegationForbidden('symmy_route_not_admitted')();
  }
  const receiver = yield* selectSymmyIntakePrivacyReceiver(proof);
  if (receiver.originalWorkloadKey !== 'integration.symmy-admit' || receiver.principalId === input.actor.principalId) {
    return yield* delegationForbidden('workload_binding_not_active')();
  }
  const attemptId = yield* (yield* Crypto.Crypto)
    .randomUUIDv4()
    .pipe(Effect.mapError(delegationUnavailable('source_evidence_unavailable')));
  const principal = yield* Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)({
    authContextRef: `job:integration.symmy.route-read:run:${attemptId}`,
    authMethod: 'system',
    principalId: receiver.principalId,
    tenantId: source.principal.tenantId,
  }).pipe(Effect.mapError(delegationForbidden('source_evidence_malformed')));
  const routeScope = yield* Schema.decodeUnknownEffect(SymmyGatewayRouteScopeSchema)({
    ...signedRoute,
    nativeReadReceiver: {
      bindingIncarnation: receiver.bindingIncarnation,
      enrollmentLegalEntityId: current.legalEntityId,
      originalPrincipalId: source.principal.principalId,
      originalWorkloadBindingIncarnation: receiver.originalWorkloadBindingIncarnation,
      originalWorkloadKey: receiver.originalWorkloadKey,
      requestHash: input.requestHash,
      workloadKey: privacyWorkload,
    },
    operations: [{ entrypointKey: privacyRead, schemaVersion: '1' }],
    principalId: receiver.principalId,
  }).pipe(Effect.mapError(delegationForbidden('source_evidence_malformed')));
  return new AdmittedNativeRouteReadValue(mintKey, {
    actor: input.actor,
    audience: input.audience,
    compositionRevision: source.compositionRevision,
    moduleAccess: [
      { access: 'write', moduleKey: 'integration.symmy' },
      { access: 'read', moduleKey: privacyModule },
    ],
    principal,
    routeScope,
    sourceKey: source.sourceKey,
    sourceValidity: source.sourceValidity,
  });
});

/** A synchronous prerequisite of the exact signed admission, not a durable invocation or a generic owner grant. */
export const admitNativeRouteRead = Effect.fn('GatewayDelegation.admitNativeRouteRead')(function* admit(
  input: NativeReadAdmissionInput,
) {
  yield* Schema.decodeUnknownEffect(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)))(input.requestHash).pipe(
    Effect.mapError(delegationForbidden('source_evidence_malformed')),
  );
  const source = readVerifiedGatewayAssertion(input.source);
  const signedRoute = source?.routeScope;
  if (source !== undefined && signedRoute?.nativeReadReceiver !== undefined) {
    return yield* admitOnwardNativeRead(input, source, signedRoute, signedRoute.nativeReadReceiver);
  }
  return yield* admitIntakeNativeRead(input, source, signedRoute);
});
