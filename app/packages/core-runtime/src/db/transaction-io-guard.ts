import type { PgClient } from '@effect/sql-pg';
import { Context, Data, Effect, Option, Schema } from 'effect';
import { FetchHttpClient } from 'effect/unstable/http';

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

interface OpenTransaction {
  readonly operationKey: string;
  /** Fetch refusals surface as transport failures, which owner code may map away; the mark re-raises them. */
  readonly refusedFetches: IoInsideDatabaseTransaction[];
}

/** The governed operation whose database transaction is open on this fiber. */
export const OpenDatabaseTransaction = Context.Reference<Option.Option<OpenTransaction>>(
  '@app/core-runtime/db/transaction-io-guard/OpenDatabaseTransaction',
  { defaultValue: Option.none },
);

/** Dies when the fiber runs inside a marked database transaction. Every Core transport calls it first. */
export const refuseInsideDatabaseTransaction = (io: TransactionIo, target: string): Effect.Effect<void> =>
  Effect.flatMap(Effect.service(OpenDatabaseTransaction), (open) =>
    Option.isNone(open)
      ? Effect.void
      : Effect.die(new IoInsideDatabaseTransaction({ io, operationKey: open.value.operationKey, target })),
  );

const isRequest = Schema.is(Schema.instanceOf(Request));

/** Origin and path only: a query string may carry credentials. */
const fetchTarget = (input: Request | URL | string): string => {
  const url = URL.parse(isRequest(input) ? input.url : String(input));
  return url === null ? 'unparseable URL' : `${url.origin}${url.pathname}`;
};

/** Every Effect HTTP client built on `FetchHttpClient` reads its fetch from the fiber; inside a mark it refuses. */
const refusingFetch =
  (open: OpenTransaction) =>
  // oxlint-disable-next-line typescript/promise-function-async -- Native `fetch` contract: the refusal is a rejected Promise, recorded first so the mark re-raises it.
  (input: Request | URL | string): Promise<Response> => {
    const refusal = new IoInsideDatabaseTransaction({
      io: 'outbound-fetch',
      operationKey: open.operationKey,
      target: fetchTarget(input),
    });
    open.refusedFetches.push(refusal);
    return Promise.reject(refusal);
  };

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
    Effect.suspend(() => {
      const open: OpenTransaction = { operationKey, refusedFetches: [] };
      return effect.pipe(
        // oxlint-disable-next-line effect-native/no-effect-provide-in-library -- The transaction mark is this seam: inside it every FetchHttpClient refuses.
        Effect.provideService(FetchHttpClient.Fetch, refusingFetch(open)),
        // oxlint-disable-next-line effect-native/no-effect-provide-in-library -- The transaction mark itself, read by every Core transport guard.
        Effect.provideService(OpenDatabaseTransaction, Option.some(open)),
        Effect.exit,
        Effect.flatMap((exit) => {
          const [refusal] = open.refusedFetches;
          return refusal === undefined ? exit : Effect.die(refusal);
        }),
      );
    });

const statementExecutions = new Set<PropertyKey>([
  'raw',
  'unprepared',
  'values',
  'valuesUnprepared',
  'withoutTransform',
]);

/**
 * The Core pool, guarded: a statement or transaction that would check out a connection other than the
 * open transaction's own dies inside a marked transaction. Statements on the transaction's connection
 * (the client's transaction service is present) and nested savepoints pass.
 */
export const guardPoolAcquisition = (client: PgClient.PgClient): PgClient.PgClient => {
  const acquisition = Effect.flatMap(Effect.serviceOption(client.transactionService), (connection) =>
    Option.isSome(connection)
      ? Effect.void
      : refuseInsideDatabaseTransaction('pool-acquisition', 'PostgreSQL connection pool'),
  );
  const guardStatement = <Statement extends object>(statement: Statement): Statement =>
    new Proxy(statement, {
      get: (target, key, receiver) => {
        // oxlint-disable-next-line anti-slop/no-reflect-get -- Proxy trap over the native statement: every member passes through unchanged.
        const value: unknown = Reflect.get(target, key, receiver);
        // @effect-diagnostics-next-line anyUnknownInErrorContext:off -- Proxy boundary: the statement's own execution Effect passes through unchanged.
        return statementExecutions.has(key) && Effect.isEffect(value) ? Effect.andThen(acquisition, value) : value;
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
      // oxlint-disable-next-line anti-slop/no-reflect-get -- Proxy trap over the native client: unguarded members pass through unchanged.
      const member: unknown = guardedMembers.has(key) ? guardedMembers.get(key) : Reflect.get(target, key, receiver);
      return member;
    },
  });
};
