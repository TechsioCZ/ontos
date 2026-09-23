import type { CatalogFactScope, CatalogSourceAuthority } from './catalog-source-resolution.ts';

/**
 * One deployment fact→authority grant: one issuing system is authoritative for exactly one fact on
 * one target kind inside one Tenant. The transport that delivered an assertion (integration route,
 * connector, batch job) is deliberately not representable here, so moving data can never create
 * authority.
 */
export interface CatalogSourceAuthorityGrant {
  readonly factKey: string;
  readonly issuerSystemId: string;
  readonly targetKind: CatalogFactScope['targetKind'];
  readonly tenantId: string;
}

export interface CatalogSourceAuthorityRequest {
  /** Delivery metadata is accepted only to be ignored; it can never decide authority. */
  readonly deliveredVia?: {
    readonly connectorRef?: string;
    readonly integrationRouteRef?: string;
  };
  readonly issuerSystemId: string;
  readonly scope: CatalogFactScope;
}

const hasText = (value: string): boolean => value.trim().length > 0;

const grantMatches = (grant: CatalogSourceAuthorityGrant, request: CatalogSourceAuthorityRequest): boolean =>
  grant.tenantId === request.scope.tenantId &&
  grant.targetKind === request.scope.targetKind &&
  grant.factKey === request.scope.factKey &&
  grant.issuerSystemId === request.issuerSystemId;

/**
 * Resolve `VERIFIED` authority only from an explicit deployment grant for the exact Tenant, target
 * kind, fact, and issuer. An unqualified scope or an unknown fact/issuer pair yields `null`, which
 * the pure resolver turns into `NO_AUTHORITY`; a connector or route reference never participates.
 */
export const resolveCatalogSourceAuthority = (
  grants: readonly CatalogSourceAuthorityGrant[],
  request: CatalogSourceAuthorityRequest,
): CatalogSourceAuthority | null => {
  if (
    !hasText(request.issuerSystemId) ||
    !hasText(request.scope.factKey) ||
    !hasText(request.scope.targetId) ||
    !hasText(request.scope.tenantId)
  ) {
    return null;
  }
  const grant = grants.find((candidate) => grantMatches(candidate, request));
  return grant === undefined
    ? null
    : { issuerSystemId: grant.issuerSystemId, scope: request.scope, status: 'VERIFIED' };
};
