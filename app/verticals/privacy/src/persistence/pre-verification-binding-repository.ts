import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import { and, eq, isNull } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { Context, DateTime, Effect, Option, Schema } from 'effect';

import {
  PreVerificationBindingRecordSchema,
  PreVerificationBindingRefSchema,
  preVerificationSourceSubjectKey,
  rebindPreVerificationSubject,
} from '../../shared/domain/pre-verification-binding.ts';
import type {
  PreVerificationBindingRecord,
  PreVerificationSourceSubject,
} from '../../shared/domain/pre-verification-binding.ts';
import { preVerificationBindings } from '../database/schema.ts';
import { PrivacyOperationPersistenceError } from './privacy-operation-persistence-error.ts';

type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];

/** The outcome of binding one source account: Privacy's record, or the account is bound in another Legal Entity. */
type PreVerificationBindOutcome =
  | { readonly kind: 'BOUND'; readonly record: PreVerificationBindingRecord }
  | { readonly kind: 'SCOPE_CONFLICT' };

/**
 * Tenant-scoped storage of pre-verification bindings over the Core-owned transaction. Every statement names the exact
 * Tenant and the exact (possibly absent) Legal Entity of the operation, and row-level security enforces the same.
 */
export interface PreVerificationBindingRepositoryService {
  readonly bind: (input: {
    readonly bindingRef: string;
    readonly occurrenceValidUntil: string;
    readonly source: PreVerificationSourceSubject;
  }) => Effect.Effect<PreVerificationBindOutcome, PrivacyOperationPersistenceError>;
  readonly get: (
    bindingRef: string,
  ) => Effect.Effect<Option.Option<PreVerificationBindingRecord>, PrivacyOperationPersistenceError>;
  readonly withdraw: (input: {
    readonly bindingRef: string;
    readonly evidenceRef: string;
    readonly withdrawnBy: string;
  }) => Effect.Effect<Option.Option<PreVerificationBindingRecord>, PrivacyOperationPersistenceError>;
}

const unavailable = (reason: string) => (cause: unknown) =>
  Object.defineProperty(
    new PrivacyOperationPersistenceError({ code: 'privacy_operation_persistence_unavailable', reason }),
    'cause',
    { configurable: true, value: cause },
  );

export class PreVerificationBindingRepository extends Context.Service<
  PreVerificationBindingRepository,
  PreVerificationBindingRepositoryService
>()('@app/privacy/persistence/pre-verification-binding-repository/PreVerificationBindingRepository') {}

const decodeStoredRecord = Schema.decodeUnknownEffect(PreVerificationBindingRecordSchema);
const unreadable = unavailable('A stored pre-verification binding is not readable');
const encodeRecord = (record: PreVerificationBindingRecord) =>
  Schema.encodeEffect(PreVerificationBindingRecordSchema)(record).pipe(
    Effect.mapError(unavailable('A pre-verification binding could not be encoded')),
  );

export const preVerificationBindingRepositoryFor = (
  transaction: ScopedTransaction,
  scope: Pick<OperationalScope, 'legalEntityId' | 'tenantId'>,
): PreVerificationBindingRepositoryService => {
  const { legalEntityId, tenantId } = scope;
  const inScope = and(
    eq(preVerificationBindings.tenantId, tenantId),
    legalEntityId === undefined
      ? isNull(preVerificationBindings.legalEntityId)
      : eq(preVerificationBindings.legalEntityId, legalEntityId),
  );

  /** Locks the one binding of the exact scope that `identity` names (its source key or its Privacy identity). */
  const lockOne = (identity: SQL | undefined) =>
    transaction
      .select({ record: preVerificationBindings.bindingRecord })
      .from(preVerificationBindings)
      .where(and(inScope, identity))
      .for('update')
      .limit(1)
      .pipe(Effect.mapError(unavailable('A pre-verification binding could not be locked')));

  const store = (record: PreVerificationBindingRecord) =>
    encodeRecord(record).pipe(
      Effect.flatMap((encoded) =>
        transaction
          .update(preVerificationBindings)
          .set({
            bindingRecord: encoded,
            revision: record.revision,
            status: record.status,
            updatedAt: DateTime.toDateUtc(DateTime.makeUnsafe(record.updatedAt)),
          })
          .where(and(inScope, eq(preVerificationBindings.bindingId, record.bindingRef))),
      ),
      Effect.mapError(unavailable('A pre-verification binding could not be stored')),
      Effect.as(record),
    );

  const bind: PreVerificationBindingRepositoryService['bind'] = Effect.fn('PrivacyPreVerificationBinding.bind')(
    function* bindSubject(input) {
      const now = DateTime.formatIso(yield* DateTime.now);
      const sourceSubjectKey = preVerificationSourceSubjectKey(input.source);
      const tenantWide: PreVerificationBindingRecord = {
        bindingRef: PreVerificationBindingRefSchema.make(input.bindingRef),
        boundAt: now,
        revision: 1,
        source: input.source,
        status: 'ACTIVE',
        tenantId,
        updatedAt: now,
        validUntil: input.occurrenceValidUntil,
      };
      const candidate = legalEntityId === undefined ? tenantWide : { ...tenantWide, legalEntityId };
      const encoded = yield* encodeRecord(candidate);
      // the unique source key spans the Tenant: an account bound in another Legal Entity is never bound a second time
      yield* transaction
        .insert(preVerificationBindings)
        .values({
          bindingId: candidate.bindingRef,
          bindingRecord: encoded,
          legalEntityId: legalEntityId ?? null,
          revision: candidate.revision,
          sourceSubjectKey,
          status: candidate.status,
          tenantId,
        })
        .onConflictDoNothing({ target: [preVerificationBindings.tenantId, preVerificationBindings.sourceSubjectKey] })
        .pipe(Effect.mapError(unavailable('A pre-verification binding could not be claimed')));
      const [row] = yield* lockOne(eq(preVerificationBindings.sourceSubjectKey, sourceSubjectKey));
      if (row === undefined) {
        return { kind: 'SCOPE_CONFLICT' } as const;
      }
      const existing = yield* decodeStoredRecord(row.record).pipe(Effect.mapError(unreadable));
      const rebound = rebindPreVerificationSubject(existing, input.occurrenceValidUntil, now);
      return { kind: 'BOUND', record: rebound === existing ? existing : yield* store(rebound) } as const;
    },
  );

  const get: PreVerificationBindingRepositoryService['get'] = Effect.fn('PrivacyPreVerificationBinding.get')(
    function* getBinding(bindingRef) {
      const [row] = yield* transaction
        .select({ record: preVerificationBindings.bindingRecord })
        .from(preVerificationBindings)
        .where(and(inScope, eq(preVerificationBindings.bindingId, bindingRef)))
        .limit(1)
        .pipe(Effect.mapError(unavailable('A pre-verification binding could not be read')));
      return row === undefined
        ? Option.none()
        : Option.some(yield* decodeStoredRecord(row.record).pipe(Effect.mapError(unreadable)));
    },
  );

  const withdraw: PreVerificationBindingRepositoryService['withdraw'] = Effect.fn(
    'PrivacyPreVerificationBinding.withdraw',
  )(function* withdrawBinding(input) {
    const [row] = yield* lockOne(eq(preVerificationBindings.bindingId, input.bindingRef));
    if (row === undefined) {
      return Option.none();
    }
    const existing = yield* decodeStoredRecord(row.record).pipe(Effect.mapError(unreadable));
    if (existing.status === 'WITHDRAWN') {
      return Option.some(existing);
    }
    const now = DateTime.formatIso(yield* DateTime.now);
    return Option.some(
      yield* store({
        ...existing,
        revision: existing.revision + 1,
        status: 'WITHDRAWN',
        updatedAt: now,
        withdrawal: { evidenceRef: input.evidenceRef, withdrawnAt: now, withdrawnBy: input.withdrawnBy },
      }),
    );
  });

  return PreVerificationBindingRepository.of({ bind, get, withdraw });
};
