/* eslint-disable max-classes-per-file -- Closed private persistence error vocabulary. */
import type { ScopedTransactionExecutor } from '@app/core-runtime';
import { and, asc, eq, isNull, ne, sql } from 'drizzle-orm';
import { Effect, Schema } from 'effect';
import { customers } from '../db/schema.ts';

export type CustomerRow = typeof customers.$inferSelect;
export type CustomerInsert = typeof customers.$inferInsert;

export class CustomerRepositoryConflict extends Schema.TaggedErrorClass<CustomerRepositoryConflict>()(
  'CustomerRepositoryConflict',
  { reason: Schema.String },
) {}

export class CustomerRepositoryUnavailable extends Schema.TaggedErrorClass<CustomerRepositoryUnavailable>()(
  'CustomerRepositoryUnavailable',
  { reason: Schema.String },
) {}

export type CustomerRepositoryError = CustomerRepositoryConflict | CustomerRepositoryUnavailable;

const unavailable = () =>
  new CustomerRepositoryUnavailable({
    reason: 'Customer persistence is temporarily unavailable',
  });

const isRegistrationConflict = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  error.code === '23505' &&
  'constraint' in error &&
  error.constraint === 'crm_customers_active_registration_uk';

const persistenceError = (error: unknown): CustomerRepositoryError =>
  isRegistrationConflict(error)
    ? new CustomerRepositoryConflict({ reason: 'The active registration number already exists' })
    : unavailable();

export interface CustomerListCursor {
  readonly customerId: string;
  readonly normalizedName: string;
}

export interface CustomerRepository {
  readonly advanceVersion: (
    tenantId: string,
    customerId: string,
    expectedVersion: number,
    updatedAt: Date,
  ) => Effect.Effect<number | undefined, CustomerRepositoryUnavailable>;
  readonly create: (
    customer: CustomerInsert,
  ) => Effect.Effect<CustomerRow, CustomerRepositoryError>;
  readonly findActiveById: (
    tenantId: string,
    customerId: string,
  ) => Effect.Effect<CustomerRow | undefined, CustomerRepositoryUnavailable>;
  readonly findById: (
    tenantId: string,
    customerId: string,
  ) => Effect.Effect<CustomerRow | undefined, CustomerRepositoryUnavailable>;
  readonly lockActiveById: (
    tenantId: string,
    customerId: string,
  ) => Effect.Effect<CustomerRow | undefined, CustomerRepositoryUnavailable>;
  readonly findActiveByRegistrationNumber: (
    tenantId: string,
    companyRegistrationNumber: string,
    excludingCustomerId?: string,
  ) => Effect.Effect<CustomerRow | undefined, CustomerRepositoryUnavailable>;
  readonly listActive: (
    tenantId: string,
    limit: number,
    cursor?: CustomerListCursor,
  ) => Effect.Effect<readonly CustomerRow[], CustomerRepositoryUnavailable>;
  readonly softDelete: (
    tenantId: string,
    customerId: string,
    expectedVersion: number,
    deletedAt: Date,
  ) => Effect.Effect<CustomerRow | undefined, CustomerRepositoryUnavailable>;
  readonly update: (
    tenantId: string,
    customerId: string,
    expectedVersion: number,
    values: Omit<CustomerInsert, 'createdAt' | 'customerId' | 'deletedAt' | 'tenantId' | 'version'>,
    updatedAt: Date,
  ) => Effect.Effect<CustomerRow | undefined, CustomerRepositoryError>;
}

export const makeCustomerRepository = (
  transaction: ScopedTransactionExecutor,
): CustomerRepository => {
  const findActiveById: CustomerRepository['findActiveById'] = (tenantId, customerId) =>
    Effect.tryPromise({
      catch: unavailable,
      try: () =>
        transaction
          .select()
          .from(customers)
          .where(
            and(
              eq(customers.tenantId, tenantId),
              eq(customers.customerId, customerId),
              isNull(customers.deletedAt),
            ),
          )
          .limit(1),
    }).pipe(Effect.map(([row]) => row));

  const create: CustomerRepository['create'] = (customer) =>
    Effect.tryPromise({
      catch: persistenceError,
      try: () => transaction.insert(customers).values(customer).returning(),
    }).pipe(
      Effect.flatMap(([created]) =>
        created === undefined ? Effect.fail(unavailable()) : Effect.succeed(created),
      ),
    );

  const findById: CustomerRepository['findById'] = (tenantId, customerId) =>
    Effect.tryPromise({
      catch: unavailable,
      try: () =>
        transaction
          .select()
          .from(customers)
          .where(and(eq(customers.tenantId, tenantId), eq(customers.customerId, customerId)))
          .limit(1),
    }).pipe(Effect.map(([row]) => row));

  const repository: CustomerRepository = {
    advanceVersion: (tenantId, customerId, expectedVersion, updatedAt) =>
      Effect.tryPromise({
        catch: unavailable,
        try: () =>
          transaction
            .update(customers)
            .set({ updatedAt, version: sql`${customers.version} + 1` })
            .where(
              and(
                eq(customers.tenantId, tenantId),
                eq(customers.customerId, customerId),
                eq(customers.version, expectedVersion),
                isNull(customers.deletedAt),
              ),
            )
            .returning({ version: customers.version }),
      }).pipe(Effect.map(([updated]) => updated?.version)),
    create,
    findActiveById,
    findActiveByRegistrationNumber: (tenantId, companyRegistrationNumber, excludingCustomerId) =>
      Effect.tryPromise({
        catch: unavailable,
        try: () =>
          transaction
            .select()
            .from(customers)
            .where(
              and(
                eq(customers.tenantId, tenantId),
                eq(customers.companyRegistrationNumber, companyRegistrationNumber),
                isNull(customers.deletedAt),
                ...(excludingCustomerId === undefined
                  ? []
                  : [ne(customers.customerId, excludingCustomerId)]),
              ),
            )
            .limit(1),
      }).pipe(Effect.map(([row]) => row)),
    findById,
    listActive: (tenantId, limit, cursor) => {
      // Drizzle has no first-class lower(column) cursor operator, so this remains a
      // parameterized tagged-SQL predicate over typed columns.
      const cursorPredicate =
        cursor === undefined
          ? undefined
          : sql`(lower(${customers.name}), ${customers.customerId}) > (${cursor.normalizedName}, ${cursor.customerId}::uuid)`;
      return Effect.tryPromise({
        catch: unavailable,
        try: () =>
          transaction
            .select()
            .from(customers)
            .where(
              and(eq(customers.tenantId, tenantId), isNull(customers.deletedAt), cursorPredicate),
            )
            .orderBy(asc(sql<string>`lower(${customers.name})`), asc(customers.customerId))
            .limit(limit + 1),
      });
    },
    lockActiveById: (tenantId, customerId) =>
      Effect.tryPromise({
        catch: unavailable,
        try: () =>
          transaction
            .select()
            .from(customers)
            .where(
              and(
                eq(customers.tenantId, tenantId),
                eq(customers.customerId, customerId),
                isNull(customers.deletedAt),
              ),
            )
            .limit(1)
            .for('update'),
      }).pipe(Effect.map(([row]) => row)),
    softDelete: (tenantId, customerId, expectedVersion, deletedAt) =>
      Effect.tryPromise({
        catch: unavailable,
        try: () =>
          transaction
            .update(customers)
            .set({
              deletedAt,
              updatedAt: deletedAt,
              version: sql`${customers.version} + 1`,
            })
            .where(
              and(
                eq(customers.tenantId, tenantId),
                eq(customers.customerId, customerId),
                eq(customers.version, expectedVersion),
                isNull(customers.deletedAt),
              ),
            )
            .returning(),
      }).pipe(Effect.map(([deleted]) => deleted)),
    update: (tenantId, customerId, expectedVersion, values, updatedAt) =>
      Effect.tryPromise({
        catch: persistenceError,
        try: () =>
          transaction
            .update(customers)
            .set({ ...values, updatedAt, version: sql`${customers.version} + 1` })
            .where(
              and(
                eq(customers.tenantId, tenantId),
                eq(customers.customerId, customerId),
                eq(customers.version, expectedVersion),
                isNull(customers.deletedAt),
              ),
            )
            .returning(),
      }).pipe(Effect.map(([updated]) => updated)),
  };
  return Object.freeze(repository);
};
