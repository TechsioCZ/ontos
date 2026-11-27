/**
 * What a company says about itself on the Shell's Home (`core.legal_entities.welcome`): part of the Shell frame every
 * member of the company sees on its welcome page, not the company's legal identity. Read inside the caller's Core
 * transaction, so the governed read's tenant scope applies; the identity record itself stays behind its own read.
 */
import { and, eq } from 'drizzle-orm';
import { Context, Effect, Option } from 'effect';

import { legalEntities } from '../db/schema.ts';
import type { CoreDatabaseExecutor } from '../db/types.ts';
import { LegalEntityWelcomeUnavailableError } from './legal-entity-welcome-unavailable-error.ts';

export { LegalEntityWelcomeUnavailableError } from './legal-entity-welcome-unavailable-error.ts';

export interface LegalEntityWelcomeContract {
  /** The company's own Home text; none when it provides no text. */
  readonly readWelcome: (
    tenantId: string,
    legalEntityId: string,
  ) => Effect.Effect<Option.Option<string>, LegalEntityWelcomeUnavailableError>;
}

export class LegalEntityWelcome extends Context.Service<LegalEntityWelcome, LegalEntityWelcomeContract>()(
  '@app/core-runtime/modules/legal-entity-welcome/LegalEntityWelcome',
) {}

/** Reads within the caller's Core transaction, so the tenant scope of the governed read applies. */
export const makeLegalEntityWelcome = (database: {
  readonly executor: Pick<CoreDatabaseExecutor, 'select'>;
}): LegalEntityWelcomeContract => ({
  readWelcome: (tenantId, legalEntityId) =>
    database.executor
      .select({ welcome: legalEntities.welcome })
      .from(legalEntities)
      .where(and(eq(legalEntities.tenantId, tenantId), eq(legalEntities.legalEntityId, legalEntityId)))
      .limit(1)
      .pipe(
        Effect.map(([row]) => Option.fromNullishOr(row?.welcome)),
        Effect.mapError(
          (cause) =>
            new LegalEntityWelcomeUnavailableError({
              cause,
              code: 'legal_entity_welcome_unavailable',
              reason: 'The company welcome text is temporarily unavailable',
            }),
        ),
      ),
});
