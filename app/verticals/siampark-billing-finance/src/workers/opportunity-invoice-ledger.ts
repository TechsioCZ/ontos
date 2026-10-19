import { randomUUID } from 'node:crypto';
import { defineScopedRoutine } from '@app/core-runtime';
import type { OutboxWorkerLegalEntityScope } from '@app/core-runtime/outbox/worker';
import { Context, DateTime, Effect, Option, Schema } from 'effect';
import type { FinanceError } from '../../shared/actions/apply-command.ts';
import { FinanceConflict, FinancePersistenceUnavailable } from '../../shared/actions/apply-command.ts';
import { FinanceStateSchema } from '../../shared/apis/records.ts';
import type { Invoice } from '../../shared/apis/records.ts';
import type { CreateInvoiceFromOpportunityCommand } from '../../shared/outbox-consumers/opportunity-won-invoice.ts';
import { transitionFinance } from '../services/persistence.service.ts';
import type { FinanceValidators } from '../services/persistence.service.ts';

const ownerModuleKey = 'siampark.billing-finance';
const RevisionSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const readFinanceStateForWorkerRoutine = defineScopedRoutine({
  name: 'read_finance_state_for_worker',
  ownerModuleKey,
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
  ],
  resultSchema: Schema.Struct({ revision: RevisionSchema, state: Schema.Unknown }),
  routineKey: 'siampark-billing-finance.read-finance-state-for-worker',
  schema: 'siampark_billing_finance',
});
export const saveFinanceStateForWorkerRoutine = defineScopedRoutine({
  name: 'save_finance_state_for_worker',
  ownerModuleKey,
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'integer' },
    { source: 'input', type: 'jsonb' },
  ],
  resultSchema: Schema.Struct({ revision: RevisionSchema }),
  routineKey: 'siampark-billing-finance.save-finance-state-for-worker',
  schema: 'siampark_billing_finance',
});

/**
 * The worker has no gateway principal, so it cannot read the party registry. The counterparty comes
 * from the sales-pipeline snapshot, which already validated it; billing's local invariants still apply.
 */
const workerValidators: FinanceValidators = { invoice: () => Effect.void };

const unavailable = (cause: unknown) =>
  Object.defineProperty(
    new FinancePersistenceUnavailable({
      code: 'finance_persistence_unavailable',
      reason: 'Finance persistence is temporarily unavailable',
    }),
    'cause',
    { value: cause },
  );

/**
 * Drafts the opportunity invoice inside one Core-verified Legal Entity scope and returns it (new or the one
 * a previous delivery drafted). None means this Legal Entity keeps no finance ledger.
 */
export const draftOpportunityInvoiceInScope = Effect.fn('Finance.draftOpportunityInvoiceInScope')(
  function* draftOpportunityInvoiceInScope(
    scope: OutboxWorkerLegalEntityScope,
    command: CreateInvoiceFromOpportunityCommand,
  ): Effect.fn.Return<Option.Option<Invoice>, FinanceError> {
    const [row] = yield* scope.routineInvoker
      .invoke(readFinanceStateForWorkerRoutine, [])
      .pipe(Effect.mapError(unavailable));
    if (row === undefined) {
      return Option.none();
    }
    const state = yield* Schema.decodeUnknownEffect(FinanceStateSchema)(row.state).pipe(Effect.mapError(unavailable));
    const now = yield* DateTime.now;
    const resourceId = yield* Effect.sync(randomUUID);
    const attemptId = yield* Effect.sync(randomUUID);
    const result = yield* transitionFinance(
      state,
      command,
      { legalEntityId: scope.legalEntityId, tenantId: scope.tenantId },
      workerValidators,
      { attemptId, now, resourceId },
    );
    if (!result.changed) {
      return Option.fromUndefinedOr(result.invoice);
    }
    const encoded = yield* Schema.encodeEffect(FinanceStateSchema)(result.state).pipe(Effect.mapError(unavailable));
    const [saved] = yield* scope.routineInvoker
      .invoke(saveFinanceStateForWorkerRoutine, [row.revision, encoded])
      .pipe(Effect.mapError(unavailable));
    if (saved === undefined) {
      return yield* new FinanceConflict({ code: 'finance_conflict', reason: 'stale_revision' });
    }
    return Option.fromUndefinedOr(result.invoice);
  },
);

export interface OpportunityInvoiceLedgerService {
  readonly draft: (
    scope: OutboxWorkerLegalEntityScope,
    command: CreateInvoiceFromOpportunityCommand,
  ) => Effect.Effect<Option.Option<Invoice>, FinanceError>;
}

/** Owner-local seam over the finance ledger; the worker host binds the scoped-routine adapter. */
export class OpportunityInvoiceLedger extends Context.Service<
  OpportunityInvoiceLedger,
  OpportunityInvoiceLedgerService
>()('@app/siampark-billing-finance/workers/opportunity-invoice-ledger/OpportunityInvoiceLedger') {}

export const opportunityInvoiceLedgerLive = Object.freeze({
  draft: draftOpportunityInvoiceInScope,
}) satisfies OpportunityInvoiceLedgerService;
