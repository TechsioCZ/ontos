/**
 * The per-Tenant modules approved for stage, in two explicit lists:
 *
 * - `stageActivationScopes`: what `activate-market-stage.mts`, the reviewed manual path, may activate;
 * - `stageReleaseTenantModules`: the pairs a release installs by itself when a Tenant still lacks them
 *   (`release-tenant-modules.mts`, run by the app host after it publishes the composition; additive only, it never
 *   changes a state a person set). Every pair is reviewed into it one by one and must also be a manual pair; adding a
 *   module to the manual list never makes a release install it.
 *
 * `commerce.tax` is the one source of VAT rates and seller VAT regime, so every stage Tenant that sells or
 * invoices gets it, and only where one of `sellingModuleKeys` is already active. The local development (`…0010`)
 * and verification (`…0090`) Tenants are not listed: neither sells nor invoices (the verification Tenant runs Tasks
 * only), and the selling-module check would refuse them anyway.
 */
import { Result } from 'effect';

import { demoTenantId } from './fixture-ids.mts';
import { N1_TENANT_ID } from './n1-stage-grants.mts';

export const taxModuleKey = 'commerce.tax';
export const stageMarketModuleKeys = [
  'commerce.market-catalog',
  'commerce.storefront-registry',
  taxModuleKey,
  'projects.core',
  'work.tasks',
] as const;
export type StageMarketModuleKey = (typeof stageMarketModuleKeys)[number];

/** The AKROS playground Tenant on stage (its storefront sells for its one company). */
export const AKROS_PLAYGROUND_TENANT_ID = 'bceaa540-13eb-5508-9ac0-9ed7e40a2ee9';

/** The modules approved to be active tenant-wide, per Tenant; nothing else is installed by either path. */
export const stageActivationScopes: readonly {
  readonly moduleKeys: readonly StageMarketModuleKey[];
  readonly tenantId: string;
}[] = [
  // The e-shop market modules, Projekty and the tax module of the six demo companies.
  {
    moduleKeys: ['commerce.market-catalog', 'commerce.storefront-registry', taxModuleKey, 'projects.core'],
    tenantId: demoTenantId,
  },
  // The N1 storefront files every contact and product inquiry as a Task, and sells through its catalogue.
  { moduleKeys: [taxModuleKey, 'work.tasks'], tenantId: N1_TENANT_ID },
  // The AKROS playground storefront sells for its one company.
  { moduleKeys: [taxModuleKey], tenantId: AKROS_PLAYGROUND_TENANT_ID },
];
export const stageActivationTenantIds = [demoTenantId, N1_TENANT_ID, AKROS_PLAYGROUND_TENANT_ID] as const;

/** Modules whose Tenant must already sell or invoice: any one of these modules active. */
export const sellingModuleKeys = ['demo.merchandise', 'finance.billing'] as const;
export const sellingPrerequisite: ReadonlySet<StageMarketModuleKey> = new Set([taxModuleKey]);

/**
 * The selling modules a plan records for one activation, or why it is refused. A module that needs a selling
 * Tenant is refused unless the Tenant already has merchandise or billing active; other modules record none.
 */
export const activationSellingEvidence = (
  moduleKey: StageMarketModuleKey,
  activeModuleKeys: readonly string[],
): Result.Result<readonly (typeof sellingModuleKeys)[number][], string> => {
  if (!sellingPrerequisite.has(moduleKey)) {
    return Result.succeed([]);
  }
  const selling = sellingModuleKeys.filter((key) => activeModuleKeys.includes(key));
  return selling.length > 0
    ? Result.succeed(selling)
    : Result.fail(
        `${moduleKey} is installed only where the Tenant sells or invoices: neither ${sellingModuleKeys.join(' nor ')} is active`,
      );
};

/** One module a release installs where a Tenant still lacks it, with the selling modules it needs. */
export interface StageReleaseTenantModule {
  readonly moduleKey: StageMarketModuleKey;
  readonly sellingModuleKeys: readonly (typeof sellingModuleKeys)[number][];
  readonly tenantId: string;
}

/** The release's own list, today exactly `commerce.tax` for the three selling Tenants. */
export const stageReleaseTenantModules: readonly StageReleaseTenantModule[] = [
  { moduleKey: taxModuleKey, sellingModuleKeys, tenantId: demoTenantId },
  { moduleKey: taxModuleKey, sellingModuleKeys, tenantId: N1_TENANT_ID },
  { moduleKey: taxModuleKey, sellingModuleKeys, tenantId: AKROS_PLAYGROUND_TENANT_ID },
];
