import type { EffectDrizzleQueryError } from 'drizzle-orm/effect-core';
import type { PgTransactionConfig } from 'drizzle-orm/pg-core';
import { Context, DateTime, Effect, Match, Option, Result } from 'effect';
import type { SqlError } from 'effect/sql/SqlError';

import { isDatabaseIntegrityRefusal, isDatabaseUnavailableFailure } from '../../database/driver-failure.ts';
import { isPostgresUniqueViolation } from '../../database/postgres-failure.ts';
import { installOperationalScope } from '../../db/scoped-transaction.ts';
import type { CoreDatabaseExecutor, CoreTransaction } from '../../db/types.ts';
import type { OperationalScope } from '../../operations/context.ts';
import type { PrincipalId } from '../ids.ts';
import type { Holder } from '../model.ts';
import type { AccessIntentError } from './errors.ts';
import { intentConflict, intentUnavailable } from './errors.ts';

/*
 * The plumbing the three access intent modules share: the request-scoped transaction (O66), the
 * failure taxonomy, the row decoders and the guards that keep a command inside its scope. Nothing
 * here knows what a membership, a team or a projection is.
 */

/** The Core executor the intent stores are built over; the caller owns the pool and its deadlines. */
export interface AccessIntentDatabase {
  readonly executor: CoreDatabaseExecutor;
}

/** One unit of work inside a transaction of the request's scope, and the failures it may name. */
export type ScopedTransactionBody<Value> = (
  transaction: CoreTransaction,
) => Effect.Effect<Value, AccessIntentStoreFailure>;

/**
 * WHERE a scoped read or write gets its transaction (O66, O75).
 *
 * The two cases are different capabilities, and this interface names them instead of dressing one as
 * the other:
 *
 * - `requestTransactions` opens ONE transaction per call on the pool. It owns the boundary and the
 *   options: it applies the isolation the work asks for (a `scopedRead` is REPEATABLE READ), commits
 *   when the body succeeds and rolls back when it fails.
 * - `callerTransactions` uses the transaction the caller already opened and still owns. It opens
 *   nothing, applies no options, starts no savepoint and never ends that transaction: the caller's
 *   COMMIT or ROLLBACK is the only boundary. Its snapshot is the caller's — whatever isolation the
 *   caller started it with — so a `scopedRead` over it does NOT claim REPEATABLE READ and a caller
 *   that needs one snapshot across several statements must have opened its transaction at that level
 *   before handing it over. Nothing here can upgrade it, and nothing pretends to.
 *
 * Both install and verify the request's operational scope on the transaction they use before the
 * body reads or writes, so row-level security admits the request's tenant rows and no other's (O66).
 */
export interface AccessTransactions {
  /** The snapshot `scopedRead` runs on: one the request asked for, or the caller's own. */
  readonly readIsolation: 'request-repeatable-read' | 'caller-transaction';
  readonly scoped: <Value>(
    scope: OperationalScope,
    constraints: ReadonlySet<string>,
    body: ScopedTransactionBody<Value>,
  ) => Effect.Effect<Value, AccessIntentError>;
  readonly scopedRead: <Value>(
    scope: OperationalScope,
    constraints: ReadonlySet<string>,
    body: ScopedTransactionBody<Value>,
  ) => Effect.Effect<Value, AccessIntentError>;
}

/** A query failure the caller still has to name: the driver's, or one this module proved itself. */
export type AccessIntentStoreFailure = EffectDrizzleQueryError | SqlError | AccessIntentError;

/** The driver may hand a timestamp back as text; the model takes a `Date`, so both land as one. */
export const asDate = (value: Date | string): Date => DateTime.toDateUtc(DateTime.makeUnsafe(value));

/** The one holder column pair a row stores; SQL keeps exactly one of the two filled. */
export const holderColumns = (
  holder: Holder,
): { readonly agentId: string | null; readonly principalId: string | null } =>
  Match.value(holder).pipe(
    Match.tag('Agent', ({ agentId }) => ({ agentId, principalId: null })),
    Match.tag('Principal', ({ principalId }) => ({ agentId: null, principalId })),
    Match.exhaustive,
  );

/** The person behind a holder: an agent is never folded into the person it acts for (guarantee 4). */
export const principalIdOf = (holder: Holder): Option.Option<PrincipalId> =>
  Match.value(holder).pipe(
    Match.tag('Principal', ({ principalId }) => Option.some(principalId)),
    Match.tag('Agent', () => Option.none<PrincipalId>()),
    Match.exhaustive,
  );

/**
 * The model omits an absent column value while the column stores null, and `exactOptionalPropertyTypes`
 * forbids stating `undefined`: both mean "not declared", so both leave the key out. The result is a
 * partial of exactly that one key, so spreading it into a model object stays typed.
 */
export const optionalProperty = <Base extends object, Key extends string, Value>(
  base: Base,
  key: Key,
  value: Value | null | undefined,
): Base & Partial<Record<Key, Value>> => (value === null || value === undefined ? base : { ...base, [key]: value });

/**
 * A write PostgreSQL refused. A uniqueness collision on one of this store's own indexes is a race the
 * caller repairs by re-reading, exactly like a lost compare-and-set; another integrity refusal means
 * the intent contradicts a rule it has to satisfy; and only a connectivity, capacity or shutdown
 * failure is retryable unavailability, so a driver failure is never reported as a decision about the
 * data.
 */
const sqlFailure = (
  failure: SqlError | EffectDrizzleQueryError,
  constraints: ReadonlySet<string>,
): AccessIntentError => {
  if (isPostgresUniqueViolation(failure, constraints)) {
    return intentConflict(
      'access_intent_record_conflict',
      'another writer already stored the intent this command claims',
    );
  }
  if (isDatabaseIntegrityRefusal(failure)) {
    return intentConflict(
      'access_intent_write_refused',
      'PostgreSQL refused the write: the stored intent contradicts a rule this record must satisfy',
    );
  }
  return intentUnavailable(
    isDatabaseUnavailableFailure(failure)
      ? 'The access intent store is unavailable'
      : 'The access intent store could not settle the write',
    failure,
  );
};

/** Only the driver failures this module understands are named; a bug stays a defect and is never retried. */
export const durable =
  (constraints: ReadonlySet<string>) =>
  <Value>(effect: Effect.Effect<Value, AccessIntentStoreFailure>): Effect.Effect<Value, AccessIntentError> =>
    effect.pipe(
      Effect.catchTags({
        EffectDrizzleQueryError: (failure) => Effect.fail(sqlFailure(failure, constraints)),
        SqlError: (failure) => Effect.fail(sqlFailure(failure, constraints)),
      }),
    );

/**
 * Every read and write of these modules runs in one tenant scope and only in that tenant's rows
 * (O66). The scope is installed on the transaction before anything is read, because the access tables
 * force tenant row-level security on `ontos_runtime`; the loader and the stores never bind a tenant to
 * themselves and never take one from the record they are asked to write.
 */
const scopeInstalledIn = <Value>(
  transaction: CoreTransaction,
  scope: OperationalScope,
  body: ScopedTransactionBody<Value>,
): Effect.Effect<Value, AccessIntentStoreFailure> =>
  installOperationalScope(transaction, scope).pipe(
    Effect.mapError((failure) => intentUnavailable('The tenant scope could not be installed', failure)),
    Effect.andThen(() => body(transaction)),
  );

/**
 * The ordinary source of a request: one transaction per call on the pool, with the options the work
 * asks for and the pool's own boundary around it (O66).
 */
export const requestTransactions = (database: AccessIntentDatabase): AccessTransactions => {
  const open = <Value>(
    config: PgTransactionConfig | undefined,
    scope: OperationalScope,
    constraints: ReadonlySet<string>,
    body: ScopedTransactionBody<Value>,
  ): Effect.Effect<Value, AccessIntentError> =>
    database.executor
      .transaction((transaction) => scopeInstalledIn(transaction, scope, body), config)
      .pipe(durable(constraints));
  return {
    readIsolation: 'request-repeatable-read',
    scoped: <Value>(scope: OperationalScope, constraints: ReadonlySet<string>, body: ScopedTransactionBody<Value>) =>
      open(undefined, scope, constraints, body),
    scopedRead: <Value>(
      scope: OperationalScope,
      constraints: ReadonlySet<string>,
      body: ScopedTransactionBody<Value>,
    ) =>
      // A read asks for its own snapshot. Inside a caller's transaction Effect SQL would make this a
      // savepoint on the caller's client, where PostgreSQL refuses the isolation level once the caller
      // has run a statement (SQLSTATE 25001), so the read leaves that transaction for the pool.
      Effect.updateContext(open({ isolationLevel: 'repeatable read' }, scope, constraints, body), (context) =>
        Context.omit(database.executor.$client.transactionService)(context),
      ),
  };
};

/**
 * The transaction a caller opened and still owns (O75). Every read and write of a store built over it
 * runs in that transaction, so a decision is proved from what the transaction its receipt is part of
 * sees — the only source a claim inside an owner Action may use, because a second connection answers
 * about another instant and one connection cannot open another transaction at all.
 *
 * What this source does NOT do is as deliberate as what it does: it opens no transaction, so it applies
 * no isolation option and starts no savepoint, and it never ends the caller's transaction. The snapshot
 * is the caller's own; a reader that needs several statements on one snapshot must be handed a
 * transaction the caller opened at that level.
 */
export const callerTransactions = (transaction: CoreTransaction): AccessTransactions => {
  const joined = <Value>(
    scope: OperationalScope,
    constraints: ReadonlySet<string>,
    body: ScopedTransactionBody<Value>,
  ): Effect.Effect<Value, AccessIntentError> => scopeInstalledIn(transaction, scope, body).pipe(durable(constraints));
  return { readIsolation: 'caller-transaction', scoped: joined, scopedRead: joined };
};

/** A command's transaction keeps PostgreSQL's default isolation; its writes are the point. */
export const runScoped = <Value>(
  database: AccessIntentDatabase,
  scope: OperationalScope,
  constraints: ReadonlySet<string>,
  body: ScopedTransactionBody<Value>,
): Effect.Effect<Value, AccessIntentError> => requestTransactions(database).scoped(scope, constraints, body);

/**
 * The isolation a reader of intent asks for: REPEATABLE READ, which is the narrowest level that makes
 * the several SELECTs of one read answer from ONE snapshot.
 *
 * A read here is never one statement. The loader asks for the scope rows and then the memberships, or
 * for a whole tenant projection and then the raw memberships again, and a decision is only coherent if
 * those answers belong to the same instant: under READ COMMITTED each statement takes a fresh
 * snapshot, so a membership suspended between two of them is mixed into a picture that still carries
 * the grant it revoked. REPEATABLE READ fixes the snapshot at the transaction's first statement and
 * keeps every later read on it, so a concurrent writer can neither half-apply nor be half-observed.
 *
 * This helper is the POOL source of a request, which can ask for that level. The same body read
 * through `callerTransactions` gets the caller's snapshot instead: PostgreSQL fixes a transaction's
 * isolation when it starts, so a joined read reports `readIsolation: 'caller-transaction'` rather than
 * claiming a level it did not open.
 *
 * The loader's read paths opt into this level; intent stores continue to use `runScoped` with the
 * default isolation. Neither helper makes the transaction READ ONLY: callers must keep their bodies
 * read-only. A driver-reported failure is propagated rather than silently changing snapshots.
 */
export const runScopedRead = <Value>(
  database: AccessIntentDatabase,
  scope: OperationalScope,
  constraints: ReadonlySet<string>,
  body: ScopedTransactionBody<Value>,
): Effect.Effect<Value, AccessIntentError> => requestTransactions(database).scopedRead(scope, constraints, body);

/**
 * A command naming another tenant than the installed scope is refused before SQL sees it: row
 * security would hide the row anyway, and a silent no-op is not an answer to a cross-tenant write.
 */
export const scopeIssue = (scope: OperationalScope, tenantIds: readonly string[]): string | null => {
  const foreign = tenantIds.find((tenantId) => tenantId !== scope.tenantId);
  return foreign === undefined
    ? null
    : `the command names tenant ${foreign} while the installed scope is tenant ${scope.tenantId}`;
};

/** The acting person of a command is the request's, never the command body's (O66). */
export const actorIssue = (scope: OperationalScope, recordedBy: string): string | null =>
  recordedBy === scope.principalId
    ? null
    : `the record is attributed to ${recordedBy}, not to the scoped person ${scope.principalId}`;

interface MessageIssue {
  readonly message: string;
}

/** A row that no longer decodes as the model is intent the store refuses to serve as if it were valid. */
export const decodeStored = <Value, Issue extends MessageIssue>(
  result: Result.Result<Value, Issue>,
  subject: string,
): Effect.Effect<Value, AccessIntentError> =>
  Result.match(result, {
    onFailure: (failure) =>
      Effect.fail(
        intentConflict('access_intent_record_conflict', `the stored ${subject} is invalid: ${failure.message}`),
      ),
    onSuccess: (decoded) => Effect.succeed(decoded),
  });
