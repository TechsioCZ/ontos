import type { TrustedPrincipalContext } from '@app/core-runtime/actions/principal-context';
import { trustVerifiedGatewayPrincipalContext } from '@app/core-runtime/auth/system-principal-context-provenance';
import type { RegisteredGatewayWorkload } from '@app/core-runtime/auth/system-principal-context-provenance';
import { decodeGatewayContextProtectedHeader, decodeSupportedGatewayContextClaims } from '@app/shared-contracts';
import { Effect, Redacted, Schema } from 'effect';
import { jwtVerify } from 'jose';

import { validateDelegationAuthentication } from './gateway-delegation-authentication.service.ts';
import { GatewayDelegationError, delegationForbidden, delegationUnavailable } from './gateway-delegation-errors.ts';
import { bindingAttestsSource } from './gateway-delegation-policy.ts';
import type { GatewayModuleBinding } from './gateway-delegation-policy.ts';
import { GatewayDelegationVerification } from './gateway-delegation-verification.ts';

/** Only scalar facts and the two finite nested restrictions cross this private evidence boundary. */
export const snapshotRegisteredGatewayWorkload = (workload: RegisteredGatewayWorkload): RegisteredGatewayWorkload => {
  const snapshot = { ...workload };
  if (workload.organizationProcessingRead !== undefined) {
    snapshot.organizationProcessingRead = Object.freeze({ ...workload.organizationProcessingRead });
  }
  if (workload.recovery !== undefined) {
    snapshot.recovery = Object.freeze({ ...workload.recovery });
  }
  return Object.freeze(snapshot);
};

interface VerifiedAssertionEvidence {
  readonly compositionRevision: string;
  readonly principal: TrustedPrincipalContext;
  readonly providerKeyId: string;
  readonly sourceAppId: string;
  readonly sourceBuildMarker: string;
  readonly sourceKey: string;
  readonly sourceValidity: { readonly expiresAt: number; readonly issuedAt: number };
  readonly workload: RegisteredGatewayWorkload | undefined;
}
const mintKey = Object.freeze({ kind: 'verified_gateway_assertion' });
class VerifiedGatewayAssertionValue {
  readonly #evidence: VerifiedAssertionEvidence | undefined;
  constructor(key: typeof mintKey, evidence: VerifiedAssertionEvidence) {
    this.#evidence =
      key === mintKey
        ? Object.freeze({
            ...evidence,
            principal: Object.freeze({ ...evidence.principal }),
            sourceValidity: Object.freeze({ ...evidence.sourceValidity }),
            workload:
              evidence.workload === undefined ? undefined : snapshotRegisteredGatewayWorkload(evidence.workload),
          })
        : undefined;
    Object.freeze(this);
  }
  static read(witness: VerifiedGatewayAssertionValue): VerifiedAssertionEvidence | undefined {
    return #evidence in witness ? witness.#evidence : undefined;
  }
}
export type VerifiedGatewayAssertion = VerifiedGatewayAssertionValue;
const witnessSchema = Schema.instanceOf(VerifiedGatewayAssertionValue);
/** Copies and raw claim objects cannot stand in for official verified assertion evidence. */
export const readVerifiedGatewayAssertion = (
  witness: VerifiedGatewayAssertion,
): VerifiedAssertionEvidence | undefined =>
  Schema.is(witnessSchema)(witness) ? VerifiedGatewayAssertionValue.read(witness) : undefined;

/** Verifies a live request's subject assertion exactly as its source module issued it, then rechecks its authentication. */
export const admitAssertionSubject = Effect.fn('GatewayDelegation.admitAssertion')(
  function* admitAssertionSubject(input: {
    readonly assertion: Redacted.Redacted;
    readonly binding: GatewayModuleBinding;
    readonly currentDate: Date;
    readonly now: number;
    readonly registeredWorkload?: boolean;
    readonly requestedCompositionRevision: string;
  }) {
    const verification = yield* GatewayDelegationVerification;
    const configuration = yield* verification.load;
    const verified = yield* Effect.tryPromise({
      catch: (cause) => new GatewayDelegationError({ cause, code: 'authentication_required' }),
      try: jwtVerify.bind(undefined, Redacted.value(input.assertion), configuration.keys, {
        algorithms: ['EdDSA'],
        audience: input.binding.sourceAppId,
        clockTolerance: 0,
        currentDate: input.currentDate,
        issuer: configuration.issuer,
      }),
    }).pipe(Effect.timeoutOrElse({ duration: '5 seconds', orElse: () => Effect.fail(delegationUnavailable()) }));
    yield* decodeGatewayContextProtectedHeader(verified.protectedHeader).pipe(Effect.mapError(delegationForbidden));
    const source = yield* decodeSupportedGatewayContextClaims(verified.payload).pipe(
      Effect.mapError(delegationForbidden),
    );
    if (
      source.iat > input.now ||
      source.exp <= input.now ||
      !bindingAttestsSource(input.binding, source, input.requestedCompositionRevision)
    ) {
      return yield* delegationForbidden();
    }
    if (source.ver === 5 || source.ver === 6) {
      return yield* delegationForbidden();
    }
    if (source.ver === 4) {
      if (input.registeredWorkload !== true) {
        return yield* delegationForbidden();
      }
    } else {
      if (input.registeredWorkload === true) {
        return yield* delegationForbidden();
      }
      yield* validateDelegationAuthentication(source.principal, input.now);
    }
    const principal = Object.freeze({ ...source.principal });
    const evidence = {
      compositionRevision: source.compositionRevision,
      expiresAtEpochSeconds: source.exp,
      principal,
      providerKeyId: input.binding.providerKeyId,
      scopePrincipal: trustVerifiedGatewayPrincipalContext(principal, source.compositionRevision, {
        assertion: input.assertion,
        audience: input.binding.sourceAppId,
      }),
      sourceAppId: source.aud,
      sourceBuildMarker: source.targetBuildMarker,
      sourceKey: source.jti,
      sourceValidity: Object.freeze({ expiresAt: source.exp, issuedAt: source.iat }),
      workload: source.ver === 4 ? snapshotRegisteredGatewayWorkload(source.workload) : undefined,
    };
    return { ...evidence, verifiedAssertion: new VerifiedGatewayAssertionValue(mintKey, evidence) };
  },
);
