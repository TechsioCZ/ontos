import { isPostgresUniqueViolation } from '@app/core-runtime';
import type { ScopedTransactionExecutor } from '@app/core-runtime';
import { PaymentTermDefinitionSnapshotSchema } from '@app/payment-term-catalog-contracts/payment-term';
import type { PaymentTermDefinitionSnapshot } from '@app/payment-term-catalog-contracts/payment-term';
import { PaymentTermRefSchema } from '@app/payment-term-catalog-contracts/resources/payment-term';
import type { PaymentTermRef } from '@app/payment-term-catalog-contracts/resources/payment-term';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { and, asc, eq } from 'drizzle-orm';
import { DateTime, Effect, Option, Schema } from 'effect';
import { Hex } from 'effect/encoding';

import { PaymentPurchasingContextSchema } from '../../shared/domain/applicability-purchasing-context.ts';
import type { PaymentPurchasingContext } from '../../shared/domain/applicability-purchasing-context.ts';
import { paymentConflict } from '../../shared/domain/payment-conflict.ts';
import type { PaymentConflict } from '../../shared/domain/payment-conflict.ts';
import { PaymentExecutionBindingSchema } from '../../shared/domain/payment-execution-binding.ts';
import type { PaymentExecutionBinding } from '../../shared/domain/payment-execution-binding.ts';
import type { PaymentMonetaryAmount } from '../../shared/domain/payment-money.ts';
import type { PaymentExecutionProvenance } from '../../shared/domain/payment-provenance.ts';
import {
  PaymentRefundableItemsBasisSchema,
  PaymentRefundBasisSchema,
} from '../../shared/domain/payment-refund-basis.ts';
import type { PaymentRefundBasis } from '../../shared/domain/payment-refund-basis.ts';
import { PaymentRefundExecutionRouteSchema } from '../../shared/domain/refund-contract.ts';
import type { PaymentRefundExecutionRoute } from '../../shared/domain/refund-contract.ts';
import { paymentRejected } from '../../shared/domain/payment-rejected.ts';
import type { PaymentRejected } from '../../shared/domain/payment-rejected.ts';
import { paymentUnavailable } from '../../shared/domain/payment-unavailable.ts';
import type { PaymentUnavailable } from '../../shared/domain/payment-unavailable.ts';
import { PaymentMethodSchema, PaymentOperationOutcomeSchema } from '../../shared/domain/payment-vocabulary.ts';
import type {
  PaymentMethod,
  PaymentOperationKind,
  PaymentOperationOutcome,
  PaymentOutcomeTransitionCause,
} from '../../shared/domain/payment-vocabulary.ts';
import type { PaymentFundsSnapshot } from '../domain/coverage.ts';
import {
  decideOperationAdmission,
  isAllowedOutcomeTransition,
  OperationAdmissionDecision,
} from '../domain/operation-lifecycle.ts';
import {
  observations,
  operationOutcomeTransitions,
  paymentOperations,
  payments,
  reconciliationCases,
  refundItemClaims,
} from '../database/schema.ts';

/**
 * Owner-local Payment aggregate persistence over the Core-installed `ScopedTransactionExecutor`
 * (pattern: commerce-order `order-commitment-persistence.ts`). Every mutating primitive takes the
 * Payment row lock (`SELECT ... FOR UPDATE`) first, so collection lineage, refund reservations,
 * coverage revision and Payment Authorization currentness share one atomic owner boundary
 * (#1148/#1149/#1150/#1151). Database triggers and partial unique indexes are the backstop.
 */

export interface PaymentRecord {
  readonly aggregateVersion: number;
  readonly amount: PaymentMonetaryAmount;
  readonly coverageRevision: number;
  readonly createdAt: DateTime.Utc;
  readonly customerConfigurationId: string;
  readonly executionBinding: PaymentExecutionBinding;
  readonly intentKey: string;
  readonly legalEntityId: string;
  readonly materialHash: string;
  readonly method: PaymentMethod;
  readonly paymentId: string;
  readonly paymentTermRef: PaymentTermRef;
  readonly predecessorPaymentId: string | undefined;
  readonly provenance: PaymentExecutionProvenance;
  readonly purchaseCorrelationId: string;
  /** The exact trusted Commerce Purchasing Context the intent was created for; immutable. */
  readonly purchasingContext: PaymentPurchasingContext;
  readonly tenantId: string;
  readonly termSemanticEvidence: PaymentTermDefinitionSnapshot;
}

export interface PaymentOperationRecord {
  readonly amount: PaymentMonetaryAmount;
  readonly binding: PaymentExecutionBinding;
  readonly createdAt: DateTime.Utc;
  readonly kind: PaymentOperationKind;
  readonly materialHash: string;
  readonly materialRequest: Schema.Json;
  readonly operationId: string;
  readonly operationKey: string;
  readonly outcome: PaymentOperationOutcome;
  readonly outcomeRevision: number;
  readonly paymentId: string;
  readonly provenance: PaymentExecutionProvenance;
  readonly refundBasis: PaymentRefundBasis | undefined;
  /** The configured executor a REFUND was requested through; immutable, never rerouted. */
  readonly refundExecutionRoute: PaymentRefundExecutionRoute | undefined;
  readonly targetOperationId: string | undefined;
}

export interface PaymentRefundItemClaimRecord {
  readonly amount: PaymentMonetaryAmount;
  readonly claimId: string;
  readonly itemRef: string;
  readonly operationId: string;
  readonly sourceEvidenceRef: string;
}

/** The Current aggregate as read under the Payment row lock. */
export interface PaymentAggregateRecord {
  /** Active item reservations (live or confirmed refunds); released claims are history only. */
  readonly activeClaims: readonly PaymentRefundItemClaimRecord[];
  /** Accepted SOURCE_CORRECTION amounts recorded against a COLLECT of this Payment. */
  readonly collectionCorrections: readonly PaymentMonetaryAmount[];
  readonly openReconciliationCaseCount: number;
  readonly operations: readonly PaymentOperationRecord[];
  readonly payment: PaymentRecord;
}

export interface NewPaymentInput {
  readonly amount: PaymentMonetaryAmount;
  readonly customerConfigurationId: string;
  readonly executionBinding: PaymentExecutionBinding;
  readonly intentKey: string;
  readonly method: PaymentMethod;
  readonly paymentTermRef: PaymentTermRef;
  /** Successor intent (#1148): the creating Action locks and checks the predecessor first. */
  readonly predecessorPaymentId?: string;
  readonly provenance: PaymentExecutionProvenance;
  readonly purchaseCorrelationId: string;
  /** The trusted Commerce Purchasing Context of the purchase (#1147/#1149); part of the material. */
  readonly purchasingContext: PaymentPurchasingContext;
  readonly termSemanticEvidence: PaymentTermDefinitionSnapshot;
}

interface NewPaymentOperationMaterial {
  readonly amount: PaymentMonetaryAmount;
  /** The immutable binding the operation executes under (the Payment's original binding). */
  readonly binding: PaymentExecutionBinding;
  readonly initialOutcome: 'PENDING' | 'INDETERMINATE';
  /** Canonical material request; its SHA-256 is the business replay comparator (#1151). */
  readonly materialRequest: Schema.Json;
  readonly operationKey: string;
  readonly paymentId: string;
  readonly provenance: PaymentExecutionProvenance;
}

/** A COLLECT, or a CANCEL_OR_VOID of the COLLECT it targets. */
export interface NewPaymentCollectOrCancelInput extends NewPaymentOperationMaterial {
  readonly kind: Exclude<PaymentOperationKind, 'REFUND'>;
  /** The COLLECT a CANCEL_OR_VOID targets; absent for COLLECT. */
  readonly targetOperationId?: string;
}

/** A REFUND of the COLLECT it targets, stored with its one immutable basis and execution route. */
export interface NewPaymentRefundInput extends NewPaymentOperationMaterial {
  readonly kind: 'REFUND';
  readonly refundBasis: PaymentRefundBasis;
  /** The configured executor chosen under the row lock (#1150); stored immutably, never rerouted. */
  readonly refundExecutionRoute: PaymentRefundExecutionRoute;
  readonly targetOperationId: string;
}

export type NewPaymentOperationInput = NewPaymentCollectOrCancelInput | NewPaymentRefundInput;

export interface PaymentOutcomeTransitionInput {
  /** What caused the change: the accepted observation, reconciliation decision or recovery. */
  readonly causedBy: {
    readonly kind: Exclude<PaymentOutcomeTransitionCause, 'CREATION'>;
    readonly sourceId?: string;
  };
  /** Optimistic fence: the outcome revision the caller decided against. */
  readonly expectedOutcomeRevision: number;
  readonly operationId: string;
  readonly paymentId: string;
  readonly provenance: PaymentExecutionProvenance;
  readonly to: PaymentOperationOutcome;
}

/** `written` is false for an exact replay or no-op: the existing record, unchanged and counted once. */
export interface PaymentWriteResult<Record> {
  readonly record: Record;
  readonly written: boolean;
}
const written = <Record>(record: Record): PaymentWriteResult<Record> => ({ record, written: true });
const unchanged = <Record>(record: Record): PaymentWriteResult<Record> => ({ record, written: false });

export type PaymentFailure = PaymentConflict | PaymentRejected | PaymentUnavailable;

export interface PaymentAggregatePersistence {
  readonly bumpCoverageRevision: (paymentId: string) => Effect.Effect<PaymentRecord, PaymentFailure>;
  readonly insertOperation: (
    input: NewPaymentOperationInput,
  ) => Effect.Effect<PaymentWriteResult<PaymentOperationRecord>, PaymentFailure>;
  readonly insertPayment: (input: NewPaymentInput) => Effect.Effect<PaymentWriteResult<PaymentRecord>, PaymentFailure>;
  readonly loadAggregate: (
    paymentId: string,
    options?: { readonly lock?: boolean },
  ) => Effect.Effect<PaymentAggregateRecord, PaymentFailure>;
  readonly lockPayment: (paymentId: string) => Effect.Effect<PaymentRecord, PaymentFailure>;
  readonly releaseRefundClaims: (input: {
    readonly operationId: string;
    readonly paymentId: string;
    readonly provenance: PaymentExecutionProvenance;
  }) => Effect.Effect<number, PaymentFailure>;
  readonly transitionOperationOutcome: (
    input: PaymentOutcomeTransitionInput,
  ) => Effect.Effect<PaymentWriteResult<PaymentOperationRecord>, PaymentFailure>;
}

/** Owner constraints whose uniqueness violation is a business conflict, not an outage. */
const CONFLICT_CONSTRAINTS: Readonly<Record<string, Parameters<typeof paymentConflict>[0]>> = Object.freeze({
  payment_operations_key_uk: 'payment_operation_material_conflict',
  payment_operations_one_collect_lineage_uk: 'payment_collect_lineage_conflict',
  payment_payments_intent_key_uk: 'payment_identity_conflict',
  payment_refund_item_claims_active_item_uk: 'payment_refund_item_reserved',
});
const CONFLICT_CONSTRAINT_ENTRIES = Object.entries(CONFLICT_CONSTRAINTS).map(
  ([constraint, code]) => [new Set([constraint]), code] as const,
);

/** Maps a driver failure to a typed conflict for owner constraints, otherwise to unavailable. */
export const paymentWriteFailure = (cause: unknown): PaymentConflict | PaymentUnavailable => {
  const match = CONFLICT_CONSTRAINT_ENTRIES.find(([constraints]) => isPostgresUniqueViolation(cause, constraints));
  if (match === undefined) {
    return paymentUnavailable('Payment state could not be written', cause);
  }
  const conflict = paymentConflict(match[1], 'A concurrent Payment change won this write');
  return Object.defineProperty(conflict, 'cause', { configurable: true, value: cause });
};

const readFailure = (cause: unknown) => paymentUnavailable('Payment state could not be read', cause);

const CanonicalJsonSchema: Schema.Codec<Schema.Json> = Schema.suspend(() =>
  Schema.Union([
    Schema.Null,
    Schema.Boolean,
    Schema.Finite,
    Schema.String,
    Schema.Array(CanonicalJsonSchema),
    Schema.Record(Schema.String, CanonicalJsonSchema),
  ]),
);
const CanonicalJsonRecordSchema = Schema.Record(Schema.String, CanonicalJsonSchema);
const compareKeys = (left: string, right: string) => {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
};
const canonicalJson = (value: Schema.Json): Schema.Json => {
  if (Array.isArray(value)) {
    return value.map(canonicalJson);
  }
  if (Schema.is(CanonicalJsonRecordSchema)(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([left], [right]) => compareKeys(left, right))
        .map(([key, child]) => [key, canonicalJson(child)]),
    );
  }
  return value;
};

/** SHA-256 of the key-sorted JSON; stable across PostgreSQL JSONB round trips. */
export const computePaymentMaterialHash = (material: Schema.Json): Effect.Effect<string, PaymentUnavailable> =>
  Schema.encodeEffect(Schema.fromJsonString(Schema.Json))(canonicalJson(material)).pipe(
    Effect.map((encoded) => Hex.encode(sha256(utf8ToBytes(encoded)))),
    Effect.mapError((cause) => paymentUnavailable('The material request could not be canonicalized', cause)),
  );

const encodeJson = <A>(schema: Schema.Codec<A, unknown>, value: A) =>
  Schema.encodeEffect(Schema.toCodecJson(schema))(value).pipe(
    Effect.mapError((cause) => paymentUnavailable('Payment evidence could not be encoded', cause)),
  );
const decodeStored = <A>(schema: Schema.Codec<A, unknown>, value: Schema.Json) =>
  Schema.decodeUnknownEffect(Schema.toCodecJson(schema))(value).pipe(
    Effect.mapError((cause) => paymentUnavailable('Stored Payment evidence is unreadable', cause)),
  );

type PaymentRow = typeof payments.$inferSelect;
type OperationRow = typeof paymentOperations.$inferSelect;

const provenanceOf = (row: {
  readonly actionInvocationId: string;
  readonly actorPrincipalId: string;
  readonly compositionRevision: string;
}): PaymentExecutionProvenance => ({
  actionInvocationId: row.actionInvocationId,
  actorPrincipalId: row.actorPrincipalId,
  compositionRevision: row.compositionRevision,
});

const amountOf = (amountMinor: number, currency: string) =>
  Schema.decodeUnknownEffect(Schema.Struct({ amountMinor: Schema.Finite, currency: Schema.Literal('CZK') }))({
    amountMinor,
    currency,
  }).pipe(Effect.mapError((cause) => paymentUnavailable('Stored Payment money is unreadable', cause)));

const paymentRecordOf = Effect.fn('PaymentAggregatePersistence.paymentRecordOf')(function* paymentRecordOf(
  row: PaymentRow,
) {
  const [amount, executionBinding, paymentTermRef, termSemanticEvidence, method, purchasingContext] = yield* Effect.all(
    [
      amountOf(row.amountMinor, row.currency),
      decodeStored(PaymentExecutionBindingSchema, row.executionBinding),
      decodeStored(PaymentTermRefSchema, row.paymentTermRef),
      decodeStored(PaymentTermDefinitionSnapshotSchema, row.termSemanticEvidence),
      decodeStored(PaymentMethodSchema, row.method),
      decodeStored(PaymentPurchasingContextSchema, row.purchasingContext),
    ],
    { concurrency: 1 },
  );
  return {
    aggregateVersion: row.aggregateVersion,
    amount,
    coverageRevision: row.coverageRevision,
    createdAt: DateTime.fromDateUnsafe(row.createdAt),
    customerConfigurationId: row.customerConfigurationId,
    executionBinding,
    intentKey: row.intentKey,
    legalEntityId: row.legalEntityId,
    materialHash: row.materialHash,
    method,
    paymentId: row.paymentId,
    paymentTermRef,
    predecessorPaymentId: row.predecessorPaymentId ?? undefined,
    provenance: provenanceOf(row),
    purchaseCorrelationId: row.purchaseCorrelationId,
    purchasingContext,
    tenantId: row.tenantId,
    termSemanticEvidence,
  } satisfies PaymentRecord;
});

const operationRecordOf = Effect.fn('PaymentAggregatePersistence.operationRecordOf')(function* operationRecordOf(
  row: OperationRow,
) {
  const [amount, binding, outcome, refundBasis, refundExecutionRoute] = yield* Effect.all(
    [
      amountOf(row.amountMinor, row.currency),
      decodeStored(PaymentExecutionBindingSchema, row.binding),
      decodeStored(PaymentOperationOutcomeSchema, row.outcome),
      row.refundBasis === null
        ? Effect.succeedNone
        : decodeStored(PaymentRefundBasisSchema, row.refundBasis).pipe(Effect.map(Option.some)),
      row.refundExecutionRoute === null
        ? Effect.succeedNone
        : decodeStored(PaymentRefundExecutionRouteSchema, row.refundExecutionRoute).pipe(Effect.map(Option.some)),
    ],
    { concurrency: 1 },
  );
  return {
    amount,
    binding,
    createdAt: DateTime.fromDateUnsafe(row.createdAt),
    kind: row.kind,
    materialHash: row.materialHash,
    materialRequest: row.materialRequest,
    operationId: row.operationId,
    operationKey: row.operationKey,
    outcome,
    outcomeRevision: row.outcomeRevision,
    paymentId: row.paymentId,
    provenance: provenanceOf(row),
    refundBasis: Option.getOrUndefined(refundBasis),
    refundExecutionRoute: Option.getOrUndefined(refundExecutionRoute),
    targetOperationId: row.targetOperationId ?? undefined,
  } satisfies PaymentOperationRecord;
});

/** Projects a loaded aggregate onto the shared funds guard input (`src/domain/coverage.ts`). */
export const paymentFundsSnapshotOf = (aggregate: PaymentAggregateRecord): PaymentFundsSnapshot => ({
  collectionCorrections: aggregate.collectionCorrections,
  operations: aggregate.operations.map((operation) => ({
    amount: operation.amount,
    kind: operation.kind,
    operationId: operation.operationId,
    outcome: operation.outcome,
    targetOperationId: operation.targetOperationId,
  })),
  required: aggregate.payment.amount,
  unresolvedEvidence: aggregate.openReconciliationCaseCount > 0,
});

/** Construction is private to a Core-owned transaction; handlers receive only these closed methods. */
export const paymentAggregatePersistenceForTransaction = (
  transaction: ScopedTransactionExecutor,
): PaymentAggregatePersistence => {
  const ownerScope = Effect.suspend(() => {
    const { legalEntityId, tenantId } = transaction.scope;
    return legalEntityId === undefined
      ? Effect.fail(paymentUnavailable('A verified Selling Legal Entity scope is required'))
      : Effect.succeed({ legalEntityId, tenantId });
  });
  const now = DateTime.now.pipe(Effect.map(DateTime.toDateUtc));

  const selectPayment = Effect.fn('PaymentAggregatePersistence.selectPayment')(function* selectPayment(
    paymentId: string,
    lock: boolean,
  ) {
    const scope = yield* ownerScope;
    const query = transaction
      .select()
      .from(payments)
      .where(
        and(
          eq(payments.tenantId, scope.tenantId),
          eq(payments.legalEntityId, scope.legalEntityId),
          eq(payments.paymentId, paymentId),
        ),
      );
    const [row] = yield* (lock ? query.for('update') : query).pipe(Effect.mapError(readFailure));
    if (row === undefined) {
      return yield* paymentRejected('payment_not_found', 'The Payment does not exist in this scope');
    }
    return row;
  });

  const lockPayment = Effect.fn('PaymentAggregatePersistence.lockPayment')(function* lockPayment(paymentId: string) {
    return yield* paymentRecordOf(yield* selectPayment(paymentId, true));
  });

  const selectOperations = Effect.fn('PaymentAggregatePersistence.selectOperations')(function* selectOperations(
    paymentId: string,
  ) {
    const scope = yield* ownerScope;
    const rows = yield* transaction
      .select()
      .from(paymentOperations)
      .where(
        and(
          eq(paymentOperations.tenantId, scope.tenantId),
          eq(paymentOperations.legalEntityId, scope.legalEntityId),
          eq(paymentOperations.paymentId, paymentId),
        ),
      )
      .orderBy(asc(paymentOperations.createdAt), asc(paymentOperations.operationId))
      .pipe(Effect.mapError(readFailure));
    return yield* Effect.forEach(rows, operationRecordOf, { concurrency: 1 });
  });

  /** Advances the aggregate version and, for a coverage-affecting change, the coverage revision. */
  const advanceAggregate = Effect.fn('PaymentAggregatePersistence.advanceAggregate')(function* advanceAggregate(
    row: PaymentRow,
    coverageAffecting: boolean,
  ) {
    const scope = yield* ownerScope;
    const [updated] = yield* transaction
      .update(payments)
      .set({
        aggregateVersion: row.aggregateVersion + 1,
        coverageRevision: coverageAffecting ? row.coverageRevision + 1 : row.coverageRevision,
      })
      .where(
        and(
          eq(payments.tenantId, scope.tenantId),
          eq(payments.legalEntityId, scope.legalEntityId),
          eq(payments.paymentId, row.paymentId),
          eq(payments.aggregateVersion, row.aggregateVersion),
        ),
      )
      .returning()
      .pipe(Effect.mapError(paymentWriteFailure));
    if (updated === undefined) {
      return yield* paymentConflict('payment_aggregate_version_conflict', 'The Payment changed concurrently');
    }
    return updated;
  });

  const selectActiveClaims = Effect.fn('PaymentAggregatePersistence.selectActiveClaims')(function* selectActiveClaims(
    paymentId: string,
  ) {
    const scope = yield* ownerScope;
    const rows = yield* transaction
      .select()
      .from(refundItemClaims)
      .where(
        and(
          eq(refundItemClaims.tenantId, scope.tenantId),
          eq(refundItemClaims.legalEntityId, scope.legalEntityId),
          eq(refundItemClaims.paymentId, paymentId),
          eq(refundItemClaims.active, true),
        ),
      )
      .orderBy(asc(refundItemClaims.claimedAt), asc(refundItemClaims.claimId))
      .pipe(Effect.mapError(readFailure));
    return yield* Effect.forEach(
      rows,
      (row) =>
        amountOf(row.amountMinor, row.currency).pipe(
          Effect.map((amount): PaymentRefundItemClaimRecord => ({
            amount,
            claimId: row.claimId,
            itemRef: row.itemRef,
            operationId: row.operationId,
            sourceEvidenceRef: row.sourceEvidenceRef,
          })),
        ),
      { concurrency: 1 },
    );
  });

  /**
   * Accepted corrections that disprove part of an established collection. Other corrections keep their
   * exact claimed amount as evidence but never reduce Current coverage (`correction_effect`).
   */
  const selectCorrections = Effect.fn('PaymentAggregatePersistence.selectCorrections')(function* selectCorrections(
    paymentId: string,
  ) {
    const scope = yield* ownerScope;
    const rows = yield* transaction
      .select({
        amountMinor: observations.amountMinor,
        currency: observations.currency,
        operationId: observations.operationId,
      })
      .from(observations)
      .where(
        and(
          eq(observations.tenantId, scope.tenantId),
          eq(observations.legalEntityId, scope.legalEntityId),
          eq(observations.paymentId, paymentId),
          eq(observations.factKind, 'SOURCE_CORRECTION'),
          eq(observations.acceptanceOutcome, 'ACCEPTED_OBSERVATION'),
          eq(observations.correctionEffect, 'REDUCE_ESTABLISHED_COLLECTION'),
        ),
      )
      .pipe(Effect.mapError(readFailure));
    const measured = rows.flatMap(({ amountMinor, currency, operationId }) =>
      operationId !== null && amountMinor !== null && currency !== null ? [{ amountMinor, currency, operationId }] : [],
    );
    return yield* Effect.forEach(
      measured,
      (row) =>
        amountOf(row.amountMinor, row.currency).pipe(
          Effect.map((amount) => ({ amount, operationId: row.operationId })),
        ),
      { concurrency: 1 },
    );
  });

  const countOpenCases = Effect.fn('PaymentAggregatePersistence.countOpenCases')(function* countOpenCases(
    paymentId: string,
  ) {
    const scope = yield* ownerScope;
    const rows = yield* transaction
      .select({ caseId: reconciliationCases.caseId })
      .from(reconciliationCases)
      .where(
        and(
          eq(reconciliationCases.tenantId, scope.tenantId),
          eq(reconciliationCases.legalEntityId, scope.legalEntityId),
          eq(reconciliationCases.paymentId, paymentId),
          eq(reconciliationCases.status, 'OPEN'),
        ),
      )
      .pipe(Effect.mapError(readFailure));
    return rows.length;
  });

  const loadAggregate = Effect.fn('PaymentAggregatePersistence.loadAggregate')(function* loadAggregate(
    paymentId: string,
    options?: { readonly lock?: boolean },
  ) {
    const paymentRow = yield* selectPayment(paymentId, options?.lock === true);
    // One transaction connection: the reads run in order after the (optional) row lock.
    const [payment, operations, activeClaims, corrections, openReconciliationCaseCount] = yield* Effect.all(
      [
        paymentRecordOf(paymentRow),
        selectOperations(paymentRow.paymentId),
        selectActiveClaims(paymentRow.paymentId),
        selectCorrections(paymentRow.paymentId),
        countOpenCases(paymentRow.paymentId),
      ],
      { concurrency: 1 },
    );
    // A correction reduces only the collection it corrected while that collection still establishes the
    // funds; a correction of an attempt later proven not effected never reduces a retry's collection.
    const collectIds = new Set<string>();
    for (const operation of operations) {
      if (operation.kind === 'COLLECT' && operation.outcome !== 'NOT_EFFECTED_CONFIRMED') {
        collectIds.add(operation.operationId);
      }
    }
    return {
      activeClaims,
      collectionCorrections: corrections.flatMap((correction) =>
        collectIds.has(correction.operationId) ? [correction.amount] : [],
      ),
      openReconciliationCaseCount,
      operations,
      payment,
    } satisfies PaymentAggregateRecord;
  });

  const insertPayment = Effect.fn('PaymentAggregatePersistence.insertPayment')(function* insertPayment(
    input: NewPaymentInput,
  ) {
    const scope = yield* ownerScope;
    const [executionBinding, paymentTermRef, termSemanticEvidence, purchasingContext] = yield* Effect.all(
      [
        encodeJson(PaymentExecutionBindingSchema, input.executionBinding),
        encodeJson(PaymentTermRefSchema, input.paymentTermRef),
        encodeJson(PaymentTermDefinitionSnapshotSchema, input.termSemanticEvidence),
        encodeJson(PaymentPurchasingContextSchema, input.purchasingContext),
      ],
      { concurrency: 1 },
    );
    const lockIntent = transaction
      .select()
      .from(payments)
      .where(
        and(
          eq(payments.tenantId, scope.tenantId),
          eq(payments.legalEntityId, scope.legalEntityId),
          eq(payments.intentKey, input.intentKey),
        ),
      )
      .for('update')
      .pipe(Effect.mapError(readFailure));
    const [materialHash, [existing]] = yield* Effect.all(
      [
        computePaymentMaterialHash({
          amountMinor: input.amount.amountMinor,
          currency: input.amount.currency,
          customerConfigurationId: input.customerConfigurationId,
          executionBinding,
          method: input.method,
          paymentTermRef,
          predecessorPaymentId: input.predecessorPaymentId ?? null,
          purchaseCorrelationId: input.purchaseCorrelationId,
          purchasingContext,
          termSemanticEvidence,
        }),
        lockIntent,
      ],
      { concurrency: 1 },
    );
    /** The stored intent is the replay only when its meaning is identical; otherwise the key conflicts. */
    const replayOf = (stored: PaymentRow) =>
      stored.materialHash === materialHash
        ? paymentRecordOf(stored).pipe(Effect.map(unchanged))
        : paymentConflict(
            'payment_intent_material_conflict',
            'The intent key already identifies a materially different Payment',
          );
    if (existing !== undefined) {
      return yield* replayOf(existing);
    }
    const createdAt = yield* now;
    // A concurrent invocation may create the same new intent after the absence check (no purchase row
    // serializes a brand-new purchase): the insert then yields to the committed winner and replays it.
    const [row] = yield* transaction
      .insert(payments)
      .values({
        ...scope,
        actionInvocationId: input.provenance.actionInvocationId,
        actorPrincipalId: input.provenance.actorPrincipalId,
        aggregateVersion: 1,
        amountMinor: input.amount.amountMinor,
        compositionRevision: input.provenance.compositionRevision,
        coverageRevision: 1,
        createdAt,
        currency: input.amount.currency,
        customerConfigurationId: input.customerConfigurationId,
        executionBinding,
        intentKey: input.intentKey,
        materialHash,
        method: input.method,
        paymentTermRef,
        predecessorPaymentId: input.predecessorPaymentId ?? null,
        purchaseCorrelationId: input.purchaseCorrelationId,
        purchasingContext,
        termSemanticEvidence,
      })
      .onConflictDoNothing({ target: [payments.tenantId, payments.legalEntityId, payments.intentKey] })
      .returning()
      .pipe(Effect.mapError(paymentWriteFailure));
    if (row !== undefined) {
      return written(yield* paymentRecordOf(row));
    }
    const [winner] = yield* lockIntent;
    if (winner === undefined) {
      return yield* paymentUnavailable('The Payment was not persisted');
    }
    return yield* replayOf(winner);
  });

  const insertClaims = Effect.fn('PaymentAggregatePersistence.insertClaims')(function* insertClaims(
    operation: OperationRow,
    basis: PaymentRefundBasis | undefined,
    claimedAt: Date,
  ) {
    if (basis === undefined || !Schema.is(PaymentRefundableItemsBasisSchema)(basis)) {
      return;
    }
    const scope = yield* ownerScope;
    yield* transaction
      .insert(refundItemClaims)
      .values(
        basis.items.map((item) => ({
          ...scope,
          active: true,
          amountMinor: item.amountMinor,
          claimedAt,
          currency: item.currency,
          itemRef: item.itemRef,
          operationId: operation.operationId,
          paymentId: operation.paymentId,
          sourceEvidenceRef: item.sourceEvidenceRef,
        })),
      )
      .pipe(Effect.mapError(paymentWriteFailure));
  });

  const insertOperation = Effect.fn('PaymentAggregatePersistence.insertOperation')(function* insertOperation(
    input: NewPaymentOperationInput,
  ) {
    const scope = yield* ownerScope;
    const [materialHash, paymentRow] = yield* Effect.all(
      [computePaymentMaterialHash(input.materialRequest), selectPayment(input.paymentId, true)],
      { concurrency: 1 },
    );
    const existing = yield* selectOperations(paymentRow.paymentId);
    const admission = decideOperationAdmission(existing, {
      kind: input.kind,
      materialHash,
      operationKey: input.operationKey,
    });
    if (OperationAdmissionDecision.$is('Replay')(admission)) {
      const replayed = existing.find((operation) => operation.operationId === admission.operationId);
      if (replayed !== undefined) {
        return unchanged(replayed);
      }
    }
    if (OperationAdmissionDecision.$is('MaterialConflict')(admission)) {
      return yield* paymentConflict(
        'payment_operation_material_conflict',
        'The operation key already identifies a materially different operation',
      );
    }
    if (OperationAdmissionDecision.$is('LineageConflict')(admission)) {
      return yield* paymentConflict(
        'payment_collect_lineage_conflict',
        'Another collection lineage is live or proven for this Payment',
      );
    }
    const refund = input.kind === 'REFUND' ? input : undefined;
    const [binding, refundBasis, refundExecutionRoute] = yield* Effect.all(
      [
        encodeJson(PaymentExecutionBindingSchema, input.binding),
        refund === undefined ? Effect.succeed(null) : encodeJson(PaymentRefundBasisSchema, refund.refundBasis),
        refund === undefined
          ? Effect.succeed(null)
          : encodeJson(PaymentRefundExecutionRouteSchema, refund.refundExecutionRoute),
      ],
      { concurrency: 1 },
    );
    const createdAt = yield* now;
    const [row] = yield* transaction
      .insert(paymentOperations)
      .values({
        ...scope,
        actionInvocationId: input.provenance.actionInvocationId,
        actorPrincipalId: input.provenance.actorPrincipalId,
        amountMinor: input.amount.amountMinor,
        binding,
        compositionRevision: input.provenance.compositionRevision,
        createdAt,
        currency: input.amount.currency,
        kind: input.kind,
        materialHash,
        materialRequest: input.materialRequest,
        operationKey: input.operationKey,
        outcome: input.initialOutcome,
        outcomeRevision: 1,
        paymentId: input.paymentId,
        refundBasis,
        refundBasisKind: refund?.refundBasis._tag ?? null,
        refundExecutionRoute,
        targetOperationId: input.targetOperationId ?? null,
      })
      .returning()
      .pipe(Effect.mapError(paymentWriteFailure));
    if (row === undefined) {
      return yield* paymentUnavailable('The Payment Operation was not persisted');
    }
    yield* transaction
      .insert(operationOutcomeTransitions)
      .values({
        ...scope,
        actionInvocationId: input.provenance.actionInvocationId,
        actorPrincipalId: input.provenance.actorPrincipalId,
        causeId: null,
        causeKind: 'CREATION',
        compositionRevision: input.provenance.compositionRevision,
        fromOutcome: null,
        operationId: row.operationId,
        outcomeRevision: 1,
        paymentId: row.paymentId,
        recordedAt: createdAt,
        toOutcome: row.outcome,
      })
      .pipe(Effect.mapError(paymentWriteFailure));
    yield* insertClaims(row, refund?.refundBasis, createdAt);
    // Starting a cancellation or refund can reduce prepaid coverage: prior proofs become unusable.
    yield* advanceAggregate(paymentRow, input.kind !== 'COLLECT');
    return written(yield* operationRecordOf(row));
  });

  const releaseClaims = Effect.fn('PaymentAggregatePersistence.releaseClaims')(function* releaseClaims(
    operationId: string,
    paymentId: string,
    provenance: PaymentExecutionProvenance,
  ) {
    const scope = yield* ownerScope;
    const releasedAt = yield* now;
    const released = yield* transaction
      .update(refundItemClaims)
      .set({ active: false, releasedAt, releasedByActionInvocationId: provenance.actionInvocationId })
      .where(
        and(
          eq(refundItemClaims.tenantId, scope.tenantId),
          eq(refundItemClaims.legalEntityId, scope.legalEntityId),
          eq(refundItemClaims.paymentId, paymentId),
          eq(refundItemClaims.operationId, operationId),
          eq(refundItemClaims.active, true),
        ),
      )
      .returning({ claimId: refundItemClaims.claimId })
      .pipe(Effect.mapError(paymentWriteFailure));
    return released.length;
  });

  const transitionOperationOutcome = Effect.fn('PaymentAggregatePersistence.transitionOperationOutcome')(
    function* transitionOperationOutcome(input: PaymentOutcomeTransitionInput) {
      const scope = yield* ownerScope;
      const paymentRow = yield* selectPayment(input.paymentId, true);
      const operations = yield* selectOperations(paymentRow.paymentId);
      const current = operations.find((operation) => operation.operationId === input.operationId);
      if (current === undefined) {
        return yield* paymentRejected('payment_operation_not_found', 'The Payment Operation does not exist');
      }
      if (current.outcomeRevision !== input.expectedOutcomeRevision) {
        return yield* paymentConflict(
          'payment_aggregate_version_conflict',
          'The operation outcome changed concurrently',
        );
      }
      if (current.outcome === input.to) {
        return unchanged(current);
      }
      if (!isAllowedOutcomeTransition(current.outcome, input.to)) {
        return yield* paymentRejected(
          'payment_outcome_transition_illegal',
          `A ${current.outcome} operation cannot become ${input.to}`,
        );
      }
      const recordedAt = yield* now;
      const nextRevision = current.outcomeRevision + 1;
      const [row] = yield* transaction
        .update(paymentOperations)
        .set({ outcome: input.to, outcomeRevision: nextRevision })
        .where(
          and(
            eq(paymentOperations.tenantId, scope.tenantId),
            eq(paymentOperations.legalEntityId, scope.legalEntityId),
            eq(paymentOperations.paymentId, input.paymentId),
            eq(paymentOperations.operationId, input.operationId),
            eq(paymentOperations.outcomeRevision, current.outcomeRevision),
          ),
        )
        .returning()
        .pipe(Effect.mapError(paymentWriteFailure));
      if (row === undefined) {
        return yield* paymentConflict(
          'payment_aggregate_version_conflict',
          'The operation outcome changed concurrently',
        );
      }
      yield* transaction
        .insert(operationOutcomeTransitions)
        .values({
          ...scope,
          actionInvocationId: input.provenance.actionInvocationId,
          actorPrincipalId: input.provenance.actorPrincipalId,
          causeId: input.causedBy.sourceId ?? null,
          causeKind: input.causedBy.kind,
          compositionRevision: input.provenance.compositionRevision,
          fromOutcome: current.outcome,
          operationId: input.operationId,
          outcomeRevision: nextRevision,
          paymentId: input.paymentId,
          recordedAt,
          toOutcome: input.to,
        })
        .pipe(Effect.mapError(paymentWriteFailure));
      // Definitive non-execution releases the operation's item reservations atomically (#1150). Claims are
      // never reactivated: if that outcome is later overturned, the refund's immutable basis protects its
      // items again (`findUnavailableRefundItem`), and an item reclaimed in between is held overlap debt.
      if (input.to === 'NOT_EFFECTED_CONFIRMED') {
        yield* releaseClaims(input.operationId, input.paymentId, input.provenance);
      }
      // Every outcome change can alter Current coverage: prior prepaid proofs become unusable.
      yield* advanceAggregate(paymentRow, true);
      return written(yield* operationRecordOf(row));
    },
  );

  const releaseRefundClaims = Effect.fn('PaymentAggregatePersistence.releaseRefundClaims')(
    function* releaseRefundClaims(input: {
      readonly operationId: string;
      readonly paymentId: string;
      readonly provenance: PaymentExecutionProvenance;
    }) {
      const paymentRow = yield* selectPayment(input.paymentId, true);
      const operations = yield* selectOperations(paymentRow.paymentId);
      const operation = operations.find((candidate) => candidate.operationId === input.operationId);
      if (operation === undefined) {
        return yield* paymentRejected('payment_operation_not_found', 'The Payment Operation does not exist');
      }
      if (operation.outcome !== 'NOT_EFFECTED_CONFIRMED') {
        return yield* paymentRejected(
          'payment_outcome_transition_illegal',
          'Only definitive non-execution releases refund reservations',
        );
      }
      return yield* releaseClaims(input.operationId, input.paymentId, input.provenance);
    },
  );

  const bumpCoverageRevision = Effect.fn('PaymentAggregatePersistence.bumpCoverageRevision')(
    function* bumpCoverageRevision(paymentId: string) {
      const row = yield* selectPayment(paymentId, true);
      return yield* paymentRecordOf(yield* advanceAggregate(row, true));
    },
  );

  return Object.freeze({
    bumpCoverageRevision,
    insertOperation,
    insertPayment,
    loadAggregate,
    lockPayment,
    releaseRefundClaims,
    transitionOperationOutcome,
  });
};
