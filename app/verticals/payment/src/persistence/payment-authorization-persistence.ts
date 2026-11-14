import { isPostgresUniqueViolation } from '@app/core-runtime';
import type { ScopedTransactionExecutor } from '@app/core-runtime';
import { PaymentTermRefSchema } from '@app/payment-term-catalog-contracts/resources/payment-term';
import { and, eq } from 'drizzle-orm';
import { DateTime, Effect, Option, Schema } from 'effect';

import {
  PaymentAuthorizationBindingSchema,
  PaymentAuthorizationConditionSchema,
  PaymentAuthorizationProofSchema,
  PaymentAuthorizationTermSemanticSchema,
  paymentAuthorizationRefused,
} from '../../shared/domain/authorization-proof.ts';
import type {
  PaymentAuthorizationBinding,
  PaymentAuthorizationCondition,
  PaymentAuthorizationProof,
  PaymentAuthorizationRefused,
  PaymentAuthorizationTermSemantic,
} from '../../shared/domain/authorization-proof.ts';
import { PaymentExecutionBindingSchema } from '../../shared/domain/payment-execution-binding.ts';
import type { PaymentExecutionProvenance } from '../../shared/domain/payment-provenance.ts';
import { paymentUnavailable } from '../../shared/domain/payment-unavailable.ts';
import type { PaymentUnavailable } from '../../shared/domain/payment-unavailable.ts';
import type { PaymentAuthorizationProofKind } from '../../shared/domain/payment-vocabulary.ts';
import { paymentAuthorizations } from '../database/schema.ts';

/**
 * Owner-local append-only Payment Authorization ledger (#1149). Callers hold the Payment row lock
 * (`loadAggregate(..., { lock: true })`) before reading or appending, so issuance, refund start and
 * Current validation serialize on one owner boundary. Proof rows are never updated or deleted.
 */

/**
 * Proof material without a dedicated column, retained in the `method_condition_evidence` JSON
 * document: the frozen business time T, the exact execution binding, the C15 semantic reference and
 * the satisfied condition. It never contains secrets or raw provider payloads.
 */
const StoredProofEvidenceSchema = Schema.Struct({
  commitmentAttemptEvidenceRef: PaymentAuthorizationProofSchema.fields.commitmentAttemptEvidenceRef,
  condition: PaymentAuthorizationConditionSchema,
  executionBinding: PaymentExecutionBindingSchema,
  orderCommitmentTime: PaymentAuthorizationBindingSchema.fields.orderCommitmentTime,
  termSemantic: PaymentAuthorizationTermSemanticSchema,
});

export interface NewPaymentAuthorizationInput {
  readonly binding: PaymentAuthorizationBinding;
  readonly commitmentAttemptEvidenceRef: string;
  readonly condition: PaymentAuthorizationCondition;
  readonly coverageRevision: number | undefined;
  readonly expiresAt: DateTime.Utc;
  readonly issuanceKey: string;
  readonly issuedAt: DateTime.Utc;
  readonly proofKind: PaymentAuthorizationProofKind;
  readonly provenance: PaymentExecutionProvenance;
  readonly termSemantic: PaymentAuthorizationTermSemantic;
}

export interface PaymentAuthorizationPersistence {
  readonly findById: (
    authorizationId: string,
  ) => Effect.Effect<Option.Option<PaymentAuthorizationProof>, PaymentUnavailable>;
  /** The proof already issued under this issuance key for the Payment, whatever its Attempt. */
  readonly findByIssuanceKey: (
    paymentId: string,
    issuanceKey: string,
  ) => Effect.Effect<Option.Option<PaymentAuthorizationProof>, PaymentUnavailable>;
  readonly insert: (
    input: NewPaymentAuthorizationInput,
  ) => Effect.Effect<PaymentAuthorizationProof, PaymentAuthorizationRefused | PaymentUnavailable>;
  /** Prepaid proofs of the Payment issued against this exact coverage revision, any Attempt. */
  readonly listPrepaidAtCoverageRevision: (
    paymentId: string,
    coverageRevision: number,
  ) => Effect.Effect<readonly PaymentAuthorizationProof[], PaymentUnavailable>;
}

const readFailure = (cause: unknown) => paymentUnavailable('Payment Authorization state could not be read', cause);
const isUuid = Schema.is(Schema.String.check(Schema.isUUID()));
const ISSUANCE_CONSTRAINTS = new Set(['payment_authorizations_issuance_uk']);

const writeFailure = (cause: unknown): PaymentAuthorizationRefused | PaymentUnavailable => {
  if (!isPostgresUniqueViolation(cause, ISSUANCE_CONSTRAINTS)) {
    return paymentUnavailable('Payment Authorization could not be written', cause);
  }
  const conflict = paymentAuthorizationRefused(
    'payment_authorization_issuance_conflict',
    'A concurrent issuance with the same issuance key won this write',
  );
  return Object.defineProperty(conflict, 'cause', { configurable: true, value: cause });
};

type AuthorizationRow = typeof paymentAuthorizations.$inferSelect;

/**
 * The original immutable proof of one stored row: binding with frozen T, satisfied condition, term
 * semantic reference, issuance key, original times and provenance. Shared with the historical read.
 */
export const paymentAuthorizationProofOfRow = Effect.fn('PaymentAuthorizationPersistence.decodeProof')(
  function* decodeProof(row: AuthorizationRow) {
    const evidence = yield* Schema.decodeUnknownEffect(Schema.toCodecJson(StoredProofEvidenceSchema))(
      row.methodConditionEvidence,
    );
    const paymentTermRef = yield* Schema.decodeUnknownEffect(Schema.toCodecJson(PaymentTermRefSchema))(
      row.paymentTermRef,
    );
    const coverage = row.coverageRevision === null ? {} : { coverageRevision: row.coverageRevision };
    const attempt =
      evidence.commitmentAttemptEvidenceRef === undefined
        ? {}
        : { commitmentAttemptEvidenceRef: evidence.commitmentAttemptEvidenceRef };
    return yield* Schema.decodeUnknownEffect(PaymentAuthorizationProofSchema)({
      authorizationId: row.authorizationId,
      binding: {
        amount: { amountMinor: row.amountMinor, currency: row.currency },
        executionBinding: evidence.executionBinding,
        method: row.method,
        orderCommitmentAttemptId: row.orderCommitmentAttemptId,
        orderCommitmentTime: DateTime.formatIso(evidence.orderCommitmentTime),
        paymentId: row.paymentId,
        paymentTermRef,
        purchaseCorrelationId: row.purchaseCorrelationId,
      },
      ...attempt,
      condition: evidence.condition,
      ...coverage,
      expiresAt: DateTime.formatIso(DateTime.fromDateUnsafe(row.expiresAt)),
      issuanceKey: row.issuanceKey,
      issuedAt: DateTime.formatIso(DateTime.fromDateUnsafe(row.issuedAt)),
      proofKind: row.proofKind,
      provenance: {
        actionInvocationId: row.actionInvocationId,
        actorPrincipalId: row.actorPrincipalId,
        compositionRevision: row.compositionRevision,
      },
      termSemantic: evidence.termSemantic,
    });
  },
  Effect.mapError((cause) => paymentUnavailable('A stored Payment Authorization is unreadable', cause)),
);

const firstProof = (rows: readonly AuthorizationRow[]) => {
  const [row] = rows;
  return row === undefined ? Effect.succeedNone : paymentAuthorizationProofOfRow(row).pipe(Effect.map(Option.some));
};

/** Construction is private to a Core-owned transaction scoped to one Selling Legal Entity. */
export const paymentAuthorizationPersistenceForTransaction = (
  transaction: ScopedTransactionExecutor,
): PaymentAuthorizationPersistence => {
  const ownerScope = Effect.suspend(() => {
    const { legalEntityId, tenantId } = transaction.scope;
    return legalEntityId === undefined
      ? Effect.fail(paymentUnavailable('A verified Selling Legal Entity scope is required'))
      : Effect.succeed({ legalEntityId, tenantId });
  });

  const findById = Effect.fn('PaymentAuthorizationPersistence.findById')(function* findById(authorizationId: string) {
    if (!isUuid(authorizationId)) {
      return Option.none<PaymentAuthorizationProof>();
    }
    const scope = yield* ownerScope;
    const rows = yield* transaction
      .select()
      .from(paymentAuthorizations)
      .where(
        and(
          eq(paymentAuthorizations.tenantId, scope.tenantId),
          eq(paymentAuthorizations.legalEntityId, scope.legalEntityId),
          eq(paymentAuthorizations.authorizationId, authorizationId),
        ),
      )
      .pipe(Effect.mapError(readFailure));
    return yield* firstProof(rows);
  });

  const findByIssuanceKey = Effect.fn('PaymentAuthorizationPersistence.findByIssuanceKey')(function* findByIssuanceKey(
    paymentId: string,
    issuanceKey: string,
  ) {
    const scope = yield* ownerScope;
    const rows = yield* transaction
      .select()
      .from(paymentAuthorizations)
      .where(
        and(
          eq(paymentAuthorizations.tenantId, scope.tenantId),
          eq(paymentAuthorizations.legalEntityId, scope.legalEntityId),
          eq(paymentAuthorizations.paymentId, paymentId),
          eq(paymentAuthorizations.issuanceKey, issuanceKey),
        ),
      )
      .pipe(Effect.mapError(readFailure));
    return yield* firstProof(rows);
  });

  const insert = Effect.fn('PaymentAuthorizationPersistence.insert')(function* insert(
    input: NewPaymentAuthorizationInput,
  ) {
    const scope = yield* ownerScope;
    const [evidence, paymentTermRef] = yield* Effect.all(
      [
        Schema.encodeEffect(Schema.toCodecJson(StoredProofEvidenceSchema))({
          commitmentAttemptEvidenceRef: input.commitmentAttemptEvidenceRef,
          condition: input.condition,
          executionBinding: input.binding.executionBinding,
          orderCommitmentTime: input.binding.orderCommitmentTime,
          termSemantic: input.termSemantic,
        }),
        Schema.encodeEffect(Schema.toCodecJson(PaymentTermRefSchema))(input.binding.paymentTermRef),
      ],
      { concurrency: 1 },
    ).pipe(
      Effect.mapError((cause) => paymentUnavailable('Payment Authorization evidence could not be encoded', cause)),
    );
    const [row] = yield* transaction
      .insert(paymentAuthorizations)
      .values({
        ...scope,
        actionInvocationId: input.provenance.actionInvocationId,
        actorPrincipalId: input.provenance.actorPrincipalId,
        amountMinor: input.binding.amount.amountMinor,
        compositionRevision: input.provenance.compositionRevision,
        coverageRevision: input.coverageRevision ?? null,
        currency: input.binding.amount.currency,
        expiresAt: DateTime.toDateUtc(input.expiresAt),
        issuanceKey: input.issuanceKey,
        issuedAt: DateTime.toDateUtc(input.issuedAt),
        method: input.binding.method,
        methodConditionEvidence: evidence,
        orderCommitmentAttemptId: input.binding.orderCommitmentAttemptId,
        paymentId: input.binding.paymentId,
        paymentTermRef,
        proofKind: input.proofKind,
        purchaseCorrelationId: input.binding.purchaseCorrelationId,
      })
      .returning()
      .pipe(Effect.mapError(writeFailure));
    if (row === undefined) {
      return yield* paymentUnavailable('The Payment Authorization was not persisted');
    }
    return yield* paymentAuthorizationProofOfRow(row);
  });

  const listPrepaidAtCoverageRevision = Effect.fn('PaymentAuthorizationPersistence.listPrepaidAtCoverageRevision')(
    function* listPrepaidAtCoverageRevision(paymentId: string, coverageRevision: number) {
      const scope = yield* ownerScope;
      const rows = yield* transaction
        .select()
        .from(paymentAuthorizations)
        .where(
          and(
            eq(paymentAuthorizations.tenantId, scope.tenantId),
            eq(paymentAuthorizations.legalEntityId, scope.legalEntityId),
            eq(paymentAuthorizations.paymentId, paymentId),
            eq(paymentAuthorizations.proofKind, 'PREPAID_COVERAGE'),
            eq(paymentAuthorizations.coverageRevision, coverageRevision),
          ),
        )
        .pipe(Effect.mapError(readFailure));
      return yield* Effect.forEach(rows, paymentAuthorizationProofOfRow, { concurrency: 1 });
    },
  );

  return Object.freeze({ findById, findByIssuanceKey, insert, listPrepaidAtCoverageRevision });
};
