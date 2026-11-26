/**
 * `integration.symmy.manage-symmy-routes`: a tenant administrator enrolls, replaces and disables the Symmy routes of
 * one integration principal in the selected company. Symmy is a connector partner: the Shell's integration flow creates
 * the integration principal and its managed API key, then enables the route families the partner may use here.
 */
import { PrincipalIdSchema } from '@app/core-runtime/auth/external-identity-contracts';
import { PriceSourceSystemSchema } from '@app/pricing-contracts/domain/price-source-provenance';
import { SymmyRouteContextSchema } from '@app/shared-contracts/symmy';
import { Schema } from 'effect';

import { SymmyFixtureExecutionPlanSchema } from '../domain/symmy-job-execution.ts';
import { SymmyLifecycleRouteIdSchema } from '../domain/symmy-job-notification.ts';

/** The Symmy ingress route families a tenant administrator may enable (`SYMMY_ROUTES` without the job poll). */
export const SymmyManagedRouteKeySchema = Schema.Literals([
  'adminCustomers',
  'adminProducts',
  'adminRegions',
  'customerGroupCustomersBatch',
  'customerGroupsBatch',
  'customersBatch',
  'inventoryStockBatch',
  'priceListPricesBatch',
  'priceLists',
  'priceListsBatchUpsert',
  'productsBatch',
]);
export type SymmyManagedRouteKey = typeof SymmyManagedRouteKeySchema.Type;

/**
 * The route families a migration-style bulk import (for example a company moving from another ERP) enables at once:
 * every durable or item-result write of the catalog, customers, price lists and prices, with the reads that prove what
 * was imported. Stock and Customer Group memberships need owner references and are enabled one by one.
 */
export const SYMMY_BULK_IMPORT_ROUTE_KEYS = [
  'priceLists',
  'adminProducts',
  'adminCustomers',
  'productsBatch',
  'customersBatch',
  'customerGroupsBatch',
  'priceListsBatchUpsert',
] as const satisfies readonly SymmyManagedRouteKey[];

const routeCode = Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(300));
const changeToken = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

/** What one route is enabled with. Owner references are named only by the routes that need them. */
export const SymmyRouteSettingsSchema = Schema.Struct({
  /** Only `inventoryStockBatch`, and `productsBatch` when it provisions stock items: the tenant Inventory policy. */
  inventorySource: SymmyFixtureExecutionPlanSchema.fields.inventorySource,
  /** Only `priceLists`: the source system the route pages a list's prices from. */
  priceReadSource: Schema.optionalKey(PriceSourceSystemSchema),
  /** Only the routes that write prices, with `pricingSourceSystem`: the grant refs of a price assertion. */
  priceSource: SymmyFixtureExecutionPlanSchema.fields.priceSource,
  pricingSourceSystem: SymmyFixtureExecutionPlanSchema.fields.pricingSourceSystem,
  /** Required by every write route and forbidden on a read: how long its admitted work is kept, in days. */
  retentionDays: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(3650)),
  ),
  /** Only `customerGroupCustomersBatch`: the Customer Group its route code selects. */
  selector: SymmyFixtureExecutionPlanSchema.fields.selector,
  /** The partner's source identity every record of the route is asserted under. */
  source: Schema.Struct({
    issuerId: SymmyRouteContextSchema.fields.issuerId,
    sourceNamespace: SymmyRouteContextSchema.fields.sourceNamespace,
  }),
});
export type SymmyRouteSettings = typeof SymmyRouteSettingsSchema.Type;

/**
 * Enables one route: without a change token it enrolls a new route, or leaves the same enrolled route unchanged; with
 * the token of the stored route it replaces or re-enables that route, refused while the route has outstanding work.
 */
export const SymmyRouteEnableSchema = Schema.Struct({
  expectedChangeToken: Schema.optionalKey(changeToken),
  kind: Schema.Literal('enable'),
  routeCode: Schema.optionalKey(routeCode),
  routeKey: SymmyManagedRouteKeySchema,
  settings: SymmyRouteSettingsSchema,
});
/** Disables the stored route at the change token the administrator read; its outstanding work is stranded. */
export const SymmyRouteDisableSchema = Schema.Struct({
  expectedChangeToken: changeToken,
  kind: Schema.Literal('disable'),
  routeCode: Schema.optionalKey(routeCode),
  routeKey: SymmyManagedRouteKeySchema,
});
export const SymmyRouteChangeRequestSchema = Schema.Union([SymmyRouteEnableSchema, SymmyRouteDisableSchema]);
export type SymmyRouteChangeRequest = typeof SymmyRouteChangeRequestSchema.Type;

export const ManageSymmyRoutesPayloadSchema = Schema.Struct({
  /** Applied in order, all or nothing: a read route a write route depends on comes first. */
  changes: Schema.NonEmptyArray(SymmyRouteChangeRequestSchema).check(Schema.isMaxLength(16)),
  /** The `integration` principal of the Tenant Symmy authenticates as through its managed API key. */
  integrationPrincipalId: PrincipalIdSchema,
  /** Recorded with every route change. */
  reason: Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(500)),
});
export type ManageSymmyRoutesPayload = typeof ManageSymmyRoutesPayloadSchema.Type;

export const SymmyManagedRouteOutcomeSchema = Schema.Struct({
  changeToken,
  outcome: Schema.Literals(['deactivated', 'enrolled', 'replaced', 'unchanged']),
  routeCode: Schema.optionalKey(routeCode),
  routeId: SymmyLifecycleRouteIdSchema,
  routeKey: SymmyManagedRouteKeySchema,
});
export const ManageSymmyRoutesResultSchema = Schema.Struct({
  routes: Schema.Array(SymmyManagedRouteOutcomeSchema),
});
export type ManageSymmyRoutesResult = typeof ManageSymmyRoutesResultSchema.Type;

export const ManageSymmyRoutesRefusalSchema = Schema.Struct({
  code: Schema.String,
  detail: Schema.String,
  /**
   * On `integration_binding_missing` and `integration_company_registration_missing`: the workloads, any one of which the
   * integration principal must hold registered for the company. Grant the first of each through
   * `core.identity.register-integration-workloads`, then repeat the route change.
   */
  workloads: Schema.optionalKey(Schema.NonEmptyArray(Schema.String)),
});

/** Every refusal of the run, so the administrator sees the whole list at once; nothing was written. */
export class ManageSymmyRoutesRejected extends Schema.TaggedError<ManageSymmyRoutesRejected>()(
  'ManageSymmyRoutesRejected',
  {
    code: Schema.Literals(['route_enrollment_refused', 'route_enrollment_unavailable']),
    reason: Schema.String,
    refusals: Schema.Array(ManageSymmyRoutesRefusalSchema),
  },
) {}
