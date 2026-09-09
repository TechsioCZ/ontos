import type {
  OperationalScope,
  ReadServiceFactory,
  ScopedRoutineInvocationError,
} from '@app/core-runtime';
import { OperationContextUnavailable } from '@app/core-runtime';
import { createHash } from 'node:crypto';
import { Effect, Option, Schema } from 'effect';
import {
  PaymentTermAliasSchema,
  PaymentTermCompatibilityIdSchema,
  PaymentTermDefinitionSchema,
  PaymentTermInstantSchema,
  PaymentTermReasonSchema,
} from '../../shared/domain/payment-term.ts';
import type {
  PaymentTermAlias,
  PaymentTermDefinition,
  PaymentTermSemantics,
} from '../../shared/domain/payment-term.ts';
import {
  PaymentTermCatalogPersistenceConflict,
  PaymentTermCatalogPersistenceUnavailable,
} from './errors.ts';
import type { PaymentTermRoutineRow } from './scoped-routine.ts';
import {
  correctPaymentTermRoutine,
  createPaymentTermRoutine,
  getCurrentPaymentTermRoutine,
  getPaymentTermHistoryRoutine,
  listCurrentPaymentTermsRoutine,
  reconcilePaymentTermRoutine,
  resolvePaymentTermReferenceRoutine,
  retirePaymentTermRoutine,
} from './scoped-routine.ts';

export {
  PaymentTermCatalogPersistenceConflict,
  PaymentTermCatalogPersistenceUnavailable,
} from './errors.ts';

type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];

const PaymentTermIdSchema = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('PaymentTermId'),
);
const MetadataRevisionSchema = Schema.Finite.check(
  Schema.isInt(),
  Schema.isBetween({ maximum: 2_147_483_647, minimum: 1 }),
);
const ReconciliationTargetSchema = Schema.Literals(['alias', 'canonical']);

export type StoredPaymentTermSemantics = PaymentTermSemantics;
export type StoredPaymentTermDefinition = PaymentTermDefinition;
export type StoredPaymentTermAlias = PaymentTermAlias;

const StoredPaymentTermLifecycleEventSchema = Schema.Struct({
  actingPrincipalId: PaymentTermIdSchema,
  actionInvocationId: PaymentTermIdSchema,
  effectiveAt: PaymentTermInstantSchema,
  eventKind: Schema.Literals(['ACTIVATED', 'RETIRED']),
  reason: PaymentTermReasonSchema,
  recordedAt: PaymentTermInstantSchema,
});

const StoredPaymentTermHistorySchema = Schema.Struct({
  aliases: Schema.Array(PaymentTermAliasSchema),
  lifecycle: Schema.Array(StoredPaymentTermLifecycleEventSchema),
  revisions: Schema.Array(PaymentTermDefinitionSchema),
});
export type StoredPaymentTermHistory = typeof StoredPaymentTermHistorySchema.Type;

export interface StoredPaymentTermPage {
  readonly definitions: readonly StoredPaymentTermDefinition[];
  readonly truncated: boolean;
}

export interface CreateStoredPaymentTermInput {
  readonly actingPrincipalId: string;
  readonly actionInvocationId: string;
  readonly activeFrom: Date;
  readonly businessCode: string;
  readonly compatibilityKey: string;
  readonly displayName: string;
  readonly explanation: string;
  readonly paymentTermId?: string;
  readonly reason: string;
  readonly semantics: StoredPaymentTermSemantics;
}

export interface CorrectStoredPaymentTermInput {
  readonly actingPrincipalId: string;
  readonly actionInvocationId: string;
  readonly displayName: string;
  readonly expectedMetadataRevision: number;
  readonly explanation: string;
  readonly paymentTermId: string;
  readonly reason: string;
}

export interface RetireStoredPaymentTermInput {
  readonly actingPrincipalId: string;
  readonly actionInvocationId: string;
  readonly effectiveAt: Date;
  readonly expectedMetadataRevision: number;
  readonly paymentTermId: string;
  readonly reason: string;
}

export interface ReconcileStoredPaymentTermInput {
  readonly actingPrincipalId: string;
  readonly actionInvocationId: string;
  readonly aliasPaymentTermId: string;
  readonly canonicalPaymentTermId: string;
  readonly expectedAliasMetadataRevision: number;
  readonly expectedCanonicalMetadataRevision: number;
  readonly reason: string;
}

const CreateStoredPaymentTermOutcomeSchema = Schema.Union([
  Schema.TaggedStruct('created', { definition: PaymentTermDefinitionSchema }),
  Schema.TaggedStruct('business_code_conflict', { existingPaymentTermId: PaymentTermIdSchema }),
  Schema.TaggedStruct('duplicate_semantics', { existingPaymentTermId: PaymentTermIdSchema }),
]);
export type CreateStoredPaymentTermOutcome = typeof CreateStoredPaymentTermOutcomeSchema.Type;

const CorrectStoredPaymentTermOutcomeSchema = Schema.Union([
  Schema.TaggedStruct('corrected', { definition: PaymentTermDefinitionSchema }),
  Schema.TaggedStruct('not_found', {}),
  Schema.TaggedStruct('revision_conflict', { actualMetadataRevision: MetadataRevisionSchema }),
  Schema.TaggedStruct('retired', { retiredEffectiveAt: PaymentTermInstantSchema }),
]);
export type CorrectStoredPaymentTermOutcome = typeof CorrectStoredPaymentTermOutcomeSchema.Type;

const RetireStoredPaymentTermOutcomeSchema = Schema.Union([
  Schema.TaggedStruct('retired', { definition: PaymentTermDefinitionSchema }),
  Schema.TaggedStruct('not_found', {}),
  Schema.TaggedStruct('revision_conflict', { actualMetadataRevision: MetadataRevisionSchema }),
  Schema.TaggedStruct('already_retired', { retiredEffectiveAt: PaymentTermInstantSchema }),
]);
export type RetireStoredPaymentTermOutcome = typeof RetireStoredPaymentTermOutcomeSchema.Type;

const ReconcileStoredPaymentTermOutcomeSchema = Schema.Union([
  Schema.TaggedStruct('reconciled', { alias: PaymentTermAliasSchema }),
  Schema.TaggedStruct('not_found', { missing: ReconciliationTargetSchema }),
  Schema.TaggedStruct('same_identity', {}),
  Schema.TaggedStruct('canonical_is_alias', { canonicalPaymentTermId: PaymentTermIdSchema }),
  Schema.TaggedStruct('already_reconciled', { canonicalPaymentTermId: PaymentTermIdSchema }),
  Schema.TaggedStruct('reconciliation_conflict', { canonicalPaymentTermId: PaymentTermIdSchema }),
  Schema.TaggedStruct('incompatible_semantics', {}),
  Schema.TaggedStruct('revision_conflict', {
    actualMetadataRevision: MetadataRevisionSchema,
    target: ReconciliationTargetSchema,
  }),
]);
export type ReconcileStoredPaymentTermOutcome = typeof ReconcileStoredPaymentTermOutcomeSchema.Type;

const ResolveStoredPaymentTermOutcomeSchema = Schema.Union([
  Schema.TaggedStruct('resolved', {
    canonicalPaymentTermId: PaymentTermIdSchema,
    definition: PaymentTermDefinitionSchema,
    requestedPaymentTermId: PaymentTermIdSchema,
  }),
  Schema.TaggedStruct('missing', { requestedPaymentTermId: PaymentTermIdSchema }),
  Schema.TaggedStruct('broken_alias', {
    reason: Schema.Literals(['cycle', 'depth_exceeded']),
    requestedPaymentTermId: PaymentTermIdSchema,
  }),
  Schema.TaggedStruct('not_yet_active', {
    activeFrom: PaymentTermInstantSchema,
    canonicalPaymentTermId: PaymentTermIdSchema,
    definition: PaymentTermDefinitionSchema,
    requestedPaymentTermId: PaymentTermIdSchema,
  }),
  Schema.TaggedStruct('retired', {
    canonicalPaymentTermId: PaymentTermIdSchema,
    definition: PaymentTermDefinitionSchema,
    requestedPaymentTermId: PaymentTermIdSchema,
    retiredEffectiveAt: PaymentTermInstantSchema,
  }),
  Schema.TaggedStruct('incompatible', {
    actualCompatibilityKey: PaymentTermCompatibilityIdSchema,
    canonicalPaymentTermId: PaymentTermIdSchema,
    definition: PaymentTermDefinitionSchema,
    requestedPaymentTermId: PaymentTermIdSchema,
  }),
]);
export type ResolveStoredPaymentTermOutcome = typeof ResolveStoredPaymentTermOutcomeSchema.Type;

const unavailable = (cause?: unknown) => {
  const failure = new PaymentTermCatalogPersistenceUnavailable({
    code: 'payment_term_catalog_persistence_unavailable',
    reason: 'Payment Term Catalog persistence is temporarily unavailable',
  });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  }
  return failure;
};

const invocationFailure = (
  failure: ScopedRoutineInvocationError,
): PaymentTermCatalogPersistenceConflict | PaymentTermCatalogPersistenceUnavailable => {
  const constraint = Option.getOrUndefined(failure.constraint);
  let conflict: PaymentTermCatalogPersistenceConflict['conflict'] | undefined;
  if (constraint === 'payment_term_catalog_terms_scope_code_uk') {
    conflict = 'BUSINESS_CODE';
  } else if (
    constraint === 'payment_term_catalog_terms_scope_id_uk' ||
    constraint === 'payment_terms_pkey'
  ) {
    conflict = 'PAYMENT_TERM_ID';
  } else if (constraint === 'payment_term_catalog_revisions_number_uk') {
    conflict = 'REVISION_NUMBER';
  } else if (constraint === 'payment_term_catalog_revisions_semantics_uk') {
    conflict = 'SEMANTIC_DUPLICATE';
  } else if (
    constraint === 'payment_term_catalog_aliases_alias_uk' ||
    constraint === 'payment_term_catalog_aliases_pair_uk'
  ) {
    conflict = 'RECONCILIATION';
  } else if (
    constraint === 'payment_term_catalog_aliases_invocation_uk' ||
    constraint === 'payment_term_catalog_lifecycle_invocation_uk' ||
    constraint === 'payment_term_catalog_revisions_invocation_uk'
  ) {
    conflict = 'ACTION_INVOCATION_REUSED';
  }
  if (conflict !== undefined) {
    return new PaymentTermCatalogPersistenceConflict({
      code: 'payment_term_catalog_persistence_conflict',
      conflict,
      reason: 'The Payment Term Catalog mutation conflicts with durable catalog state',
    });
  }
  return unavailable(failure);
};

const decodePayload = <Value>(
  schema: Schema.ConstraintDecoder<Value>,
  rows: readonly PaymentTermRoutineRow[],
): Effect.Effect<Value, PaymentTermCatalogPersistenceUnavailable> => {
  const [row] = rows;
  return row === undefined
    ? Effect.fail(unavailable())
    : Schema.decodeUnknownEffect(schema)(row.payload).pipe(Effect.mapError(unavailable));
};

const decodeOptionalPayload = <Value>(
  schema: Schema.ConstraintDecoder<Value>,
  rows: readonly PaymentTermRoutineRow[],
): Effect.Effect<Option.Option<Value>, PaymentTermCatalogPersistenceUnavailable> => {
  const [row] = rows;
  if (row === undefined) {
    return Effect.fail(unavailable());
  }
  return row.payload === null
    ? Effect.succeed(Option.none())
    : Schema.decodeUnknownEffect(schema)(row.payload).pipe(
        Effect.map(Option.some),
        Effect.mapError(unavailable),
      );
};

export const paymentTermSemanticFingerprint = (
  semantics: StoredPaymentTermSemantics,
  compatibilityKey: string,
): string => {
  const canonical =
    semantics.kind === 'IMMEDIATE'
      ? `IMMEDIATE|1|NOT_APPLICABLE|${compatibilityKey}`
      : `NET_DAYS|${semantics.days}|INVOICE_ISSUED_AT|CALENDAR_DAYS_UTC|1|${compatibilityKey}`;
  return createHash('sha256').update(canonical, 'utf-8').digest('hex');
};

export interface PaymentTermCatalogPersistence {
  readonly correct: (
    input: CorrectStoredPaymentTermInput,
  ) => Effect.Effect<
    CorrectStoredPaymentTermOutcome,
    PaymentTermCatalogPersistenceConflict | PaymentTermCatalogPersistenceUnavailable
  >;
  readonly create: (
    input: CreateStoredPaymentTermInput,
  ) => Effect.Effect<
    CreateStoredPaymentTermOutcome,
    PaymentTermCatalogPersistenceConflict | PaymentTermCatalogPersistenceUnavailable
  >;
  readonly getCurrent: (
    paymentTermId: string,
  ) => Effect.Effect<
    Option.Option<StoredPaymentTermDefinition>,
    PaymentTermCatalogPersistenceUnavailable
  >;
  readonly getHistory: (
    paymentTermId: string,
  ) => Effect.Effect<
    Option.Option<StoredPaymentTermHistory>,
    PaymentTermCatalogPersistenceUnavailable
  >;
  readonly listCurrent: (
    limit: number,
    at: Date,
  ) => Effect.Effect<StoredPaymentTermPage, PaymentTermCatalogPersistenceUnavailable>;
  readonly reconcile: (
    input: ReconcileStoredPaymentTermInput,
  ) => Effect.Effect<
    ReconcileStoredPaymentTermOutcome,
    PaymentTermCatalogPersistenceConflict | PaymentTermCatalogPersistenceUnavailable
  >;
  readonly resolveReference: (
    paymentTermId: string,
    at: Date,
    expectedCompatibilityKey?: string,
  ) => Effect.Effect<ResolveStoredPaymentTermOutcome, PaymentTermCatalogPersistenceUnavailable>;
  readonly retire: (
    input: RetireStoredPaymentTermInput,
  ) => Effect.Effect<
    RetireStoredPaymentTermOutcome,
    PaymentTermCatalogPersistenceConflict | PaymentTermCatalogPersistenceUnavailable
  >;
}

const scopeUnavailable = () =>
  new OperationContextUnavailable({
    code: 'operation_context_unavailable',
    reason: 'Payment Term Catalog operations require a trusted legal entity',
  });

export const makePaymentTermCatalogPersistence = (
  transaction: ScopedTransaction,
  scope: OperationalScope,
): Effect.Effect<PaymentTermCatalogPersistence, OperationContextUnavailable> => {
  if (scope.legalEntityId === undefined) {
    return Effect.fail(scopeUnavailable());
  }

  const create: PaymentTermCatalogPersistence['create'] = Effect.fn(
    'PaymentTermCatalogPersistence.create',
  )(function* createPaymentTerm(input) {
    const rows = yield* transaction
      .invoke(createPaymentTermRoutine, [
        {
          actingPrincipalId: input.actingPrincipalId,
          actionInvocationId: input.actionInvocationId,
          activeFrom: input.activeFrom.toISOString(),
          businessCode: input.businessCode,
          compatibilityKey: input.compatibilityKey,
          displayName: input.displayName,
          explanation: input.explanation,
          paymentTermId: input.paymentTermId ?? null,
          reason: input.reason,
          semantics: input.semantics,
        },
      ])
      .pipe(Effect.mapError(invocationFailure));
    return yield* decodePayload(CreateStoredPaymentTermOutcomeSchema, rows);
  });

  const correct: PaymentTermCatalogPersistence['correct'] = Effect.fn(
    'PaymentTermCatalogPersistence.correct',
  )(function* correctPaymentTerm(input) {
    const rows = yield* transaction
      .invoke(correctPaymentTermRoutine, [input])
      .pipe(Effect.mapError(invocationFailure));
    return yield* decodePayload(CorrectStoredPaymentTermOutcomeSchema, rows);
  });

  const retire: PaymentTermCatalogPersistence['retire'] = Effect.fn(
    'PaymentTermCatalogPersistence.retire',
  )(function* retirePaymentTerm(input) {
    const rows = yield* transaction
      .invoke(retirePaymentTermRoutine, [
        { ...input, effectiveAt: input.effectiveAt.toISOString() },
      ])
      .pipe(Effect.mapError(invocationFailure));
    return yield* decodePayload(RetireStoredPaymentTermOutcomeSchema, rows);
  });

  const reconcile: PaymentTermCatalogPersistence['reconcile'] = Effect.fn(
    'PaymentTermCatalogPersistence.reconcile',
  )(function* reconcilePaymentTerm(input) {
    const rows = yield* transaction
      .invoke(reconcilePaymentTermRoutine, [input])
      .pipe(Effect.mapError(invocationFailure));
    return yield* decodePayload(ReconcileStoredPaymentTermOutcomeSchema, rows);
  });

  const getCurrent: PaymentTermCatalogPersistence['getCurrent'] = Effect.fn(
    'PaymentTermCatalogPersistence.getCurrent',
  )(function* getCurrentPaymentTerm(paymentTermId) {
    const rows = yield* transaction
      .invoke(getCurrentPaymentTermRoutine, [paymentTermId])
      .pipe(Effect.mapError(unavailable));
    return yield* decodeOptionalPayload(PaymentTermDefinitionSchema, rows);
  });

  const getHistory: PaymentTermCatalogPersistence['getHistory'] = Effect.fn(
    'PaymentTermCatalogPersistence.getHistory',
  )(function* getPaymentTermHistory(paymentTermId) {
    const rows = yield* transaction
      .invoke(getPaymentTermHistoryRoutine, [paymentTermId])
      .pipe(Effect.mapError(unavailable));
    return yield* decodeOptionalPayload(StoredPaymentTermHistorySchema, rows);
  });

  const listCurrent: PaymentTermCatalogPersistence['listCurrent'] = Effect.fn(
    'PaymentTermCatalogPersistence.listCurrent',
  )(function* listCurrentPaymentTerms(limit, at) {
    const pageLimit = Math.max(1, Math.min(limit, 200));
    const rows = yield* transaction
      .invoke(listCurrentPaymentTermsRoutine, [pageLimit, at])
      .pipe(Effect.mapError(unavailable));
    const definitions = yield* Effect.forEach(
      rows,
      ({ payload }) =>
        Schema.decodeUnknownEffect(PaymentTermDefinitionSchema)(payload).pipe(
          Effect.mapError(unavailable),
        ),
      { concurrency: 1 },
    );
    return {
      definitions: definitions.slice(0, pageLimit),
      truncated: definitions.length > pageLimit,
    };
  });

  const resolveReference: PaymentTermCatalogPersistence['resolveReference'] = Effect.fn(
    'PaymentTermCatalogPersistence.resolveReference',
  )(function* resolvePaymentTermReference(paymentTermId, at, expectedCompatibilityKey) {
    const rows = yield* transaction
      .invoke(resolvePaymentTermReferenceRoutine, [
        paymentTermId,
        at,
        expectedCompatibilityKey ?? null,
      ])
      .pipe(Effect.mapError(unavailable));
    return yield* decodePayload(ResolveStoredPaymentTermOutcomeSchema, rows);
  });

  return Effect.succeed(
    Object.freeze({
      correct,
      create,
      getCurrent,
      getHistory,
      listCurrent,
      reconcile,
      resolveReference,
      retire,
    }),
  );
};
