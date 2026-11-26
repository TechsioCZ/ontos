import { TrustedPrincipalContextSchema } from '@app/core-runtime/actions/principal-context';
import type { TrustedPrincipalContext } from '@app/core-runtime/actions/principal-context';
import { RegisteredGatewayRouteScopeSchema } from '@app/core-runtime/auth/system-principal-context-provenance';
import type { RegisteredGatewayRouteScope } from '@app/core-runtime/auth/system-principal-context-provenance';
import type { GatewayActorClaim } from '@app/shared-contracts';
import { Crypto, Effect, Schema } from 'effect';

import { readVerifiedGatewayAssertion } from './gateway-assertion-evidence.ts';
import { delegationForbidden, delegationUnavailable } from './gateway-delegation-errors.ts';
import { GatewayNativeRoutePolicy } from './gateway-native-route-policy.ts';
import type {
  NativeReadAdmissionInput,
  NativeReadReceiver,
  NativeReadRouteScope,
  VerifiedNativeReadSource,
} from './gateway-native-route-policy.ts';
import { selectOnwardNativeReadReceiver } from './gateway-native-route-read-receiver.ts';
import {
  acquireSymmyRouteScopeProof,
  readSymmyRouteScope,
  selectSymmyIntakePrivacyReceiver,
} from './gateway-symmy-route-scope.ts';

interface NativeRouteReadEvidence {
  readonly actor: GatewayActorClaim;
  readonly audience: string;
  readonly compositionRevision: string;
  readonly moduleAccess: readonly { readonly access: 'read' | 'write'; readonly moduleKey: string }[];
  readonly principal: TrustedPrincipalContext;
  readonly routeScope: RegisteredGatewayRouteScope;
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

const admitOnwardNativeRead = Effect.fn('GatewayDelegation.admitOnwardNativeRead')(function* admit(
  input: NativeReadAdmissionInput,
  source: VerifiedNativeReadSource,
  signedRoute: NativeReadRouteScope,
  native: NativeReadReceiver,
) {
  const policy = yield* GatewayNativeRoutePolicy;
  const { consumer, destination, rule } = yield* policy.admitOnward(input, source, signedRoute, native);
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
    authContextRef: `job:${policy.authContextJobKey}:run:${attemptId}`,
    authMethod: 'system',
    principalId: receiver.principalId,
    tenantId: source.principal.tenantId,
  }).pipe(Effect.mapError(delegationForbidden('source_evidence_malformed')));
  const routeScope = yield* Schema.decodeUnknownEffect(RegisteredGatewayRouteScopeSchema)({
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

const admitIntakeNativeRead = Effect.fn('GatewayDelegation.admitIntakeNativeRead')(function* admit(
  input: NativeReadAdmissionInput,
  verifiedSource: VerifiedNativeReadSource | undefined,
  verifiedRoute: NativeReadRouteScope | undefined,
) {
  const policy = yield* GatewayNativeRoutePolicy;
  const decision = yield* policy.admitIntake(input, verifiedSource, verifiedRoute);
  const { routeRequest, signedRoute, source } = decision;
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
  if (
    receiver.originalWorkloadKey !== decision.originalWorkloadKey ||
    receiver.principalId === input.actor.principalId
  ) {
    return yield* delegationForbidden('workload_binding_not_active')();
  }
  const attemptId = yield* (yield* Crypto.Crypto)
    .randomUUIDv4()
    .pipe(Effect.mapError(delegationUnavailable('source_evidence_unavailable')));
  const principal = yield* Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)({
    authContextRef: `job:${policy.authContextJobKey}:run:${attemptId}`,
    authMethod: 'system',
    principalId: receiver.principalId,
    tenantId: source.principal.tenantId,
  }).pipe(Effect.mapError(delegationForbidden('source_evidence_malformed')));
  const routeScope = yield* Schema.decodeUnknownEffect(RegisteredGatewayRouteScopeSchema)({
    ...signedRoute,
    nativeReadReceiver: {
      bindingIncarnation: receiver.bindingIncarnation,
      enrollmentLegalEntityId: current.legalEntityId,
      originalPrincipalId: source.principal.principalId,
      originalWorkloadBindingIncarnation: receiver.originalWorkloadBindingIncarnation,
      originalWorkloadKey: receiver.originalWorkloadKey,
      requestHash: input.requestHash,
      workloadKey: decision.workloadKey,
    },
    operations: [{ entrypointKey: decision.entrypointKey, schemaVersion: decision.schemaVersion }],
    principalId: receiver.principalId,
  }).pipe(Effect.mapError(delegationForbidden('source_evidence_malformed')));
  return new AdmittedNativeRouteReadValue(mintKey, {
    actor: input.actor,
    audience: input.audience,
    compositionRevision: source.compositionRevision,
    moduleAccess: [
      { access: 'write', moduleKey: decision.sourceModuleId },
      { access: 'read', moduleKey: decision.destinationModuleId },
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
