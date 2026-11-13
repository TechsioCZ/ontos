import { OperationContextUnavailable } from '@app/core-runtime';
import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import { and, eq } from 'drizzle-orm';
import { Clock, DateTime, Effect, Predicate, Ref, Schema, SchemaIssue } from 'effect';
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

const STORED_DECODE_WARNING_INTERVAL_MS = 60_000;
/** When each company's ledger last warned, and how many failures it has not reported since. */
const storedDecodeWarnings = Ref.makeUnsafe(new Map<string, { readonly at: number; readonly unreported: number }>());
const pathSegment = (segment: PropertyKey | { readonly key: PropertyKey }) =>
  String(Predicate.hasProperty(segment, 'key') ? segment.key : segment);
const STORED_RULE_NOT_MET = 'rule not met';
const STORED_ISSUE_KIND = /^[A-Z][A-Za-z]+$/u;
/**
 * The field path and the KIND of each failure, never a value: the ledger holds amounts, e-mails and parties. Messages
 * come from the issue's kind and a fixed text; one the formatter composes itself becomes "invalid".
 */
const formatStoredIssues = SchemaIssue.makeFormatterStandardSchemaV1({
  checkHook: () => STORED_RULE_NOT_MET,
  leafHook: (issue) => issue._tag,
});
const storedReason = (message: string) =>
  message === STORED_RULE_NOT_MET || STORED_ISSUE_KIND.test(message) ? message : 'invalid';

/**
 * A company's stored ledger that does not decode on a read: the read stays unavailable (the decoder is never relaxed),
 * and one WARN names the module, tenant, company, document, field path and reason, at most once a minute per company,
 * with how many failures that line stands for. No value of the ledger is logged.
 */
const warnUndecodableState = Effect.fn('Finance.warnUndecodableState')(function* warnUndecodableState(
  scope: Pick<OperationalScope, 'legalEntityId' | 'tenantId'>,
  error: Schema.SchemaError,
) {
  const now = yield* Clock.currentTimeMillis;
  const key = `${scope.tenantId}|${scope.legalEntityId ?? ''}`;
  const failures = yield* Ref.modify(storedDecodeWarnings, (warnings) => {
    const last = warnings.get(key);
    const quiet = last !== undefined && now - last.at < STORED_DECODE_WARNING_INTERVAL_MS;
    const next = new Map([
      ...warnings,
      [key, quiet ? { at: last.at, unreported: last.unreported + 1 } : { at: now, unreported: 0 }] as const,
    ]);
    return [quiet ? 0 : 1 + (last?.unreported ?? 0), next] as const;
  });
  if (failures === 0) {
    return;
  }
  yield* Effect.logWarning("A company's stored finance ledger does not decode; the read answers unavailable").pipe(
    Effect.annotateLogs({
      company: scope.legalEntityId ?? null,
      document: 'finance_billing.finance_states.state',
      failures,
      issues: formatStoredIssues(error.issue).issues.map((issue) => ({
        path: (issue.path ?? []).map(pathSegment).join('.'),
        reason: storedReason(issue.message),
      })),
      module: 'finance.billing',
      tenant: scope.tenantId,
    }),
  );
});

/**
 * Missing owner state is an empty company; only an Action save materializes the first revision. `scope` names the
 * company in the WARN a read writes when the stored ledger does not decode.
 */
export const decodeFinanceState = Effect.fn('Finance.decodeState')(function* decodeFinanceState(
  row: StateRow | undefined,
  scope?: Pick<OperationalScope, 'legalEntityId' | 'tenantId'>,
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
  const state = yield* Schema.decodeEffect(FinanceStateSchema)(row.state).pipe(
    Effect.tapError((error) => (scope === undefined ? Effect.void : warnUndecodableState(scope, error))),
    Effect.mapError(unavailable),
  );
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
  const loadSearchStateRow = () =>
    transaction
      .select({
        legalEntityId: financeStates.legalEntityId,
        revision: financeStates.revision,
        state: financeStates.state,
        tenantId: financeStates.tenantId,
      })
      .from(financeStates)
      .where(scopeWhere)
      .limit(1)
      .pipe(
        Effect.mapError(unavailable),
        Effect.flatMap(([row]) => {
          if (row === undefined) {
            return Effect.succeed<StateRow | undefined>(row);
          }
          if (row.tenantId !== scope.tenantId || row.legalEntityId !== legalEntityId) {
            return Effect.fail(unavailable());
          }
          return Effect.succeed<StateRow>({ revision: row.revision, state: row.state });
        }),
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
    loadSearchStateRow,
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
