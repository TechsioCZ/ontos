import { describe, expect, it } from 'effect-rstest';

import { resolveCatalogSourceAuthority } from '../../src/domain/catalog-source-authority.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const scope = {
  factKey: 'height',
  targetId: '22222222-2222-4222-8222-222222222222',
  targetKind: 'PRODUCT',
  tenantId,
} as const;
const grants = [{ factKey: 'height', issuerSystemId: 'source-1', targetKind: 'PRODUCT', tenantId }] as const;

describe('Catalog deployment source authority map', () => {
  it('verifies only the exact fact, target kind, Tenant, and issuer', () => {
    expect(resolveCatalogSourceAuthority(grants, { issuerSystemId: 'source-1', scope })).toEqual({
      issuerSystemId: 'source-1',
      scope,
      status: 'VERIFIED',
    });
    expect(resolveCatalogSourceAuthority(grants, { issuerSystemId: 'source-2', scope })).toBeNull();
    expect(
      resolveCatalogSourceAuthority(grants, { issuerSystemId: 'source-1', scope: { ...scope, factKey: 'width' } }),
    ).toBeNull();
    expect(
      resolveCatalogSourceAuthority(grants, { issuerSystemId: 'source-1', scope: { ...scope, targetKind: 'VARIANT' } }),
    ).toBeNull();
    expect(
      resolveCatalogSourceAuthority(grants, { issuerSystemId: 'source-1', scope: { ...scope, tenantId: 'other' } }),
    ).toBeNull();
  });

  it('never derives authority from the connector or route that delivered the data', () => {
    expect(
      resolveCatalogSourceAuthority([], {
        deliveredVia: { connectorRef: 'connector-1', integrationRouteRef: 'route-1' },
        issuerSystemId: 'source-1',
        scope,
      }),
    ).toBeNull();
    expect(
      resolveCatalogSourceAuthority(grants, {
        deliveredVia: { connectorRef: 'unrelated', integrationRouteRef: 'unrelated' },
        issuerSystemId: 'source-1',
        scope,
      }),
    ).toEqual({ issuerSystemId: 'source-1', scope, status: 'VERIFIED' });
  });

  it('returns no authority for an unqualified scope or issuer', () => {
    expect(
      resolveCatalogSourceAuthority(grants, { issuerSystemId: 'source-1', scope: { ...scope, tenantId: '' } }),
    ).toBeNull();
    expect(
      resolveCatalogSourceAuthority(grants, { issuerSystemId: 'source-1', scope: { ...scope, factKey: '  ' } }),
    ).toBeNull();
    expect(resolveCatalogSourceAuthority(grants, { issuerSystemId: '', scope })).toBeNull();
  });
});
