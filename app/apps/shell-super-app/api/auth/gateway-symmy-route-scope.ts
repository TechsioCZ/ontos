import { LegalEntityContext, recoverSqlTransactionError } from '@app/core-runtime';
import { TrustedPrincipalContextSchema } from '@app/core-runtime/actions/principal-context';
import type { TrustedPrincipalContext } from '@app/core-runtime/actions/principal-context';
import { internalWorkloadPrincipalId } from '@app/core-runtime/auth/module-credentials';
import { RegisteredGatewayRouteScopeSchema } from '@app/core-runtime/auth/system-principal-context-provenance';
import type { RegisteredGatewayRouteScope } from '@app/core-runtime/auth/system-principal-context-provenance';
import { CoreDatabase } from '@app/core-runtime/db/client';
import {
  SymmyRouteContextRequestSchema,
  SymmyRouteContextResponseSchema,
} from '@app/symmy-integration/api/symmy-route-context';
import { executeSymmyRouteContextWithAuthorization } from '@app/symmy-integration/api/symmy-route-context/client';
import { sql } from 'drizzle-orm';
import { Crypto, Effect, Option, Predicate, Schema } from 'effect';

import type { ShellInstalledCatalog } from '../modules/installed-module-catalog.ts';
import { ShellInstalledModuleCatalog } from '../modules/installed-module-catalog.ts';
import { resolveSymmyOwnerReleaseBase } from '../symmy/owner-release-transport.ts';
import { GatewayDelegationError, delegationForbidden, delegationUnavailable } from './gateway-delegation-errors.ts';
import { gatewayPublishedOperationAccess } from './gateway-delegation-policy.ts';
import {
  gatewayIssuerRefusalReason,
  issueNativeReadRouteScopedGatewayContextAssertion,
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
    return Effect.fail(delegationForbidden('symmy_route_not_admitted')());
  }
  return Effect.fromOption(SymmyRouteScopeProofValue.read(proof)).pipe(
    Effect.mapError(delegationForbidden('symmy_route_not_admitted')),
  );
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
const validateCompany = Effect.fn('SymmyRouteScope.validateCompany')(function* company(route: Route, tenantId: string) {
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

type InstalledContract = ShellInstalledCatalog['contracts'][number];

const nativeReadOperations = [
  ['party.registry', 'party.registry.api.source-profile-export', 'party.registry.source-read'],
  ['party.registry', 'party.registry.api.source-party-search', 'party.registry.source-read'],
  ['party.registry', 'party.registry.api.organization-business-name-export', 'party.registry.source-read'],
  ['commerce.customer-context', 'commerce.customer-context.api.customer-profile-source-page', 'commerce.customer-context.source-read'],
  ['commerce.customer-context', 'commerce.customer-context.api.customer-profile-source', 'commerce.customer-context.source-read'],
  ['commerce.customer-context', 'commerce.customer-context.api.customer-profile-source-parties', 'commerce.customer-context.source-read'],
  ['commerce.customer-context', 'commerce.customer-context.api.customer-profile-ico', 'commerce.customer-context.source-read'],
  ['commerce.customer-context', 'commerce.customer-context.api.organization-customer-profile-ico', 'commerce.customer-context.source-read'],
  ['commerce.customer-context', 'commerce.customer-context.api.customer-group-definition-source', 'commerce.customer-context.source-read'],
  ['pricing.price-group-catalog', 'pricing.price-group-catalog.api.price-group-definition', 'pricing.price-group-catalog.source-read'],
  ['pricing.price-group-catalog', 'pricing.price-group-catalog.api.price-group-source-associations', 'pricing.price-group-catalog.source-read'],
  ['commerce.pricing', 'commerce.pricing.api.price-group-source-prices', 'commerce.pricing.source-read'],
  ['commerce.catalog', 'commerce.catalog.api.catalog-source-product-page', 'commerce.catalog.symmy-product-read'],
  ['commerce.inventory', 'commerce.inventory.api.source-stock-position-resolution', 'commerce.inventory.source-read'],
] as const;
const tenantOnlyNativeReads = [
  ['catalog', 'commerce.catalog', 'commerce.catalog.api.catalog-source-product-page'],
  ['price-group-catalog', 'pricing.price-group-catalog', 'pricing.price-group-catalog.api.price-group-definition'],
  ['price-group-catalog', 'pricing.price-group-catalog', 'pricing.price-group-catalog.api.price-group-source-associations'],
] as const;

interface NativeReadEvidence {
  readonly audience: string;
  readonly compositionRevision: string;
  readonly principal: TrustedPrincipalContext;
  readonly routeScope: RegisteredGatewayRouteScope;
}
const nativeReadMintKey = Object.freeze({ kind: 'symmy_native_route_read' });
class AdmittedSymmyNativeReadValue {
  readonly #evidence: NativeReadEvidence | undefined;
  constructor(key: typeof nativeReadMintKey, evidence: NativeReadEvidence) {
    this.#evidence = key === nativeReadMintKey
      && evidence.routeScope.nativeReadReceiver !== undefined
      ? Object.freeze({
          ...evidence,
          principal: Object.freeze({ ...evidence.principal }),
          routeScope: Object.freeze({
            ...evidence.routeScope,
            nativeReadReceiver: Object.freeze({ ...evidence.routeScope.nativeReadReceiver }),
            operations: Object.freeze(evidence.routeScope.operations.map((operation) => Object.freeze({ ...operation }))),
          }),
        })
      : undefined;
    Object.freeze(this);
  }
  static read(witness: AdmittedSymmyNativeReadValue): NativeReadEvidence | undefined {
    return #evidence in witness ? witness.#evidence : undefined;
  }
}
export type AdmittedSymmyNativeRead = AdmittedSymmyNativeReadValue;
const nativeReadWitnessSchema = Schema.instanceOf(AdmittedSymmyNativeReadValue);
/** Only complete current route and native enrollment proof can request the private V9 issuer path. */
export const readAdmittedSymmyNativeRead = (witness: AdmittedSymmyNativeRead): NativeReadEvidence | undefined =>
  Schema.is(nativeReadWitnessSchema)(witness) ? AdmittedSymmyNativeReadValue.read(witness) : undefined;

const nativeReadRowSchema = Schema.Struct({
  bindingIncarnation: Schema.String.check(Schema.isUUID()),
  originalWorkloadBindingIncarnation: Schema.String.check(Schema.isUUID()),
  originalWorkloadKey: Schema.Literals(['integration.symmy-admit', 'integration.symmy-poll']),
  principalId: TrustedPrincipalContextSchema.fields.principalId,
});
const selectNativeReadReceiver = Effect.fn('SymmyRouteScope.selectNativeReadReceiver')(function* select(
  facts: RouteScopeFacts,
  route: Route,
  workloadKey: string,
) {
  const database = yield* CoreDatabase;
  const systemCount = sql`(
    select count(*) from core.access_workload_bindings sb
    join core.principals sp on sp.tenant_id=sb.tenant_id and sp.principal_id=sb.principal_id
      and sp.kind='system' and sp.status='active'
    where sb.tenant_id=${facts.principal.tenantId}::uuid and sb.workload_key=${workloadKey} and sb.status='active'
  )`;
  const service = route.legalEntityId === undefined ? sql`false` : sql`
    receiver.kind='service' and receiver.platform_role='internal_workload'
    and receiver.principal_id=${internalWorkloadPrincipalId({
      tenantId: facts.principal.tenantId, legalEntityId: route.legalEntityId, workloadKey,
    })}::uuid
    and exists (
      select 1 from core.access_workload_company_bindings cb
      join core.legal_entities le on le.tenant_id=cb.tenant_id and le.legal_entity_id=cb.legal_entity_id and le.status='active'
      where cb.tenant_id=b.tenant_id and cb.workload_binding_id=b.binding_id and cb.status='active'
        and cb.legal_entity_id=${route.legalEntityId}::uuid
    )`;
  const rows = yield* database.executor.transaction(
    Effect.fn('SymmyRouteScope.nativeReadEvidence')(function* nativeReadEvidence(transaction) {
      yield* transaction.execute(
        sql`select set_config('ontos.tenant_id', ${facts.principal.tenantId}, true), set_config('ontos.legal_entity_id', '', true)`,
        'objects',
      );
      return yield* transaction.execute(sql`
        select receiver.principal_id as "principalId", b.incarnation as "bindingIncarnation",
          original_binding.workload_key as "originalWorkloadKey",
          original_binding.incarnation as "originalWorkloadBindingIncarnation"
        from core.access_workload_bindings b
        join core.tenants t on t.tenant_id=b.tenant_id and t.status='active'
        join core.principals receiver on receiver.tenant_id=b.tenant_id and receiver.principal_id=b.principal_id and receiver.status='active'
        join core.principals original on original.tenant_id=t.tenant_id and original.principal_id=${facts.principal.principalId}::uuid
          and original.kind='integration' and original.status='active'
        join core.principal_auth_bindings original_auth on original_auth.tenant_id=original.tenant_id
          and original_auth.principal_id=original.principal_id
          and original_auth.principal_auth_binding_id=${facts.principal.authBindingId}::uuid
          and original_auth.status='active' and original_auth.revoked_at is null
          and original_auth.provider='better_auth' and original_auth.subject_type='api_key'
          and original_auth.provider_subject_id=${facts.principal.authContextRef?.slice('better-auth-api-key:'.length) ?? ''}
          and original_auth.authentication_namespace_id=${facts.principal.authenticationNamespaceId ?? ''}
        join core.access_workload_bindings original_binding on original_binding.tenant_id=original.tenant_id
          and original_binding.principal_id=original.principal_id and original_binding.status='active'
          and (original_binding.workload_key='integration.symmy-admit' or (
            ${facts.sourcePurpose}='read' and original_binding.workload_key='integration.symmy-poll'
            and not exists(select 1 from core.access_workload_bindings preferred
              where preferred.tenant_id=original.tenant_id and preferred.principal_id=original.principal_id
                and preferred.workload_key='integration.symmy-admit' and preferred.status='active')
          ))
        where b.tenant_id=${facts.principal.tenantId}::uuid and b.workload_key=${workloadKey} and b.status='active'
          and ((receiver.kind='system' and ${systemCount}=1) or (${systemCount}=0 and ${service}))
          and (${route.legalEntityId ?? null}::uuid is null or exists(
            select 1 from core.legal_entities company where company.tenant_id=t.tenant_id
              and company.legal_entity_id=${route.legalEntityId ?? null}::uuid and company.status='active'))
        limit 2`, 'objects');
    }),
  ).pipe(
    recoverSqlTransactionError,
    Effect.mapError(delegationUnavailable('symmy_route_unavailable')),
    Effect.flatMap((rows) => Schema.decodeUnknownEffect(Schema.Array(nativeReadRowSchema))(rows).pipe(
      Effect.mapError(delegationUnavailable('symmy_route_unavailable')),
    )),
  );
  const [receiver] = rows;
  if (rows.length !== 1 || receiver === undefined) {
    return yield* delegationForbidden('symmy_route_not_admitted')();
  }
  return receiver;
});

/** The intake handoff uses the same current native enrollment proof, never an invocation-shaped substitute. */
export const selectSymmyIntakePrivacyReceiver = Effect.fn('SymmyRouteScope.selectIntakePrivacyReceiver')(
  function* selectIntakePrivacyReceiver(proof: SymmyRouteScopeProof) {
    const facts = yield* proofFacts(proof);
    if (facts.sourcePurpose !== 'admit' ||
      (facts.routeKey !== 'customersBatch' && facts.routeKey !== 'customerGroupCustomersBatch')) {
      return yield* delegationForbidden('symmy_route_not_admitted')();
    }
    return yield* selectNativeReadReceiver(facts, yield* readSymmyRouteScope(proof), 'privacy.core.source-processing-check');
  },
);
/**
 * Finite owner operations of admission routes: pre-admission source reads and the demo catalog import with its
 * required revision read. Enrollment and the installed owner's exact access/version remain mandatory.
 */
const admissionOwnerOperations = [
  {
    access: 'read',
    entrypointKey: 'commerce.customer-context.api.customer-group-definition-source',
    moduleId: 'commerce.customer-context',
    requiresCompany: true,
    routeKey: 'customerGroupsBatch',
    schemaVersion: '1',
  },
  {
    access: 'read',
    entrypointKey: 'commerce.inventory.api.source-stock-position-resolution',
    moduleId: 'commerce.inventory',
    requiresCompany: false,
    routeKey: 'inventoryStockBatch',
    schemaVersion: '1',
  },
  {
    access: 'write',
    entrypointKey: 'demo.merchandise.import-source-catalog',
    moduleId: 'demo.merchandise',
    requiresCompany: true,
    routeKey: 'productsBatch',
    schemaVersion: '1',
  },
  {
    access: 'read',
    entrypointKey: 'demo.merchandise.api.demo-catalog-revision',
    moduleId: 'demo.merchandise',
    requiresCompany: true,
    routeKey: 'productsBatch',
    schemaVersion: '1',
  },
] as const;
/**
 * Read proofs name enrolled published reads. Admission proofs name only the finite operations above, once however
 * many enrollment items name them, with the declared company requirement and exact published access.
 */
const ownerRouteOperations = (destination: InstalledContract, route: Route, facts: RouteScopeFacts) => {
  if (facts.sourcePurpose === 'admit') {
    return admissionOwnerOperations.flatMap(({ access, entrypointKey, moduleId, requiresCompany, routeKey, schemaVersion }) =>
      routeKey === facts.routeKey &&
        (!requiresCompany || route.legalEntityId !== undefined) &&
        destination.manifest.module.id === moduleId &&
        route.allowedOwnerOperations.some(
          (operation) =>
            operation.moduleId === moduleId &&
            operation.entrypointKey === entrypointKey &&
            operation.schemaVersion === schemaVersion,
        ) &&
        gatewayPublishedOperationAccess(destination, entrypointKey, schemaVersion) === access
        ? [{ entrypointKey, schemaVersion }]
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

export const projectSymmyRouteScopePrincipal = Effect.fn('SymmyRouteScope.projectPrincipal')(function* project(
  proof: SymmyRouteScopeProof,
  input: { readonly audience: string; readonly legalEntityId?: string; readonly principal: TrustedPrincipalContext },
) {
  const facts = yield* proofFacts(proof);
  if (!sameIdentity(facts.principal, input.principal)) {
    return yield* delegationForbidden('symmy_route_not_admitted')();
  }
  const principal = yield* validateRoutePrincipal(input.principal, facts.sourcePurpose);
  const route = yield* readSymmyRouteScope(proof);
  const inventoryTenantRead =
    facts.sourcePurpose === 'admit' && facts.routeKey === 'inventoryStockBatch' && input.audience === 'inventory';
  const nativeTenantRead = facts.sourcePurpose === 'read' && tenantOnlyNativeReads.some(
    ([audience, moduleId, entrypointKey]) => input.audience === audience &&
      route.allowedOwnerOperations.some((operation) => operation.moduleId === moduleId &&
        operation.entrypointKey === entrypointKey && operation.schemaVersion === '1'),
  );
  const receiverCompany = inventoryTenantRead || nativeTenantRead ? undefined : route.legalEntityId;
  if (input.legalEntityId !== receiverCompany) {
    return yield* delegationForbidden('symmy_route_not_admitted')();
  }
  yield* validateCompany(route, principal.tenantId);
  const catalog = yield* ShellInstalledModuleCatalog;
  const installed = yield* catalog.load.pipe(Effect.mapError(delegationUnavailable('installed_release_unavailable')));
  if (installed.composition.revision !== facts.compositionRevision) {
    return yield* new GatewayDelegationError({ code: 'reload_required', reason: 'release_changed' });
  }
  if (input.audience !== symmyAudience) {
    const destination = installed.contracts.find((contract) => contract.deployment.appId === input.audience);
    if (destination === undefined || ownerRouteOperations(destination, route, facts).length === 0) {
      return yield* delegationForbidden('symmy_route_not_admitted')();
    }
  }
  return receiverCompany === undefined ? principal : { ...principal, legalEntityId: receiverCompany };
});

const symmyAdmissionActions: ReadonlySet<string> = new Set([
  'integration.symmy.admit-symmy-job',
  'integration.symmy.admit-symmy-sync',
]);
const symmyRouteReadKey = 'integration.symmy.api.symmy-route-context';
const symmySyncAdmissionReadKey = 'integration.symmy.api.symmy-sync-admission';
const routeScopeOperations = (destination: InstalledContract, route: Route, facts: RouteScopeFacts) => {
  if (destination.deployment.appId === symmyAudience) {
    if (facts.sourcePurpose === 'admit') {
      const syncRoute = facts.routeKey === 'customerGroupsBatch' || facts.routeKey === 'inventoryStockBatch';
      const replay = route.replayIdempotencyDigest !== undefined;
      const replayActionKey = syncRoute ? 'integration.symmy.admit-symmy-sync' : 'integration.symmy.admit-symmy-job';
      return [
        ...destination.manifest.publicSurface.actions.flatMap((action) =>
          symmyAdmissionActions.has(action.actionKey) &&
          action.entrypoint.access === 'write' &&
          (!replay || action.actionKey === replayActionKey)
            ? [{ entrypointKey: action.entrypoint.entrypointKey, schemaVersion: action.schemaVersion }]
            : [],
        ),
        ...(destination.manifest.publicSurface.operationContracts ?? []).flatMap((operation) =>
          (!replay || syncRoute) &&
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
  return ownerRouteOperations(destination, route, facts);
};

/**
 * One of the two private callers of the route-scope signing wrapper; the other is the Payment binding route
 * proof (`gateway-payment-route-scope.ts`), which signs only for the Payment audience.
 */
export const issueSymmyRouteScopeAssertion = Effect.fn('SymmyRouteScope.issueAssertion')(function* issue(
  proof: SymmyRouteScopeProof,
  input: { readonly audience: string; readonly legalEntityId?: string; readonly principal: TrustedPrincipalContext },
) {
  const [principal, facts] = yield* Effect.all([projectSymmyRouteScopePrincipal(proof, input), proofFacts(proof)], {
    concurrency: 2,
  });
  // Symmy resolves its own companyless admission by route and principal. Delegation to an owner
  // always carries the signed operation restriction, regardless of the owner's company scope.
  if (input.audience === symmyAudience && principal.legalEntityId === undefined) {
    return yield* issueSymmyGatewayContextAssertion({
      compositionRevision: facts.compositionRevision,
      principal,
      principalKind: 'integration',
    }).pipe(Effect.mapError((failure) => delegationUnavailable(gatewayIssuerRefusalReason(failure))(failure)));
  }
  const route = yield* readSymmyRouteScope(proof);
  const installed = yield* (yield* ShellInstalledModuleCatalog).load.pipe(
    Effect.mapError(delegationUnavailable('installed_release_unavailable')),
  );
  const destination = installed.contracts.find((contract) => contract.deployment.appId === input.audience);
  if (installed.composition.revision !== facts.compositionRevision || destination === undefined) {
    return yield* delegationForbidden('symmy_route_not_admitted')();
  }
  const routeScopeInput = {
    mappingVersion: route.mappingVersion,
    operations: routeScopeOperations(destination, route, facts),
    principalId: principal.principalId,
    routeId: route.routeId,
    routeKey: facts.routeKey,
    routeRevision: route.routeRevision,
    sourceMappingVersion: route.sourceMappingVersion,
    sourceRouteId: route.sourceRouteId,
    sourceRouteRevision: route.sourceRouteRevision,
    tenantId: principal.tenantId,
  };
  if (input.legalEntityId !== undefined) {
    Object.assign(routeScopeInput, { legalEntityId: input.legalEntityId });
  }
  if (route.replayIdempotencyDigest !== undefined) {
    Object.assign(routeScopeInput, { replayIdempotencyDigest: route.replayIdempotencyDigest });
  }
  if (input.audience !== symmyAudience &&
      routeScopeInput.operations.every(({ entrypointKey, schemaVersion }) =>
        gatewayPublishedOperationAccess(destination, entrypointKey, schemaVersion) === 'read')) {
    const mapped = routeScopeInput.operations.flatMap((operation) => {
      const approved = nativeReadOperations.find(([moduleId, entrypointKey]) =>
        moduleId === destination.manifest.module.id && entrypointKey === operation.entrypointKey &&
        operation.schemaVersion === '1');
      return approved === undefined ? [] : [{ operation, workloadKey: approved[2] }];
    });
    const workloadKeys = new Set(mapped.map(({ workloadKey }) => workloadKey));
    const [workloadKey] = workloadKeys;
    if (workloadKeys.size > 1) return yield* delegationForbidden('symmy_route_not_admitted')();
    if (workloadKey !== undefined) {
      const receiver = yield* selectNativeReadReceiver(facts, route, workloadKey);
      const readAttemptId = yield* (yield* Crypto.Crypto).randomUUIDv4().pipe(
        Effect.mapError(delegationUnavailable('symmy_route_unavailable')),
      );
      const nativePrincipal = yield* Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)({
        authMethod: 'system',
        authContextRef: `job:integration.symmy.route-read:run:${readAttemptId}`,
        principalId: receiver.principalId,
        tenantId: principal.tenantId,
      }).pipe(Effect.mapError(delegationForbidden('symmy_route_not_admitted')));
      const nativeScope = yield* Schema.decodeUnknownEffect(RegisteredGatewayRouteScopeSchema)({
        ...routeScopeInput,
        operations: mapped.map(({ operation }) => operation),
        principalId: receiver.principalId,
        nativeReadReceiver: {
          bindingIncarnation: receiver.bindingIncarnation,
          workloadKey,
          originalPrincipalId: facts.principal.principalId,
          originalWorkloadKey: receiver.originalWorkloadKey,
          originalWorkloadBindingIncarnation: receiver.originalWorkloadBindingIncarnation,
          ...(route.legalEntityId === undefined ? {} : { enrollmentLegalEntityId: route.legalEntityId }),
        },
      }).pipe(Effect.mapError(delegationUnavailable('symmy_route_unavailable')));
      return yield* issueNativeReadRouteScopedGatewayContextAssertion(
        new AdmittedSymmyNativeReadValue(nativeReadMintKey, {
          audience: input.audience,
          compositionRevision: facts.compositionRevision,
          principal: nativePrincipal,
          routeScope: nativeScope,
        }),
      ).pipe(Effect.mapError((failure) => delegationUnavailable(gatewayIssuerRefusalReason(failure))(failure)));
    }
  }
  const routeScope = yield* Schema.decodeUnknownEffect(RegisteredGatewayRouteScopeSchema)(routeScopeInput).pipe(
    Effect.mapError(delegationUnavailable('symmy_route_unavailable')),
  );
  return yield* issueRouteScopedGatewayContextAssertion({
    audience: input.audience,
    compositionRevision: facts.compositionRevision,
    principal,
    routeScope,
  }).pipe(Effect.mapError((failure) => delegationUnavailable(gatewayIssuerRefusalReason(failure))(failure)));
});
