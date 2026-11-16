import { defineScopedRoutine } from '@app/core-runtime';
import type { OutboxWorkerLegalEntityScope } from '@app/core-runtime/outbox/worker';
import { Context, Crypto, DateTime, Duration, Effect, Option, Schema } from 'effect';
import type { FinanceError } from '../../shared/actions/apply-command.ts';
import { FinanceConflict, FinancePersistenceUnavailable } from '../../shared/actions/apply-command.ts';
import { FinanceStateSchema } from '../../shared/apis/records.ts';
import type { FinanceState, Invoice, OpportunityAwaitingVat, OpportunityLeftWon } from '../../shared/apis/records.ts';
import type { CreateInvoiceFromOpportunityCommand } from '../../shared/outbox-consumers/opportunity-won-invoice.ts';
import { FinanceTaxRates } from '../integrations/tax-rates.ts';
import { OpportunityNoLongerWon } from './opportunity-no-longer-won.ts';
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
 * How long a ledger remembers an opportunity that left WON before its invoice was drafted: longer than this worker
 * retries a won delivery at all (100 attempts, at most a day apart), so no older won message can outlive the record.
 */
const LEFT_WON_RETENTION_DAYS = 100;
const LEFT_WON_MAX_RECORDS = 1000;
/** How long a won opportunity waits for its company's VAT once Tax first answered "not ready". */
export const NOT_READY_WINDOW = Duration.hours(72);
/** A wait record no delivery has looked at for this long is gone (its delivery completed or was resolved). */
const AWAITING_VAT_RETENTION_DAYS = 30;
const AWAITING_VAT_MAX_RECORDS = 1000;

/** This Legal Entity's finance ledger and the revision it was read at; none when it keeps no ledger. */
const readLedger = Effect.fn('Finance.readOpportunityLedger')(function* readLedger(
  scope: OutboxWorkerLegalEntityScope,
): Effect.fn.Return<Option.Option<{ readonly revision: number; readonly state: FinanceState }>, FinanceError> {
  const [row] = yield* scope.routineInvoker
    .invoke(readFinanceStateForWorkerRoutine, [])
    .pipe(Effect.mapError(unavailable));
  if (row === undefined) {
    return Option.none();
  }
  const state = yield* Schema.decodeUnknownEffect(FinanceStateSchema)(row.state).pipe(Effect.mapError(unavailable));
  return Option.some({ revision: row.revision, state });
});

/** Saves the ledger only if nobody saved it since it was read at `revision`. */
const saveLedger = Effect.fn('Finance.saveOpportunityLedger')(function* saveLedger(
  scope: OutboxWorkerLegalEntityScope,
  revision: number,
  state: FinanceState,
): Effect.fn.Return<void, FinanceError> {
  const encoded = yield* Schema.encodeEffect(FinanceStateSchema)(state).pipe(Effect.mapError(unavailable));
  const [saved] = yield* scope.routineInvoker
    .invoke(saveFinanceStateForWorkerRoutine, [revision, encoded])
    .pipe(Effect.mapError(unavailable));
  if (saved === undefined) {
    return yield* new FinanceConflict({ code: 'finance_conflict', reason: 'stale_revision' });
  }
  return yield* Effect.void;
});

/**
 * Drafts the opportunity invoice inside one Core-verified Legal Entity scope and returns it (new or the one
 * a previous delivery drafted). None means this Legal Entity keeps no finance ledger. A won message older than the
 * opportunity's recorded move out of WON (`wonRevision` below that move's revision) drafts nothing and asks no Tax.
 */
export const draftOpportunityInvoiceInScope = Effect.fn('Finance.draftOpportunityInvoiceInScope')(
  function* draftOpportunityInvoiceInScope(
    scope: OutboxWorkerLegalEntityScope,
    command: CreateInvoiceFromOpportunityCommand,
    originator: OpportunityWonOriginator,
    wonRevision: number,
  ): Effect.fn.Return<Option.Option<Invoice>, FinanceError | OpportunityNoLongerWon, Crypto.Crypto | FinanceTaxRates> {
    const ledger = yield* readLedger(scope);
    if (Option.isNone(ledger)) {
      return Option.none();
    }
    const { revision, state } = ledger.value;
    const left = state.opportunitiesLeftWon?.find((record) => record.opportunityId === command.opportunityId);
    if (left !== undefined && left.revision > wonRevision) {
      return yield* new OpportunityNoLongerWon({ leftAtRevision: left.revision });
    }
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
    // A drafted invoice ends its wait for VAT.
    const awaiting = result.state.opportunitiesAwaitingVat ?? [];
    const waitEnded =
      result.invoice !== undefined && awaiting.some((record) => record.opportunityId === command.opportunityId);
    const saved = waitEnded
      ? {
          ...result.state,
          opportunitiesAwaitingVat: awaiting.filter((record) => record.opportunityId !== command.opportunityId),
        }
      : result.state;
    if (result.changed || waitEnded) {
      yield* saveLedger(scope, revision, saved);
    }
    return Option.fromUndefinedOr(result.invoice);
  },
);

/** The ledger state without the opportunity's recorded wait for VAT; undefined when it has none. */
const withoutVatWait = (state: FinanceState, opportunityId: string): FinanceState | undefined => {
  const awaiting = state.opportunitiesAwaitingVat ?? [];
  return awaiting.some((record) => record.opportunityId === opportunityId)
    ? { ...state, opportunitiesAwaitingVat: awaiting.filter((record) => record.opportunityId !== opportunityId) }
    : undefined;
};

/**
 * Remembers in this Legal Entity's ledger that the opportunity left WON, so its older won message, still waiting to
 * retry, no longer drafts an invoice. Nothing to remember once its invoice is drafted (the old message converges on
 * it) or when a later move is already recorded. Its wait for VAT, if any, ends with it: won again later, it waits a
 * fresh 72 hours. False means this Legal Entity keeps no finance ledger.
 */
export const recordOpportunityLeftWonInScope = Effect.fn('Finance.recordOpportunityLeftWonInScope')(
  function* recordOpportunityLeftWonInScope(
    scope: OutboxWorkerLegalEntityScope,
    left: OpportunityLeftWon,
  ): Effect.fn.Return<boolean, FinanceError> {
    const ledger = yield* readLedger(scope);
    if (Option.isNone(ledger)) {
      return false;
    }
    const { revision } = ledger.value;
    const waitEnded = withoutVatWait(ledger.value.state, left.opportunityId);
    const state = waitEnded ?? ledger.value.state;
    const recorded = state.opportunitiesLeftWon ?? [];
    if (
      state.invoices.some((invoice) => invoice.opportunityId === left.opportunityId) ||
      recorded.some((record) => record.opportunityId === left.opportunityId && record.revision >= left.revision)
    ) {
      if (waitEnded !== undefined) {
        yield* saveLedger(scope, revision, waitEnded);
      }
      return true;
    }
    const keepFrom = DateTime.subtract(yield* DateTime.now, { days: LEFT_WON_RETENTION_DAYS });
    const kept = recorded.filter(
      (record) =>
        record.opportunityId !== left.opportunityId && DateTime.isGreaterThanOrEqualTo(record.leftAt, keepFrom),
    );
    yield* saveLedger(scope, revision, {
      ...state,
      opportunitiesLeftWon: [...kept, left].slice(-LEFT_WON_MAX_RECORDS),
    });
    return true;
  },
);

/**
 * Ends the opportunity's wait for VAT, if it has one, when its delivery settles without a draft for another reason
 * (it left WON, or its lines are refused): a later won message waits a fresh 72 hours.
 */
export const endOpportunityVatWaitInScope = Effect.fn('Finance.endOpportunityVatWaitInScope')(
  function* endOpportunityVatWaitInScope(
    scope: OutboxWorkerLegalEntityScope,
    opportunityId: OpportunityAwaitingVat['opportunityId'],
  ): Effect.fn.Return<void, FinanceError> {
    const ledger = yield* readLedger(scope);
    if (Option.isNone(ledger)) {
      return;
    }
    const waitEnded = withoutVatWait(ledger.value.state, opportunityId);
    if (waitEnded !== undefined) {
      yield* saveLedger(scope, ledger.value.revision, waitEnded);
    }
  },
);

/** Where a won opportunity's wait for its company's VAT stands after Tax answered "not ready" once more. */
export interface VatWait {
  readonly firstNotReadyAt: DateTime.Utc;
  /** The wait is over (72 hours since the first "not ready"); its record is gone. */
  readonly over: boolean;
}

/**
 * Records, on Tax's first "not ready" for the opportunity, when that was; on a later one says whether 72 hours have
 * passed since, and if so removes the record (the delivery then completes without a draft). The wait is real time,
 * kept in the company's ledger: lease re-claims and retries that come quickly cannot shorten it. A ledger the old
 * release rewrote after a rollback has no record (it drops fields it does not know): the wait simply starts again.
 */
export const recordOpportunityVatNotReadyInScope = Effect.fn('Finance.recordOpportunityVatNotReadyInScope')(
  function* recordOpportunityVatNotReadyInScope(
    scope: OutboxWorkerLegalEntityScope,
    opportunityId: OpportunityAwaitingVat['opportunityId'],
  ): Effect.fn.Return<VatWait, FinanceError> {
    const now = yield* DateTime.now;
    const ledger = yield* readLedger(scope);
    if (Option.isNone(ledger)) {
      return { firstNotReadyAt: now, over: false };
    }
    const { revision, state } = ledger.value;
    const awaiting = state.opportunitiesAwaitingVat ?? [];
    const recorded = awaiting.find((record) => record.opportunityId === opportunityId);
    if (recorded !== undefined) {
      const over = Duration.isGreaterThanOrEqualTo(DateTime.distance(recorded.firstNotReadyAt, now), NOT_READY_WINDOW);
      if (over) {
        yield* saveLedger(scope, revision, {
          ...state,
          opportunitiesAwaitingVat: awaiting.filter((record) => record.opportunityId !== opportunityId),
        });
      }
      return { firstNotReadyAt: recorded.firstNotReadyAt, over };
    }
    const keepFrom = DateTime.subtract(now, { days: AWAITING_VAT_RETENTION_DAYS });
    const kept = awaiting.filter((record) => DateTime.isGreaterThanOrEqualTo(record.firstNotReadyAt, keepFrom));
    const first: OpportunityAwaitingVat = { firstNotReadyAt: now, opportunityId };
    yield* saveLedger(scope, revision, {
      ...state,
      opportunitiesAwaitingVat: [...kept, first].slice(-AWAITING_VAT_MAX_RECORDS),
    });
    return { firstNotReadyAt: now, over: false };
  },
);

/** Whether this Legal Entity keeps a finance ledger at all. */
export const holdsOpportunityLedgerInScope = (scope: OutboxWorkerLegalEntityScope) =>
  readLedger(scope).pipe(Effect.map(Option.isSome));

export interface OpportunityInvoiceLedgerService {
  readonly draft: (
    scope: OutboxWorkerLegalEntityScope,
    command: CreateInvoiceFromOpportunityCommand,
    originator: OpportunityWonOriginator,
    wonRevision: number,
  ) => Effect.Effect<Option.Option<Invoice>, FinanceError | OpportunityNoLongerWon, Crypto.Crypto | FinanceTaxRates>;
  readonly endVatWait: (
    scope: OutboxWorkerLegalEntityScope,
    opportunityId: OpportunityAwaitingVat['opportunityId'],
  ) => Effect.Effect<void, FinanceError>;
  readonly holds: (scope: OutboxWorkerLegalEntityScope) => Effect.Effect<boolean, FinanceError>;
  readonly recordLeftWon: (
    scope: OutboxWorkerLegalEntityScope,
    left: OpportunityLeftWon,
  ) => Effect.Effect<boolean, FinanceError>;
  readonly vatNotReady: (
    scope: OutboxWorkerLegalEntityScope,
    opportunityId: OpportunityAwaitingVat['opportunityId'],
  ) => Effect.Effect<VatWait, FinanceError>;
}

/** Owner-local seam over the finance ledger; the worker host binds the scoped-routine adapter. */
export class OpportunityInvoiceLedger extends Context.Service<
  OpportunityInvoiceLedger,
  OpportunityInvoiceLedgerService
>()('@app/finance-billing/workers/opportunity-invoice-ledger/OpportunityInvoiceLedger') {}

export const opportunityInvoiceLedgerLive = Object.freeze({
  draft: draftOpportunityInvoiceInScope,
  endVatWait: endOpportunityVatWaitInScope,
  holds: holdsOpportunityLedgerInScope,
  recordLeftWon: recordOpportunityLeftWonInScope,
  vatNotReady: recordOpportunityVatNotReadyInScope,
}) satisfies OpportunityInvoiceLedgerService;
