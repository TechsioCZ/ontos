import { defineScopedRoutine } from '@app/core-runtime';
import type { OutboxWorkerLegalEntityScope } from '@app/core-runtime/outbox/worker';
import { Context, Crypto, DateTime, Effect, Option, Schema } from 'effect';
import type { FinanceError } from '../../shared/actions/apply-command.ts';
import { FinanceConflict, FinancePersistenceUnavailable } from '../../shared/actions/apply-command.ts';
import { FinanceStateSchema } from '../../shared/apis/records.ts';
import type { Invoice } from '../../shared/apis/records.ts';
import type { CreateInvoiceFromOpportunityCommand } from '../../shared/outbox-consumers/opportunity-won-invoice.ts';
import { FinanceTaxRates } from '../integrations/tax-rates.ts';
import { transitionFinance } from '../services/persistence.service.ts';
import type { FinanceValidators } from '../services/persistence.service.ts';

const ownerModuleKey = 'finance.billing';
const RevisionSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const readFinanceStateForWorkerRoutine = defineScopedRoutine({
  name: 'read_finance_state_for_worker',
  ownerModuleKey,
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
  ],
  resultSchema: Schema.Struct({ revision: RevisionSchema, state: Schema.Unknown }),
  routineKey: 'finance-billing.read-finance-state-for-worker',
  schema: 'finance_billing',
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
  routineKey: 'finance-billing.save-finance-state-for-worker',
  schema: 'finance_billing',
});

/** The invocation a won message runs for: the one that marked the opportunity won, under its release. */
export interface OpportunityWonOriginator {
  readonly actionInvocationId: string;
  readonly compositionRevision: string;
}

/**
 * The worker has no gateway principal, so it cannot read the party registry. The counterparty comes
 * from the sales-pipeline snapshot, which already validated it; billing's local invariants still apply.
 * Its VAT comes from Tax like every new line's: Finance asks Tax for the person who marked the opportunity won,
 * in the company of this ledger. While Tax cannot answer the delivery fails and retries later; no line is stored
 * without the Tax rule revision of its rate.
 */
const workerValidators = Effect.fn('Finance.opportunityWorkerValidators')(function* workerValidators(
  scope: OutboxWorkerLegalEntityScope,
  originator: OpportunityWonOriginator,
) {
  const taxRates = yield* FinanceTaxRates;
  return {
    invoice: () => Effect.void,
    vat: (on: string) =>
      taxRates.choicesFor(
        {
          requestCorrelation: `finance-won-opportunity-${originator.actionInvocationId}`,
          subject: {
            _tag: 'Originator',
            actionInvocationId: originator.actionInvocationId,
            compositionRevision: originator.compositionRevision,
            legalEntityId: scope.legalEntityId,
            tenantId: scope.tenantId,
          },
        },
        on,
      ),
  } satisfies FinanceValidators;
});

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
    originator: OpportunityWonOriginator,
  ): Effect.fn.Return<Option.Option<Invoice>, FinanceError, Crypto.Crypto | FinanceTaxRates> {
    const [row] = yield* scope.routineInvoker
      .invoke(readFinanceStateForWorkerRoutine, [])
      .pipe(Effect.mapError(unavailable));
    if (row === undefined) {
      return Option.none();
    }
    const state = yield* Schema.decodeUnknownEffect(FinanceStateSchema)(row.state).pipe(Effect.mapError(unavailable));
    const now = yield* DateTime.now;
    const crypto = yield* Crypto.Crypto;
    const resourceId = yield* crypto.randomUUIDv4().pipe(Effect.mapError(unavailable));
    const attemptId = yield* crypto.randomUUIDv4().pipe(Effect.mapError(unavailable));
    const result = yield* transitionFinance(
      state,
      command,
      { legalEntityId: scope.legalEntityId, tenantId: scope.tenantId },
      yield* workerValidators(scope, originator),
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
    originator: OpportunityWonOriginator,
  ) => Effect.Effect<Option.Option<Invoice>, FinanceError, Crypto.Crypto | FinanceTaxRates>;
}

/** Owner-local seam over the finance ledger; the worker host binds the scoped-routine adapter. */
export class OpportunityInvoiceLedger extends Context.Service<
  OpportunityInvoiceLedger,
  OpportunityInvoiceLedgerService
>()('@app/finance-billing/workers/opportunity-invoice-ledger/OpportunityInvoiceLedger') {}

export const opportunityInvoiceLedgerLive = Object.freeze({
  draft: draftOpportunityInvoiceInScope,
}) satisfies OpportunityInvoiceLedgerService;
