import { LegalEntityContext, recoverSqlTransactionError } from '@app/core-runtime';
import { TrustedPrincipalContextSchema } from '@app/core-runtime/actions/principal-context';
import type { TrustedPrincipalContext } from '@app/core-runtime/actions/principal-context';
import { RegisteredGatewayRouteScopeSchema } from '@app/core-runtime/auth/system-principal-context-provenance';
import { CoreDatabase } from '@app/core-runtime/db/client';
import {
  ProviderBindingRouteKeySchema,
  ProviderBindingRouteResponseSchema,
} from '@app/payment/api/provider-binding-route';
import type { ProviderBindingRouteResponse } from '@app/payment/api/provider-binding-route';
import { executeProviderBindingRouteWithAuthorization } from '@app/payment/api/provider-binding-route/client';
import { sql } from 'drizzle-orm';
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
/** Every Payment route principal must also hold the Payment source workload. */
const paymentSourceWorkload = 'payment.source-ingress';
const routeScopeKey = 'provider-binding-route';

const PaymentRouteWorkloadSchema = Schema.Literals([
  'payment.provider-notification-ingress',
  'payment.provider-reconciliation',
]);
export type PaymentRouteWorkload = typeof PaymentRouteWorkloadSchema.Type;
type ProviderFamily = ProviderBindingRouteResponse['providerFamily'];
/** What a notification path names: the Tenant its relay credential belongs to and the provider family. */
export interface PaymentNotificationPath {
  readonly providerFamily: ProviderFamily;
  readonly tenantId: string;
}

/** `not_found` is indistinguishable for unknown keys, other tenants' keys and another provider family. */
const PaymentRouteScopeErrorSchema = Schema.TaggedStruct('PaymentRouteScopeError', {
  cause: Schema.optionalKey(Schema.Defect()),
  code: Schema.Literals(['forbidden', 'not_found', 'unavailable']),
});
type PaymentRouteScopeError = typeof PaymentRouteScopeErrorSchema.Type;
const scopeError = (code: PaymentRouteScopeError['code'], cause: unknown): PaymentRouteScopeError =>
  cause === undefined
    ? PaymentRouteScopeErrorSchema.make({ code })
    : PaymentRouteScopeErrorSchema.make({ cause, code });
const forbidden = (cause?: unknown) =>
  scopeError(Predicate.isTagged(cause, 'PrincipalResolverUnavailableError') ? 'unavailable' : 'forbidden', cause);
const notFound = (cause?: unknown) => scopeError('not_found', cause);
const unavailable = (cause?: unknown) => scopeError('unavailable', cause);

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

/**
 * Native identity and workload facts, read again for every proof and every issuance: an active integration
 * principal of an active tenant, its active managed API key binding, the requested route workload and the
 * Payment source workload.
 */
const validatePaymentRoutePrincipal = Effect.fn('PaymentRouteScope.validatePrincipal')(function* validatePrincipal(
  candidate: TrustedPrincipalContext,
  requestedWorkload: PaymentRouteWorkload,
) {
  const workload = yield* Schema.decodeUnknownEffect(PaymentRouteWorkloadSchema)(requestedWorkload).pipe(
    Effect.mapError(forbidden),
  );
  const principal = yield* Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)(candidate).pipe(
    Effect.mapError(forbidden),
  );
  if (
    principal.authMethod !== 'api_key' ||
    principal.legalEntityId !== undefined ||
    principal.authBindingId === undefined ||
    principal.authContextRef === undefined ||
    !principal.authContextRef.startsWith('better-auth-api-key:')
  ) {
    return yield* Effect.fail(forbidden());
  }
  const providerKeyId = principal.authContextRef.slice('better-auth-api-key:'.length);
  const database = yield* CoreDatabase;
  const eligible = yield* database.executor
    .transaction(
      Effect.fn('PaymentRouteScope.nativeIdentity')(function* nativeIdentity(transaction) {
        yield* transaction.execute(
          sql`select set_config('ontos.tenant_id', ${principal.tenantId}, true), set_config('ontos.legal_entity_id', '', true)`,
          'objects',
        );
        return yield* transaction.execute(
          sql`
      select p.principal_id
      from core.principals p
      join core.tenants t on t.tenant_id=p.tenant_id and t.status='active'
      join core.principal_auth_bindings a on a.tenant_id=p.tenant_id and a.principal_id=p.principal_id
        and a.principal_auth_binding_id=${principal.authBindingId}::uuid and a.status='active' and a.revoked_at is null
        and a.subject_type='api_key' and a.provider='better_auth' and a.provider_subject_id=${providerKeyId}
        and a.authentication_namespace_id=${principal.authenticationNamespaceId ?? ''}
      where p.tenant_id=${principal.tenantId}::uuid and p.principal_id=${principal.principalId}::uuid
        and p.kind='integration' and p.status='active'
        and exists(select 1 from core.access_workload_bindings w where w.tenant_id=p.tenant_id and w.principal_id=p.principal_id
          and w.status='active' and w.workload_key=${workload})
        and exists(select 1 from core.access_workload_bindings s where s.tenant_id=p.tenant_id and s.principal_id=p.principal_id
          and s.status='active' and s.workload_key=${paymentSourceWorkload})
      limit 2`,
          'objects',
        );
      }),
    )
    .pipe(recoverSqlTransactionError, Effect.mapError(unavailable));
  if (eligible.length !== 1) {
    return yield* Effect.fail(forbidden());
  }
  return principal;
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
