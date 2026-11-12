import type { ScopedTransactionExecutor } from '@app/core-runtime';
import { and, eq } from 'drizzle-orm';
import { DateTime, Effect, Option, Schema } from 'effect';

import { PaymentProviderReplayGuaranteeSchema } from '../../../shared/domain/evidence-contract.ts';
import type { PaymentProviderReplayGuarantee } from '../../../shared/domain/evidence-contract.ts';
import { PaymentOperationIdSchema } from '../../../shared/domain/payment-identifiers.ts';
import { paymentUnavailable } from '../../../shared/domain/payment-unavailable.ts';
import { pspProviderDispatches } from '../../database/schema.ts';
import type {
  PaymentProviderReplayEvidenceRequest,
  PaymentProviderReplayEvidenceService,
} from '../../ports/provider-replay-evidence-port.ts';
import { idempotencyKeyHashOf } from './dispatch-ledger.ts';
import { deriveProviderCorrelation } from './psp-correlation.ts';
import type { ProviderReplayGuaranteeReaderContract } from './replay-guarantee.ts';

/**
 * Action-side reader of C17's retained original dispatch (#1158), over the Action's own Core-scoped
 * transaction. A guarantee exists only for a Stripe dispatch of exactly the requested lineage (operation,
 * Payment, kind, C16 materialHash and GATEWAY_ACCOUNT binding) whose exact request bytes, headers and
 * deterministic idempotency key are persisted, whose response is still unknown (PREPARED or
 * OUTCOME_UNKNOWN), and whose ledger window `[replayStartsAt, replayExpiresAt)` covers the actual time of
 * the read. It never creates a key or a window.
 */

type DispatchRow = typeof pspProviderDispatches.$inferSelect;

const REPLAYABLE_STATES: ReadonlySet<string> = new Set(['PREPARED', 'OUTCOME_UNKNOWN']);

const sameLineage = (row: DispatchRow, request: PaymentProviderReplayEvidenceRequest): boolean =>
  row.providerFamily === 'STRIPE' &&
  REPLAYABLE_STATES.has(row.state) &&
  row.paymentId === request.paymentId &&
  row.operationKind === request.operationKind &&
  row.materialHash === request.materialHash &&
  row.providerFamily === request.binding.providerFamily &&
  row.providerAccountRef === request.binding.providerAccountRef &&
  row.environment === request.binding.environment;

/** The deterministic key of the operation must be exactly the persisted one (never a new key). */
const keyHashMatches = (operationId: typeof PaymentOperationIdSchema.Type, keyHash: string): boolean =>
  keyHash === idempotencyKeyHashOf(deriveProviderCorrelation(operationId).idempotencyKey);

const decodeGuarantee = Schema.decodeUnknownOption(PaymentProviderReplayGuaranteeSchema);

/** The guarantee of one dispatch row at `nowMs`; `None` whenever any part of it is not proven. */
const guaranteeOf = (
  row: DispatchRow,
  request: PaymentProviderReplayEvidenceRequest,
  nowMs: number,
): Option.Option<PaymentProviderReplayGuarantee> => {
  if (!sameLineage(row, request) || row.requestBody === null || row.requestHeaders === null) {
    return Option.none();
  }
  return Option.all({
    endpointRef: Option.fromNullOr(row.endpointRef),
    expiresAt: Option.fromNullOr(row.replayExpiresAt),
    keyHash: Option.fromNullOr(row.idempotencyKeyHash),
    operationId: Schema.decodeUnknownOption(PaymentOperationIdSchema)(row.operationId),
    requestHash: Option.fromNullOr(row.requestHash),
    startsAt: Option.fromNullOr(row.replayStartsAt),
  }).pipe(
    Option.filter(
      ({ expiresAt, keyHash, operationId, startsAt }) =>
        keyHashMatches(operationId, keyHash) && startsAt.getTime() <= nowMs && nowMs < expiresAt.getTime(),
    ),
    Option.flatMap(({ endpointRef, expiresAt, keyHash, requestHash, startsAt }) =>
      decodeGuarantee({
        binding: request.binding,
        endpointRef,
        expiresAtEpochMs: expiresAt.getTime(),
        legalEntityId: row.legalEntityId,
        materialHash: row.materialHash,
        operationId: row.operationId,
        operationKind: row.operationKind,
        paymentId: row.paymentId,
        providerIdempotencyKeyHash: keyHash,
        providerRequestHash: requestHash,
        startsAtEpochMs: startsAt.getTime(),
        tenantId: row.tenantId,
      }),
    ),
  );
};

/** The C17 replay guarantee reader bound to one Action transaction. */
export const providerReplayGuaranteeReaderForTransaction = (
  transaction: ScopedTransactionExecutor,
): ProviderReplayGuaranteeReaderContract => {
  const read = Effect.fn('ProviderReplayGuaranteeReader.read')(function* read(
    request: PaymentProviderReplayEvidenceRequest,
  ) {
    const { legalEntityId, tenantId } = transaction.scope;
    // A request for another scope than the transaction's proves nothing here.
    if (
      legalEntityId === undefined ||
      request.scope.legalEntityId !== legalEntityId ||
      request.scope.tenantId !== tenantId
    ) {
      return Option.none<PaymentProviderReplayGuarantee>();
    }
    const rows = yield* transaction
      .select()
      .from(pspProviderDispatches)
      .where(
        and(
          eq(pspProviderDispatches.tenantId, tenantId),
          eq(pspProviderDispatches.legalEntityId, legalEntityId),
          eq(pspProviderDispatches.operationId, request.operationId),
        ),
      )
      .pipe(Effect.mapError((cause) => paymentUnavailable('The provider dispatch ledger could not be read', cause)));
    const now = yield* DateTime.now;
    return Option.fromUndefinedOr(rows[0]).pipe(
      Option.flatMap((row) => guaranteeOf(row, request, DateTime.toEpochMillis(now))),
    );
  });
  return Object.freeze({ read });
};

/** `PaymentProviderReplayEvidencePort` backed by the C17 reader of the same Action transaction. */
export const providerReplayEvidenceForTransaction = (
  transaction: ScopedTransactionExecutor,
): PaymentProviderReplayEvidenceService => {
  const reader = providerReplayGuaranteeReaderForTransaction(transaction);
  return Object.freeze({ readGuarantee: reader.read });
};
