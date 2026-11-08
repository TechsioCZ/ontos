import { eq } from 'drizzle-orm';
import { Context, Effect, Layer } from 'effect';

import { recoverSqlTransactionError } from '../../actions/repository.ts';
import { CoreDatabase } from '../../db/client.ts';
import { DatabaseIdentityEnrollmentContext } from '../../db/database-identities.ts';
import type { DatabaseIdentityEnrollment } from '../../db/database-identities.ts';
import { installOperationalScope } from '../../db/scoped-transaction.ts';
import { legalEntities } from '../../db/schema.ts';
import type { CoreDatabaseExecutor, CoreTransaction } from '../../db/types.ts';
import type { OperationalScope } from '../../operations/context.ts';
import { accessDecisionUnavailable } from '../decision/errors.ts';
import type { AccessDecisionUnavailable } from '../decision/errors.ts';
import type { LegalEntityId } from '../ids.ts';
import { LegalEntityIdSchema, TenantIdSchema } from '../ids.ts';

/**
 * The companies this tenant has at all. Which of them the actor may actually select is a question
 * for the engine (`access_legal_entity#select`), never for this read (O28, O64).
 */
export interface AccessLegalEntityCandidates {
  /**
   * `transaction` is a transaction the caller already owns (O75): a company list read beside an owner
   * Action's write must answer from that transaction, not from a second connection. A caller with no
   * transaction leaves it out and the read opens one of its own in the request's scope.
   */
  readonly listCandidateIds: (
    scope: OperationalScope,
    transaction?: CoreTransaction,
  ) => Effect.Effect<readonly LegalEntityId[], AccessDecisionUnavailable>;
}

/** The runtime binds the company list through this service tag. */
export class LegalEntityCandidates extends Context.Service<LegalEntityCandidates, AccessLegalEntityCandidates>()(
  '@app/core-runtime/access/enforcement/legal-entities/LegalEntityCandidates',
) {}

export interface AccessLegalEntityCandidateDatabase {
  /** The enrolled database identities whose scope authority the installed scope is verified against. */
  readonly enrollment: DatabaseIdentityEnrollment;
  readonly executor: CoreDatabaseExecutor;
}

const listCandidateIdsEffect = Effect.fn('AccessLegalEntityCandidates.listCandidateIds')(function* listCandidateIds(
  database: AccessLegalEntityCandidateDatabase,
  scope: OperationalScope,
  transaction?: CoreTransaction,
) {
  const read = (opened: CoreTransaction) =>
    installOperationalScope(opened, scope, database.enrollment).pipe(
      Effect.andThen(() =>
        opened
          .select({ legalEntityId: legalEntities.legalEntityId })
          .from(legalEntities)
          .where(eq(legalEntities.tenantId, TenantIdSchema.make(scope.tenantId))),
      ),
    );
  const rows = yield* transaction === undefined ? database.executor.transaction(read) : read(transaction);
  return rows.map(({ legalEntityId }) => LegalEntityIdSchema.make(legalEntityId));
});

export const makeDrizzleLegalEntityCandidates = (
  database: AccessLegalEntityCandidateDatabase,
): AccessLegalEntityCandidates => ({
  listCandidateIds: (scope, transaction) =>
    listCandidateIdsEffect(database, scope, transaction).pipe(
      recoverSqlTransactionError,
      Effect.mapError((cause) => accessDecisionUnavailable('The companies of this tenant could not be read', cause)),
    ),
});

export const LegalEntityCandidatesLive: Layer.Layer<
  LegalEntityCandidates,
  never,
  CoreDatabase | DatabaseIdentityEnrollmentContext
> = Layer.effect(
  LegalEntityCandidates,
  Effect.gen(function* legalEntityCandidatesLive() {
    const database = yield* CoreDatabase;
    const enrollment = yield* DatabaseIdentityEnrollmentContext;
    return makeDrizzleLegalEntityCandidates({ enrollment, executor: database.executor });
  }),
);
