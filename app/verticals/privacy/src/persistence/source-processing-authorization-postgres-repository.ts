import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import { OperationContextUnavailable } from '@app/core-runtime';
import { and, asc, desc, eq, inArray, lt } from 'drizzle-orm';
import { DateTime, Effect, Option, Schema } from 'effect';

import {
  SourceProcessingAuthorizationSchema,
  sourceIsOnRoute,
  sourceProcessingIdentityKey,
} from '../../shared/domain/privacy-source-processing-authorization.ts';
import type { SourceProcessingAuthorization } from '../../shared/domain/privacy-source-processing-authorization.ts';
import { PrivacySourceRecordIdentitySchema } from '../../shared/domain/privacy-subject.ts';
import { privacySubjects, sourceProcessingAdmissions, sourceProcessingAuthorizations } from '../database/schema.ts';
import {
  PrivacyOperationPersistenceError,
  privacyOperationPersistenceFailureCode,
} from './privacy-operation-persistence-error.ts';
import {
  SourceProcessingAuthorizationRepository,
  SourceProcessingAdmissionRowSchema,
} from './source-processing-authorization-repository.ts';
import type {
  SourceProcessingAdmissionRole,
  SourceProcessingAdmissionRow,
  SourceProcessingAuthorizationRepositoryService,
} from './source-processing-authorization-repository.ts';

type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];

const failure = (code: PrivacyOperationPersistenceError['code'], reason: string, cause?: unknown) => {
  const error = new PrivacyOperationPersistenceError({ code, reason });
  return cause === undefined ? error : Object.defineProperty(error, 'cause', { configurable: true, value: cause });
};
const persistenceFailure = (reason: string) => (cause: unknown) =>
  failure(privacyOperationPersistenceFailureCode(cause), reason, cause);
const conflict = (reason: string) => failure('privacy_operation_conflict', reason);
const iso = (value: Date) => DateTime.formatIso(DateTime.fromDateUnsafe(value));
const date = (value: string) => DateTime.toDateUtc(DateTime.makeUnsafe(value));
const decodeAuthorization = Schema.decodeUnknownEffect(SourceProcessingAuthorizationSchema);
const authorizationDecodeFailure = persistenceFailure('Stored Source Processing Authorization could not be decoded');
const decodeAdmissionRow = (row: {
  readonly firstAdmittedAt: Date;
  readonly lastAdmittedAt: Date;
  readonly privacySubjectId: string;
  readonly role: string;
}) =>
  Schema.decodeUnknownEffect(SourceProcessingAdmissionRowSchema)({
    firstAdmittedAt: iso(row.firstAdmittedAt),
    lastAdmittedAt: iso(row.lastAdmittedAt),
    role: row.role,
    subjectId: row.privacySubjectId,
  }).pipe(Effect.mapError(persistenceFailure('Stored source admission is invalid')));
const encodeAuthorization = (authorization: SourceProcessingAuthorization) =>
  Schema.encodeEffect(SourceProcessingAuthorizationSchema)(authorization).pipe(
    Effect.mapError(persistenceFailure('Source Processing Authorization could not be encoded')),
  );

const makeRepository = (
  transaction: ScopedTransaction,
  scope: Readonly<{ legalEntityId: string; tenantId: string }>,
): SourceProcessingAuthorizationRepositoryService => {
  const inScope = [
    eq(sourceProcessingAuthorizations.tenantId, scope.tenantId),
    eq(sourceProcessingAuthorizations.legalEntityId, scope.legalEntityId),
  ];
  const admissionScope = (authorizationId: string) => [
    eq(sourceProcessingAdmissions.tenantId, scope.tenantId),
    eq(sourceProcessingAdmissions.legalEntityId, scope.legalEntityId),
    eq(sourceProcessingAdmissions.authorizationId, authorizationId),
  ];
  const belongsToScope = (authorization: SourceProcessingAuthorization) =>
    authorization.authorizationRef.tenantId === scope.tenantId && authorization.legalEntityId === scope.legalEntityId;
  const get: SourceProcessingAuthorizationRepositoryService['get'] = Effect.fn(
    'SourceProcessingAuthorizationRepository.get',
  )(function* get(authorizationId) {
    const [row] = yield* transaction
      .select({ record: sourceProcessingAuthorizations.authorizationRecord })
      .from(sourceProcessingAuthorizations)
      .where(and(...inScope, eq(sourceProcessingAuthorizations.authorizationId, authorizationId)))
      .limit(1)
      .pipe(Effect.mapError(persistenceFailure('Source Processing Authorization could not be loaded')));
    if (row === undefined) {
      return Option.none();
    }
    const authorization = yield* decodeAuthorization(row.record).pipe(Effect.mapError(authorizationDecodeFailure));
    return belongsToScope(authorization) ? Option.some(authorization) : yield* conflict('Authorization scope mismatch');
  });

  const forRoute = (activeOnly: boolean): SourceProcessingAuthorizationRepositoryService['activeForRoute'] =>
    Effect.fn('SourceProcessingAuthorizationRepository.forRoute')(function* findRoute(route, lock) {
      const query = transaction
        .select({ record: sourceProcessingAuthorizations.authorizationRecord })
        .from(sourceProcessingAuthorizations)
        .where(
          and(
            ...inScope,
            activeOnly ? eq(sourceProcessingAuthorizations.lifecycle, 'ACTIVE') : undefined,
            eq(sourceProcessingAuthorizations.sourceIssuer, route.issuer),
            eq(sourceProcessingAuthorizations.sourceNamespace, route.namespace),
            eq(sourceProcessingAuthorizations.sourceRouteRef, route.routeRef),
          ),
        )
        .orderBy(asc(sourceProcessingAuthorizations.lifecycle), desc(sourceProcessingAuthorizations.createdAt))
        .limit(1);
      const rows = yield* (lock === 'admission' ? query.for('update') : query).pipe(
        Effect.mapError(persistenceFailure('Source Processing Authorizations could not be loaded')),
      );
      const authorizations = yield* Effect.forEach(
        rows,
        ({ record }) => decodeAuthorization(record).pipe(Effect.mapError(authorizationDecodeFailure)),
        { concurrency: 1 },
      );
      return authorizations.filter(belongsToScope);
    });

  return SourceProcessingAuthorizationRepository.of({
    activeForRoute: forRoute(true),
    admission: Effect.fn('SourceProcessingAuthorizationRepository.admission')(
      function* admission(authorizationId, source) {
        const [row] = yield* transaction
          .select({
            firstAdmittedAt: sourceProcessingAdmissions.firstAdmittedAt,
            lastAdmittedAt: sourceProcessingAdmissions.lastAdmittedAt,
            privacySubjectId: sourceProcessingAdmissions.privacySubjectId,
            role: sourceProcessingAdmissions.role,
          })
          .from(sourceProcessingAdmissions)
          .where(
            and(
              ...admissionScope(authorizationId),
              eq(sourceProcessingAdmissions.sourceIdentityKey, sourceProcessingIdentityKey(source)),
            ),
          )
          .limit(1)
          .pipe(Effect.mapError(persistenceFailure('Source admission could not be resolved')));
        return row === undefined ? Option.none() : Option.some(yield* decodeAdmissionRow(row));
      },
    ),
    admit: Effect.fn('SourceProcessingAuthorizationRepository.admit')(function* admit(input) {
      const keyed = input.sources.map((entry) => ({ ...entry, key: sourceProcessingIdentityKey(entry.source) }));
      const roots = keyed.filter(({ role }) => role === 'SUBJECT');
      const subject = input.membershipRoot === undefined ? roots[0] : keyed[0];
      if (input.membershipRoot !== undefined) {
        if (
          keyed.length !== 1 ||
          subject?.role !== 'CHILD' ||
          subject.source.recordType !== 'CUSTOMER_GROUP_MEMBERSHIP'
        ) {
          return yield* conflict('A membership must describe just one existing customer');
        }
        const [bound] = yield* transaction
          .select({ id: privacySubjects.privacySubjectId })
          .from(privacySubjects)
          .where(
            and(
              eq(privacySubjects.tenantId, scope.tenantId),
              eq(privacySubjects.legalEntityId, scope.legalEntityId),
              eq(privacySubjects.sourceIdentityKey, sourceProcessingIdentityKey(input.membershipRoot)),
            ),
          )
          .limit(1)
          .pipe(Effect.mapError(persistenceFailure('Membership subject could not be checked')));
        if (bound?.id !== input.subjectId) {
          return yield* conflict('Membership subject does not match its Profile');
        }
      }
      if ((input.membershipRoot === undefined && roots.length !== 1) || subject === undefined) {
        return yield* conflict('An admission requires exactly one subject source');
      }
      const [current] = yield* forRoute(true)(subject.source, 'admission');
      if (
        current?.authorizationRef.resourceId !== input.authorizationId ||
        keyed.some(({ source }) => !sourceIsOnRoute(current.source, source))
      ) {
        return yield* conflict('The source authorization is no longer active for these sources');
      }
      const keys = keyed.map(({ key }) => key);
      const [existing, aliases] = yield* Effect.all(
        [
          transaction
            .select({
              authorizationId: sourceProcessingAdmissions.authorizationId,
              firstAdmittedAt: sourceProcessingAdmissions.firstAdmittedAt,
              key: sourceProcessingAdmissions.sourceIdentityKey,
              lastAdmittedAt: sourceProcessingAdmissions.lastAdmittedAt,
              privacySubjectId: sourceProcessingAdmissions.privacySubjectId,
              role: sourceProcessingAdmissions.role,
            })
            .from(sourceProcessingAdmissions)
            .where(
              and(
                eq(sourceProcessingAdmissions.tenantId, scope.tenantId),
                eq(sourceProcessingAdmissions.legalEntityId, scope.legalEntityId),
                inArray(sourceProcessingAdmissions.sourceIdentityKey, keys),
              ),
            ),
          transaction
            .select({ subjectId: privacySubjects.privacySubjectId })
            .from(privacySubjects)
            .where(
              and(
                eq(privacySubjects.tenantId, scope.tenantId),
                eq(privacySubjects.legalEntityId, scope.legalEntityId),
                inArray(
                  privacySubjects.sourceIdentityKey,
                  keyed.flatMap(({ key, role }) => (role === 'CHILD' ? [key] : [])),
                ),
              ),
            ),
        ],
        { concurrency: 1 },
      ).pipe(Effect.mapError(persistenceFailure('Source admissions could not be resolved')));
      if (aliases.length > 0) {
        return yield* conflict('A child source record is already a Privacy subject of its own');
      }
      const known = new Map(
        existing.flatMap((row) => (row.authorizationId === input.authorizationId ? [[row.key, row] as const] : [])),
      );
      if (
        existing.some(
          (row) =>
            row.privacySubjectId !== input.subjectId || keyed.find((entry) => entry.key === row.key)?.role !== row.role,
        )
      ) {
        return yield* conflict('A source record is already admitted for a different subject or role');
      }
      yield* Effect.forEach(
        keyed,
        Effect.fn('SourceProcessingAuthorizationRepository.admitSource')(function* admitSource(entry) {
          const sourceRecord = yield* Schema.encodeEffect(PrivacySourceRecordIdentitySchema)(entry.source).pipe(
            Effect.mapError(persistenceFailure('Source record could not be encoded')),
          );
          yield* (
            known.has(entry.key)
              ? transaction
                  .update(sourceProcessingAdmissions)
                  .set({ lastActionInvocationId: input.actionInvocationId, lastAdmittedAt: date(input.admittedAt) })
                  .where(
                    and(
                      ...admissionScope(input.authorizationId),
                      lt(sourceProcessingAdmissions.lastAdmittedAt, date(input.admittedAt)),
                      eq(sourceProcessingAdmissions.sourceIdentityKey, entry.key),
                    ),
                  )
              : transaction.insert(sourceProcessingAdmissions).values({
                  authorizationId: input.authorizationId,
                  firstAdmittedAt: date(input.admittedAt),
                  lastActionInvocationId: input.actionInvocationId,
                  lastAdmittedAt: date(input.admittedAt),
                  legalEntityId: scope.legalEntityId,
                  privacySubjectId: input.subjectId,
                  role: entry.role satisfies SourceProcessingAdmissionRole,
                  sourceIdentityKey: entry.key,
                  sourceRecord,
                  tenantId: scope.tenantId,
                })
          ).pipe(Effect.mapError(persistenceFailure('Source admission could not be recorded')));
        }),
        { concurrency: 1, discard: true },
      );
      const prior = known.get(subject.key);
      return {
        firstAdmittedAt: prior === undefined ? input.admittedAt : iso(prior.firstAdmittedAt),
        lastAdmittedAt:
          prior !== undefined && prior.lastAdmittedAt > date(input.admittedAt)
            ? iso(prior.lastAdmittedAt)
            : input.admittedAt,
        role: subject.role,
        subjectId: input.subjectId,
      } satisfies SourceProcessingAdmissionRow;
    }),
    create: Effect.fn('SourceProcessingAuthorizationRepository.create')(
      function* create(authorization, actionInvocationId) {
        if (!belongsToScope(authorization) || authorization.lifecycle !== 'ACTIVE' || authorization.revision !== 1) {
          return yield* conflict('A new Source Processing Authorization starts ACTIVE at revision 1 in its scope');
        }
        yield* transaction
          .insert(sourceProcessingAuthorizations)
          .values({
            authorizationId: authorization.authorizationRef.resourceId,
            authorizationRecord: yield* encodeAuthorization(authorization),
            createdAt: date(authorization.createdAt),
            createdByActionInvocationId: actionInvocationId,
            legalEntityId: scope.legalEntityId,
            lifecycle: authorization.lifecycle,
            revision: authorization.revision,
            sourceIssuer: authorization.source.issuer,
            sourceNamespace: authorization.source.namespace,
            sourceRouteRef: authorization.source.routeRef,
            tenantId: scope.tenantId,
          })
          .pipe(Effect.mapError(persistenceFailure('Source Processing Authorization could not be recorded')));
        return authorization;
      },
    ),
    end: Effect.fn('SourceProcessingAuthorizationRepository.end')(
      function* end(ended, expectedRevision, actionInvocationId) {
        if (!belongsToScope(ended) || ended.lifecycle !== 'ENDED' || ended.endedAt === null) {
          return yield* conflict('An ended Source Processing Authorization records its end in its scope');
        }
        const updated = yield* transaction
          .update(sourceProcessingAuthorizations)
          .set({
            authorizationRecord: yield* encodeAuthorization(ended),
            endedAt: date(ended.endedAt),
            endedByActionInvocationId: actionInvocationId,
            lifecycle: ended.lifecycle,
            revision: ended.revision,
          })
          .where(
            and(
              ...inScope,
              eq(sourceProcessingAuthorizations.authorizationId, ended.authorizationRef.resourceId),
              eq(sourceProcessingAuthorizations.lifecycle, 'ACTIVE'),
              eq(sourceProcessingAuthorizations.revision, expectedRevision),
            ),
          )
          .returning({ authorizationId: sourceProcessingAuthorizations.authorizationId })
          .pipe(Effect.mapError(persistenceFailure('Source Processing Authorization could not be ended')));
        return updated.length === 1 ? ended : yield* conflict('The authorization changed or already ended');
      },
    ),
    get,
    latestForRoute: forRoute(false),
    sourceSubjectId: Effect.fn('SourceProcessingAuthorizationRepository.sourceSubjectId')(
      function* sourceSubjectId(source) {
        const [row] = yield* transaction
          .select({ id: privacySubjects.privacySubjectId })
          .from(privacySubjects)
          .where(
            and(
              eq(privacySubjects.tenantId, scope.tenantId),
              eq(privacySubjects.legalEntityId, scope.legalEntityId),
              eq(privacySubjects.sourceIdentityKey, sourceProcessingIdentityKey(source)),
            ),
          )
          .limit(1)
          .pipe(Effect.mapError(persistenceFailure('Source subject could not be resolved')));
        return Option.fromUndefinedOr(row?.id);
      },
    ),
  });
};

export const sourceProcessingAuthorizationRepositoryForScope = (
  transaction: ScopedTransaction,
  scope: OperationalScope,
): Effect.Effect<SourceProcessingAuthorizationRepositoryService, OperationContextUnavailable> =>
  scope.legalEntityId === undefined
    ? Effect.fail(
        new OperationContextUnavailable({
          code: 'operation_context_unavailable',
          reason: 'Source Processing Authorizations require a trusted Legal Entity scope',
        }),
      )
    : Effect.succeed(makeRepository(transaction, { legalEntityId: scope.legalEntityId, tenantId: scope.tenantId }));
