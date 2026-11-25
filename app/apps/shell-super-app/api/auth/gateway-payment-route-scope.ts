import { forbidden, notFound, unavailable } from './gateway-payment-route-errors.ts';
import type { PaymentRouteWorkload } from './gateway-payment-route-errors.ts';
import { GatewayNativeEvidence } from './gateway-native-evidence.ts';
import { LegalEntityContext } from '@app/core-runtime';

import type { TrustedPrincipalContext } from '@app/core-runtime/actions/principal-context';
import { RegisteredGatewayRouteScopeSchema } from '@app/core-runtime/auth/system-principal-context-provenance';
import {
  ProviderBindingRouteKeySchema,
  ProviderBindingRouteResponseSchema,
} from '@app/payment/api/provider-binding-route';
import type { ProviderBindingRouteResponse } from '@app/payment/api/provider-binding-route';
import { executeProviderBindingRouteWithAuthorization } from '@app/payment/api/provider-binding-route/client';
import { Effect, Option, Predicate, Schema } from 'effect';

import { resolvePaymentOwnerReleaseBase } from '../payment-gateway/owner-release-transport.ts';
import { issueGatewayContextAssertion, issueRouteScopedGatewayContextAssertion } from './gateway-issuer.ts';

/**
 * Payment binding route proof (#1157, phase 2 D-P4/D-P5). A relay or reconciliation integration principal
 * reaches exactly one Payment operation of exactly one Provider Account Binding: its tenant, Legal Entity
 * and binding come only from the protected `provider-binding-route` Read answered for that principal, never
 * from the request.
 */

const PAYMENT_ROUTE_AUDIENCE = 'payment';
const routeScopeKey = 'provider-binding-route';

export type { PaymentRouteWorkload } from './gateway-payment-route-errors.ts';
type ProviderFamily = ProviderBindingRouteResponse['providerFamily'];
/** What a notification path names: the Tenant its relay credential belongs to and the provider family. */
export interface PaymentNotificationPath {
  readonly providerFamily: ProviderFamily;
  readonly tenantId: string;
}

interface RouteScopeFacts {
  readonly compositionRevision: string;
  readonly principal: TrustedPrincipalContext;
  readonly routeJson: string;
  readonly workload: PaymentRouteWorkload;
}

const routeJsonSchema = Schema.fromJsonString(ProviderBindingRouteResponseSchema);
const routeScopeMintKey = Object.freeze({ kind: 'payment_route_scope' });

/** Only a successful protected route Read for the requesting principal constructs this request-local proof. */
class PaymentRouteScopeProofValue {
  readonly #facts: Option.Option<RouteScopeFacts>;
  constructor(key: typeof routeScopeMintKey, facts: RouteScopeFacts) {
    this.#facts = key === routeScopeMintKey ? Option.some(facts) : Option.none();
    Object.freeze(this);
  }
  static read(proof: PaymentRouteScopeProofValue): Option.Option<RouteScopeFacts> {
    return #facts in proof ? proof.#facts : Option.none();
  }
}
type PaymentRouteScopeProof = PaymentRouteScopeProofValue;
const proofSchema = Schema.instanceOf(PaymentRouteScopeProofValue);
const proofFacts = (proof: PaymentRouteScopeProof) => {
  if (!Schema.is(proofSchema)(proof)) {
    return Effect.fail(forbidden());
  }
  return Effect.fromOption(PaymentRouteScopeProofValue.read(proof)).pipe(Effect.mapError(forbidden));
};
const sameIdentity = (left: TrustedPrincipalContext, right: TrustedPrincipalContext): boolean =>
  left.principalId === right.principalId &&
  left.tenantId === right.tenantId &&
  left.authMethod === right.authMethod &&
  left.authBindingId === right.authBindingId &&
  left.authContextRef === right.authContextRef &&
  left.authenticationNamespaceId === right.authenticationNamespaceId;

const validatePaymentRoutePrincipal = Effect.fn('GatewayNativeEvidence.validatePaymentRoutePrincipal')(function* native(
  candidate: TrustedPrincipalContext,
  requestedWorkload: PaymentRouteWorkload,
) {
  return yield* (yield* GatewayNativeEvidence).validatePaymentRoutePrincipal(candidate, requestedWorkload);
});

const validateCompany = Effect.fn('PaymentRouteScope.validateCompany')(function* company(
  route: ProviderBindingRouteResponse,
  tenantId: string,
) {
  if (route.tenantId !== tenantId) {
    return yield* Effect.fail(forbidden());
  }
  const entities = yield* LegalEntityContext;
  yield* entities
    .validateSelection(tenantId, route.legalEntityId)
    .pipe(
      Effect.mapError((cause) =>
        Predicate.isTagged(cause, 'LegalEntityContextUnavailableError') ? unavailable(cause) : forbidden(cause),
      ),
    );
  return yield* Effect.void;
});

/** The single route operation for the requested workload; the route answer must name exactly one. */
const workloadOperation = (route: ProviderBindingRouteResponse, workload: PaymentRouteWorkload) => {
  const operations = route.operations.filter((operation) => operation.workloadKey === workload);
  const [operation] = operations;
  return operations.length === 1 && operation !== undefined ? Effect.succeed(operation) : Effect.fail(unavailable());
};

export const acquirePaymentRouteScopeProof = Effect.fn('PaymentRouteScope.acquire')(function* acquire(input: {
  readonly compositionRevision: string;
  /** Notifications only: the route tenant and family must equal what the path names. */
  readonly notificationPath: Option.Option<PaymentNotificationPath>;
  readonly principal: TrustedPrincipalContext;
  readonly requestCorrelation: string;
  readonly routeKey: string;
  readonly workload: PaymentRouteWorkload;
}) {
  const routeKey = yield* Schema.decodeUnknownEffect(ProviderBindingRouteKeySchema)(input.routeKey).pipe(
    Effect.mapError(notFound),
  );
  if (Option.isSome(input.notificationPath) && input.notificationPath.value.tenantId !== input.principal.tenantId) {
    return yield* Effect.fail(forbidden());
  }
  const principal = yield* validatePaymentRoutePrincipal(input.principal, input.workload);
  const assertion = yield* issueGatewayContextAssertion({
    audience: PAYMENT_ROUTE_AUDIENCE,
    compositionRevision: input.compositionRevision,
    principal,
  }).pipe(Effect.mapError(unavailable));
  if (assertion.compositionRevision !== input.compositionRevision) {
    return yield* Effect.fail(forbidden());
  }
  const baseUrl = yield* resolvePaymentOwnerReleaseBase(assertion.apiBaseUrl).pipe(Effect.mapError(unavailable));
  const route = yield* executeProviderBindingRouteWithAuthorization(
    { routeKey },
    `Bearer ${assertion.token}`,
    input.requestCorrelation,
    { baseUrl, compositionRevision: assertion.compositionRevision },
  ).pipe(
    Effect.mapError((cause) => {
      if (Predicate.isTagged(cause, 'ProviderBindingRouteNotFoundProblem')) {
        return notFound(cause);
      }
      return Predicate.isTagged(cause, 'ProviderBindingRouteForbiddenProblem') ||
        Predicate.isTagged(cause, 'ProviderBindingRouteAuthenticationProblem')
        ? forbidden(cause)
        : unavailable(cause);
    }),
  );
  if (Option.isSome(input.notificationPath) && route.providerFamily !== input.notificationPath.value.providerFamily) {
    return yield* Effect.fail(notFound());
  }
  yield* workloadOperation(route, input.workload);
  yield* validateCompany(route, principal.tenantId);
  const routeJson = yield* Schema.encodeEffect(routeJsonSchema)(route).pipe(Effect.mapError(unavailable));
  return new PaymentRouteScopeProofValue(
    routeScopeMintKey,
    Object.freeze({
      compositionRevision: assertion.compositionRevision,
      principal: Object.freeze({ ...principal }),
      routeJson,
      workload: input.workload,
    }),
  );
});

export const readPaymentRouteScope = Effect.fn('PaymentRouteScope.read')(function* read(proof: PaymentRouteScopeProof) {
  const facts = yield* proofFacts(proof);
  return yield* Schema.decodeUnknownEffect(routeJsonSchema)(facts.routeJson).pipe(Effect.mapError(unavailable));
});

/**
 * Signs a Payment assertion for the route's Legal Entity whose route scope names exactly the one operation
 * of the proof's workload: notification capture or operation recovery, never both.
 */
export const issuePaymentRouteScopeAssertion = Effect.fn('PaymentRouteScope.issueAssertion')(function* issue(
  proof: PaymentRouteScopeProof,
  input: { readonly principal: TrustedPrincipalContext },
) {
  const facts = yield* proofFacts(proof);
  if (!sameIdentity(facts.principal, input.principal)) {
    return yield* Effect.fail(forbidden());
  }
  const principal = yield* validatePaymentRoutePrincipal(input.principal, facts.workload);
  const route = yield* readPaymentRouteScope(proof);
  yield* validateCompany(route, principal.tenantId);
  const operation = yield* workloadOperation(route, facts.workload);
  const routeRevision = String(route.routeRevision);
  const routeScope = yield* Schema.decodeUnknownEffect(RegisteredGatewayRouteScopeSchema)({
    legalEntityId: route.legalEntityId,
    operations: [{ entrypointKey: operation.entrypointKey, schemaVersion: operation.schemaVersion }],
    principalId: principal.principalId,
    routeId: route.bindingId,
    routeKey: routeScopeKey,
    routeRevision,
    sourceRouteId: route.bindingId,
    sourceRouteRevision: routeRevision,
    tenantId: principal.tenantId,
  }).pipe(Effect.mapError(unavailable));
  const assertion = yield* issueRouteScopedGatewayContextAssertion({
    audience: PAYMENT_ROUTE_AUDIENCE,
    compositionRevision: facts.compositionRevision,
    principal: { ...principal, legalEntityId: route.legalEntityId },
    routeScope,
  }).pipe(Effect.mapError(unavailable));
  return { assertion, route };
});
