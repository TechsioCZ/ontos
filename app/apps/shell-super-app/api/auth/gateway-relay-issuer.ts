import { GatewayRelayVerification } from './gateway-relay-verification.ts';
import { validateRelayAuthentication } from './gateway-relay-authentication.service.ts';
import { OperationalScopeResolver } from '@app/core-runtime/operations/context';
import { trustVerifiedGatewayPrincipalContext } from '@app/core-runtime/auth/system-principal-context-provenance';
import { TenantModuleStateService, tenantStatesAllowingAccess } from '@app/core-runtime';
import type { GatewayRelayRequestSchema } from '@app/shared-contracts';
import {
  GatewayTrustedPrincipalContextSchema,
  decodeGatewayContextProtectedHeader,
  decodeSupportedGatewayContextClaims,
} from '@app/shared-contracts';
import { DateTime, Effect, Predicate, Redacted, Schema } from 'effect';
import { jwtVerify } from 'jose';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

import { ShellInstalledModuleCatalog } from '../modules/installed-module-catalog.ts';
import { GatewayIssuer } from './gateway-issuer.ts';
import { GatewayRelayExchangeLedger } from './gateway-relay-exchanges.service.ts';
import { loadGatewayRelaySourceBindings, permitsGatewayRelay } from './gateway-relay-policy.ts';

import {
  GatewayRelayError,
  relayForbidden as forbidden,
  relayUnavailable as unavailable,
} from './gateway-relay-errors.ts';
/** Source workload attests the attempt; no cross-owner redemption table or caller-supplied identity is trusted. */
export const issueRelayedGatewayContextAssertion = Effect.fn('GatewayRelay.issue')(function* relay(input: {
  readonly payload: typeof GatewayRelayRequestSchema.Type;
  readonly requestCorrelation: string;
  readonly verifiedProviderKeyId: string;
}) {
  const { payload } = input;
  const bindings = yield* loadGatewayRelaySourceBindings.pipe(Effect.mapError(unavailable));
  const binding = bindings.find((candidate) => candidate.providerKeyId === input.verifiedProviderKeyId);
  if (binding === undefined) {
    return yield* forbidden();
  }
  const currentDate = DateTime.toDateUtc(yield* DateTime.now);
  const now = Math.floor(currentDate.getTime() / 1000);
  const verification = yield* GatewayRelayVerification;
  const configuration = yield* verification.load;
  const verified = yield* Effect.tryPromise({
    catch: (cause) => new GatewayRelayError({ cause, code: 'authentication_required' }),
    try: jwtVerify.bind(undefined, Redacted.value(payload.sourceAssertion), configuration.keys, {
      algorithms: ['EdDSA'],
      audience: binding.sourceAppId,
      clockTolerance: 0,
      currentDate,
      issuer: configuration.issuer,
    }),
  }).pipe(Effect.timeoutOrElse({ duration: '5 seconds', orElse: () => Effect.fail(unavailable()) }));
  yield* decodeGatewayContextProtectedHeader(verified.protectedHeader).pipe(Effect.mapError(forbidden));
  const source = yield* decodeSupportedGatewayContextClaims(verified.payload).pipe(Effect.mapError(forbidden));
  if (
    source.iat > now ||
    source.exp <= now ||
    !permitsGatewayRelay(input.verifiedProviderKeyId, binding, source, payload)
  ) {
    return yield* forbidden();
  }
  const catalog = yield* ShellInstalledModuleCatalog;
  const installed = yield* catalog.load.pipe(Effect.mapError(unavailable));
  if (installed.composition.revision !== payload.compositionRevision) {
    return yield* new GatewayRelayError({ code: 'reload_required' });
  }
  const sourceContract = installed.contracts.find((contract) => contract.deployment.appId === source.aud);
  const destination = installed.contracts.find((contract) => contract.deployment.appId === payload.audience);
  if (sourceContract?.deployment.buildMarker !== source.targetBuildMarker || destination === undefined) {
    return yield* forbidden();
  }
  yield* validateRelayAuthentication(source.principal, now);
  const principal = trustVerifiedGatewayPrincipalContext(source.principal, source.compositionRevision, {
    assertion: payload.sourceAssertion,
    audience: source.aud,
  });
  const resolver = yield* OperationalScopeResolver;
  yield* resolver
    .resolve({
      audience: source.aud,
      correlationId: input.requestCorrelation,
      legalEntityScope: source.principal.legalEntityId === undefined ? 'forbidden' : 'required',
      principal,
    })
    .pipe(
      Effect.mapError(
        (cause) =>
          new GatewayRelayError({
            code: Predicate.isTagged(cause, 'OperationContextUnavailable') ? 'unavailable' : 'forbidden',
          }),
      ),
    );
  const moduleStates = yield* TenantModuleStateService;
  const moduleKeys = [sourceContract.manifest.module.id, destination.manifest.module.id];
  const states = yield* moduleStates
    .getTenantModuleStates(source.principal.tenantId, moduleKeys)
    .pipe(Effect.mapError(unavailable));
  const readableStates = new Set(tenantStatesAllowingAccess('read'));
  if (moduleKeys.some((key) => !states.some((state) => state.moduleKey === key && readableStates.has(state.state)))) {
    return yield* forbidden();
  }
  const ledger = yield* GatewayRelayExchangeLedger;
  const fingerprintSource = yield* Schema.encodeUnknownEffect(
    Schema.fromJsonString(
      Schema.Struct({
        audience: Schema.String,
        compositionRevision: Schema.String,
        correlationId: Schema.String.pipe(Schema.brand('GatewayRelayCorrelationId')),
        operationKey: Schema.String.pipe(Schema.brand('GatewayRelayOperationKey')),
        principal: GatewayTrustedPrincipalContextSchema,
        sourceAppId: Schema.String.pipe(Schema.brand('GatewayRelaySourceAppId')),
        sourceBuildMarker: Schema.String,
      }),
    ),
  )({
    audience: payload.audience,
    compositionRevision: payload.compositionRevision,
    correlationId: input.requestCorrelation,
    operationKey: payload.operationKey,
    principal: source.principal,
    sourceAppId: source.aud,
    sourceBuildMarker: source.targetBuildMarker,
  }).pipe(Effect.mapError(unavailable));
  const requestFingerprint = bytesToHex(sha256(utf8ToBytes(fingerprintSource)));
  yield* ledger
    .reserve({
      exchangeId: payload.exchangeId,
      expiresAtEpochSeconds: source.exp,
      requestFingerprint,
      sourceJti: source.jti,
    })
    .pipe(
      Effect.mapError((cause) =>
        Predicate.isTagged(cause, 'GatewayRelayExchangeReplay') ? forbidden() : unavailable(),
      ),
    );
  const issuer = yield* GatewayIssuer;
  return yield* issuer.issue({
    audience: payload.audience,
    compositionRevision: payload.compositionRevision,
    principal: source.principal,
    sourceValidity: { expiresAt: source.exp, issuedAt: source.iat },
  });
});
