import { Option, Result, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { SYMMY_BULK_IMPORT_ROUTE_KEYS, SymmyRouteSettingsSchema } from '../../shared/actions/manage-symmy-routes.ts';
import type { SymmyManagedRouteKey } from '../../shared/actions/manage-symmy-routes.ts';
import {
  symmyFamilyRefusals,
  symmyRetentionRefusals,
  symmyRouteInventoryOf,
  symmyRouteRequestRefusals,
} from '../../src/ops/symmy-route-enrollment.ts';
import type { SymmyRouteEnrollmentRequest } from '../../src/ops/symmy-route-enrollment.ts';
import {
  symmyManagedRetentionPolicy,
  symmyManagedRouteId,
  symmyManagedRouteRequest,
} from '../../src/ops/symmy-route-templates.ts';

const scope = {
  legalEntityId: '22222222-2222-4222-8222-222222222222',
  principalId: '44444444-4444-4444-8444-444444444444',
  tenantId: '11111111-1111-4111-8111-111111111111',
};
const source = { issuerId: 'symmy-akros', sourceNamespace: 'akros-erp' };
const reads: ReadonlySet<SymmyManagedRouteKey> = new Set<SymmyManagedRouteKey>([
  'adminCustomers',
  'adminProducts',
  'adminRegions',
  'priceLists',
]);

const requestOf = (routeKey: SymmyManagedRouteKey): SymmyRouteEnrollmentRequest => {
  const decoded = symmyManagedRouteRequest({
    routeKey,
    scope,
    settings: Schema.decodeUnknownSync(SymmyRouteSettingsSchema)(
      reads.has(routeKey) ? { source } : { retentionDays: 30, source },
    ),
  });
  if (Result.isFailure(decoded)) {
    throw new Error(decoded.failure.message);
  }
  return decoded.success;
};
const enrolled = (request: SymmyRouteEnrollmentRequest) => ({
  ...request,
  legalEntityId: request.legalEntityId ?? null,
});

describe('Symmy routes a tenant administrator enables', () => {
  it('enrolls every bulk-import and read family as a route the enrollment accepts', () => {
    for (const routeKey of [...SYMMY_BULK_IMPORT_ROUTE_KEYS, 'adminRegions'] as const) {
      const request = requestOf(routeKey);
      const inventory = Option.getOrThrow(symmyRouteInventoryOf(routeKey));
      expect([routeKey, symmyRouteRequestRefusals(request, inventory)]).toEqual([routeKey, []]);
      expect(request.legalEntityId).toBe(scope.legalEntityId);
      expect(request.routeId).toBe(symmyManagedRouteId(scope, routeKey));
    }
  });

  it('gives the routes of one source one logical source, so their readers and writers agree', () => {
    for (const [reader, writer] of [
      ['adminProducts', 'productsBatch'],
      ['adminCustomers', 'customersBatch'],
      ['priceLists', 'priceListsBatchUpsert'],
    ] as const) {
      expect(symmyFamilyRefusals(enrolled(requestOf(writer)), [enrolled(requestOf(reader))])).toEqual([]);
    }
  });

  it('pins a retention policy row that exactly one admission match finds, and none on a read', () => {
    const products = requestOf('productsBatch');
    const policy = Result.getOrThrow(symmyManagedRetentionPolicy(products, scope, 30));
    expect(symmyRetentionRefusals(products, [policy])).toEqual([]);
    expect(symmyRetentionRefusals(products, [])).toHaveLength(1);
    expect(requestOf('adminProducts').lifecyclePolicy).toBeUndefined();
  });

  it('derives the same route on every enable, and another for another company or principal', () => {
    expect(requestOf('customersBatch').routeId).toBe(requestOf('customersBatch').routeId);
    expect(symmyManagedRouteId({ ...scope, legalEntityId: scope.tenantId }, 'customersBatch')).not.toBe(
      requestOf('customersBatch').routeId,
    );
    expect(symmyManagedRouteId({ ...scope, principalId: scope.tenantId }, 'customersBatch')).not.toBe(
      requestOf('customersBatch').routeId,
    );
  });
});
