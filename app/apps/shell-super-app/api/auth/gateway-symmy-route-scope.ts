import { symmyIntakeReadWorkload, symmyRouteSourceWorkloads } from '../symmy/native-evidence-policy.ts';
import { GatewayNativeEvidence } from './gateway-native-evidence.ts';

import { TrustedPrincipalContextSchema } from '@app/core-runtime/actions/principal-context';
import type { TrustedPrincipalContext } from '@app/core-runtime/actions/principal-context';

import { RegisteredGatewayRouteScopeSchema } from '@app/core-runtime/auth/system-principal-context-provenance';
import type { RegisteredGatewayRouteScope } from '@app/core-runtime/auth/system-principal-context-provenance';
import type {
  SymmyRouteContextRequestSchema,
  SymmyRouteContextResponseSchema,
} from '@app/symmy-integration/api/symmy-route-context';
import { Crypto, Effect, Schema } from 'effect';

import type { ShellInstalledCatalog } from '../modules/installed-module-catalog.ts';
import { ShellInstalledModuleCatalog } from '../modules/installed-module-catalog.ts';
import { GatewayDelegationError, delegationForbidden, delegationUnavailable } from './gateway-delegation-errors.ts';
import { gatewayPublishedOperationAccess } from './gateway-delegation-policy.ts';

import {
  proofFacts,
  readSymmyRouteScope,
  sameIdentity,
  validateCompany,
  validateRoutePrincipal,
} from './gateway-symmy-route-proof.ts';
import type { RouteScopeFacts, SymmyRouteScopeProof } from './gateway-symmy-route-proof.ts';

export { acquireSymmyRouteScopeProof, readSymmyRouteScope } from './gateway-symmy-route-proof.ts';
export type { SymmyRouteScopeProof } from './gateway-symmy-route-proof.ts';

const symmyAudience = 'symmy-integration';
type Route = typeof SymmyRouteContextResponseSchema.Type;
type RouteRequest = typeof SymmyRouteContextRequestSchema.Encoded;
const partyModule = 'party.registry';
const partySourceRead = 'party.registry.source-read';
const customerContextModule = 'commerce.customer-context';
const customerContextSourceRead = 'commerce.customer-context.source-read';
const priceGroupModule = 'pricing.price-group-catalog';
const priceGroupSourceRead = 'pricing.price-group-catalog.source-read';
const priceGroupAudience = 'price-group-catalog';
const priceGroupAssociationRead = 'pricing.price-group-catalog.api.price-group-source-associations';
const priceGroupDefinitionRead = 'pricing.price-group-catalog.api.price-group-definition';
const catalogProductPageRead = 'commerce.catalog.api.catalog-source-product-page';

/** These routes already enroll the source-association Read as their exact list prerequisite. */
export const requiresSymmyPriceGroupRouteProof = (
  routeKey: RouteRequest['routeKey'] | undefined,
  audience: string,
): boolean =>
  audience === priceGroupAudience &&
  (routeKey === 'priceLists' || routeKey === 'priceListPricesBatch' || routeKey === 'productsBatch');

type SymmyOwnerRouteAdmission =
  | { readonly kind: 'refused' }
  | { readonly kind: 'unscoped' }
  | { readonly kind: 'route-proof'; readonly routeRequest: RouteRequest };

/** The integration owns which owner calls require its already-selected route; hosts only execute that decision. */
export const decideSymmyOwnerRouteAdmission = (
  selectedRoute: RouteRequest | undefined,
  input: { readonly audience: string; readonly legalEntityId?: string },
): SymmyOwnerRouteAdmission => {
  if (
    input.audience === 'inventory' &&
    selectedRoute?.routeKey !== 'inventoryStockBatch' &&
    // The demo store copy reads company on-hand figures under the company-qualified product read route.
    !(selectedRoute?.routeKey === 'adminProducts' && input.legalEntityId !== undefined)
  ) {
    return { kind: 'refused' };
  }
  if (
    input.legalEntityId === undefined &&
    input.audience !== 'inventory' &&
    !requiresSymmyPriceGroupRouteProof(selectedRoute?.routeKey, input.audience)
  ) {
    return { kind: 'unscoped' };
  }
  return selectedRoute === undefined ? { kind: 'refused' } : { kind: 'route-proof', routeRequest: selectedRoute };
};
type InstalledContract = ShellInstalledCatalog['contracts'][number];

const nativeReadOperations = [
  [partyModule, 'party.registry.api.source-profile-export', partySourceRead],
  [partyModule, 'party.registry.api.source-party-search', partySourceRead],
  [partyModule, 'party.registry.api.organization-business-name-export', partySourceRead],
  [customerContextModule, 'commerce.customer-context.api.customer-profile-source-page', customerContextSourceRead],
  [customerContextModule, 'commerce.customer-context.api.customer-profile-source', customerContextSourceRead],
  [customerContextModule, 'commerce.customer-context.api.customer-profile-source-parties', customerContextSourceRead],
  [customerContextModule, 'commerce.customer-context.api.customer-profile-ico', customerContextSourceRead],
  [customerContextModule, 'commerce.customer-context.api.organization-customer-profile-ico', customerContextSourceRead],
  [customerContextModule, 'commerce.customer-context.api.customer-group-definition-source', customerContextSourceRead],
  [priceGroupModule, priceGroupDefinitionRead, priceGroupSourceRead],
  [priceGroupModule, priceGroupAssociationRead, priceGroupSourceRead],
  ['commerce.pricing', 'commerce.pricing.api.price-group-source-prices', 'commerce.pricing.source-read'],
  ['commerce.pricing', 'commerce.pricing.api.price-schedule', 'commerce.pricing.source-read'],
  ['commerce.catalog', catalogProductPageRead, 'commerce.catalog.symmy-product-read'],
  ['commerce.inventory', 'commerce.inventory.api.source-stock-position-resolution', 'commerce.inventory.source-read'],
] as const;
const tenantOnlyNativeReads = [
  ['catalog', 'commerce.catalog', catalogProductPageRead],
  [priceGroupAudience, priceGroupModule, priceGroupDefinitionRead],
  [priceGroupAudience, priceGroupModule, priceGroupAssociationRead],
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
    this.#evidence =
      key === nativeReadMintKey && evidence.routeScope.nativeReadReceiver !== undefined
        ? Object.freeze({
            ...evidence,
            principal: Object.freeze({ ...evidence.principal }),
            routeScope: Object.freeze({
              ...evidence.routeScope,
              nativeReadReceiver: Object.freeze({ ...evidence.routeScope.nativeReadReceiver }),
              operations: Object.freeze(
                evidence.routeScope.operations.map((operation) => Object.freeze({ ...operation })),
              ),
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

const selectNativeReadReceiver = Effect.fn('GatewayNativeEvidence.selectNativeReadReceiver')(function* native(
  facts: RouteScopeFacts,
  route: Route,
  workloadKey: string,
) {
  return yield* (yield* GatewayNativeEvidence).selectNativeReadReceiver(
    facts.principal,
    route.legalEntityId,
    workloadKey,
    symmyRouteSourceWorkloads(facts.sourcePurpose),
  );
});

/** The intake handoff uses the same current native enrollment proof, never an invocation-shaped substitute. */
export const selectSymmyIntakePrivacyReceiver = Effect.fn('SymmyRouteScope.selectIntakePrivacyReceiver')(
  function* selectIntakePrivacyReceiver(proof: SymmyRouteScopeProof) {
    const facts = yield* proofFacts(proof);
    if (
      facts.sourcePurpose !== 'admit' ||
      (facts.routeKey !== 'customersBatch' && facts.routeKey !== 'customerGroupCustomersBatch')
    ) {
      return yield* delegationForbidden('symmy_route_not_admitted')();
    }
    return yield* selectNativeReadReceiver(facts, yield* readSymmyRouteScope(proof), symmyIntakeReadWorkload);
  },
);
/**
 * Finite owner operations of admission routes: pre-admission source reads and the demo catalog import with its
 * required revision read. Enrollment and the installed owner's exact access/version remain mandatory.
 */
const admissionOwnerOperations = [
  ...(['priceListPricesBatch', 'productsBatch'] as const).map((routeKey) => ({
    access: 'read' as const,
    entrypointKey: priceGroupAssociationRead,
    moduleId: priceGroupModule,
    requiresCompany: false,
    routeKey,
    schemaVersion: '1',
  })),
  {
    access: 'read',
    entrypointKey: 'commerce.customer-context.api.customer-group-definition-source',
    moduleId: customerContextModule,
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
    return admissionOwnerOperations.flatMap(
      ({ access, entrypointKey, moduleId, requiresCompany, routeKey, schemaVersion }) =>
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
  const nativeTenantRead =
    (facts.sourcePurpose === 'read' || requiresSymmyPriceGroupRouteProof(facts.routeKey, input.audience)) &&
    tenantOnlyNativeReads.some(
      ([audience, moduleId, entrypointKey]) =>
        input.audience === audience &&
        route.allowedOwnerOperations.some(
          (operation) =>
            operation.moduleId === moduleId &&
            operation.entrypointKey === entrypointKey &&
            operation.schemaVersion === '1',
        ),
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

/** Derive the exact signing inputs from an authenticated, enrolled route proof. */
export const prepareSymmyRouteScopeAssertion = Effect.fn('SymmyRouteScope.prepareAssertion')(function* prepare(
  proof: SymmyRouteScopeProof,
  input: { readonly audience: string; readonly legalEntityId?: string; readonly principal: TrustedPrincipalContext },
) {
  const [principal, facts] = yield* Effect.all([projectSymmyRouteScopePrincipal(proof, input), proofFacts(proof)], {
    concurrency: 2,
  });
  // Symmy resolves its own companyless admission by route and principal. Delegation to an owner
  // always carries the signed operation restriction, regardless of the owner's company scope.
  if (input.audience === symmyAudience && principal.legalEntityId === undefined) {
    return { compositionRevision: facts.compositionRevision, kind: 'symmy' as const, principal };
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
  if (
    input.audience !== symmyAudience &&
    routeScopeInput.operations.every(
      ({ entrypointKey, schemaVersion }) =>
        gatewayPublishedOperationAccess(destination, entrypointKey, schemaVersion) === 'read',
    )
  ) {
    const mapped = routeScopeInput.operations.flatMap((operation) => {
      const approved = nativeReadOperations.find(
        ([moduleId, entrypointKey]) =>
          moduleId === destination.manifest.module.id &&
          entrypointKey === operation.entrypointKey &&
          operation.schemaVersion === '1',
      );
      return approved === undefined ? [] : [{ operation, workloadKey: approved[2] }];
    });
    const workloadKeys = new Set(mapped.map(({ workloadKey }) => workloadKey));
    const [workloadKey] = workloadKeys;
    if (workloadKeys.size > 1) {
      return yield* delegationForbidden('symmy_route_not_admitted')();
    }
    if (workloadKey !== undefined) {
      const receiver = yield* selectNativeReadReceiver(facts, route, workloadKey);
      const readAttemptId = yield* (yield* Crypto.Crypto)
        .randomUUIDv4()
        .pipe(Effect.mapError(delegationUnavailable('symmy_route_unavailable')));
      const nativePrincipal = yield* Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)({
        authContextRef: `job:integration.symmy.route-read:run:${readAttemptId}`,
        authMethod: 'system',
        principalId: receiver.principalId,
        tenantId: principal.tenantId,
      }).pipe(Effect.mapError(delegationForbidden('symmy_route_not_admitted')));
      const nativeReadReceiver = {
        bindingIncarnation: receiver.bindingIncarnation,
        originalPrincipalId: facts.principal.principalId,
        originalWorkloadBindingIncarnation: receiver.originalWorkloadBindingIncarnation,
        originalWorkloadKey: receiver.originalWorkloadKey,
        workloadKey,
      };
      const nativeScope = yield* Schema.decodeUnknownEffect(RegisteredGatewayRouteScopeSchema)({
        ...routeScopeInput,
        nativeReadReceiver:
          route.legalEntityId === undefined
            ? nativeReadReceiver
            : { ...nativeReadReceiver, enrollmentLegalEntityId: route.legalEntityId },
        operations: mapped.map(({ operation }) => operation),
        principalId: receiver.principalId,
      }).pipe(Effect.mapError(delegationUnavailable('symmy_route_unavailable')));
      return {
        kind: 'native_read' as const,
        witness: new AdmittedSymmyNativeReadValue(nativeReadMintKey, {
          audience: input.audience,
          compositionRevision: facts.compositionRevision,
          principal: nativePrincipal,
          routeScope: nativeScope,
        }),
      };
    }
  }
  const routeScope = yield* Schema.decodeUnknownEffect(RegisteredGatewayRouteScopeSchema)(routeScopeInput).pipe(
    Effect.mapError(delegationUnavailable('symmy_route_unavailable')),
  );
  return {
    audience: input.audience,
    compositionRevision: facts.compositionRevision,
    kind: 'route' as const,
    principal,
    routeScope,
  };
});
