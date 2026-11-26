import type {
  SymmyManagedRouteKey,
  SymmyRouteChangeRequestSchema,
} from '@app/symmy-integration/actions/manage-symmy-routes';
import type { SymmyCompanyRoutesResponse } from '@app/symmy-integration/api/symmy-company-routes';

/*
 * What the Shell's Symmy panel asks `integration.symmy.manage-symmy-routes` for. Symmy is a connector partner: the
 * administrator names the partner's source identity once, and the panel enables the route families the partner reads
 * and writes in the selected company. Route families that need owner references (stock, prices of a list, customer
 * group memberships, price-list upserts) are enabled outside this panel.
 */
export const SYMMY_PANEL_READ_ROUTES = ['adminProducts', 'adminCustomers', 'adminRegions', 'priceLists'] as const;
export const SYMMY_PANEL_WRITE_ROUTES = ['productsBatch', 'customersBatch', 'customerGroupsBatch'] as const;
type PanelRouteKey = (typeof SYMMY_PANEL_READ_ROUTES)[number] | (typeof SYMMY_PANEL_WRITE_ROUTES)[number];
/** Reads first: a write route that depends on a read is applied after it (the Action applies changes in order). */
export const SYMMY_PANEL_ROUTES: readonly PanelRouteKey[] = [...SYMMY_PANEL_READ_ROUTES, ...SYMMY_PANEL_WRITE_ROUTES];
export const SYMMY_DEFAULT_RETENTION_DAYS = 30;
/** The pricing owner module a Symmy price list's prices are read from (the partner's source system). */
const SYMMY_PRICE_OWNER_MODULE = 'external.symmy';

const writeRoutes: ReadonlySet<SymmyManagedRouteKey> = new Set(SYMMY_PANEL_WRITE_ROUTES);

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
  return writeRoutes.has(routeKey) ? { retentionDays, source } : { source };
};

const baseRoute = (routes: readonly CompanyRoute[], routeKey: SymmyManagedRouteKey) =>
  routes.find((route) => route.routeKey === routeKey && route.routeCode === undefined);

/** The panel's route families not active in the company yet, in panel order. */
export const symmyPendingRoutes = (routes: readonly CompanyRoute[]): readonly PanelRouteKey[] =>
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
