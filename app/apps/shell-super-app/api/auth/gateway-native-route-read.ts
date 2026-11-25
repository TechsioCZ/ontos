import { TrustedPrincipalContextSchema } from '@app/core-runtime/actions/principal-context';
import type { TrustedPrincipalContext } from '@app/core-runtime/actions/principal-context';
import { RegisteredGatewayRouteScopeSchema } from '@app/core-runtime/auth/system-principal-context-provenance';
import type { RegisteredGatewayRouteScope } from '@app/core-runtime/auth/system-principal-context-provenance';
import type { GatewayActorClaim } from '@app/shared-contracts';
import { Crypto, Effect, Schema } from 'effect';

import type { ShellInstalledCatalog } from '../modules/installed-module-catalog.ts';
import { readVerifiedGatewayAssertion } from './gateway-assertion-evidence.ts';
import type { VerifiedGatewayAssertion } from './gateway-assertion-evidence.ts';
import { delegationForbidden, delegationUnavailable } from './gateway-delegation-errors.ts';
import { gatewayPublishedOperationAccess, gatewayRegisteredOperationContractAllows } from './gateway-delegation-policy.ts';
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
const privacyWorkload = 'privacy.core.source-processing-check';

interface NativeRouteReadEvidence {
  readonly actor: GatewayActorClaim;
  readonly audience: string;
  readonly compositionRevision: string;
  readonly principal: TrustedPrincipalContext;
  readonly routeScope: RegisteredGatewayRouteScope;
  readonly sourceKey: string;
  readonly sourceValidity: { readonly expiresAt: number; readonly issuedAt: number };
  readonly moduleAccess: readonly { readonly access: 'read' | 'write'; readonly moduleKey: string }[];
}
const mintKey = Object.freeze({ kind: 'admitted_native_route_read' });
class AdmittedNativeRouteReadValue {
  readonly #evidence: NativeRouteReadEvidence | undefined;
  #consumed = false;
  constructor(key: typeof mintKey, evidence: NativeRouteReadEvidence) {
    this.#evidence = key === mintKey && evidence.routeScope.nativeReadReceiver !== undefined
      ? Object.freeze({
          ...evidence,
          actor: Object.freeze({ ...evidence.actor }),
          principal: Object.freeze({ ...evidence.principal }),
          sourceValidity: Object.freeze({ ...evidence.sourceValidity }),
          moduleAccess: Object.freeze(evidence.moduleAccess.map((item) => Object.freeze({ ...item }))),
          routeScope: Object.freeze({
            ...evidence.routeScope,
            nativeReadReceiver: Object.freeze({ ...evidence.routeScope.nativeReadReceiver }),
            operations: Object.freeze(evidence.routeScope.operations.map((operation) => Object.freeze({ ...operation }))),
          }),
        })
      : undefined;
    Object.freeze(this);
  }
  static read(witness: AdmittedNativeRouteReadValue): NativeRouteReadEvidence | undefined {
    return #evidence in witness ? witness.#evidence : undefined;
  }
  static take(witness: AdmittedNativeRouteReadValue): NativeRouteReadEvidence | undefined {
    if (!(#evidence in witness) || witness.#consumed) return undefined;
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

/** A synchronous prerequisite of the exact signed admission, not a durable invocation or a generic owner grant. */
export const admitNativeRouteRead = Effect.fn('GatewayDelegation.admitNativeRouteRead')(function* admit(input: {
  readonly actor: GatewayActorClaim;
  readonly audience: string;
  readonly binding: GatewayModuleBinding;
  readonly installed: ShellInstalledCatalog;
  readonly operationRequirementKey: string;
  readonly requestCorrelation: string;
  readonly requestHash: string;
  readonly source: VerifiedGatewayAssertion;
}) {
  yield* Schema.decodeUnknownEffect(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)))(input.requestHash)
    .pipe(Effect.mapError(delegationForbidden('source_evidence_malformed')));
  const source = readVerifiedGatewayAssertion(input.source);
  const signedRoute = source?.routeScope;
  if (source !== undefined && signedRoute?.nativeReadReceiver !== undefined) {
    const native = signedRoute.nativeReadReceiver;
    const consumer = input.installed.contracts.find((contract) => contract.deployment.appId === input.binding.sourceAppId);
    const destination = input.installed.contracts.find((contract) => contract.deployment.appId === input.audience);
    const requirements = consumer?.manifest.requirements?.operations.filter(
      (requirement) => requirement.key === input.operationRequirementKey,
    ) ?? [];
    const [requirement] = requirements;
    const sourceOperations = signedRoute.operations.filter((operation) =>
      operation.entrypointKey === requirement?.entrypointKey && consumer !== undefined &&
      gatewayPublishedOperationAccess(consumer, operation.entrypointKey, operation.schemaVersion) === 'read');
    const [sourceOperation] = sourceOperations;
    // Native route reads carry current binding evidence, never signed V4 recovery/delivery authority.
    const rules = (input.binding.registeredWorkloads ?? []).filter((rule) =>
      requirement !== undefined && destination !== undefined && rule.audience === input.audience &&
      rule.entrypointKey === requirement.provider.entrypointKey && rule.schemaVersion === requirement.provider.schemaVersion &&
      rule.sourceWorkloadKey === native.workloadKey && rule.jobKey === 'integration.symmy.execute-symmy-job' &&
      rule.sourceActionKey === undefined && rule.workerKey === undefined && rule.recoveryOf === undefined &&
      rule.allowRecoverySource !== true && rule.allowHistoricalDeliveryRecovery !== true);
    const [rule] = rules;
    const priorActor = source.sourceActor;
    const priorActorContract = priorActor === undefined ? undefined : input.installed.contracts.find(
      (contract) => contract.deployment.appId === priorActor.appId);
    if (
      consumer === undefined || destination === undefined || requirements.length !== 1 || requirement === undefined ||
      sourceOperations.length !== 1 || sourceOperation === undefined || rules.length !== 1 || rule === undefined ||
      source.workload !== undefined || source.principal.authMethod !== 'system' ||
      source.principal.legalEntityId !== undefined ||
      !['adminCustomers', 'customersBatch', 'customerGroupCustomersBatch'].includes(signedRoute.routeKey) ||
      signedRoute.legalEntityId === undefined || native.enrollmentLegalEntityId !== signedRoute.legalEntityId ||
      signedRoute.principalId !== source.principal.principalId || signedRoute.tenantId !== source.principal.tenantId ||
      input.actor.appId !== input.binding.sourceAppId || input.actor.buildMarker !== input.binding.sourceBuildMarker ||
      input.actor.principalId === source.principal.principalId || input.actor.principalId === native.originalPrincipalId ||
      source.sourceAppId !== input.binding.sourceAppId || source.providerKeyId !== input.binding.providerKeyId ||
      source.sourceBuildMarker !== input.binding.sourceBuildMarker || source.compositionRevision !== input.binding.compositionRevision ||
      source.compositionRevision !== input.installed.composition.revision ||
      consumer.deployment.buildMarker !== input.binding.sourceBuildMarker ||
      (priorActor !== undefined && priorActorContract?.deployment.buildMarker !== priorActor.buildMarker) ||
      requirement.provider.moduleId !== destination.manifest.module.id ||
      gatewayPublishedOperationAccess(destination, rule.entrypointKey, rule.schemaVersion) !== 'read' ||
      !gatewayRegisteredOperationContractAllows(consumer, destination, rule, signedRoute.legalEntityId, {
        requirementKey: input.operationRequirementKey, sourceEntrypointKey: sourceOperation.entrypointKey,
        sourceSchemaVersion: sourceOperation.schemaVersion,
      })
    ) {
      return yield* delegationForbidden('conditional_requirement_refused')();
    }
    const receiver = yield* selectOnwardNativeReadReceiver({
      principal: source.principal, routeScope: signedRoute, workloadKey: rule.workloadKey,
    });
    if (receiver.principalId === input.actor.principalId || receiver.principalId === native.originalPrincipalId) {
      return yield* delegationForbidden('workload_binding_not_active')();
    }
    const attemptId = yield* (yield* Crypto.Crypto).randomUUIDv4().pipe(
      Effect.mapError(delegationUnavailable('source_evidence_unavailable')),
    );
    const principal = yield* Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)({
      authMethod: 'system', authContextRef: `job:integration.symmy.route-read:run:${attemptId}`,
      principalId: receiver.principalId, tenantId: source.principal.tenantId,
    }).pipe(Effect.mapError(delegationForbidden('source_evidence_malformed')));
    const routeScope = yield* Schema.decodeUnknownEffect(RegisteredGatewayRouteScopeSchema)({
      ...signedRoute, principalId: receiver.principalId,
      operations: [{ entrypointKey: rule.entrypointKey, schemaVersion: rule.schemaVersion }],
      nativeReadReceiver: { ...native, workloadKey: rule.workloadKey, bindingIncarnation: receiver.bindingIncarnation, requestHash: input.requestHash },
    }).pipe(Effect.mapError(delegationForbidden('source_evidence_malformed')));
    return new AdmittedNativeRouteReadValue(mintKey, {
      actor: input.actor, audience: input.audience, compositionRevision: source.compositionRevision,
      principal, routeScope, sourceKey: source.sourceKey, sourceValidity: source.sourceValidity,
      moduleAccess: [
        { access: 'read', moduleKey: consumer.manifest.module.id },
        { access: 'read', moduleKey: destination.manifest.module.id },
      ],
    });
  }
  const consumer = input.installed.contracts.find((contract) => contract.deployment.appId === 'symmy-integration');
  const destination = input.installed.contracts.find((contract) => contract.deployment.appId === input.audience);
  const requirements = consumer?.manifest.requirements?.operations.filter(
    (requirement) => requirement.key === input.operationRequirementKey,
  ) ?? [];
  const [requirement] = requirements;
  if (
    source === undefined || signedRoute === undefined || source.workload !== undefined ||
    signedRoute.nativeReadReceiver !== undefined ||
    (signedRoute.routeKey !== 'customersBatch' && signedRoute.routeKey !== 'customerGroupCustomersBatch') ||
    source.principal.authMethod !== 'api_key' || source.principal.authenticationNamespaceId === undefined ||
    source.principal.legalEntityId === undefined || signedRoute.legalEntityId !== source.principal.legalEntityId ||
    signedRoute.principalId !== source.principal.principalId || signedRoute.tenantId !== source.principal.tenantId ||
    !signedRoute.operations.some((operation) => operation.entrypointKey === intakeAction && operation.schemaVersion === '1') ||
    input.actor.appId !== 'symmy-integration' || input.actor.appId !== input.binding.sourceAppId ||
    input.actor.buildMarker !== input.binding.sourceBuildMarker ||
    source.sourceAppId !== input.binding.sourceAppId || source.providerKeyId !== input.binding.providerKeyId ||
    source.sourceBuildMarker !== input.binding.sourceBuildMarker ||
    source.compositionRevision !== input.binding.compositionRevision ||
    source.compositionRevision !== input.installed.composition.revision ||
    consumer?.deployment.buildMarker !== input.binding.sourceBuildMarker ||
    consumer.manifest.module.id !== 'integration.symmy' || destination?.manifest.module.id !== 'privacy.core' ||
    input.audience !== 'privacy' || input.operationRequirementKey !== intakeRequirement ||
    requirements.length !== 1 || requirement === undefined || requirement.entrypointKey !== intakeAction ||
    requirement.provider.moduleId !== 'privacy.core' || requirement.provider.entrypointKey !== privacyRead ||
    requirement.provider.schemaVersion !== '1' ||
    gatewayPublishedOperationAccess(consumer, intakeAction, '1') !== 'write' ||
    gatewayPublishedOperationAccess(destination, privacyRead, '1') !== 'read'
  ) {
    return yield* delegationForbidden('conditional_requirement_refused')();
  }
  const { legalEntityId: _company, ...tenantPrincipal } = source.principal;
  const proof = yield* acquireSymmyRouteScopeProof({
    compositionRevision: source.compositionRevision,
    principal: tenantPrincipal,
    requestCorrelation: input.requestCorrelation,
    routeRequest: { routeKey: signedRoute.routeKey },
    sourcePurpose: 'admit',
  });
  const current = yield* readSymmyRouteScope(proof);
  if (
    current.routeId !== signedRoute.routeId || current.routeRevision !== signedRoute.routeRevision ||
    current.mappingVersion !== signedRoute.mappingVersion || current.sourceRouteId !== signedRoute.sourceRouteId ||
    current.sourceRouteRevision !== signedRoute.sourceRouteRevision ||
    current.sourceMappingVersion !== signedRoute.sourceMappingVersion ||
    current.legalEntityId !== signedRoute.legalEntityId || current.tenantId !== signedRoute.tenantId
  ) {
    return yield* delegationForbidden('symmy_route_not_admitted')();
  }
  const receiver = yield* selectSymmyIntakePrivacyReceiver(proof);
  if (receiver.originalWorkloadKey !== 'integration.symmy-admit' || receiver.principalId === input.actor.principalId) {
    return yield* delegationForbidden('workload_binding_not_active')();
  }
  const attemptId = yield* (yield* Crypto.Crypto).randomUUIDv4().pipe(
    Effect.mapError(delegationUnavailable('source_evidence_unavailable')),
  );
  const principal = yield* Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)({
    authMethod: 'system',
    authContextRef: `job:integration.symmy.route-read:run:${attemptId}`,
    principalId: receiver.principalId,
    tenantId: source.principal.tenantId,
  }).pipe(Effect.mapError(delegationForbidden('source_evidence_malformed')));
  const routeScope = yield* Schema.decodeUnknownEffect(RegisteredGatewayRouteScopeSchema)({
    ...signedRoute,
    principalId: receiver.principalId,
    operations: [{ entrypointKey: privacyRead, schemaVersion: '1' }],
    nativeReadReceiver: {
      requestHash: input.requestHash,
      workloadKey: privacyWorkload,
      bindingIncarnation: receiver.bindingIncarnation,
      enrollmentLegalEntityId: current.legalEntityId,
      originalPrincipalId: source.principal.principalId,
      originalWorkloadKey: receiver.originalWorkloadKey,
      originalWorkloadBindingIncarnation: receiver.originalWorkloadBindingIncarnation,
    },
  }).pipe(Effect.mapError(delegationForbidden('source_evidence_malformed')));
  return new AdmittedNativeRouteReadValue(mintKey, {
    actor: input.actor,
    audience: input.audience,
    compositionRevision: source.compositionRevision,
    principal,
    routeScope,
    sourceKey: source.sourceKey,
    sourceValidity: source.sourceValidity,
    moduleAccess: [{ access: 'write', moduleKey: 'integration.symmy' }, { access: 'read', moduleKey: 'privacy.core' }],
  });
});
