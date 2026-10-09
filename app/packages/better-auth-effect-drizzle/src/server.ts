import { AsyncResource } from 'node:async_hooks';

import type { BetterAuthOptions, DBPrimitive } from 'better-auth';
import { createAdapterFactory } from 'better-auth/adapters';
import type {
  AdapterFactoryConfig,
  AdapterFactoryCustomizeAdapterCreator,
  CleanedWhere,
  CustomAdapter,
  DBAdapter,
  DBTransactionAdapter,
  WhereOperator,
} from 'better-auth/adapters';
import {
  and,
  asc,
  count,
  desc,
  eq,
  getColumns,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  notInArray,
  or,
  sql,
} from 'drizzle-orm';
import type { AnyRelations, SQL, SQLWrapper } from 'drizzle-orm';
import type { EffectPgDatabase } from 'drizzle-orm/effect-postgres';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { Effect, flow, Predicate, Schema } from 'effect';
import type { SqlError } from 'effect/unstable/sql/SqlError';

/** A Better Auth model or field that the Drizzle tables passed to the adapter do not declare. */
export class EffectDrizzleAuthAdapterSchemaError extends Schema.TaggedError<EffectDrizzleAuthAdapterSchemaError>()(
  'EffectDrizzleAuthAdapterSchemaError',
  { reason: Schema.String },
) {}

/** Better Auth's `database` option; Better Auth resolves it once with its final options. */
export type EffectDrizzleAuthAdapter = (options: BetterAuthOptions) => DBAdapter;

/** Drizzle tables keyed by Better Auth model name. */
export type EffectDrizzleAuthTables = Readonly<Record<string, PgTable>>;

type Executor = Pick<EffectPgDatabase<AnyRelations>, 'delete' | 'insert' | 'select' | 'update'>;
type Row = Record<string, DBPrimitive>;
type FieldName = Parameters<AdapterFactoryCustomizeAdapterCreator>[0]['getFieldName'];

interface ModelTable {
  readonly column: (field: string) => Effect.Effect<PgColumn, EffectDrizzleAuthAdapterSchemaError>;
  readonly name: (field: string) => string;
  readonly table: PgTable;
}

const schemaError = (reason: string) => new EffectDrizzleAuthAdapterSchemaError({ reason });

const resolveModel =
  (tables: EffectDrizzleAuthTables, getFieldName: FieldName) =>
  (model: string): Effect.Effect<ModelTable, EffectDrizzleAuthAdapterSchemaError> => {
    const table = tables[model];
    if (table === undefined) {
      return Effect.fail(
        schemaError(`Better Auth model "${model}" has no Drizzle table; add the table to the adapter under that name`),
      );
    }
    const columns = getColumns(table);
    const name = (field: string) => getFieldName({ field, model });
    const column = (field: string) => {
      const found = columns[name(field)];
      return found === undefined
        ? Effect.fail(
            schemaError(`Better Auth field "${field}" of model "${model}" has no Drizzle column; add it to the table`),
          )
        : Effect.succeed(found);
    };
    return Effect.succeed({ column, name, table });
  };

const escapeLikePattern = (value: CleanedWhere['value']): string =>
  String(value ?? '').replaceAll(/[\\%_]/gu, (character) => `\\${character}`);

const isInsensitive = (where: CleanedWhere): boolean =>
  where.mode === 'insensitive' &&
  (Predicate.isString(where.value) || (Array.isArray(where.value) && where.value.every(Predicate.isString)));

const like = (column: PgColumn, pattern: string, where: CleanedWhere): Effect.Effect<SQL> =>
  Effect.succeed(
    isInsensitive(where)
      ? sql`${column} ILIKE ${pattern} ESCAPE ${'\\'}`
      : sql`${column} LIKE ${pattern} ESCAPE ${'\\'}`,
  );

const membership = (negated: boolean) =>
  Effect.fnUntraced(function* membershipCondition(column: PgColumn, where: CleanedWhere) {
    const { value } = where;
    if (!Array.isArray(value)) {
      return yield* schemaError(
        `Better Auth field "${where.field}" needs an array value for the "${where.operator}" operator`,
      );
    }
    const values: (number | string)[] = value;
    if (isInsensitive(where) && values.every(Predicate.isString)) {
      if (values.length === 0) {
        return negated ? sql`true` : sql`false`;
      }
      const lowered = sql.join(
        values.map((entry) => sql`LOWER(${entry})`),
        sql`, `,
      );
      return negated ? sql`LOWER(${column}) NOT IN (${lowered})` : sql`LOWER(${column}) IN (${lowered})`;
    }
    const target: SQLWrapper = column;
    return negated ? notInArray(target, values) : inArray(target, values);
  });

const equality = (negated: boolean) => (column: PgColumn, where: CleanedWhere) => {
  const { value } = where;
  if (value === null) {
    return Effect.succeed(negated ? isNotNull(column) : isNull(column));
  }
  if (isInsensitive(where)) {
    return Effect.succeed(negated ? sql`LOWER(${column}) <> LOWER(${value})` : sql`LOWER(${column}) = LOWER(${value})`);
  }
  return Effect.succeed(negated ? ne(column, value) : eq(column, value));
};

type OperatorCondition = (
  column: PgColumn,
  where: CleanedWhere,
) => Effect.Effect<SQL, EffectDrizzleAuthAdapterSchemaError>;

const contains: OperatorCondition = (column, where) => like(column, `%${escapeLikePattern(where.value)}%`, where);
const endsWith: OperatorCondition = (column, where) => like(column, `%${escapeLikePattern(where.value)}`, where);
const startsWith: OperatorCondition = (column, where) => like(column, `${escapeLikePattern(where.value)}%`, where);
const greaterThan: OperatorCondition = (column, where) => Effect.succeed(gt(column, where.value));
const greaterThanOrEqual: OperatorCondition = (column, where) => Effect.succeed(gte(column, where.value));
const lessThan: OperatorCondition = (column, where) => Effect.succeed(lt(column, where.value));
const lessThanOrEqual: OperatorCondition = (column, where) => Effect.succeed(lte(column, where.value));

/** Better Auth's where operators, translated for PostgreSQL as its own Drizzle adapter translates them. */
const operatorConditions = {
  contains,
  ends_with: endsWith,
  eq: equality(false),
  gt: greaterThan,
  gte: greaterThanOrEqual,
  in: membership(false),
  lt: lessThan,
  lte: lessThanOrEqual,
  ne: equality(true),
  not_in: membership(true),
  starts_with: startsWith,
} satisfies Record<WhereOperator, OperatorCondition>;

const clauseCondition = (target: ModelTable) => (where: CleanedWhere) =>
  Effect.flatMap(target.column(where.field), (column) => operatorConditions[where.operator ?? 'eq'](column, where));

/** AND-connected clauses must all hold, and at least one OR-connected clause must hold. */
const whereCondition = Effect.fnUntraced(function* whereCondition(
  target: ModelTable,
  where: readonly CleanedWhere[] | undefined,
) {
  const clauses = where ?? [];
  // Pure column lookups; sequential keeps the generated SQL in the caller's clause order.
  const conjunctive = yield* Effect.forEach(
    clauses.filter((clause) => clause.connector !== 'OR'),
    clauseCondition(target),
    { concurrency: 1 },
  );
  const disjunctive = yield* Effect.forEach(
    clauses.filter((clause) => clause.connector === 'OR'),
    clauseCondition(target),
    { concurrency: 1 },
  );
  return and(...conjunctive, or(...disjunctive));
});

const projection = Effect.fnUntraced(function* projection(target: ModelTable, select: readonly string[] | undefined) {
  if (select === undefined || select.length === 0) {
    return getColumns(target.table);
  }
  const entries = yield* Effect.forEach(
    select,
    (field) => Effect.map(target.column(field), (column) => [target.name(field), column] as const),
    { concurrency: 1 },
  );
  return Object.fromEntries(entries);
});

const incrementAssignments = Effect.fnUntraced(function* incrementAssignments(
  target: ModelTable,
  increment: Readonly<Record<string, number>>,
) {
  const entries = yield* Effect.forEach(
    Object.entries(increment),
    ([field, delta]) =>
      Effect.map(target.column(field), (column) => [target.name(field), sql`${column} + ${delta}`] as const),
    { concurrency: 1 },
  );
  return Object.fromEntries(entries);
});

/** The adapter's operations as Effects over one executor: the root database or an open transaction. */
const makeOperations = (tables: EffectDrizzleAuthTables, executor: Executor) => (getFieldName: FieldName) => {
  const resolve = resolveModel(tables, getFieldName);
  const firstMatchingId = Effect.fnUntraced(function* firstMatchingId(target: ModelTable, where: CleanedWhere[]) {
    // Both are pure schema lookups.
    const [id, condition] = yield* Effect.all([target.column('id'), whereCondition(target, where)], {
      concurrency: 1,
    });
    return { id, rows: executor.select({ id }).from(target.table).where(condition).limit(1) };
  });
  return {
    consumeOne: Effect.fn('EffectDrizzleAuthAdapter.consumeOne')(function* consumeOne(query: {
      model: string;
      where: CleanedWhere[];
    }) {
      const target = yield* resolve(query.model);
      const { id, rows } = yield* firstMatchingId(target, query.where);
      const [row] = yield* executor.delete(target.table).where(inArray(id, rows)).returning();
      return row ?? null;
    }),
    count: Effect.fn('EffectDrizzleAuthAdapter.count')(function* countRows(query: {
      model: string;
      where?: CleanedWhere[] | undefined;
    }) {
      const target = yield* resolve(query.model);
      const [row] = yield* executor
        .select({ total: count() })
        .from(target.table)
        .where(yield* whereCondition(target, query.where));
      return row?.total ?? 0;
    }),
    create: Effect.fn('EffectDrizzleAuthAdapter.create')(function* create(mutation: { data: Row; model: string }) {
      const target = yield* resolve(mutation.model);
      yield* Effect.forEach(Object.keys(mutation.data), target.column, { concurrency: 1, discard: true });
      const [row] = yield* executor.insert(target.table).values(mutation.data).returning();
      return row;
    }),
    delete: Effect.fn('EffectDrizzleAuthAdapter.delete')(function* deleteRows(mutation: {
      model: string;
      where: CleanedWhere[];
    }) {
      const target = yield* resolve(mutation.model);
      yield* executor.delete(target.table).where(yield* whereCondition(target, mutation.where));
    }),
    deleteMany: Effect.fn('EffectDrizzleAuthAdapter.deleteMany')(function* deleteMany(mutation: {
      model: string;
      where: CleanedWhere[];
    }) {
      const target = yield* resolve(mutation.model);
      const id = yield* target.column('id');
      const rows = yield* executor
        .delete(target.table)
        .where(yield* whereCondition(target, mutation.where))
        .returning({ id });
      return rows.length;
    }),
    findMany: Effect.fn('EffectDrizzleAuthAdapter.findMany')(function* findMany(query: {
      limit: number;
      model: string;
      offset?: number | undefined;
      select?: string[] | undefined;
      sortBy?: { direction: 'asc' | 'desc'; field: string } | undefined;
      where?: CleanedWhere[] | undefined;
    }) {
      const target = yield* resolve(query.model);
      const rows = executor
        .select(yield* projection(target, query.select))
        .from(target.table)
        .where(yield* whereCondition(target, query.where))
        .limit(query.limit)
        .offset(query.offset ?? 0);
      const { sortBy } = query;
      if (sortBy === undefined) {
        return yield* rows;
      }
      const column = yield* target.column(sortBy.field);
      return yield* rows.orderBy(sortBy.direction === 'desc' ? desc(column) : asc(column));
    }),
    findOne: Effect.fn('EffectDrizzleAuthAdapter.findOne')(function* findOne(query: {
      model: string;
      select?: string[] | undefined;
      where: CleanedWhere[];
    }) {
      const target = yield* resolve(query.model);
      const [row] = yield* executor
        .select(yield* projection(target, query.select))
        .from(target.table)
        .where(yield* whereCondition(target, query.where))
        .limit(1);
      return row ?? null;
    }),
    incrementOne: Effect.fn('EffectDrizzleAuthAdapter.incrementOne')(function* incrementOne(mutation: {
      increment: Record<string, number>;
      model: string;
      set?: Row | undefined;
      where: CleanedWhere[];
    }) {
      const target = yield* resolve(mutation.model);
      // Both are pure schema lookups.
      const [{ id, rows }, increments] = yield* Effect.all(
        [firstMatchingId(target, mutation.where), incrementAssignments(target, mutation.increment)],
        { concurrency: 1 },
      );
      const [row] = yield* executor
        .update(target.table)
        .set({ ...mutation.set, ...increments })
        .where(inArray(id, rows))
        .returning();
      return row ?? null;
    }),
    update: Effect.fn('EffectDrizzleAuthAdapter.update')(function* update(mutation: {
      model: string;
      update: Row;
      where: CleanedWhere[];
    }) {
      const target = yield* resolve(mutation.model);
      const [row] = yield* executor
        .update(target.table)
        .set(mutation.update)
        .where(yield* whereCondition(target, mutation.where))
        .returning();
      return row ?? null;
    }),
    updateMany: Effect.fn('EffectDrizzleAuthAdapter.updateMany')(function* updateMany(mutation: {
      model: string;
      update: Row;
      where: CleanedWhere[];
    }) {
      const target = yield* resolve(mutation.model);
      const id = yield* target.column('id');
      const rows = yield* executor
        .update(target.table)
        .set(mutation.update)
        .where(yield* whereCondition(target, mutation.where))
        .returning({ id });
      return rows.length;
    }),
  };
};

type OperationsFor = ReturnType<typeof makeOperations>;

/** Better Auth's Promise port over the operations, each run with the services it was given. */
const promiseAdapter =
  (operationsFor: OperationsFor, run: typeof Effect.runPromise): AdapterFactoryCustomizeAdapterCreator =>
  ({ getFieldName }) => {
    const operations = operationsFor(getFieldName);
    const adapter = {
      consumeOne: flow(operations.consumeOne, run),
      count: flow(operations.count, run),
      create: flow(operations.create, run),
      delete: flow(operations.delete, run),
      deleteMany: flow(operations.deleteMany, run),
      findMany: flow(operations.findMany, run),
      findOne: flow(operations.findOne, run),
      incrementOne: flow(operations.incrementOne, run),
      update: flow(operations.update, run),
      updateMany: flow(operations.updateMany, run),
    };
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: CustomAdapter lets each caller name the row type it wants; the adapter factory decodes every row through the Better Auth schema, and each table is keyed by that model.
    return adapter as CustomAdapter;
  };

const factoryConfig = {
  adapterId: 'effect-drizzle',
  adapterName: 'Effect Drizzle Adapter',
  supportsArrays: true,
  supportsJSON: true,
  supportsUUIDs: true,
  usePlural: false,
} satisfies AdapterFactoryConfig;

/** The Better Auth adapter for one open transaction, running with that transaction's services. */
const transactionAdapter = Effect.fnUntraced(function* transactionAdapter(
  tables: EffectDrizzleAuthTables,
  transaction: Executor,
  options: BetterAuthOptions,
) {
  const services = yield* Effect.context();
  return createAdapterFactory({
    adapter: promiseAdapter(makeOperations(tables, transaction), Effect.runPromiseWith(services)),
    config: { ...factoryConfig, transaction: false },
  })(options);
});

const transactionBody =
  <Result>(
    tables: EffectDrizzleAuthTables,
    options: BetterAuthOptions,
    body: (adapter: DBTransactionAdapter) => Promise<Result>,
  ) =>
  (transaction: Executor) =>
    Effect.flatMap(transactionAdapter(tables, transaction, options), (adapter) =>
      // A rejected body must reach Better Auth unchanged (an APIError stays an APIError), so it
      // travels as the defect that rolls the transaction back and is rethrown by the runner.
      // oxlint-disable-next-line effect-native/require-timeout-on-external-effect, typescript/promise-function-async -- Effect owns this foreign Promise boundary; every statement in the body is bounded by the connection's server-side statement_timeout.
      Effect.promise(() => body(adapter)),
    );

/**
 * Better Auth database adapter over an owner's native Effect Drizzle executor; it opens no connection.
 *
 * Better Auth calls its adapter through Promises, so each operation runs with the services captured
 * here. A Better Auth transaction runs inside `database.transaction`, and its adapter runs with the
 * services captured inside that transaction, so every statement uses the transaction's connection
 * and a rejected transaction body rolls the transaction back.
 */
export const makeEffectDrizzleAuthAdapter = Effect.fn('EffectDrizzleAuthAdapter.make')(function* makeAdapter(
  database: EffectPgDatabase<AnyRelations>,
  tables: EffectDrizzleAuthTables,
): Effect.fn.Return<EffectDrizzleAuthAdapter> {
  const run = Effect.runPromiseWith(yield* Effect.context());
  const runTransaction: <A>(effect: Effect.Effect<A, SqlError>) => ReturnType<typeof run<A, SqlError>> = run;
  return (options) => {
    const transaction = Effect.fnUntraced(function* betterAuthTransaction<Result>(
      // oxlint-disable-next-line effect-native/no-promise-shaped-port -- Better Auth's transaction body is a Promise port by contract; this is its only conversion.
      body: (adapter: DBTransactionAdapter) => Promise<Result>,
    ) {
      // The first step runs synchronously inside Better Auth's call. Its async context carries the
      // endpoint context that database hooks read, and it is lost once the connection wait resumes
      // on the driver's socket, so the body stays bound to it.
      return yield* database.transaction(transactionBody(tables, options, AsyncResource.bind(body)));
    }, runTransaction);
    return createAdapterFactory({
      adapter: promiseAdapter(makeOperations(tables, database), run),
      config: { ...factoryConfig, transaction },
    })(options);
  };
});
