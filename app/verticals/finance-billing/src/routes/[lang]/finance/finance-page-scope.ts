import { pageDataScopeKey } from '@app/shared-contracts/page-data';
import type { ModulePageContext } from '@app/shared-contracts/page-data';

/**
 * The Shell's verified page scope (tenant, company, principal) for Finance; undefined without a trusted context.
 * Ledgers, reference lists, the actor label, revisions and commands are not unique across scopes, so every Finance
 * cache entry and remembered proposal belongs to exactly one scope, and a page without one reads and writes nothing.
 */
export const financePageScope = (context: ModulePageContext | undefined): string | undefined =>
  pageDataScopeKey(context, 'finance.billing');
