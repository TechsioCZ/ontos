import { OperationContextUnavailable } from '@app/core-runtime';
import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import { and, eq } from 'drizzle-orm';
import { DateTime, Effect, Schema } from 'effect';
import { FinanceConflict, FinancePersistenceUnavailable } from '../../shared/actions/apply-command.ts';
import { FinanceStateSchema } from '../../shared/apis/records.ts';
import type { FinanceState } from '../../shared/apis/records.ts';
import { financeDocumentContents, financeStates } from '../database/schema.ts';

/* The scoped adapter stays apart from pure transitions so the worker bundle never imports request-time Core. */
type Transaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];
type EncodedState = typeof FinanceStateSchema.Encoded;
export interface StateRow {
  readonly revision: number;
  readonly state: EncodedState;
}
interface RevisionRow {
  readonly revision: number;
}
interface StatePersistence {
  readonly insert: (state: EncodedState) => Effect.Effect<readonly RevisionRow[], FinancePersistenceUnavailable>;
  readonly load: Effect.Effect<StateRow | undefined, FinancePersistenceUnavailable>;
  readonly update: (
    state: EncodedState,
    revision: number,
  ) => Effect.Effect<readonly RevisionRow[], FinancePersistenceUnavailable>;
}
const conflict = (reason: string) => new FinanceConflict({ code: 'finance_conflict', reason });
const unavailable = (cause?: Error) =>
  Object.defineProperty(
    new FinancePersistenceUnavailable({
      code: 'finance_persistence_unavailable',
      reason: 'Finance persistence is temporarily unavailable',
    }),
    'cause',
    { value: cause },
  );

/** Missing owner state is an empty company; only an Action save materializes the first revision. */
export const decodeFinanceState = Effect.fn('Finance.decodeState')(function* decodeFinanceState(
  row: StateRow | undefined,
) {
  if (row === undefined) {
    return {
      revision: 0,
      state: {
        financialPlanEntries: [],
        invoices: [],
      } satisfies FinanceState,
    };
  }
  const state = yield* Schema.decodeEffect(FinanceStateSchema)(row.state).pipe(Effect.mapError(unavailable));
  return { revision: row.revision, state };
});

export const financeStateRepository = (persistence: StatePersistence) => ({
  load: () => persistence.load.pipe(Effect.flatMap(decodeFinanceState)),
  save: Effect.fn('Finance.save')(function* save(state: FinanceState, expectedRevision: number) {
    const encoded = yield* Schema.encodeEffect(FinanceStateSchema)(state).pipe(Effect.mapError(unavailable));
    const updated = yield* persistence.update(encoded, expectedRevision);
    const [row] = updated;
    if (row !== undefined) {
      return row.revision;
    }
    if (expectedRevision === 0) {
      const [created] = yield* persistence.insert(encoded);
      if (created !== undefined) {
        return created.revision;
      }
    }
    return yield* conflict('stale_revision');
  }),
});

export interface StoredDocument {
  readonly contentBase64: string;
  readonly documentId: string;
  readonly mimeType: string;
}

export const persistenceService = (transaction: Transaction, scope: OperationalScope) => {
  const { legalEntityId } = scope;
  if (
    legalEntityId === undefined ||
    transaction.scope.tenantId !== scope.tenantId ||
    transaction.scope.legalEntityId !== legalEntityId
  ) {
    return Effect.fail(
      new OperationContextUnavailable({
        code: 'operation_context_unavailable',
        reason: 'A scoped Legal Entity transaction is required',
      }),
    );
  }
  const scopeWhere = and(eq(financeStates.tenantId, scope.tenantId), eq(financeStates.legalEntityId, legalEntityId));
  /** The stored row, still encoded: a read decodes it after its transaction commits. */
  const loadStateRow = transaction
    .select({ revision: financeStates.revision, state: financeStates.state })
    .from(financeStates)
    .where(scopeWhere)
    .limit(1)
    .pipe(
      Effect.mapError(unavailable),
      Effect.map(([row]): StateRow | undefined => row),
    );
  const documents = {
    loadDocument: (documentId: string) =>
      transaction
        .select()
        .from(financeDocumentContents)
        .where(
          and(
            eq(financeDocumentContents.tenantId, scope.tenantId),
            eq(financeDocumentContents.legalEntityId, legalEntityId),
            eq(financeDocumentContents.documentId, documentId),
          ),
        )
        .limit(1)
        .pipe(
          Effect.mapError(unavailable),
          Effect.map(([row]): StoredDocument | undefined => row),
        ),
    writeDocument: (document: StoredDocument) =>
      transaction
        .insert(financeDocumentContents)
        .values({ ...document, legalEntityId, tenantId: scope.tenantId })
        .onConflictDoNothing()
        .pipe(Effect.mapError(unavailable), Effect.asVoid),
  };
  return Effect.succeed({
    ...documents,
    loadStateRow: () => loadStateRow,
    ...financeStateRepository({
      insert: (state) =>
        DateTime.now.pipe(
          Effect.flatMap((now) =>
            transaction
              .insert(financeStates)
              .values({
                legalEntityId,
                revision: 1,
                state,
                tenantId: scope.tenantId,
                updatedAt: DateTime.toDateUtc(now),
              })
              .onConflictDoNothing()
              .returning({ revision: financeStates.revision })
              .pipe(Effect.mapError(unavailable)),
          ),
        ),
      load: loadStateRow,
      update: (state, revision) =>
        DateTime.now.pipe(
          Effect.flatMap((now) =>
            transaction
              .update(financeStates)
              .set({ revision: revision + 1, state, updatedAt: DateTime.toDateUtc(now) })
              .where(and(scopeWhere, eq(financeStates.revision, revision)))
              .returning({ revision: financeStates.revision })
              .pipe(Effect.mapError(unavailable)),
          ),
        ),
    }),
  });
};
