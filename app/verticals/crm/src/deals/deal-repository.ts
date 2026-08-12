/* eslint-disable max-classes-per-file -- Closed private Deal persistence error vocabulary. */
import type { ScopedTransactionExecutor } from '@app/core-runtime';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { Effect, Schema } from 'effect';
import { deals } from '../db/schema.ts';

export type DealRow = typeof deals.$inferSelect;
export type DealInsert = typeof deals.$inferInsert;

export class DealRepositoryUnavailable extends Schema.TaggedErrorClass<DealRepositoryUnavailable>()(
  'DealRepositoryUnavailable',
  { reason: Schema.String },
) {}

const unavailable = () =>
  new DealRepositoryUnavailable({ reason: 'Deal persistence is temporarily unavailable' });

export interface DealListCursor {
  readonly dealId: string;
  readonly updatedAt: Date;
}

export interface DealRepository {
  readonly create: (deal: DealInsert) => Effect.Effect<DealRow, DealRepositoryUnavailable>;
  readonly findActiveById: (
    tenantId: string,
    legalEntityId: string,
    dealId: string,
  ) => Effect.Effect<DealRow | undefined, DealRepositoryUnavailable>;
  readonly findById: (
    tenantId: string,
    legalEntityId: string,
    dealId: string,
  ) => Effect.Effect<DealRow | undefined, DealRepositoryUnavailable>;
  readonly listActive: (
    tenantId: string,
    legalEntityId: string,
    limit: number,
    customerId?: string,
    cursor?: DealListCursor,
  ) => Effect.Effect<readonly DealRow[], DealRepositoryUnavailable>;
  readonly lockActiveById: (
    tenantId: string,
    legalEntityId: string,
    dealId: string,
  ) => Effect.Effect<DealRow | undefined, DealRepositoryUnavailable>;
  readonly softDelete: (
    tenantId: string,
    legalEntityId: string,
    dealId: string,
    expectedVersion: number,
    deletedAt: Date,
  ) => Effect.Effect<DealRow | undefined, DealRepositoryUnavailable>;
  readonly update: (
    tenantId: string,
    legalEntityId: string,
    dealId: string,
    expectedVersion: number,
    values: Pick<
      DealInsert,
      | 'contactId'
      | 'currency'
      | 'customerId'
      | 'description'
      | 'expectedCloseDate'
      | 'expectedValue'
      | 'title'
    >,
    updatedAt: Date,
  ) => Effect.Effect<DealRow | undefined, DealRepositoryUnavailable>;
}

export const makeDealRepository = (transaction: ScopedTransactionExecutor): DealRepository => {
  const findById = (tenantId: string, legalEntityId: string, dealId: string, activeOnly: boolean) =>
    Effect.tryPromise({
      catch: unavailable,
      try: () =>
        transaction
          .select()
          .from(deals)
          .where(
            and(
              eq(deals.tenantId, tenantId),
              eq(deals.legalEntityId, legalEntityId),
              eq(deals.dealId, dealId),
              ...(activeOnly ? [isNull(deals.deletedAt)] : []),
            ),
          )
          .limit(1),
    }).pipe(Effect.map(([row]) => row));

  const repository: DealRepository = {
    create: (deal) =>
      Effect.tryPromise({
        catch: unavailable,
        try: () => transaction.insert(deals).values(deal).returning(),
      }).pipe(
        Effect.flatMap(([created]) =>
          created === undefined ? Effect.fail(unavailable()) : Effect.succeed(created),
        ),
      ),
    findActiveById: (tenantId, legalEntityId, dealId) =>
      findById(tenantId, legalEntityId, dealId, true),
    findById: (tenantId, legalEntityId, dealId) => findById(tenantId, legalEntityId, dealId, false),
    listActive: (tenantId, legalEntityId, limit, customerId, cursor) => {
      // Drizzle has no first-class descending tuple cursor, so this remains a parameterized
      // tagged-SQL predicate over typed columns.
      const cursorPredicate =
        cursor === undefined
          ? undefined
          : sql`(${deals.updatedAt}, ${deals.dealId}) < (${cursor.updatedAt}, ${cursor.dealId}::uuid)`;
      return Effect.tryPromise({
        catch: unavailable,
        try: () =>
          transaction
            .select()
            .from(deals)
            .where(
              and(
                eq(deals.tenantId, tenantId),
                eq(deals.legalEntityId, legalEntityId),
                isNull(deals.deletedAt),
                customerId === undefined ? undefined : eq(deals.customerId, customerId),
                cursorPredicate,
              ),
            )
            .orderBy(desc(deals.updatedAt), desc(deals.dealId))
            .limit(limit + 1),
      });
    },
    lockActiveById: (tenantId, legalEntityId, dealId) =>
      Effect.tryPromise({
        catch: unavailable,
        try: () =>
          transaction
            .select()
            .from(deals)
            .where(
              and(
                eq(deals.tenantId, tenantId),
                eq(deals.legalEntityId, legalEntityId),
                eq(deals.dealId, dealId),
                isNull(deals.deletedAt),
              ),
            )
            .limit(1)
            .for('update'),
      }).pipe(Effect.map(([row]) => row)),
    softDelete: (tenantId, legalEntityId, dealId, expectedVersion, deletedAt) =>
      Effect.tryPromise({
        catch: unavailable,
        try: () =>
          transaction
            .update(deals)
            .set({
              deletedAt,
              updatedAt: deletedAt,
              version: sql`${deals.version} + 1`,
            })
            .where(
              and(
                eq(deals.tenantId, tenantId),
                eq(deals.legalEntityId, legalEntityId),
                eq(deals.dealId, dealId),
                eq(deals.version, expectedVersion),
                isNull(deals.deletedAt),
              ),
            )
            .returning(),
      }).pipe(Effect.map(([deleted]) => deleted)),
    update: (tenantId, legalEntityId, dealId, expectedVersion, values, updatedAt) =>
      Effect.tryPromise({
        catch: unavailable,
        try: () =>
          transaction
            .update(deals)
            .set({ ...values, updatedAt, version: sql`${deals.version} + 1` })
            .where(
              and(
                eq(deals.tenantId, tenantId),
                eq(deals.legalEntityId, legalEntityId),
                eq(deals.dealId, dealId),
                eq(deals.version, expectedVersion),
                isNull(deals.deletedAt),
              ),
            )
            .returning(),
      }).pipe(Effect.map(([updated]) => updated)),
  };
  return Object.freeze(repository);
};
