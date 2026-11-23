import { LegalEntityContext, recoverSqlTransactionError } from '@app/core-runtime';
import { TrustedPrincipalContextSchema } from '@app/core-runtime/actions/principal-context';
import type { TrustedPrincipalContext } from '@app/core-runtime/actions/principal-context';
import { CoreDatabase } from '@app/core-runtime/db/client';
import {
  SymmyRouteContextRequestSchema,
  SymmyRouteContextResponseSchema,
} from '@app/symmy-integration/api/symmy-route-context';
import { executeSymmyRouteContextWithAuthorization } from '@app/symmy-integration/api/symmy-route-context/client';
import { sql } from 'drizzle-orm';
import { Effect, Option, Predicate, Schema } from 'effect';

import { resolveSymmyOwnerReleaseBase } from '../symmy/owner-release-transport.ts';
import { delegationForbidden, delegationUnavailable } from './gateway-delegation-errors.ts';
import { gatewayIssuerRefusalReason, issueSymmyGatewayContextAssertion } from './gateway-issuer-service.ts';

const symmyAudience = 'symmy-integration';
type Route = typeof SymmyRouteContextResponseSchema.Type;
type RouteRequest = typeof SymmyRouteContextRequestSchema.Encoded;
const SourcePurposeSchema = Schema.Literals(['admit', 'read']);
type SourcePurpose = typeof SourcePurposeSchema.Type;
const routeJsonSchema = Schema.fromJsonString(SymmyRouteContextResponseSchema);
const readRoutes: ReadonlySet<RouteRequest['routeKey']> = new Set([
  'adminCustomers',
  'adminProducts',
  'adminRegions',
  'priceLists',
]);
export interface RouteScopeFacts {
  readonly compositionRevision: string;
  readonly principal: TrustedPrincipalContext;
  readonly routeJson: string;
  readonly routeKey: RouteRequest['routeKey'];
  readonly sourcePurpose: SourcePurpose;
}

const routeScopeMintKey = Object.freeze({ kind: 'symmy_route_scope' });

/** Only a successful, protected route-context invocation constructs this request-local proof. */
export class SymmyRouteScopeProofValue {
  readonly #facts: Option.Option<RouteScopeFacts>;
  constructor(key: typeof routeScopeMintKey, facts: RouteScopeFacts) {
    this.#facts = key === routeScopeMintKey ? Option.some(facts) : Option.none();
    Object.freeze(this);
  }
  static read(proof: SymmyRouteScopeProofValue): Option.Option<RouteScopeFacts> {
    return #facts in proof ? proof.#facts : Option.none();
  }
}
export type SymmyRouteScopeProof = SymmyRouteScopeProofValue;
const proofSchema = Schema.instanceOf(SymmyRouteScopeProofValue);
export const proofFacts = (proof: SymmyRouteScopeProof) => {
  if (!Schema.is(proofSchema)(proof)) {
    return Effect.fail(delegationForbidden('symmy_route_not_admitted')());
  }
  return Effect.fromOption(SymmyRouteScopeProofValue.read(proof)).pipe(
    Effect.mapError(delegationForbidden('symmy_route_not_admitted')),
  );
};
export const sameIdentity = (left: TrustedPrincipalContext, right: TrustedPrincipalContext): boolean =>
  left.principalId === right.principalId &&
  left.tenantId === right.tenantId &&
  left.authMethod === right.authMethod &&
  left.authBindingId === right.authBindingId &&
  left.authContextRef === right.authContextRef &&
  left.authenticationNamespaceId === right.authenticationNamespaceId;

/** Native identity and source-workload facts are read again for every projection attempt. */
export const validateRoutePrincipal = Effect.fn('SymmyRouteScope.validatePrincipal')(function* validatePrincipal(
  candidate: TrustedPrincipalContext,
  sourcePurpose: SourcePurpose,
) {
  const principal = yield* Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)(candidate).pipe(
    Effect.mapError(delegationForbidden('symmy_route_not_admitted')),
  );
  if (
    principal.authMethod !== 'api_key' ||
    principal.legalEntityId !== undefined ||
    principal.authBindingId === undefined ||
    principal.authContextRef === undefined ||
    !principal.authContextRef.startsWith('better-auth-api-key:')
  ) {
    return yield* delegationForbidden('symmy_route_not_admitted')();
  }
  const providerKeyId = principal.authContextRef.slice('better-auth-api-key:'.length);
  const database = yield* CoreDatabase;
  const eligible = yield* database.executor
    .transaction(
      Effect.fn('SymmyRouteScope.nativeIdentity')(function* nativeIdentity(transaction) {
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
          and w.status='active' and (w.workload_key='integration.symmy-admit' or (${sourcePurpose}='read' and w.workload_key='integration.symmy-poll')))
      limit 2`,
          'objects',
        );
      }),
    )
    .pipe(recoverSqlTransactionError, Effect.mapError(delegationUnavailable('symmy_route_unavailable')));
  if (eligible.length !== 1) {
    return yield* delegationForbidden('symmy_route_not_admitted')();
  }
  return principal;
});
export const validateCompany = Effect.fn('SymmyRouteScope.validateCompany')(function* company(
  route: Route,
  tenantId: string,
) {
  if (route.tenantId !== tenantId) {
    return yield* delegationForbidden('symmy_route_not_admitted')();
  }
  if (route.legalEntityId !== undefined) {
    const entities = yield* LegalEntityContext;
    yield* entities
      .validateSelection(tenantId, route.legalEntityId)
      .pipe(
        Effect.mapError((cause) =>
          Predicate.isTagged(cause, 'LegalEntityContextUnavailableError')
            ? delegationUnavailable('symmy_route_unavailable')(cause)
            : delegationForbidden('symmy_route_not_admitted')(cause),
        ),
      );
  }
  return yield* Effect.void;
});

export const acquireSymmyRouteScopeProof = Effect.fn('SymmyRouteScope.acquire')(function* acquire(input: {
  readonly compositionRevision: string;
  readonly principal: TrustedPrincipalContext;
  readonly requestCorrelation: string;
  readonly routeRequest: RouteRequest;
  readonly sourcePurpose: SourcePurpose;
}) {
  const sourcePurpose = yield* Schema.decodeUnknownEffect(SourcePurposeSchema)(input.sourcePurpose).pipe(
    Effect.mapError(delegationForbidden('symmy_route_not_admitted')),
  );
  const routeRequest = yield* Schema.decodeUnknownEffect(SymmyRouteContextRequestSchema)(input.routeRequest).pipe(
    Effect.mapError(delegationForbidden('symmy_route_not_admitted')),
  );
  if ((sourcePurpose === 'read') !== readRoutes.has(routeRequest.routeKey)) {
    return yield* delegationForbidden('symmy_route_not_admitted')();
  }
  const principal = yield* validateRoutePrincipal(input.principal, sourcePurpose);
  const assertion = yield* issueSymmyGatewayContextAssertion({
    compositionRevision: input.compositionRevision,
    principal,
    principalKind: 'integration',
  }).pipe(Effect.mapError((failure) => delegationUnavailable(gatewayIssuerRefusalReason(failure))(failure)));
  if (assertion.compositionRevision !== input.compositionRevision) {
    return yield* delegationForbidden('symmy_route_not_admitted')();
  }
  const baseUrl = yield* resolveSymmyOwnerReleaseBase(assertion.apiBaseUrl, symmyAudience).pipe(
    Effect.mapError(delegationUnavailable('symmy_route_unavailable')),
  );
  const route = yield* executeSymmyRouteContextWithAuthorization(
    routeRequest,
    `Bearer ${assertion.token}`,
    input.requestCorrelation,
    { baseUrl, compositionRevision: assertion.compositionRevision },
  ).pipe(
    Effect.mapError((cause) =>
      Predicate.isTagged(cause, 'SymmyRouteContextForbiddenProblem') ||
      Predicate.isTagged(cause, 'SymmyRouteContextAuthenticationProblem')
        ? delegationForbidden('symmy_route_not_admitted')(cause)
        : delegationUnavailable('symmy_route_unavailable')(cause),
    ),
  );
  yield* validateCompany(route, principal.tenantId);
  const routeJson = yield* Schema.encodeEffect(routeJsonSchema)(route).pipe(
    Effect.mapError(delegationUnavailable('symmy_route_unavailable')),
  );
  return new SymmyRouteScopeProofValue(
    routeScopeMintKey,
    Object.freeze({
      compositionRevision: assertion.compositionRevision,
      principal: Object.freeze({ ...principal }),
      routeJson,
      routeKey: routeRequest.routeKey,
      sourcePurpose,
    }),
  );
});

export const readSymmyRouteScope = Effect.fn('SymmyRouteScope.read')(function* read(proof: SymmyRouteScopeProof) {
  const facts = yield* proofFacts(proof);
  return yield* Schema.decodeUnknownEffect(routeJsonSchema)(facts.routeJson).pipe(
    Effect.mapError(delegationUnavailable('symmy_route_unavailable')),
  );
});
