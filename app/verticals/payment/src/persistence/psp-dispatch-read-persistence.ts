import type { ScopedTransactionExecutor } from '@app/core-runtime';
import { and, asc, eq, gt, inArray, lte, notInArray, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { DateTime, Effect, Option, Schema } from 'effect';

import { paymentUnavailable } from '../../shared/domain/payment-unavailable.ts';
import type { PaymentUnavailable } from '../../shared/domain/payment-unavailable.ts';
import type { PaymentOperationKind, PaymentOperationOutcome } from '../../shared/domain/payment-vocabulary.ts';
import {
  GatewayCustomerActionViewSchema,
  GatewayReconciliationDebtRowSchema,
  GatewayReturnStatusViewSchema,
} from '../../shared/domain/psp-configuration.ts';
import type {
  GatewayCustomerActionView,
  GatewayReconciliationDebtRow,
  GatewayReturnStatusView,
  GatewayReturnToken,
} from '../../shared/domain/psp-configuration.ts';
import { GATEWAY_WAIT_BUDGET_MS } from '../../shared/domain/psp-vocabulary.ts';
import type { ProviderDispatchState, ProviderNotSentReason } from '../../shared/domain/psp-vocabulary.ts';
import { paymentOperations, pspProviderDispatches, pspProviderEvidence } from '../database/schema.ts';

/**
 * Read-side queries over the C17 provider dispatch ledger (#1156-#1158) for the gateway Reads, over the
 * Read's own Core-scoped transaction (RLS plus explicit Tenant and Selling Legal Entity predicates). They
 * never call a provider, never write and never select a scope from their input.
 */

export interface PspCustomerActionQuery {
  readonly operationId: string;
  readonly paymentId: string;
}

export interface PspReconciliationDebtPageQuery {
  /** Keyset cursor: only operations whose id sorts after this one. */
  readonly afterOperationId: Option.Option<string>;
  /** Clamped to `1..PSP_RECONCILIATION_DEBT_MAX_PAGE_SIZE`. */
  readonly limit: number;
}

export interface PspReconciliationDebtPage {
  /** The cursor of the next page; `None` on the last page. */
  readonly nextAfterOperationId: Option.Option<string>;
  readonly rows: readonly GatewayReconciliationDebtRow[];
}

export interface PspDispatchReadPersistence {
  /**
   * The customer redirect of one operation of one Payment. `None` when that operation of that Payment
   * does not exist in scope. REDIRECT_AVAILABLE only for an ACKNOWLEDGED COLLECT with a redirect URL whose
   * Payment outcome is still PENDING; AWAITING_PROVIDER while a pending COLLECT has no provider answer
   * yet (no row, AWAITING_TARGET, PREPARED, OUTCOME_UNKNOWN); NOT_AVAILABLE otherwise.
   */
  readonly selectCustomerAction: (
    query: PspCustomerActionQuery,
  ) => Effect.Effect<Option.Option<GatewayCustomerActionView>, PaymentUnavailable>;
  /**
   * Gateway reconciliation debt, ordered by operation id: operations whose ledger state is OUTCOME_UNKNOWN,
   * TARGET_UNRESOLVED, UNSUPPORTED or NOT_SENT while the Payment outcome is not definitive, ACKNOWLEDGED
   * operations still not definitive once the gateway wait budget after their request has passed (a lost
   * callback or an accepted pending observation leaves them without queued evidence), and every operation
   * with PENDING_SUBMISSION evidence. `recommendedTrigger` is EXECUTION_OUTCOME_UNKNOWN for
   * OUTCOME_UNKNOWN and TARGET_UNRESOLVED, otherwise OUTCOME_OVERDUE (plan §2.2).
   */
  readonly selectReconciliationDebt: (
    query: PspReconciliationDebtPageQuery,
  ) => Effect.Effect<PspReconciliationDebtPage, PaymentUnavailable>;
  /** The current Payment outcome and dispatch state behind one return token; `None` for a token not of this scope. */
  readonly selectReturnStatus: (
    returnToken: GatewayReturnToken,
  ) => Effect.Effect<Option.Option<GatewayReturnStatusView>, PaymentUnavailable>;
}

export const PSP_RECONCILIATION_DEBT_MAX_PAGE_SIZE = 200;

const DEBT_LEDGER_STATES = [
  'OUTCOME_UNKNOWN',
  'TARGET_UNRESOLVED',
  'UNSUPPORTED',
  'NOT_SENT',
] as const satisfies readonly ProviderDispatchState[];
const DEFINITIVE_OUTCOMES = [
  'EFFECT_CONFIRMED',
  'NOT_EFFECTED_CONFIRMED',
] as const satisfies readonly PaymentOperationOutcome[];
const AWAITING_PROVIDER_STATES: ReadonlySet<string> = new Set(['AWAITING_TARGET', 'PREPARED', 'OUTCOME_UNKNOWN']);
const UNKNOWN_EXECUTION_STATES: ReadonlySet<string> = new Set(['OUTCOME_UNKNOWN', 'TARGET_UNRESOLVED']);

const readFailure = (reason: string) => (cause: unknown) => paymentUnavailable(reason, cause);

const decodeCustomerAction = Schema.decodeUnknownEffect(GatewayCustomerActionViewSchema);
const decodeReturnStatus = Schema.decodeUnknownEffect(GatewayReturnStatusViewSchema);
const decodeDebtRow = Schema.decodeUnknownEffect(GatewayReconciliationDebtRowSchema);

/** The customer action of an operation and its (possibly absent) dispatch row. */
const customerActionOf = (row: {
  readonly customerRedirectUrl: string | null;
  readonly kind: string;
  readonly outcome: string;
  readonly state: string | null;
}) => {
  if (row.kind !== 'COLLECT' || row.outcome !== 'PENDING') {
    return { status: 'NOT_AVAILABLE' };
  }
  if (row.state === 'ACKNOWLEDGED' && row.customerRedirectUrl !== null) {
    return { redirectUrl: row.customerRedirectUrl, status: 'REDIRECT_AVAILABLE' };
  }
  return row.state === null || AWAITING_PROVIDER_STATES.has(row.state)
    ? { status: 'AWAITING_PROVIDER' }
    : { status: 'NOT_AVAILABLE' };
};

/** Same Tenant, Selling Legal Entity and operation as the outer dispatch row. */
const evidenceOfDispatch: SQL = sql`${pspProviderEvidence.tenantId} = ${pspProviderDispatches.tenantId}
  and ${pspProviderEvidence.legalEntityId} = ${pspProviderDispatches.legalEntityId}
  and ${pspProviderEvidence.operationId} = ${pspProviderDispatches.operationId}
  and ${pspProviderEvidence.submissionState} = 'PENDING_SUBMISSION'`;
const pendingEvidenceCount = sql<number>`(select count(*)::integer from ${pspProviderEvidence} where ${evidenceOfDispatch})`;
const oldestPendingAt = sql<
  null | string
>`(select to_char(min(${pspProviderEvidence.recordedAt}) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') from ${pspProviderEvidence} where ${evidenceOfDispatch})`;

type EncodedDebtRow = {
  -readonly [
    Key in keyof typeof GatewayReconciliationDebtRowSchema.Encoded
  ]: (typeof GatewayReconciliationDebtRowSchema.Encoded)[Key];
};

/** One debt row in its encoded form; absent keys mean "not applicable". */
const encodedDebtRowOf = (row: {
  readonly ledgerState: ProviderDispatchState;
  readonly notSentReason: null | ProviderNotSentReason;
  readonly oldestPendingAt: null | string;
  readonly operationId: string;
  readonly operationKind: PaymentOperationKind;
  readonly paymentId: string;
  readonly pendingEvidenceCount: number;
}) => {
  const encoded: EncodedDebtRow = {
    ledgerState: row.ledgerState,
    operationId: row.operationId,
    operationKind: row.operationKind,
    paymentId: row.paymentId,
    pendingEvidenceCount: row.pendingEvidenceCount,
    recommendedTrigger: UNKNOWN_EXECUTION_STATES.has(row.ledgerState) ? 'EXECUTION_OUTCOME_UNKNOWN' : 'OUTCOME_OVERDUE',
  };
  if (row.notSentReason !== null) {
    encoded.notSentReason = row.notSentReason;
  }
  if (row.oldestPendingAt !== null) {
    encoded.oldestPendingAt = row.oldestPendingAt;
  }
  return encoded;
};

export const pspDispatchReadPersistenceForTransaction = (
  transaction: ScopedTransactionExecutor,
): PspDispatchReadPersistence => {
  const requireLegalEntity = Effect.fn('PspDispatchReadPersistence.scope')(function* requireLegalEntity() {
    const { legalEntityId, tenantId } = transaction.scope;
    if (legalEntityId === undefined) {
      return yield* paymentUnavailable('A verified Selling Legal Entity scope is required');
    }
    return { legalEntityId, tenantId };
  });

  const selectCustomerAction = Effect.fn('PspDispatchReadPersistence.selectCustomerAction')(
    function* selectCustomerAction(query: PspCustomerActionQuery) {
      const scope = yield* requireLegalEntity();
      const rows = yield* transaction
        .select({
          customerRedirectUrl: pspProviderDispatches.customerRedirectUrl,
          kind: paymentOperations.kind,
          outcome: paymentOperations.outcome,
          state: pspProviderDispatches.state,
        })
        .from(paymentOperations)
        .leftJoin(
          pspProviderDispatches,
          and(
            eq(pspProviderDispatches.tenantId, paymentOperations.tenantId),
            eq(pspProviderDispatches.legalEntityId, paymentOperations.legalEntityId),
            eq(pspProviderDispatches.operationId, paymentOperations.operationId),
          ),
        )
        .where(
          and(
            eq(paymentOperations.tenantId, scope.tenantId),
            eq(paymentOperations.legalEntityId, scope.legalEntityId),
            eq(paymentOperations.paymentId, query.paymentId),
            eq(paymentOperations.operationId, query.operationId),
          ),
        )
        .pipe(Effect.mapError(readFailure('The gateway customer action could not be read')));
      const [row] = rows;
      if (row === undefined) {
        return Option.none<GatewayCustomerActionView>();
      }
      const view = yield* decodeCustomerAction(customerActionOf(row)).pipe(
        Effect.mapError(readFailure('A stored gateway redirect is unreadable')),
      );
      return Option.some(view);
    },
  );

  const selectReturnStatus = Effect.fn('PspDispatchReadPersistence.selectReturnStatus')(function* selectReturnStatus(
    returnToken: GatewayReturnToken,
  ) {
    const scope = yield* requireLegalEntity();
    const rows = yield* transaction
      .select({ dispatchState: pspProviderDispatches.state, outcome: paymentOperations.outcome })
      .from(pspProviderDispatches)
      .innerJoin(
        paymentOperations,
        and(
          eq(paymentOperations.tenantId, pspProviderDispatches.tenantId),
          eq(paymentOperations.legalEntityId, pspProviderDispatches.legalEntityId),
          eq(paymentOperations.operationId, pspProviderDispatches.operationId),
        ),
      )
      .where(
        and(
          eq(pspProviderDispatches.tenantId, scope.tenantId),
          eq(pspProviderDispatches.legalEntityId, scope.legalEntityId),
          eq(pspProviderDispatches.returnToken, returnToken),
        ),
      )
      .pipe(Effect.mapError(readFailure('The gateway return status could not be read')));
    const [row] = rows;
    if (row === undefined) {
      return Option.none<GatewayReturnStatusView>();
    }
    const view = yield* decodeReturnStatus(row).pipe(
      Effect.mapError(readFailure('A stored gateway return status is unreadable')),
    );
    return Option.some(view);
  });

  const selectReconciliationDebt = Effect.fn('PspDispatchReadPersistence.selectReconciliationDebt')(
    function* selectReconciliationDebt(query: PspReconciliationDebtPageQuery) {
      const scope = yield* requireLegalEntity();
      const limit = Math.min(Math.max(Math.trunc(query.limit), 1), PSP_RECONCILIATION_DEBT_MAX_PAGE_SIZE);
      const overdueRequestedBefore = DateTime.toDateUtc(
        DateTime.subtract(yield* DateTime.now, { milliseconds: GATEWAY_WAIT_BUDGET_MS }),
      );
      const rows = yield* transaction
        .select({
          ledgerState: pspProviderDispatches.state,
          notSentReason: pspProviderDispatches.notSentReason,
          oldestPendingAt,
          operationId: pspProviderDispatches.operationId,
          operationKind: pspProviderDispatches.operationKind,
          paymentId: pspProviderDispatches.paymentId,
          pendingEvidenceCount,
        })
        .from(pspProviderDispatches)
        .innerJoin(
          paymentOperations,
          and(
            eq(paymentOperations.tenantId, pspProviderDispatches.tenantId),
            eq(paymentOperations.legalEntityId, pspProviderDispatches.legalEntityId),
            eq(paymentOperations.operationId, pspProviderDispatches.operationId),
          ),
        )
        .where(
          and(
            eq(pspProviderDispatches.tenantId, scope.tenantId),
            eq(pspProviderDispatches.legalEntityId, scope.legalEntityId),
            ...Option.match(query.afterOperationId, {
              onNone: () => [],
              onSome: (after) => [gt(pspProviderDispatches.operationId, after)],
            }),
            or(
              sql`${pendingEvidenceCount} > 0`,
              and(
                notInArray(paymentOperations.outcome, [...DEFINITIVE_OUTCOMES]),
                or(
                  inArray(pspProviderDispatches.state, [...DEBT_LEDGER_STATES]),
                  and(
                    eq(pspProviderDispatches.state, 'ACKNOWLEDGED'),
                    lte(paymentOperations.createdAt, overdueRequestedBefore),
                  ),
                ),
              ),
            ),
          ),
        )
        .orderBy(asc(pspProviderDispatches.operationId))
        .limit(limit + 1)
        .pipe(Effect.mapError(readFailure('The gateway reconciliation debt could not be read')));
      const page = rows.slice(0, limit);
      const decoded = yield* Effect.forEach(
        page,
        (row) =>
          decodeDebtRow(encodedDebtRowOf(row)).pipe(
            Effect.mapError(readFailure('A stored gateway reconciliation debt row is unreadable')),
          ),
        { concurrency: 1 },
      );
      return {
        nextAfterOperationId:
          rows.length > limit ? Option.fromUndefinedOr(page.at(-1)?.operationId) : Option.none<string>(),
        rows: decoded,
      } satisfies PspReconciliationDebtPage;
    },
  );

  return Object.freeze({ selectCustomerAction, selectReconciliationDebt, selectReturnStatus });
};
