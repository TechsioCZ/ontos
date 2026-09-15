import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import { OperationContextUnavailable } from '@app/core-runtime';
import { and, asc, eq } from 'drizzle-orm';
import { DateTime, Effect, Option, Schema } from 'effect';

import { PrivacyNoticeProvisionSchema } from '../../shared/domain/privacy-notice-provision.ts';
import { noticeProvisions } from '../database/schema.ts';
import { NoticeProvisionPersistenceError } from './notice-provision-persistence-error.ts';
import type { NoticeProvisionRepositoryService } from './notice-provision-repository.ts';

type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];

const PERSISTENCE_UNAVAILABLE = 'Notice Provision persistence is unavailable';
const persistenceFailure = (reason: string, cause?: unknown) => {
  const error = new NoticeProvisionPersistenceError({
    code: 'privacy_notice_provision_persistence_unavailable',
    reason,
  });
  if (cause !== undefined) {
    Object.defineProperty(error, 'cause', { configurable: true, value: cause });
  }
  return error;
};

const identityConflict = (reason: string) =>
  new NoticeProvisionPersistenceError({
    code: 'privacy_notice_provision_identity_conflict',
    reason,
  });

const scopeUnavailable = () =>
  new OperationContextUnavailable({
    code: 'operation_context_unavailable',
    reason: 'Notice Provision operations require a trusted Legal Entity scope',
  });

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- PostgreSQL jsonb is decoded immediately through the public Notice Provision schema.
const decodeProvision = (value: unknown) =>
  Schema.decodeUnknownEffect(PrivacyNoticeProvisionSchema)(value).pipe(
    Effect.mapError((cause) => persistenceFailure('Stored Notice Provision could not be decoded', cause)),
  );

const provisionsAreEquivalent = Schema.toEquivalence(PrivacyNoticeProvisionSchema);

const makeRepository = (
  transaction: ScopedTransaction,
  trustedScope: Readonly<{ legalEntityId: string; tenantId: string }>,
): NoticeProvisionRepositoryService => {
  const assertScope = (tenantId: string, legalEntityId: string) =>
    tenantId === trustedScope.tenantId && legalEntityId === trustedScope.legalEntityId
      ? Effect.void
      : Effect.fail(persistenceFailure('Notice Provision request scope does not match trusted operation scope'));

  const findById: NoticeProvisionRepositoryService['findById'] = Effect.fn(
    'NoticeProvisionPostgresRepository.findById',
  )(function* findProvision(tenantId, legalEntityId, provisionId) {
    yield* assertScope(tenantId, legalEntityId);
    const rows = yield* transaction
      .select({ provisionRecord: noticeProvisions.provisionRecord })
      .from(noticeProvisions)
      .where(
        and(
          eq(noticeProvisions.tenantId, tenantId),
          eq(noticeProvisions.legalEntityId, legalEntityId),
          eq(noticeProvisions.provisionId, provisionId),
        ),
      )
      .limit(1)
      .pipe(Effect.mapError((cause) => persistenceFailure(PERSISTENCE_UNAVAILABLE, cause)));
    const [row] = rows;
    return row === undefined ? Option.none() : Option.some(yield* decodeProvision(row.provisionRecord));
  });

  return {
    findById,
    listForSubject: Effect.fn('NoticeProvisionPostgresRepository.listForSubject')(
      function* listForSubject(tenantId, legalEntityId, privacySubjectRef) {
        yield* assertScope(tenantId, legalEntityId);
        const rows = yield* transaction
          .select({ provisionRecord: noticeProvisions.provisionRecord })
          .from(noticeProvisions)
          .where(
            and(
              eq(noticeProvisions.tenantId, tenantId),
              eq(noticeProvisions.legalEntityId, legalEntityId),
              eq(noticeProvisions.privacySubjectRef, privacySubjectRef),
            ),
          )
          .orderBy(asc(noticeProvisions.recordedAt))
          .pipe(Effect.mapError((cause) => persistenceFailure(PERSISTENCE_UNAVAILABLE, cause)));
        return yield* Effect.forEach(rows, ({ provisionRecord }) => decodeProvision(provisionRecord), {
          concurrency: 1,
        });
      },
    ),
    record: Effect.fn('NoticeProvisionPostgresRepository.record')(
      function* recordProvision(tenantId, legalEntityId, actionInvocationId, provision) {
        yield* assertScope(tenantId, legalEntityId);
        const replayRows = yield* transaction
          .select({ provisionRecord: noticeProvisions.provisionRecord })
          .from(noticeProvisions)
          .where(
            and(
              eq(noticeProvisions.tenantId, tenantId),
              eq(noticeProvisions.legalEntityId, legalEntityId),
              eq(noticeProvisions.actionInvocationId, actionInvocationId),
            ),
          )
          .limit(1)
          .pipe(Effect.mapError((cause) => persistenceFailure(PERSISTENCE_UNAVAILABLE, cause)));
        const [replay] = replayRows;
        if (replay !== undefined) {
          const previous = yield* decodeProvision(replay.provisionRecord);
          return provisionsAreEquivalent(previous, provision)
            ? previous
            : yield* identityConflict('Action invocation was replayed with a different Notice Provision');
        }
        const existing = yield* findById(tenantId, legalEntityId, provision.provisionId);
        if (Option.isSome(existing)) {
          return provisionsAreEquivalent(existing.value, provision)
            ? existing.value
            : yield* identityConflict('Notice Provision identity already belongs to different evidence');
        }
        yield* transaction
          .insert(noticeProvisions)
          .values({
            actionInvocationId,
            anonymousContextRef: provision.anonymousContextRef,
            legalEntityId,
            noticeVersionRef: provision.noticeVersionRef,
            outcome: provision.outcome,
            privacySubjectRef: provision.privacySubjectRef,
            provisionId: provision.provisionId,
            provisionRecord: provision,
            recordedAt: DateTime.toDateUtc(DateTime.makeUnsafe(provision.recordedAt)),
            tenantId,
          })
          .pipe(Effect.mapError((cause) => persistenceFailure('Notice Provision could not be recorded', cause)));
        return provision;
      },
    ),
  };
};

export const noticeProvisionRepositoryForScope = (
  transaction: ScopedTransaction,
  scope: OperationalScope,
): Effect.Effect<NoticeProvisionRepositoryService, OperationContextUnavailable> =>
  scope.legalEntityId === undefined
    ? Effect.fail(scopeUnavailable())
    : Effect.succeed(makeRepository(transaction, { legalEntityId: scope.legalEntityId, tenantId: scope.tenantId }));
