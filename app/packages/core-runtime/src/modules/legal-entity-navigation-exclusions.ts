/**
 * Per-company Shell navigation exclusions: tenant data naming page entrypoints a legal entity does not offer in its
 * navigation. Core and the Shell never name a module or a company; installation and seed tooling fill the rows.
 */
import { and, eq } from 'drizzle-orm';
import { Context, Effect } from 'effect';

import { legalEntityNavigationExclusions } from '../db/schema.ts';
import type { CoreDatabaseExecutor } from '../db/types.ts';
import { LegalEntityNavigationExclusionsUnavailableError } from './legal-entity-navigation-exclusions-unavailable-error.ts';

export { LegalEntityNavigationExclusionsUnavailableError } from './legal-entity-navigation-exclusions-unavailable-error.ts';

export interface LegalEntityNavigationExclusionsContract {
  /** Page entrypoint keys excluded from the navigation of one legal entity. */
  readonly listExcludedEntrypoints: (
    tenantId: string,
    legalEntityId: string,
  ) => Effect.Effect<ReadonlySet<string>, LegalEntityNavigationExclusionsUnavailableError>;
}

export class LegalEntityNavigationExclusions extends Context.Service<
  LegalEntityNavigationExclusions,
  LegalEntityNavigationExclusionsContract
>()('@app/core-runtime/modules/legal-entity-navigation-exclusions/LegalEntityNavigationExclusions') {}

/** Reads within the caller's Core transaction, so the tenant scope of the governed read applies. */
export const makeLegalEntityNavigationExclusions = (database: {
  readonly executor: Pick<CoreDatabaseExecutor, 'select'>;
}): LegalEntityNavigationExclusionsContract => ({
  listExcludedEntrypoints: (tenantId, legalEntityId) =>
    database.executor
      .select({ entrypointKey: legalEntityNavigationExclusions.entrypointKey })
      .from(legalEntityNavigationExclusions)
      .where(
        and(
          eq(legalEntityNavigationExclusions.tenantId, tenantId),
          eq(legalEntityNavigationExclusions.legalEntityId, legalEntityId),
        ),
      )
      .pipe(
        Effect.map((rows): ReadonlySet<string> => new Set(rows.map(({ entrypointKey }) => entrypointKey))),
        Effect.mapError(
          (cause) =>
            new LegalEntityNavigationExclusionsUnavailableError({
              cause,
              code: 'legal_entity_navigation_exclusions_unavailable',
              reason: 'Company navigation settings are temporarily unavailable',
            }),
        ),
      ),
});
