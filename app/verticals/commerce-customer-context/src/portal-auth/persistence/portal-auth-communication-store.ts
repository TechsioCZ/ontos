import { and, asc, eq, inArray, isNotNull, isNull, lte, ne, or, sql } from 'drizzle-orm';
import { DateTime, Effect, Layer, Option, Schema } from 'effect';

import { withSafeCause } from '../../../api/portal-auth/provider/safe-failure.ts';
import { PortalAuthEmailFlowSchema, PortalAuthIssuanceRefSchema } from '../../../shared/portal-auth-communications.ts';
import type { PortalAuthIssuanceRef } from '../../../shared/portal-auth-communications.ts';
import type {
  ClaimedCommunicationRequest,
  IssuanceSettlement,
  PortalAuthCommunicationStoreService,
  StoredIssuance,
} from '../../portal-auth/communications/communication-store.ts';
import { PortalAuthCommunicationUnavailable } from '../../portal-auth/communications/communication-unavailable.ts';
import { PortalAuthIssuanceStateUnavailable } from '../../portal-auth/communications/issuance-state-unavailable.ts';
import type { PortalAuthIssuance } from '../../portal-auth/communications/issuance.ts';
import {
  CommercePortalAuthCommunicationStore,
  IssuanceSettlementSchema,
} from '../../portal-auth/communications/communication-store.ts';
import { CommercePortalAuthDatabase } from './portal-auth-database.ts';
import type { CommercePortalAuthDatabaseExecutor } from './portal-auth-database-types.ts';
import { communicationIssuance, communicationRequestOutbox } from './portal-auth-tables.ts';

/**
 * Auth's PostgreSQL record of the issuances it routes through Communications and of their Auth-local outbox (D1, D2). Every
 * failure keeps only its safe kind and SQLSTATE: a row holds a sealed value and a statement echoes its parameters.
 */

const PENDING = 'PENDING';
const STORE_FLOW = 'stored-issuance';
const decodeSettlement = Schema.decodeUnknownOption(IssuanceSettlementSchema);
const decodeFlow = Schema.decodeUnknownEffect(PortalAuthEmailFlowSchema);
const decodeRef = Schema.decodeUnknownEffect(PortalAuthIssuanceRefSchema);

const stateUnavailable = (cause: unknown) =>
  withSafeCause(new PortalAuthIssuanceStateUnavailable({ flow: STORE_FLOW }), cause);
const outboxUnavailable = (operation: string) => (cause: unknown) =>
  withSafeCause(new PortalAuthCommunicationUnavailable({ operation }), cause);

const dateOf = DateTime.toDate;
const utcOf = (date: Date) => DateTime.fromDateUnsafe(date);

interface IssuanceRow {
  readonly enrollmentOwnerInvocationId: string | null;
  readonly expiresAt: Date;
  readonly flow: string;
  readonly issuanceRef: string;
  readonly issuedAt: Date;
  readonly protectedValue: string | null;
  readonly providerSubjectId: string;
  readonly settledState: string | null;
}

const storedOf = (row: IssuanceRow) =>
  Effect.all([decodeFlow(row.flow), decodeRef(row.issuanceRef)], { concurrency: 1 }).pipe(
    Effect.map(([flow, issuanceRef]): StoredIssuance => {
      const base = {
        expiresAt: utcOf(row.expiresAt),
        flow,
        issuanceRef,
        issuedAt: utcOf(row.issuedAt),
        providerSubjectId: row.providerSubjectId,
      } satisfies PortalAuthIssuance;
      const issuance: PortalAuthIssuance =
        row.enrollmentOwnerInvocationId === null
          ? base
          : { ...base, enrollmentOwnerInvocationId: row.enrollmentOwnerInvocationId };
      return {
        issuance,
        sealedValue: Option.fromNullishOr(row.protectedValue),
        settled: Option.flatMap(Option.fromNullishOr(row.settledState), decodeSettlement),
      };
    }),
  );

const issuanceColumns = {
  enrollmentOwnerInvocationId: communicationIssuance.enrollmentOwnerInvocationId,
  expiresAt: communicationIssuance.expiresAt,
  flow: communicationIssuance.flow,
  issuanceRef: communicationIssuance.issuanceRef,
  issuedAt: communicationIssuance.issuedAt,
  protectedValue: communicationIssuance.protectedValue,
  providerSubjectId: communicationIssuance.providerSubjectId,
  settledState: communicationIssuance.settledState,
};

const leasedBy = (issuanceRef: PortalAuthIssuanceRef, leaseOwner: string) =>
  and(
    eq(communicationRequestOutbox.issuanceRef, issuanceRef),
    eq(communicationRequestOutbox.leaseOwner, leaseOwner),
    eq(communicationRequestOutbox.state, PENDING),
  );

/** The claimed rows in claim order, each with its issuance's expiry (the foreign key guarantees the issuance). */
const claimedRowsOf = (
  refs: readonly string[],
  claimed: readonly { readonly attempts: number; readonly issuanceRef: string; readonly request: string }[],
  expiries: readonly { readonly expiresAt: Date; readonly issuanceRef: string }[],
) => {
  const expiryOf = new Map(expiries.map((row) => [row.issuanceRef, row.expiresAt]));
  const toClaim = (row: (typeof claimed)[number]) =>
    decodeRef(row.issuanceRef).pipe(
      Effect.map((issuanceRef): ClaimedCommunicationRequest => ({
        attempts: row.attempts,
        // a missing issuance could only be a past expiry: the relay then closes the row without submitting it
        expiresAt: Option.fromNullishOr(expiryOf.get(row.issuanceRef)).pipe(
          Option.map(utcOf),
          Option.getOrElse(() => DateTime.makeUnsafe(0)),
        ),
        issuanceRef,
        request: row.request,
      })),
    );
  const ordered = claimed.toSorted((left, right) => refs.indexOf(left.issuanceRef) - refs.indexOf(right.issuanceRef));
  return Effect.forEach(ordered, toClaim, { concurrency: 1 });
};

export const makeCommercePortalAuthCommunicationStore = (
  database: CommercePortalAuthDatabaseExecutor,
): PortalAuthCommunicationStoreService => {
  const record: PortalAuthCommunicationStoreService['record'] = (input) => {
    const now = dateOf(input.now);
    const { issuance } = input;
    return database
      .transaction(
        Effect.fn('CommercePortalAuthCommunicationStore.record.transaction')(function* recordTransaction(transaction) {
          if (input.supersede) {
            yield* transaction
              .update(communicationIssuance)
              .set({ protectedValue: null, settledState: 'SUPERSEDED', updatedAt: now })
              .where(
                and(
                  eq(communicationIssuance.flow, issuance.flow),
                  eq(communicationIssuance.providerSubjectId, issuance.providerSubjectId),
                  isNull(communicationIssuance.settledState),
                  ne(communicationIssuance.issuanceRef, issuance.issuanceRef),
                ),
              );
          }
          yield* transaction.insert(communicationIssuance).values({
            createdAt: now,
            enrollmentOwnerInvocationId: issuance.enrollmentOwnerInvocationId ?? null,
            expiresAt: dateOf(issuance.expiresAt),
            flow: issuance.flow,
            issuanceRef: issuance.issuanceRef,
            issuedAt: dateOf(issuance.issuedAt),
            protectedValue: input.sealedValue,
            providerSubjectId: issuance.providerSubjectId,
            updatedAt: now,
          });
          yield* transaction.insert(communicationRequestOutbox).values({
            availableAt: now,
            createdAt: now,
            issuanceRef: issuance.issuanceRef,
            request: input.request,
            state: PENDING,
            tenantId: input.tenantId,
            updatedAt: now,
          });
        }),
      )
      .pipe(Effect.mapError(outboxUnavailable('issuance-record')));
  };

  const find: PortalAuthCommunicationStoreService['find'] = (issuanceRef) =>
    database
      .select(issuanceColumns)
      .from(communicationIssuance)
      .where(eq(communicationIssuance.issuanceRef, issuanceRef))
      .limit(1)
      .pipe(
        Effect.flatMap((rows) => {
          const [row] = rows;
          return row === undefined ? Effect.succeedNone : storedOf(row).pipe(Effect.map(Option.some));
        }),
        Effect.mapError(stateUnavailable),
      );

  const settle = (issuanceRef: PortalAuthIssuanceRef, state: IssuanceSettlement) =>
    DateTime.nowAsDate.pipe(
      Effect.flatMap((now) =>
        database
          .update(communicationIssuance)
          .set({ protectedValue: null, settledState: state, updatedAt: now })
          .where(and(eq(communicationIssuance.issuanceRef, issuanceRef), isNull(communicationIssuance.settledState))),
      ),
      Effect.asVoid,
      Effect.mapError(stateUnavailable),
    );

  const forget: PortalAuthCommunicationStoreService['forget'] = (issuanceRef) =>
    DateTime.nowAsDate.pipe(
      Effect.flatMap((now) =>
        database
          .update(communicationIssuance)
          .set({ protectedValue: null, updatedAt: now })
          .where(eq(communicationIssuance.issuanceRef, issuanceRef)),
      ),
      Effect.asVoid,
      Effect.mapError(stateUnavailable),
    );

  const forgetExpired: PortalAuthCommunicationStoreService['forgetExpired'] = (now) =>
    database
      .update(communicationIssuance)
      .set({ protectedValue: null, updatedAt: dateOf(now) })
      .where(and(isNotNull(communicationIssuance.protectedValue), lte(communicationIssuance.expiresAt, dateOf(now))))
      .returning({ issuanceRef: communicationIssuance.issuanceRef })
      .pipe(
        Effect.map((rows) => rows.length),
        Effect.mapError(outboxUnavailable('issuance-expiry')),
      );

  const claimDue: PortalAuthCommunicationStoreService['claimDue'] = (input) => {
    const now = dateOf(input.now);
    const leaseExpiresAt = dateOf(DateTime.add(input.now, { milliseconds: input.leaseMillis }));
    return database
      .transaction(
        Effect.fn('CommercePortalAuthCommunicationStore.claimDue.transaction')(function* claimTransaction(transaction) {
          // rows another relay holds locked are skipped, never waited for: two relays never take the same row
          const due = yield* transaction
            .select({ issuanceRef: communicationRequestOutbox.issuanceRef })
            .from(communicationRequestOutbox)
            .where(
              and(
                eq(communicationRequestOutbox.tenantId, input.tenantId),
                eq(communicationRequestOutbox.state, PENDING),
                lte(communicationRequestOutbox.availableAt, now),
                or(
                  isNull(communicationRequestOutbox.leaseExpiresAt),
                  lte(communicationRequestOutbox.leaseExpiresAt, now),
                ),
              ),
            )
            .orderBy(asc(communicationRequestOutbox.availableAt), asc(communicationRequestOutbox.issuanceRef))
            .limit(input.limit)
            .for('update', { skipLocked: true });
          if (due.length === 0) {
            return [];
          }
          const refs = due.map(({ issuanceRef }) => issuanceRef);
          // one transaction, one connection: the lease is taken and the expiries read in order, never concurrently
          const [claimed, expiries] = yield* Effect.all(
            [
              transaction
                .update(communicationRequestOutbox)
                .set({
                  attempts: sql`${communicationRequestOutbox.attempts} + 1`,
                  leaseExpiresAt,
                  leaseOwner: input.leaseOwner,
                  updatedAt: now,
                })
                .where(inArray(communicationRequestOutbox.issuanceRef, refs))
                .returning({
                  attempts: communicationRequestOutbox.attempts,
                  issuanceRef: communicationRequestOutbox.issuanceRef,
                  request: communicationRequestOutbox.request,
                }),
              transaction
                .select({ expiresAt: communicationIssuance.expiresAt, issuanceRef: communicationIssuance.issuanceRef })
                .from(communicationIssuance)
                .where(inArray(communicationIssuance.issuanceRef, refs)),
            ],
            { concurrency: 1 },
          );
          return yield* claimedRowsOf(refs, claimed, expiries);
        }),
      )
      .pipe(Effect.mapError(outboxUnavailable('request-claim')));
  };

  const complete: PortalAuthCommunicationStoreService['complete'] = (input) => {
    const now = dateOf(input.now);
    return database
      .transaction(
        Effect.fn('CommercePortalAuthCommunicationStore.complete.transaction')(
          function* completeTransaction(transaction) {
            const ended = yield* transaction
              .update(communicationRequestOutbox)
              .set({
                lastFailure: null,
                leaseExpiresAt: null,
                leaseOwner: null,
                outcome: Option.getOrNull(input.outcome),
                state: input.state,
                updatedAt: now,
              })
              .where(leasedBy(input.issuanceRef, input.leaseOwner))
              .returning({ issuanceRef: communicationRequestOutbox.issuanceRef });
            if (ended.length === 0) {
              return false;
            }
            if (input.forget) {
              yield* transaction
                .update(communicationIssuance)
                .set({ protectedValue: null, updatedAt: now })
                .where(eq(communicationIssuance.issuanceRef, input.issuanceRef));
            }
            return true;
          },
        ),
      )
      .pipe(Effect.mapError(outboxUnavailable('request-complete')));
  };

  const release: PortalAuthCommunicationStoreService['release'] = (input) =>
    database
      .update(communicationRequestOutbox)
      .set({
        availableAt: dateOf(input.availableAt),
        lastFailure: input.failure,
        leaseExpiresAt: null,
        leaseOwner: null,
        updatedAt: dateOf(input.now),
      })
      .where(leasedBy(input.issuanceRef, input.leaseOwner))
      .returning({ issuanceRef: communicationRequestOutbox.issuanceRef })
      .pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.mapError(outboxUnavailable('request-release')),
      );

  return {
    claimDue,
    complete,
    find,
    forget,
    forgetExpired,
    record,
    release,
    settle: ({ issuanceRef, state }) => settle(issuanceRef, state),
  };
};

/** The store over the realm's own database. */
export const CommercePortalAuthCommunicationStoreLive = Layer.effect(
  CommercePortalAuthCommunicationStore,
  Effect.gen(function* makeCommercePortalAuthCommunicationStoreLive() {
    const database = yield* CommercePortalAuthDatabase;
    return makeCommercePortalAuthCommunicationStore(database.executor);
  }),
);
