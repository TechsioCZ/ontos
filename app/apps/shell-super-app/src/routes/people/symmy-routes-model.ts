import { SYMMY_ROUTES } from '@app/shared-contracts/symmy';
import { SYMMY_BULK_IMPORT_ROUTE_KEYS } from '@app/symmy-integration/actions/manage-symmy-routes';
import type {
  SymmyManagedRouteKey,
  SymmyRouteChangeRequestSchema,
} from '@app/symmy-integration/actions/manage-symmy-routes';
import type { SymmyCompanyRoutesResponse } from '@app/symmy-integration/api/symmy-company-routes';

/*
 * What the Shell's Symmy panel asks `integration.symmy.manage-symmy-routes` for. Symmy is a connector partner: the
 * administrator names the partner's source identity once, and the panel enables the route families the partner reads
 * and writes in the selected company: Symmy's own bulk-import set (`SYMMY_BULK_IMPORT_ROUTE_KEYS`) and the region read.
 * Route families that need owner references (stock, prices of a list, customer group memberships) are enabled outside
 * this panel.
 */
/** A write route keeps its admitted work for a retention; a read route keeps none. */
const isWriteRoute = (routeKey: SymmyManagedRouteKey) => SYMMY_ROUTES[routeKey].method !== 'GET';
/** Symmy's bulk-import set and the region read its orders need, reads first (the Action applies changes in order). */
const panelRoutes: readonly SymmyManagedRouteKey[] = [
  ...new Set([...SYMMY_BULK_IMPORT_ROUTE_KEYS, 'adminRegions' as const]),
];
export const SYMMY_PANEL_ROUTES: readonly SymmyManagedRouteKey[] = [
  ...panelRoutes.filter((routeKey) => !isWriteRoute(routeKey)),
  ...panelRoutes.filter(isWriteRoute),
];
export const SYMMY_DEFAULT_RETENTION_DAYS = 30;
/** The pricing owner module a Symmy price list's prices are read from (the partner's source system). */
const SYMMY_PRICE_OWNER_MODULE = 'external.symmy';

type CompanyRoute = SymmyCompanyRoutesResponse['routes'][number];
/** A change as the panel builds it from the administrator's input; the panel decodes it before it is sent. */
export type SymmyRouteChangeInput = typeof SymmyRouteChangeRequestSchema.Encoded;
type RouteSettingsInput = Extract<SymmyRouteChangeInput, { readonly kind: 'enable' }>['settings'];

export interface SymmyRouteSetup {
  readonly issuerId: string;
  readonly retentionDays: number;
  readonly routeKeys: readonly SymmyManagedRouteKey[];
  readonly sourceNamespace: string;
}

/** A write keeps its admitted work for the retention; a price-list read pages prices from the partner's source. */
const routeSettings = (
  routeKey: SymmyManagedRouteKey,
  retentionDays: number,
  source: RouteSettingsInput['source'],
): RouteSettingsInput => {
  if (routeKey === 'priceLists') {
    return { priceReadSource: { ownerModuleId: SYMMY_PRICE_OWNER_MODULE, sourceSystemRef: source.issuerId }, source };
  }
  return isWriteRoute(routeKey) ? { retentionDays, source } : { source };
};

const baseRoute = (routes: readonly CompanyRoute[], routeKey: SymmyManagedRouteKey) =>
  routes.find((route) => route.routeKey === routeKey && route.routeCode === undefined);

/** The panel's route families not active in the company yet, in panel order. */
export const symmyPendingRoutes = (routes: readonly CompanyRoute[]): readonly SymmyManagedRouteKey[] =>
  SYMMY_PANEL_ROUTES.filter((routeKey) => baseRoute(routes, routeKey)?.active !== true);

/**
 * The enable changes for every chosen route that is not active yet, in panel order: a route never enrolled is
 * enrolled, a disabled one is re-enabled at its change token, an active one is left as it is.
 */
export const symmyEnableChanges = (
  setup: SymmyRouteSetup,
  routes: readonly CompanyRoute[],
): readonly SymmyRouteChangeInput[] => {
  const source = { issuerId: setup.issuerId.trim(), sourceNamespace: setup.sourceNamespace.trim() };
  const chosen = new Set(setup.routeKeys);
  return symmyPendingRoutes(routes).flatMap((routeKey): SymmyRouteChangeInput[] => {
    const stored = baseRoute(routes, routeKey);
    if (!chosen.has(routeKey)) {
      return [];
    }
    const settings = routeSettings(routeKey, setup.retentionDays, source);
    return [
      stored === undefined
        ? { kind: 'enable', routeKey, settings }
        : { expectedChangeToken: stored.changeToken, kind: 'enable', routeKey, settings },
    ];
  });
};

const bindingRefusals = new Set(['integration_binding_missing', 'integration_company_registration_missing']);

/**
 * The workloads to register for the integration before the route change can succeed, when every refusal is a missing
 * integration binding or company registration that names them; any other refusal is the administrator's to fix, so
 * the answer is then `null`. Of each refusal's alternatives the first is registered.
 */
export const symmyMissingWorkloads = (
  refusals: readonly { readonly code: string; readonly workloads?: readonly string[] | undefined }[],
): readonly [string, ...string[]] | null => {
  if (refusals.length === 0 || !refusals.every(({ code }) => bindingRefusals.has(code))) {
    return null;
  }
  const firsts = refusals.flatMap(({ workloads }) => workloads?.slice(0, 1) ?? []);
  if (firsts.length < refusals.length) {
    return null;
  }
  const [first, ...rest] = [...new Set(firsts)];
  return first === undefined ? null : [first, ...rest];
};
