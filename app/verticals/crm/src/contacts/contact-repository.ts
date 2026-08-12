/* eslint-disable max-classes-per-file -- Closed private Contact persistence error vocabulary. */
import type { ScopedTransactionExecutor } from '@app/core-runtime';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { Effect, Schema } from 'effect';
import { contacts } from '../db/schema.ts';

export type ContactRow = typeof contacts.$inferSelect;
export type ContactInsert = typeof contacts.$inferInsert;

export class ContactRepositoryUnavailable extends Schema.TaggedErrorClass<ContactRepositoryUnavailable>()(
  'ContactRepositoryUnavailable',
  { reason: Schema.String },
) {}

const unavailable = () =>
  new ContactRepositoryUnavailable({ reason: 'Contact persistence is temporarily unavailable' });

export interface ContactListCursor {
  readonly contactId: string;
  readonly normalizedFirstName: string;
  readonly normalizedLastName: string;
}

export interface ContactRepository {
  readonly create: (
    contact: ContactInsert,
  ) => Effect.Effect<ContactRow, ContactRepositoryUnavailable>;
  readonly findActiveById: (
    tenantId: string,
    contactId: string,
  ) => Effect.Effect<ContactRow | undefined, ContactRepositoryUnavailable>;
  readonly findById: (
    tenantId: string,
    contactId: string,
  ) => Effect.Effect<ContactRow | undefined, ContactRepositoryUnavailable>;
  readonly listActiveForCustomer: (
    tenantId: string,
    customerId: string,
    limit: number,
    cursor?: ContactListCursor,
  ) => Effect.Effect<readonly ContactRow[], ContactRepositoryUnavailable>;
  readonly softDelete: (
    tenantId: string,
    contactId: string,
    expectedVersion: number,
    deletedAt: Date,
  ) => Effect.Effect<ContactRow | undefined, ContactRepositoryUnavailable>;
  readonly update: (
    tenantId: string,
    contactId: string,
    expectedVersion: number,
    values: {
      readonly email: null | string;
      readonly firstName: null | string;
      readonly jobTitle: null | string;
      readonly lastName: null | string;
      readonly phone: null | string;
    },
    updatedAt: Date,
  ) => Effect.Effect<ContactRow | undefined, ContactRepositoryUnavailable>;
}

export const makeContactRepository = (
  transaction: ScopedTransactionExecutor,
): ContactRepository => {
  const findById = (tenantId: string, contactId: string, activeOnly: boolean) =>
    Effect.tryPromise({
      catch: unavailable,
      try: () =>
        transaction
          .select()
          .from(contacts)
          .where(
            and(
              eq(contacts.tenantId, tenantId),
              eq(contacts.contactId, contactId),
              ...(activeOnly ? [isNull(contacts.deletedAt)] : []),
            ),
          )
          .limit(1),
    }).pipe(Effect.map(([row]) => row));

  const create: ContactRepository['create'] = (contact) =>
    Effect.tryPromise({
      catch: unavailable,
      try: () => transaction.insert(contacts).values(contact).returning(),
    }).pipe(
      Effect.flatMap(([created]) =>
        created === undefined ? Effect.fail(unavailable()) : Effect.succeed(created),
      ),
    );

  const repository: ContactRepository = {
    create,
    findActiveById: (tenantId, contactId) => findById(tenantId, contactId, true),
    findById: (tenantId, contactId) => findById(tenantId, contactId, false),
    listActiveForCustomer: (tenantId, customerId, limit, cursor) => {
      // Drizzle has no first-class tuple cursor over normalized nullable names, so this remains a
      // parameterized tagged-SQL predicate over typed columns.
      const cursorPredicate =
        cursor === undefined
          ? undefined
          : sql`(lower(coalesce(${contacts.lastName}, '')), lower(coalesce(${contacts.firstName}, '')), ${contacts.contactId}) > (${cursor.normalizedLastName}, ${cursor.normalizedFirstName}, ${cursor.contactId}::uuid)`;
      return Effect.tryPromise({
        catch: unavailable,
        try: () =>
          transaction
            .select()
            .from(contacts)
            .where(
              and(
                eq(contacts.tenantId, tenantId),
                eq(contacts.customerId, customerId),
                isNull(contacts.deletedAt),
                cursorPredicate,
              ),
            )
            .orderBy(
              asc(sql<string>`lower(coalesce(${contacts.lastName}, ''))`),
              asc(sql<string>`lower(coalesce(${contacts.firstName}, ''))`),
              asc(contacts.contactId),
            )
            .limit(limit + 1),
      });
    },
    softDelete: (tenantId, contactId, expectedVersion, deletedAt) =>
      Effect.tryPromise({
        catch: unavailable,
        try: () =>
          transaction
            .update(contacts)
            .set({
              deletedAt,
              updatedAt: deletedAt,
              version: sql`${contacts.version} + 1`,
            })
            .where(
              and(
                eq(contacts.tenantId, tenantId),
                eq(contacts.contactId, contactId),
                eq(contacts.version, expectedVersion),
                isNull(contacts.deletedAt),
              ),
            )
            .returning(),
      }).pipe(Effect.map(([deleted]) => deleted)),
    update: (tenantId, contactId, expectedVersion, values, updatedAt) =>
      Effect.tryPromise({
        catch: unavailable,
        try: () =>
          transaction
            .update(contacts)
            .set({ ...values, updatedAt, version: sql`${contacts.version} + 1` })
            .where(
              and(
                eq(contacts.tenantId, tenantId),
                eq(contacts.contactId, contactId),
                eq(contacts.version, expectedVersion),
                isNull(contacts.deletedAt),
              ),
            )
            .returning(),
      }).pipe(Effect.map(([updated]) => updated)),
  };
  return Object.freeze(repository);
};
