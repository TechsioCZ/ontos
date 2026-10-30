import { NoticeProvisionRepository } from './notice-provision-repository.ts';
import type { NoticeProvisionRepositoryService } from './notice-provision-repository.ts';
import type { DataAccessEventInput, OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import { OperationContextUnavailable } from '@app/core-runtime';
import { and, asc, eq } from 'drizzle-orm';
import { flow, Context, DateTime, Effect, Option, Redacted, Schema } from 'effect';

import { PrivacyNoticeProvisionSchema } from '../../shared/domain/privacy-notice-provision.ts';
import { noticeAcknowledgements, noticeProvisions } from '../database/schema.ts';
import {
  PrivacyNoticeAcknowledgementError,
  PrivacyNoticeAcknowledgementSchema,
  privacyNoticePresentationBindingFields,
} from '../../shared/resources/privacy-notice-acknowledgement.ts';
import type { PrivacyNoticeAcknowledgement } from '../../shared/resources/privacy-notice-acknowledgement.ts';
import { NoticeProvisionPersistenceError } from './notice-provision-persistence-error.ts';

/** Each implementation is built over the current Core-owned transaction and fixed Tenant/LE. */
export interface NoticeAcknowledgementRepository {
  readonly findById: (
    acknowledgementId: string,
  ) => Effect.Effect<Option.Option<PrivacyNoticeAcknowledgement>, PrivacyNoticeAcknowledgementError>;
  readonly findByPresentation: (
    presentationId: string,
  ) => Effect.Effect<Option.Option<PrivacyNoticeAcknowledgement>, PrivacyNoticeAcknowledgementError>;
  readonly readEvidence?: () => readonly DataAccessEventInput[];
  readonly record: (
    acknowledgement: PrivacyNoticeAcknowledgement,
  ) => Effect.Effect<PrivacyNoticeAcknowledgement, PrivacyNoticeAcknowledgementError>;
}

export class NoticeAcknowledgementRepositoryTag extends Context.Service<
  NoticeAcknowledgementRepositoryTag,
  NoticeAcknowledgementRepository
>()('@app/privacy/persistence/notice-provision-postgres-repository/NoticeAcknowledgementRepositoryTag') {}

type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];

const MODULE_KEY = 'privacy.core' as const;
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

const decodeProvision = flow(
  Schema.decodeUnknownEffect(PrivacyNoticeProvisionSchema),
  Effect.mapError((cause) => persistenceFailure('Stored Notice Provision could not be decoded', cause)),
);

const provisionsAreEquivalent = Schema.toEquivalence(PrivacyNoticeProvisionSchema);

const makeRepository = (
  transaction: ScopedTransaction,
  trustedScope: Readonly<{ legalEntityId: string; tenantId: string }>,
): NoticeProvisionRepositoryService & { readonly readEvidence: () => readonly DataAccessEventInput[] } => {
  const reads: DataAccessEventInput[] = [];
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
    reads.push({
      accessKind: 'read',
      queryHash: 'privacy.notice-provision.by-id.v1',
      resultCount: rows.length,
      servingModuleKey: MODULE_KEY,
    });
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
        reads.push({
          accessKind: 'list',
          queryHash: 'privacy.notice-provision.for-subject.v1',
          resultCount: rows.length,
          servingModuleKey: MODULE_KEY,
        });
        return yield* Effect.forEach(rows, ({ provisionRecord }) => decodeProvision(provisionRecord), {
          concurrency: 1,
        });
      },
    ),
    readEvidence: () => [...reads],
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
        reads.push({
          accessKind: 'read',
          queryHash: 'privacy.notice-provision.by-invocation.v1',
          resultCount: replayRows.length,
          servingModuleKey: MODULE_KEY,
        });
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
        const insertedRows = yield* transaction
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
          .onConflictDoNothing({ target: noticeProvisions.provisionId })
          .returning({ provisionRecord: noticeProvisions.provisionRecord })
          .pipe(Effect.mapError((cause) => persistenceFailure('Notice Provision could not be recorded', cause)));
        const [inserted] = insertedRows;
        if (inserted !== undefined) {
          return yield* decodeProvision(inserted.provisionRecord);
        }
        const concurrent = yield* findById(tenantId, legalEntityId, provision.provisionId);
        if (Option.isNone(concurrent)) {
          return yield* identityConflict('Notice Provision identity belongs to another scope or is unavailable');
        }
        return provisionsAreEquivalent(concurrent.value, provision)
          ? concurrent.value
          : yield* identityConflict('Notice Provision identity already belongs to different evidence');
      },
    ),
  };
};

export const noticeProvisionRepositoryForScope = (
  transaction: ScopedTransaction,
  scope: OperationalScope,
): Effect.Effect<ReturnType<typeof makeRepository>, OperationContextUnavailable> => {
  if (scope.legalEntityId === undefined) {
    return Effect.fail(scopeUnavailable());
  }
  const repository = makeRepository(transaction, { legalEntityId: scope.legalEntityId, tenantId: scope.tenantId });
  return Effect.succeed({ ...NoticeProvisionRepository.of(repository), readEvidence: repository.readEvidence });
};

const acknowledgementUnavailable = (cause?: unknown) => {
  const error = new PrivacyNoticeAcknowledgementError({
    code: 'privacy_notice_acknowledgement_unavailable',
    reason: 'Notice acknowledgement persistence is unavailable',
  });
  if (cause !== undefined) {
    Object.defineProperty(error, 'cause', { value: Redacted.make(cause) });
  }
  return error;
};
const acknowledgementConflict = () =>
  new PrivacyNoticeAcknowledgementError({
    code: 'privacy_notice_acknowledgement_conflict',
    reason: 'The presentation already belongs to different immutable acknowledgement bindings',
  });
const samePresentationBinding = Schema.toEquivalence(Schema.Struct(privacyNoticePresentationBindingFields));

/** No global pool or caller-selected scope: reads and writes share the current operation transaction. */
export const noticeAcknowledgementRepositoryForScope = (
  transaction: ScopedTransaction,
  scope: OperationalScope,
): Effect.Effect<NoticeAcknowledgementRepository, OperationContextUnavailable> => {
  const { legalEntityId, tenantId } = scope;
  if (legalEntityId === undefined) {
    return Effect.fail(scopeUnavailable());
  }
  const reads: DataAccessEventInput[] = [];
  const decode = flow(
    Schema.decodeUnknownEffect(PrivacyNoticeAcknowledgementSchema),
    Effect.mapError(acknowledgementUnavailable),
  );
  const scopePredicate = and(
    eq(noticeAcknowledgements.tenantId, tenantId),
    eq(noticeAcknowledgements.legalEntityId, legalEntityId),
  );
  const findById: NoticeAcknowledgementRepository['findById'] = Effect.fn('NoticeAcknowledgementRepository.findById')(
    function* findById(acknowledgementId) {
      const rows = yield* transaction
        .select({ record: noticeAcknowledgements.acknowledgementRecord })
        .from(noticeAcknowledgements)
        .where(and(scopePredicate, eq(noticeAcknowledgements.acknowledgementId, acknowledgementId)))
        .limit(1)
        .pipe(Effect.mapError(acknowledgementUnavailable));
      reads.push({
        accessKind: 'read',
        queryHash: 'privacy.notice-acknowledgement.by-id.v1',
        resultCount: rows.length,
        servingModuleKey: MODULE_KEY,
      });
      return rows[0] === undefined ? Option.none() : Option.some(yield* decode(rows[0].record));
    },
  );
  const findByPresentation: NoticeAcknowledgementRepository['findByPresentation'] = Effect.fn(
    'NoticeAcknowledgementRepository.findByPresentation',
  )(function* findByPresentation(presentationId) {
    const rows = yield* transaction
      .select({ record: noticeAcknowledgements.acknowledgementRecord })
      .from(noticeAcknowledgements)
      .where(and(scopePredicate, eq(noticeAcknowledgements.presentationId, presentationId)))
      .limit(1)
      .pipe(Effect.mapError(acknowledgementUnavailable));
    reads.push({
      accessKind: 'read',
      queryHash: 'privacy.notice-acknowledgement.by-presentation.v1',
      resultCount: rows.length,
      servingModuleKey: MODULE_KEY,
    });
    return rows[0] === undefined ? Option.none() : Option.some(yield* decode(rows[0].record));
  });
  return Effect.succeed(
    NoticeAcknowledgementRepositoryTag.of({
      findById,
      findByPresentation,
      readEvidence: () => [...reads],
      record: Effect.fn('NoticeAcknowledgementRepository.record')(function* record(acknowledgement) {
        const validated = yield* Schema.decodeUnknownEffect(PrivacyNoticeAcknowledgementSchema)(acknowledgement).pipe(
          Effect.mapError(acknowledgementUnavailable),
        );
        if (
          validated.tenantId !== tenantId ||
          validated.legalEntityId !== legalEntityId ||
          validated.privacySubjectRef.tenantId !== tenantId
        ) {
          return yield* acknowledgementConflict();
        }
        const rows = yield* transaction
          .insert(noticeAcknowledgements)
          .values({
            acknowledgedAt: DateTime.toDateUtc(DateTime.makeUnsafe(validated.acknowledgedAt)),
            acknowledgementId: validated.acknowledgementId,
            acknowledgementRecord: validated,
            actionInvocationId: validated.actionInvocationId,
            actorPrincipalId: validated.actorPrincipalId,
            authBindingId: validated.authBindingId,
            legalEntityId,
            noticeVersionId: validated.noticeVersionId,
            presentationId: validated.presentationId,
            privacySubjectId: validated.privacySubjectRef.resourceId,
            recordedAt: DateTime.toDateUtc(DateTime.makeUnsafe(validated.recordedAt)),
            retailProfileId: validated.retailProfileId,
            servedAt: DateTime.toDateUtc(DateTime.makeUnsafe(validated.servedAt)),
            sessionContextDigest: validated.sessionContextDigest,
            tenantId,
          })
          .onConflictDoNothing({
            target: [
              noticeAcknowledgements.tenantId,
              noticeAcknowledgements.legalEntityId,
              noticeAcknowledgements.presentationId,
            ],
          })
          .returning({ record: noticeAcknowledgements.acknowledgementRecord })
          .pipe(Effect.mapError(acknowledgementUnavailable));
        const [inserted] = rows;
        if (inserted !== undefined) {
          return yield* decode(inserted.record);
        }
        const existing = yield* findByPresentation(validated.presentationId);
        if (Option.isNone(existing)) {
          return yield* acknowledgementUnavailable();
        }
        return samePresentationBinding(existing.value, validated) ? existing.value : yield* acknowledgementConflict();
      }),
    }),
  );
};
