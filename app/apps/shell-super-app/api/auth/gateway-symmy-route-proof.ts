import { GatewayNativeEvidence } from './gateway-native-evidence.ts';
import { LegalEntityContext } from '@app/core-runtime';

import type { TrustedPrincipalContext } from '@app/core-runtime/actions/principal-context';
import {
  decodeSymmyOwnerRoute,
  encodeSymmyOwnerRoute,
  resolveSymmyOwnerRoute,
  symmyRouteSourceWorkloads,
  validateSymmyRouteRequest,
} from '../symmy/native-evidence-policy.ts';
import type { Route, RouteRequest, SourcePurpose } from '../symmy/native-evidence-policy.ts';
import { Effect, Option, Predicate, Schema } from 'effect';

import { delegationForbidden, delegationUnavailable } from './gateway-delegation-errors.ts';
import { gatewayIssuerRefusalReason, issueSymmyGatewayContextAssertion } from './gateway-issuer-service.ts';

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

export const validateRoutePrincipal = Effect.fn('GatewayNativeEvidence.validateRoutePrincipal')(function* native(
  candidate: TrustedPrincipalContext,
  sourcePurpose: SourcePurpose,
) {
  return yield* (yield* GatewayNativeEvidence).validateRoutePrincipal(
    candidate,
    symmyRouteSourceWorkloads(sourcePurpose),
  );
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
  const { routeRequest, sourcePurpose } = yield* validateSymmyRouteRequest(input);
  const principal = yield* validateRoutePrincipal(input.principal, sourcePurpose);
  const assertion = yield* issueSymmyGatewayContextAssertion({
    compositionRevision: input.compositionRevision,
    principal,
    principalKind: 'integration',
  }).pipe(Effect.mapError((failure) => delegationUnavailable(gatewayIssuerRefusalReason(failure))(failure)));
  if (assertion.compositionRevision !== input.compositionRevision) {
    return yield* delegationForbidden('symmy_route_not_admitted')();
  }
  const route = yield* resolveSymmyOwnerRoute({
    assertion,
    requestCorrelation: input.requestCorrelation,
    routeRequest,
  });
  yield* validateCompany(route, principal.tenantId);
  const routeJson = yield* encodeSymmyOwnerRoute(route);
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
  return yield* decodeSymmyOwnerRoute(facts.routeJson);
});
