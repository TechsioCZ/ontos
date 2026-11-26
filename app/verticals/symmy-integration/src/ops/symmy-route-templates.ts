/**
 * The route a tenant administrator enables, derived from the route family alone: the route enrolls every owner
 * operation of its family's inventory (`symmyRouteInventoryOf`) that it can serve with the settings it names, and the
 * routes of one source share one logical source route per Tenant, principal, company and family. The operations
 * that need an owner reference are enrolled only with it: prices with a price source, stock item provisioning with an
 * Inventory policy. Catalog readiness needs an operator's explicit Unit and locale and is never enabled here.
 *
 * Everything here is decided without I/O; the enrollment store checks the result against Core, the composition and the
 * sibling routes, exactly as for any route.
 */
import { stableUuid } from '@app/core-runtime/access/catalog';
import { Option, Schema } from 'effect';

import type { SymmyManagedRouteKey, SymmyRouteSettings } from '../../shared/actions/manage-symmy-routes.ts';
import { SymmyJobRetentionPolicySchema } from '../../shared/domain/symmy-job-retention.ts';
import { reviseOperation } from '../persistence/symmy-price-batch-plan.ts';
import { priceOperation } from '../persistence/symmy-price-list-plan.ts';
import { provisionStockItemOperation, readinessOperations } from '../persistence/symmy-product-plan.ts';
import { SymmyRouteEnrollmentRequestSchema, symmyRouteInventoryOf } from './symmy-route-enrollment.ts';
import type { SymmyOwnerOperation, SymmyRouteEnrollmentRequest } from './symmy-route-enrollment.ts';

const DAY_MS = 86_400_000;
type Mutable<T> = { -readonly [Key in keyof T]: T[Key] };
/** A route configuration as the enrollment request carries it before it is decoded. */
type SymmyRouteConfigurationInput = (typeof SymmyRouteEnrollmentRequestSchema.Encoded)['configuration'];
/** A route a tenant administrator enrolls is revision `v1`; a replacement at token N is revision `cN`. */
export const SYMMY_MANAGED_ROUTE_FIRST_REVISION = 'v1';
const MAPPING_VERSION = 'v1';

/** The record type the route's items name when no operation decides it. */
const defaultEntityKind = {
  adminCustomers: 'CUSTOMER',
  adminProducts: 'PRODUCT',
  adminRegions: 'REGION',
  customerGroupCustomersBatch: 'CUSTOMER_GROUP',
  customerGroupsBatch: 'CUSTOMER_GROUP',
  customersBatch: 'CUSTOMER',
  inventoryStockBatch: 'STOCK',
  priceListPricesBatch: 'PRICE',
  priceLists: 'PRICE_GROUP',
  priceListsBatchUpsert: 'PRICE_GROUP',
  productsBatch: 'PRODUCT',
} as const satisfies Readonly<Record<SymmyManagedRouteKey, string>>;
/** The logical source of the routes that share one (`symmySourceFamilyPeers`): products, customers, groups, prices. */
const sourceFamily = {
  adminCustomers: 'customers',
  adminProducts: 'products',
  adminRegions: 'regions',
  customerGroupCustomersBatch: 'customerGroups',
  customerGroupsBatch: 'customerGroups',
  customersBatch: 'customers',
  inventoryStockBatch: 'products',
  priceListPricesBatch: 'priceLists',
  priceLists: 'priceLists',
  priceListsBatchUpsert: 'priceLists',
  productsBatch: 'products',
} as const satisfies Readonly<Record<SymmyManagedRouteKey, string>>;

const sameOperation = (left: SymmyOwnerOperation, right: SymmyOwnerOperation) =>
  left.moduleId === right.moduleId &&
  left.entrypointKey === right.entrypointKey &&
  left.schemaVersion === right.schemaVersion;
const priceWrites = [priceOperation, reviseOperation];

/** Whom and where a route is enabled for. */
export interface SymmyManagedRouteScope {
  /** The administrator's selected company. */
  readonly legalEntityId: string;
  readonly principalId: string;
  readonly tenantId: string;
}

/** The stock route asserts for the Tenant's one Inventory backend and names no company; every other route does. */
export const symmyManagedRouteCompany = (routeKey: SymmyManagedRouteKey, scope: SymmyManagedRouteScope) =>
  routeKey === 'inventoryStockBatch' ? undefined : scope.legalEntityId;

/** The physical route of one family, code and company of one principal: the same on every enable. */
export const symmyManagedRouteId = (
  scope: SymmyManagedRouteScope,
  routeKey: SymmyManagedRouteKey,
  routeCode?: string,
) =>
  stableUuid(
    [
      'integration.symmy.route',
      scope.tenantId,
      scope.principalId,
      symmyManagedRouteCompany(routeKey, scope) ?? 'tenant',
      routeKey,
      routeCode ?? '',
    ].join(':'),
  );

/** The logical source route every route of one family of the principal in the company names. */
export const symmyManagedSourceRouteId = (scope: SymmyManagedRouteScope, routeKey: SymmyManagedRouteKey) =>
  stableUuid(
    ['integration.symmy.source', scope.tenantId, scope.principalId, scope.legalEntityId, sourceFamily[routeKey]].join(
      ':',
    ),
  );

/** The operations of the family the settings let the route serve. */
const servedOperations = (routeKey: SymmyManagedRouteKey, settings: SymmyRouteSettings) =>
  Option.match(symmyRouteInventoryOf(routeKey), {
    onNone: () => [],
    onSome: ({ operations }) =>
      operations.filter(
        (operation) =>
          !readinessOperations.some((readiness) => sameOperation(readiness, operation)) &&
          (settings.priceSource !== undefined || !priceWrites.some((write) => sameOperation(write, operation))) &&
          (settings.inventorySource !== undefined || !sameOperation(provisionStockItemOperation, operation)),
      ),
  });

/** A route configuration while its optional settings are added. */
type SymmyRouteConfigurationDraft = Mutable<SymmyRouteConfigurationInput>;
/** An enrollment request while its optional fields are added. */
type SymmyRouteEnrollmentRequestDraft = Mutable<typeof SymmyRouteEnrollmentRequestSchema.Encoded>;

/** The route configuration: one template item per record type, each naming the operations read from it. */
export const symmyManagedRouteConfiguration = (
  scope: SymmyManagedRouteScope,
  routeKey: SymmyManagedRouteKey,
  settings: SymmyRouteSettings,
) => {
  const byKind = new Map<string, SymmyOwnerOperation[]>();
  for (const operation of servedOperations(routeKey, settings)) {
    const kind =
      operation.caller === 'executor' && operation.entityKind !== undefined
        ? operation.entityKind
        : defaultEntityKind[routeKey];
    byKind.set(kind, [...(byKind.get(kind) ?? []), operation]);
  }
  const itemOf = ([entityKind, operations]: readonly [string, readonly SymmyOwnerOperation[]]) => ({
    effects: operations.map(({ entrypointKey, moduleId, schemaVersion }, index) => ({
      effectKey: `operation-${String(index)}`,
      operation: { entrypointKey, moduleId, schemaVersion },
    })),
    itemKey: `template-${entityKind.toLowerCase()}`,
    source: { entityKind, ...settings.source, sourceRecordId: 'ENROLLMENT_TEMPLATE' },
  });
  // Every family serves at least one operation; an item stating no work is refused when the request is decoded.
  const [first = [defaultEntityKind[routeKey], []], ...rest] = byKind.entries();
  const sourceRouteId = symmyManagedSourceRouteId(scope, routeKey);
  const configuration: SymmyRouteConfigurationDraft = {
    items: [itemOf(first), ...rest.map(itemOf)],
    sourceMappingVersion: MAPPING_VERSION,
    sourceRouteId,
    sourceRouteRevision: SYMMY_MANAGED_ROUTE_FIRST_REVISION,
  };
  if (settings.priceSource !== undefined) {
    Object.assign(configuration, { priceSource: settings.priceSource });
  }
  if (settings.pricingSourceSystem !== undefined) {
    Object.assign(configuration, { pricingSourceSystem: settings.pricingSourceSystem });
  }
  if (settings.inventorySource !== undefined) {
    Object.assign(configuration, {
      inventoryBackendId: settings.inventorySource.issuer.backendId,
      inventorySource: settings.inventorySource,
    });
  }
  if (settings.selector !== undefined) {
    // A membership route writes to a group its source created: the group route of this family.
    Object.assign(configuration, {
      selector: {
        ...settings.selector,
        source: {
          ...settings.selector.source,
          route: { integrationRouteId: sourceRouteId, tenantId: scope.tenantId },
        },
      },
    });
  }
  return configuration;
};

/** The lifecycle policy a write route pins: one revision per retention, so a new retention replaces the route. */
export const symmyManagedLifecyclePolicy = (routeKey: SymmyManagedRouteKey, retentionDays: number) => ({
  policyId: `symmy-${routeKey}`,
  revision: `${String(retentionDays)}d`,
});

/** The route enrollment request one enable makes, at the revision its change names. */
export const symmyManagedRouteRequest = (input: {
  readonly expectedChangeToken?: number;
  readonly routeCode?: string;
  readonly routeKey: SymmyManagedRouteKey;
  readonly scope: SymmyManagedRouteScope;
  readonly settings: SymmyRouteSettings;
}) => {
  const { expectedChangeToken, routeCode, routeKey, scope, settings } = input;
  const legalEntityId = symmyManagedRouteCompany(routeKey, scope);
  const request: SymmyRouteEnrollmentRequestDraft = {
    configuration: symmyManagedRouteConfiguration(scope, routeKey, settings),
    mappingVersion: MAPPING_VERSION,
    principalId: scope.principalId,
    routeId: symmyManagedRouteId(scope, routeKey, routeCode),
    routeKey,
    routeRevision:
      expectedChangeToken === undefined ? SYMMY_MANAGED_ROUTE_FIRST_REVISION : `c${String(expectedChangeToken)}`,
    tenantId: scope.tenantId,
  };
  if (legalEntityId !== undefined) {
    request.legalEntityId = legalEntityId;
  }
  if (routeCode !== undefined) {
    request.routeCode = routeCode;
  }
  if (settings.retentionDays !== undefined) {
    request.lifecyclePolicy = symmyManagedLifecyclePolicy(routeKey, settings.retentionDays);
  }
  return Schema.decodeUnknownResult(SymmyRouteEnrollmentRequestSchema, { onExcessProperty: 'error' })(request);
};

/** The retention policy row the route's lifecycle policy names, governed by the administrator's company. */
export const symmyManagedRetentionPolicy = (
  request: SymmyRouteEnrollmentRequest,
  scope: SymmyManagedRouteScope,
  retentionDays: number,
) =>
  Schema.decodeUnknownResult(SymmyJobRetentionPolicySchema)({
    governanceLegalEntityId: scope.legalEntityId,
    policyId: request.lifecyclePolicy?.policyId,
    retentionMs: retentionDays * DAY_MS,
    revision: request.lifecyclePolicy?.revision,
    routeId: request.routeId,
    targetLegalEntityId: request.legalEntityId ?? null,
    tenantId: scope.tenantId,
  });
