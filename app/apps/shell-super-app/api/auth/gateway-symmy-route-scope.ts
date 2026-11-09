import { LegalEntityContext, recoverSqlTransactionError } from '@app/core-runtime';
import { TrustedPrincipalContextSchema } from '@app/core-runtime/actions/principal-context';
import type { TrustedPrincipalContext } from '@app/core-runtime/actions/principal-context';
import { RegisteredGatewayRouteScopeSchema } from '@app/core-runtime/auth/system-principal-context-provenance';
import { CoreDatabase } from '@app/core-runtime/db/client';
import {
  SymmyRouteContextRequestSchema,
  SymmyRouteContextResponseSchema,
} from '@app/symmy-integration/api/symmy-route-context';
import { executeSymmyRouteContextWithAuthorization } from '@app/symmy-integration/api/symmy-route-context/client';
import { sql } from 'drizzle-orm';
import { Effect, Option, Predicate, Schema } from 'effect';

import type { ShellInstalledCatalog } from '../modules/installed-module-catalog.ts';
import { ShellInstalledModuleCatalog } from '../modules/installed-module-catalog.ts';
import { resolveSymmyOwnerReleaseBase } from '../symmy/owner-release-transport.ts';
import { GatewayDelegationError, delegationForbidden, delegationUnavailable } from './gateway-delegation-errors.ts';
import { gatewayPublishedOperationAccess } from './gateway-delegation-policy.ts';
import {
  issueGatewayContextAssertion,
  issueRouteScopedGatewayContextAssertion,
  issueSymmyGatewayContextAssertion,
} from './gateway-issuer.ts';

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
interface RouteScopeFacts {
  readonly compositionRevision: string;
  readonly principal: TrustedPrincipalContext;
  readonly routeJson: string;
  readonly routeKey: RouteRequest['routeKey'];
  readonly sourcePurpose: SourcePurpose;
}

const routeScopeMintKey = Object.freeze({ kind: 'symmy_route_scope' });

/** Only a successful, protected route-context invocation constructs this request-local proof. */
class SymmyRouteScopeProofValue {
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
const proofFacts = (proof: SymmyRouteScopeProof) => {
  if (!Schema.is(proofSchema)(proof)) {
    return Effect.fail(delegationForbidden());
  }
  return Effect.fromOption(SymmyRouteScopeProofValue.read(proof)).pipe(Effect.mapError(delegationForbidden));
};
const sameIdentity = (left: TrustedPrincipalContext, right: TrustedPrincipalContext): boolean =>
  left.principalId === right.principalId &&
  left.tenantId === right.tenantId &&
  left.authMethod === right.authMethod &&
  left.authBindingId === right.authBindingId &&
  left.authContextRef === right.authContextRef &&
  left.authenticationNamespaceId === right.authenticationNamespaceId;

/** Native identity and source-workload facts are read again for every projection attempt. */
const validateRoutePrincipal = Effect.fn('SymmyRouteScope.validatePrincipal')(function* validatePrincipal(
  candidate: TrustedPrincipalContext,
  sourcePurpose: SourcePurpose,
) {
  const principal = yield* Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)(candidate).pipe(
    Effect.mapError(delegationForbidden),
  );
  if (
    principal.authMethod !== 'api_key' ||
    principal.legalEntityId !== undefined ||
    principal.authBindingId === undefined ||
    principal.authContextRef === undefined ||
    !principal.authContextRef.startsWith('better-auth-api-key:')
  ) {
    return yield* delegationForbidden();
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
    .pipe(recoverSqlTransactionError, Effect.mapError(delegationUnavailable));
  if (eligible.length !== 1) {
    return yield* delegationForbidden();
  }
  return principal;
});
const validateCompany = Effect.fn('SymmyRouteScope.validateCompany')(function* company(route: Route, tenantId: string) {
  if (route.tenantId !== tenantId) {
    return yield* delegationForbidden();
  }
  if (route.legalEntityId !== undefined) {
    const entities = yield* LegalEntityContext;
    yield* entities
      .validateSelection(tenantId, route.legalEntityId)
      .pipe(
        Effect.mapError((cause) =>
          Predicate.isTagged(cause, 'LegalEntityContextUnavailableError')
            ? delegationUnavailable(cause)
            : delegationForbidden(cause),
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
    Effect.mapError(delegationForbidden),
  );
  const routeRequest = yield* Schema.decodeUnknownEffect(SymmyRouteContextRequestSchema)(input.routeRequest).pipe(
    Effect.mapError(delegationForbidden),
  );
  if ((sourcePurpose === 'read') !== readRoutes.has(routeRequest.routeKey)) {
    return yield* delegationForbidden();
  }
  const principal = yield* validateRoutePrincipal(input.principal, sourcePurpose);
  const assertion = yield* issueSymmyGatewayContextAssertion({
    compositionRevision: input.compositionRevision,
    principal,
    principalKind: 'integration',
  }).pipe(Effect.mapError(delegationUnavailable));
  if (assertion.compositionRevision !== input.compositionRevision) {
    return yield* delegationForbidden();
  }
  const baseUrl = yield* resolveSymmyOwnerReleaseBase(assertion.apiBaseUrl, symmyAudience).pipe(
    Effect.mapError(delegationUnavailable),
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
        ? delegationForbidden(cause)
        : delegationUnavailable(cause),
    ),
  );
  yield* validateCompany(route, principal.tenantId);
  const routeJson = yield* Schema.encodeEffect(routeJsonSchema)(route).pipe(Effect.mapError(delegationUnavailable));
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
    Effect.mapError(delegationUnavailable),
  );
});

export const projectSymmyRouteScopePrincipal = Effect.fn('SymmyRouteScope.projectPrincipal')(function* project(
  proof: SymmyRouteScopeProof,
  input: { readonly audience: string; readonly legalEntityId?: string; readonly principal: TrustedPrincipalContext },
) {
  const facts = yield* proofFacts(proof);
  if (!sameIdentity(facts.principal, input.principal)) {
    return yield* delegationForbidden();
  }
  const principal = yield* validateRoutePrincipal(input.principal, facts.sourcePurpose);
  const route = yield* readSymmyRouteScope(proof);
  if (input.legalEntityId !== route.legalEntityId) {
    return yield* delegationForbidden();
  }
  yield* validateCompany(route, principal.tenantId);
  const catalog = yield* ShellInstalledModuleCatalog;
  const installed = yield* catalog.load.pipe(Effect.mapError(delegationUnavailable));
  if (installed.composition.revision !== facts.compositionRevision) {
    return yield* new GatewayDelegationError({ code: 'reload_required' });
  }
  if (input.audience !== symmyAudience) {
    const destination = installed.contracts.find((contract) => contract.deployment.appId === input.audience);
    if (
      facts.sourcePurpose !== 'read' ||
      destination === undefined ||
      !route.allowedOwnerOperations.some(
        (operation) =>
          operation.moduleId === destination.manifest.module.id &&
          ['read', 'historical_read'].some(
            (access) =>
              gatewayPublishedOperationAccess(destination, operation.entrypointKey, operation.schemaVersion) === access,
          ),
      )
    ) {
      return yield* delegationForbidden();
    }
  }
  return route.legalEntityId === undefined ? principal : { ...principal, legalEntityId: route.legalEntityId };
});

type InstalledContract = ShellInstalledCatalog['contracts'][number];
const symmyAdmissionActions: ReadonlySet<string> = new Set([
  'integration.symmy.admit-symmy-job',
  'integration.symmy.admit-symmy-sync',
]);
const symmyRouteReadKey = 'integration.symmy.api.symmy-route-context';
const symmySyncAdmissionReadKey = 'integration.symmy.api.symmy-sync-admission';
const routeScopeOperations = (destination: InstalledContract, route: Route, facts: RouteScopeFacts) => {
  if (destination.deployment.appId === symmyAudience) {
    if (facts.sourcePurpose === 'admit') {
      return [
        ...destination.manifest.publicSurface.actions.flatMap((action) =>
          symmyAdmissionActions.has(action.actionKey) && action.entrypoint.access === 'write'
            ? [{ entrypointKey: action.entrypoint.entrypointKey, schemaVersion: action.schemaVersion }]
            : [],
        ),
        ...(destination.manifest.publicSurface.operationContracts ?? []).flatMap((operation) =>
          operation.entrypoint.entrypointKey === symmySyncAdmissionReadKey &&
          operation.schemaVersion === '1' &&
          operation.entrypoint.access === 'read'
            ? [{ entrypointKey: operation.entrypoint.entrypointKey, schemaVersion: operation.schemaVersion }]
            : [],
        ),
      ];
    }
    return (destination.manifest.publicSurface.operationContracts ?? []).flatMap((operation) =>
      operation.entrypoint.entrypointKey === symmyRouteReadKey && operation.entrypoint.access === 'read'
        ? [{ entrypointKey: operation.entrypoint.entrypointKey, schemaVersion: operation.schemaVersion }]
        : [],
    );
  }
  return route.allowedOwnerOperations.flatMap((operation) => {
    if (operation.moduleId !== destination.manifest.module.id) {
      return [];
    }
    const access = gatewayPublishedOperationAccess(destination, operation.entrypointKey, operation.schemaVersion);
    return access === 'read' || access === 'historical_read'
      ? [{ entrypointKey: operation.entrypointKey, schemaVersion: operation.schemaVersion }]
      : [];
  });
};

/** This private proof is the sole caller of the route-symbol signing wrapper. */
export const issueSymmyRouteScopeAssertion = Effect.fn('SymmyRouteScope.issueAssertion')(function* issue(
  proof: SymmyRouteScopeProof,
  input: { readonly audience: string; readonly legalEntityId?: string; readonly principal: TrustedPrincipalContext },
) {
  const [principal, facts] = yield* Effect.all([projectSymmyRouteScopePrincipal(proof, input), proofFacts(proof)], {
    concurrency: 2,
  });
  if (principal.legalEntityId === undefined) {
    return yield* (
      input.audience === symmyAudience
        ? issueSymmyGatewayContextAssertion({
            compositionRevision: facts.compositionRevision,
            principal,
            principalKind: 'integration',
          })
        : issueGatewayContextAssertion({
            audience: input.audience,
            compositionRevision: facts.compositionRevision,
            principal,
          })
    ).pipe(Effect.mapError(delegationUnavailable));
  }
  const route = yield* readSymmyRouteScope(proof);
  const installed = yield* (yield* ShellInstalledModuleCatalog).load.pipe(Effect.mapError(delegationUnavailable));
  const destination = installed.contracts.find((contract) => contract.deployment.appId === input.audience);
  if (installed.composition.revision !== facts.compositionRevision || destination === undefined) {
    return yield* delegationForbidden();
  }
  const routeScope = yield* Schema.decodeUnknownEffect(RegisteredGatewayRouteScopeSchema)({
    legalEntityId: principal.legalEntityId,
    operations: routeScopeOperations(destination, route, facts),
    principalId: principal.principalId,
    routeId: route.routeId,
    routeKey: facts.routeKey,
    routeRevision: route.routeRevision,
    sourceRouteId: route.sourceRouteId,
    sourceRouteRevision: route.sourceRouteRevision,
    tenantId: principal.tenantId,
  }).pipe(Effect.mapError(delegationUnavailable));
  return yield* issueRouteScopedGatewayContextAssertion({
    audience: input.audience,
    compositionRevision: facts.compositionRevision,
    principal,
    routeScope,
  }).pipe(Effect.mapError(delegationUnavailable));
});
