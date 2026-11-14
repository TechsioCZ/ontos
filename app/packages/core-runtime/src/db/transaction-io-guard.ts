import type { PgClient } from '@effect/sql-pg';
import type { SqlError } from 'effect/sql/SqlError';
import { Context, Data, Effect, Option, Predicate, Schema, flow } from 'effect';
import type { Borrower } from 'effect/sql/SqlConnection';
import { FetchHttpClient } from 'effect/http';

/**
 * What must never run between BEGIN and COMMIT of a governed operation: every one of them would hold the
 * transaction's pooled connection idle while it waits on something else.
 */
export const TransactionIoSchema = Schema.Literals([
  'module-transport',
  'outbound-fetch',
  'pool-acquisition',
  'spicedb',
]);
export type TransactionIo = typeof TransactionIoSchema.Type;

/** A defect: owner code reached remote I/O or a second pooled connection inside a database transaction. */
export class IoInsideDatabaseTransaction extends Data.TaggedError('IoInsideDatabaseTransaction')<{
  readonly io: TransactionIo;
  readonly operationKey: string;
  readonly target: string;
}> {
  override get message(): string {
    return `${this.io} (${this.target}) ran inside the database transaction of ${this.operationKey}. Do remote work in the owner prepare or finish step, and read the database only through the transaction's own executor.`;
  }
}

type Fetch = typeof globalThis.fetch;

interface OpenTransaction {
  readonly operationKey: string;
  /** The fiber's fetch before the outermost mark replaced it; only a declared evidence call gets it back. */
  readonly originalFetch: Fetch;
  /** Fetch refusals surface as transport failures, which owner code may map away; the mark re-raises them. */
  readonly refusedFetches: IoInsideDatabaseTransaction[];
}

/** The governed operation whose database transaction is open on this fiber. */
export const OpenDatabaseTransaction = Context.Reference<Option.Option<OpenTransaction>>(
  '@app/core-runtime/db/transaction-io-guard/OpenDatabaseTransaction',
  { defaultValue: Option.none },
);

/**
 * One owner proof read that main's source-evidence design makes from inside its write transaction, because its
 * request can only be derived there (DEPLOYMENT.md, demo divergence: declared in-transaction evidence calls).
 * `owner` is the owning module id; `evidence` is a short stable name of the proof.
 */
export interface DeclaredEvidenceCall {
  readonly evidence: string;
  readonly owner: string;
}

interface SuspendedTransaction {
  readonly declaration: DeclaredEvidenceCall;
  readonly transaction: OpenTransaction;
}

/** The marked transaction a declared evidence call suspended: its connection is still held. */
const DeclaredEvidenceCallTransaction = Context.Reference<Option.Option<SuspendedTransaction>>(
  '@app/core-runtime/db/transaction-io-guard/DeclaredEvidenceCallTransaction',
  { defaultValue: Option.none },
);

/**
 * Dies when the fiber runs inside a marked database transaction. Every Core transport calls it first. A declared
 * evidence call lifts the remote refusals, never the pool refusal: its transaction still holds its connection.
 */
export const refuseInsideDatabaseTransaction = (io: TransactionIo, target: string): Effect.Effect<void> =>
  Effect.flatMap(
    Effect.all([Effect.service(OpenDatabaseTransaction), Effect.service(DeclaredEvidenceCallTransaction)]),
    ([open, suspended]) => {
      const refusing = Option.isSome(open)
        ? Option.some(open.value.operationKey)
        : io === 'pool-acquisition'
          ? Option.map(suspended, ({ transaction }) => transaction.operationKey)
          : Option.none<string>();
      return Option.isNone(refusing)
        ? Effect.void
        : Effect.die(new IoInsideDatabaseTransaction({ io, operationKey: refusing.value, target }));
    },
  );

const isRequest = Schema.is(Schema.instanceOf(Request));

/** Origin and path only: a query string may carry credentials. */
const fetchTarget = (input: Request | URL | string): string => {
  const url = URL.parse(isRequest(input) ? input.url : String(input));
  return url === null ? 'unparseable URL' : `${url.origin}${url.pathname}`;
};

/** Every Effect HTTP client built on `FetchHttpClient` reads its fetch from the fiber; inside a mark it refuses. */
const refusingFetch = (open: OpenTransaction) =>
  flow(
    (input: Request | URL | string) => {
      const refusal = new IoInsideDatabaseTransaction({
        io: 'outbound-fetch',
        operationKey: open.operationKey,
        target: fetchTarget(input),
      });
      open.refusedFetches.push(refusal);
      return refusal;
    },
    Promise.reject.bind(Promise)<Response>,
  );

/**
 * Marks `effect` as the body of the named operation's database transaction: SpiceDB, module transport,
 * outbound fetch, and a second pool acquisition all die inside it. Apply it inside the transaction, after
 * its own connection is acquired.
 */
export const insideDatabaseTransaction =
  (operationKey: string) =>
  <Value, Failure, Requirements>(
    effect: Effect.Effect<Value, Failure, Requirements>,
  ): Effect.Effect<Value, Failure, Requirements> =>
    Effect.flatMap(
      Effect.all([Effect.service(OpenDatabaseTransaction), Effect.service(FetchHttpClient.Fetch)]),
      ([outer, currentFetch]) => {
      const open: OpenTransaction = {
        operationKey,
        // A nested mark keeps the outermost original, never an outer mark's refusing fetch.
        originalFetch: Option.isSome(outer) ? outer.value.originalFetch : currentFetch,
        refusedFetches: [],
      };
      return effect.pipe(
        Effect.updateService(FetchHttpClient.Fetch, () => refusingFetch(open)),
        Effect.updateService(OpenDatabaseTransaction, () => Option.some(open)),
        Effect.exit,
        Effect.flatMap((exit) => {
          const [refusal] = open.refusedFetches;
          return refusal === undefined ? exit : Effect.die(refusal);
        }),
      );
      },
    );

/**
 * Runs one declared owner evidence call inside a marked transaction: within `effect` only, the mark reads as
 * absent (SpiceDB and module transport are not refused) and fetch is the one the outermost mark replaced. A
 * second pool acquisition still dies, and statements through the transaction's own client still join it. Outside
 * a marked transaction it is the identity. Every use is pinned in the declared evidence call inventory.
 */
export const declaredEvidenceCallInsideTransaction =
  (declaration: DeclaredEvidenceCall) =>
  <Value, Failure, Requirements>(
    effect: Effect.Effect<Value, Failure, Requirements>,
  ): Effect.Effect<Value, Failure, Requirements> =>
    Effect.flatMap(Effect.service(OpenDatabaseTransaction), (open) =>
      Option.isNone(open)
        ? effect
        : effect.pipe(
            Effect.updateService(FetchHttpClient.Fetch, () => open.value.originalFetch),
            Effect.updateService(OpenDatabaseTransaction, () => Option.none()),
            Effect.updateService(DeclaredEvidenceCallTransaction, () =>
              Option.some({ declaration, transaction: open.value }),
            ),
          ),
    );

/** A statement that borrows its connection (no scoped lease) when it runs outside a transaction. */
const BorrowingStatementSchema = Schema.Struct({
  borrower: Schema.declare<Borrower>((value): value is Borrower => Predicate.isFunction(value)),
});
const isBorrowingStatement = Schema.is(BorrowingStatementSchema);

/**
 * Runs `acquisition` before every statement, transaction or reservation of `client`. A failure is a
 * SqlError, so callers keep the statement's own error channel.
 *
 * A statement reaches its connection only through its `acquirer` (pooled checkout) or `borrower` (borrowed
 * connection), whichever way it runs: yielded directly, `values`, `raw`, `unprepared`, `withoutTransform` or
 * `stream`. Guarding those two members covers every execution path.
 */
export const beforePoolAcquisition = (
  client: PgClient.PgClient,
  acquisition: Effect.Effect<void, SqlError>,
): PgClient.PgClient => {
  const guardStatement = <Statement extends object>(statement: Statement): Statement =>
    new Proxy(statement, {
      get: (target, key, receiver) => {
        const value: unknown = Reflect.get(target, key, receiver);
        if (key === 'acquirer' && Effect.isEffect(value)) {
          // @effect-diagnostics-next-line anyUnknownInErrorContext:off -- Proxy boundary: the statement's own connection checkout passes through unchanged.
          return Effect.andThen(acquisition, value);
        }
        if (key === 'borrower' && isBorrowingStatement(target)) {
          const { borrower } = target;
          const guarded: Borrower = (run) => Effect.andThen(acquisition, borrower(run));
          return guarded;
        }
        return value;
      },
    });
  const unsafe: PgClient.PgClient['unsafe'] = (sql, params) => guardStatement(client.unsafe(sql, params));
  const withTransaction: PgClient.PgClient['withTransaction'] = (effect) =>
    Effect.andThen(acquisition, client.withTransaction(effect));
  const guardedMembers = new Map<PropertyKey, unknown>([
    ['reserve', Effect.andThen(acquisition, client.reserve)],
    ['unsafe', unsafe],
    ['withTransaction', withTransaction],
  ]);
  return new Proxy(client, {
    get: (target, key, receiver) => {
      const member: unknown = guardedMembers.has(key) ? guardedMembers.get(key) : Reflect.get(target, key, receiver);
      return member;
    },
  });
};

/**
 * The Core pool, guarded: a statement or transaction that would check out a connection other than the
 * open transaction's own dies inside a marked transaction. Statements on the transaction's connection
 * (the client's transaction service is present) and nested savepoints pass.
 */
export const guardPoolAcquisition = (client: PgClient.PgClient): PgClient.PgClient =>
  beforePoolAcquisition(
    client,
    Effect.flatMap(Effect.serviceOption(client.transactionService), (connection) =>
      Option.isSome(connection)
        ? Effect.void
        : refuseInsideDatabaseTransaction('pool-acquisition', 'PostgreSQL connection pool'),
    ),
  );
