import type { CustomerListItem } from '@app/party-registry/api/client';
import { CounterpartyRefSchema } from '@app/party-registry/resources/counterparty';
import { makeReferenceGatewayCredentials } from '@app/shared-contracts';
import { definePageData, pageDataPending } from '@app/shared-contracts/page-data';
import type { PageDataSnapshot } from '@app/shared-contracts/page-data';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useRouterState } from '@modern-js/plugin-tanstack/runtime';
import { defaultParseSearch } from '@tanstack/react-router';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { Effect, Match, Option, Schema } from 'effect';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { FinanceCommand } from '../../../../shared/actions/apply-command.ts';
import { FinancePartyIdSchema, RecordsRequestSchema } from '../../../../shared/apis/records.ts';
import type { CalendarDateSchema, Invoice, InvoiceLine, RecordsResponse } from '../../../../shared/apis/records.ts';
import { nextInvoiceNumber } from '../../../../shared/domain/invoice-totals.ts';
import { commandReferenceAudiences } from '../../../../shared/domain/reference-audiences.ts';
import { InvoiceRefSchema } from '../../../../shared/resources/invoice.ts';
import { executeApplyCommand } from '../../../api/apply-command-action-client.ts';
import { browserCrypto } from '../../../api/browser-crypto.ts';
import { executeRecords } from '../../../api/records-client.ts';
import { financeBrowserRuntime } from '../../../runtime/browser.ts';
import { reasonText } from './finance-ui.tsx';
import { useFinanceReferences } from './use-finance-references.ts';
import { useRentalObjects } from './use-rental-objects.ts';

export type CalendarDate = typeof CalendarDateSchema.Type;

export interface DraftInvoiceInput {
  readonly anchors?: {
    readonly costCenter?: string;
    readonly propertyRef?: NonNullable<Invoice['propertyRef']>;
    readonly unitRef?: NonNullable<Invoice['unitRef']>;
  };
  readonly customer: CustomerListItem;
  readonly documentKind?: NonNullable<Invoice['documentKind']>;
  readonly dueDate: CalendarDate;
  readonly issueDate: CalendarDate;
  readonly lines: readonly InvoiceLine[];
}

export type DraftInvoiceOutcome =
  | { readonly feedback: Feedback; readonly ok: false }
  | { readonly invoice: Invoice; readonly ok: true };

const searchSchema = Schema.Struct({
  counterpartyId: Schema.optional(CounterpartyRefSchema.fields.resourceId),
  partyId: Schema.optional(FinancePartyIdSchema),
  resourceId: Schema.optional(InvoiceRefSchema.fields.resourceId.check(Schema.isUUID())),
  tenantId: Schema.optional(CounterpartyRefSchema.fields.tenantId),
});
export const decodeCustomerInvoiceSearch = Schema.decodeUnknownOption(Schema.toEncoded(searchSchema));

const customerInvoiceRequest = (
  partyId: string | undefined,
  counterpartyId: string | undefined,
  tenantId: string | undefined,
) => {
  if ((counterpartyId === undefined) !== (tenantId === undefined)) {
    return Option.none();
  }
  if (counterpartyId !== undefined && tenantId !== undefined) {
    return Schema.decodeOption(RecordsRequestSchema)({
      counterpartyRef: {
        moduleId: 'party.registry',
        resourceId: counterpartyId,
        resourceType: 'party.registry.counterparty',
        tenantId,
      },
    });
  }
  return Schema.decodeOption(RecordsRequestSchema)(partyId === undefined ? {} : { partyId });
};

type RecordsRequest = typeof RecordsRequestSchema.Type;

const recordsRequestKey = (request: RecordsRequest): string =>
  Schema.encodeOption(Schema.fromJsonString(RecordsRequestSchema))(request).pipe(Option.getOrElse(() => 'invalid'));

/** The ledger request a decoded customer filter asks for; none when the filter is incomplete or malformed. */
const recordsRequestOf = (rawSearch: typeof searchSchema.Encoded | null): Option.Option<RecordsRequest> =>
  (rawSearch === null ? Option.none() : Schema.decodeOption(searchSchema)(rawSearch)).pipe(
    Option.flatMap((search) => customerInvoiceRequest(search.partyId, search.counterpartyId, search.tenantId)),
  );

/** Filter changes remount the owning view, so a new customer never displays an old customer's snapshot. */
export const customerInvoiceFilterKey = (rawSearch: typeof searchSchema.Encoded | null): string =>
  Option.match(recordsRequestOf(rawSearch), { onNone: () => 'invalid', onSome: recordsRequestKey });

/**
 * The ledger request of a raw query string (`?partyId=…`), the form the Shell hands to `preloadPage`. It is parsed
 * by the router's own search parser, so the preloaded entry is the one the page reads from `location.search`.
 */
export const recordsRequestFromQuery = (query: string): Option.Option<RecordsRequest> =>
  recordsRequestOf(decodeCustomerInvoiceSearch(defaultParseSearch(query)).pipe(Option.getOrElse(() => null)));

const FeedbackSchema = Schema.Literals([
  'loading',
  'ready',
  'saving',
  'forbidden',
  'conflict',
  'validation',
  'unavailable',
]);
type Feedback = typeof FeedbackSchema.Type;
type UiFailure = Effect.Error<
  | ReturnType<typeof executeApplyCommand>
  | ReturnType<typeof executeRecords>
  | ReturnType<typeof makeReferenceGatewayCredentials>
  | typeof browserCrypto.randomUUIDv4
>;
const forbidden = Schema.is(Schema.Struct({ status: Schema.Literal(403) }));
const conflicting = Schema.is(Schema.Struct({ status: Schema.Literal(409) }));
const invalid = Schema.is(Schema.Struct({ status: Schema.Literals([400, 422]) }));
export const financeFailureFeedback = (error: UiFailure): Feedback =>
  Match.value(error).pipe(
    Match.when(forbidden, () => 'forbidden' as const),
    Match.when(conflicting, () => 'conflict' as const),
    Match.when(invalid, () => 'validation' as const),
    Match.orElse(() => 'unavailable' as const),
  );
const submitFinanceCommand = Effect.fn('Finance.browserSubmit')(function* submitFinanceCommand(
  snapshot: RecordsResponse,
  command: FinanceCommand,
) {
  // Only the modules the validators will read: asking for an audience outside the composition fails the command.
  const referenceCredentials = yield* makeReferenceGatewayCredentials(
    commandReferenceAudiences(command, snapshot.state.invoices, snapshot.state.recurringTemplates ?? []),
  );
  const idempotencyKey = yield* browserCrypto.randomUUIDv4;
  return yield* executeApplyCommand({ command, expectedRevision: snapshot.revision }, 'finance-billing.command', {
    idempotencyKey,
    referenceCredentials,
  });
});

const fetchRecords = (request: RecordsRequest) => executeRecords(request, 'finance-billing.records');

/** The ledger snapshot (invoices and KPI indicators) per customer filter; the Shell preloads it before reveal. */
const financeRecords = definePageData({
  key: recordsRequestKey,
  load: fetchRecords,
  runtime: financeBrowserRuntime,
});

export const preloadFinanceRecords = (query: string): Effect.Effect<void> =>
  Option.match(recordsRequestFromQuery(query), { onNone: () => Effect.void, onSome: financeRecords.preload });

type RecordsSnapshot = PageDataSnapshot<RecordsResponse, Effect.Error<ReturnType<typeof fetchRecords>>>;
const readyRecords = (snapshot: RecordsSnapshot): RecordsResponse | undefined =>
  snapshot.state === 'ready' ? snapshot.value : undefined;
const pendingRecords = (): RecordsSnapshot => pageDataPending;
const loadFeedbackOf = (snapshot: RecordsSnapshot): Feedback => {
  if (snapshot.state === 'pending') {
    return 'loading';
  }
  return snapshot.state === 'failed' ? financeFailureFeedback(snapshot.error) : 'ready';
};

/** TanStack history numbers its entries in `history.state`; only the index is read here. */
const TanstackHistoryStateSchema = Schema.Struct({ __TSR_index: Schema.Int });

const detailUrl = (id?: string) => {
  const url = new URL(window.location.href);
  if (id === undefined) {
    url.searchParams.delete('resourceId');
  } else {
    url.searchParams.set('resourceId', id);
  }
  return url;
};

/**
 * Opens an invoice as a new history entry (`?resourceId=`), so browser Back returns to the list. The entry gets the
 * next TanStack index and its own key, so the router reads Back as one step back instead of a jump.
 */
const pushDetailUrl = (id: string) => {
  const index = Option.match(Schema.decodeUnknownOption(TanstackHistoryStateSchema)(window.history.state), {
    onNone: () => 0,
    onSome: (state) => state.__TSR_index,
  });
  const key = `invoice-${id}`;
  window.history.pushState({ __TSR_index: index + 1, __TSR_key: key, key }, '', detailUrl(id));
};

export type CommandOutcome =
  | { readonly feedback: Feedback; readonly ok: false; readonly reason: string | undefined }
  | { readonly invoice: Invoice | undefined; readonly ok: true };

/** Problem `detail`/`reason` of a failed command, so the UI can explain known domain refusals. */
const failureReason = (error: unknown): string | undefined => {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const record = error as Record<string, unknown>;
  for (const key of ['reason', 'detail', 'title']) {
    const value = record[key];
    if (typeof value === 'string') {
      return value;
    }
  }
  return undefined;
};

/** Signed-in user's display name from the shell session; used as a readable author label next to the principal. */
// @effect-diagnostics-next-line globalFetch:off
const fetchSession = () => fetch('/shell-super-app-api/auth/session', { credentials: 'include' });
const useActorLabel = () => {
  const [label, setLabel] = useState<string>();
  useEffect(() => {
    let active = true;
    void fetchSession()
      .then((response) => (response.ok ? response.json() : undefined))
      .then((body: unknown) => {
        const identity =
          typeof body === 'object' && body !== null
            ? (body as { readonly identity?: Record<string, unknown> }).identity
            : undefined;
        const rawName = identity?.['displayName'];
        const email = identity?.['email'];
        const name =
          typeof rawName === 'string' && rawName.trim() !== ''
            ? typeof email === 'string'
              ? `${rawName} (${email})`
              : rawName
            : email;
        if (active && typeof name === 'string') {
          setLabel(name.slice(0, 200));
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);
  return label;
};

/**
 * Invoice list and detail state. The ledger comes from the page-data store (ready on first paint when the Shell
 * prepared the page); commands refresh it after they succeed and keep the current rows visible meanwhile.
 */
export const useFinanceRecords = () => {
  const actorLabel = useActorLabel();
  const { t } = useModernI18n();
  const toaster = useToast();
  const rawSearch = useRouterState({
    select: (state) => {
      const input: unknown = state.location.search;
      return decodeCustomerInvoiceSearch(input).pipe(Option.getOrElse(() => null));
    },
  });
  const search = rawSearch === null ? Option.none() : Schema.decodeOption(searchSchema)(rawSearch);
  const searchInvalid = Option.isNone(search);
  const fields = Option.getOrElse(search, (): typeof searchSchema.Type => ({}));
  const { counterpartyId, partyId, tenantId } = fields;
  const requestedId = fields.resourceId;
  const request = searchInvalid ? Option.none() : customerInvoiceRequest(partyId, counterpartyId, tenantId);
  const recordsSnapshot = useSyncExternalStore(
    financeRecords.subscribe,
    () => (Option.isSome(request) ? financeRecords.snapshot(request.value) : pageDataPending),
    pendingRecords,
  );
  const snapshot = readyRecords(recordsSnapshot);
  /** Latest snapshot, so commands issued one after another use the revision the previous one produced. */
  const latestSnapshot = () =>
    Option.isSome(request) ? readyRecords(financeRecords.snapshot(request.value)) : undefined;
  /** Outcome of the user's own reload or command; 'ready' defers to the ledger's load state. */
  const [actionFeedback, setActionFeedback] = useState<Feedback>('ready');
  const feedback = actionFeedback === 'ready' ? loadFeedbackOf(recordsSnapshot) : actionFeedback;
  const [voidTarget, setVoidTarget] = useState<Invoice>();
  /** Confirming numbers the invoice and locks it, so every entry point asks first. */
  const [confirmTarget, setConfirmTarget] = useState<Invoice>();
  /** True while the open detail is a history entry this page pushed, so closing it can step back instead. */
  const detailPushed = useRef(false);
  const selected = snapshot?.state.invoices.find((record) => record.ref.resourceId === requestedId);
  const busy = feedback === 'loading' || feedback === 'saving';
  const canWrite = Option.isSome(request) && snapshot?.canWrite === true;
  const references = useFinanceReferences();
  const objects = useRentalObjects();

  /** Never fails: a failed reload keeps the rows on screen. */
  const load = (): Effect.Effect<void> => (Option.isSome(request) ? financeRecords.refresh(request.value) : Effect.void);

  /**
   * Creates a draft from the form. The counterparty ref is the party registry's own ref for the customer, and the
   * number is the next one in the series; the backend stores the lines as given (price snapshots).
   */
  const createDraft = (input: DraftInvoiceInput): Effect.Effect<DraftInvoiceOutcome> => {
    if (snapshot === undefined || !canWrite) {
      return Effect.succeed({ feedback: 'unavailable', ok: false });
    }
    const command: FinanceCommand = {
      _tag: 'CreateInvoiceDraft',
      counterpartyRef: input.customer.counterpartyRef,
      currency: 'CZK',
      direction: 'OUTGOING',
      documentNumber: nextInvoiceNumber(snapshot.state.invoices),
      dueDate: input.dueDate,
      issueDate: input.issueDate,
      lines: [...input.lines],
      partyId: input.customer.partyId,
      ...(input.documentKind === undefined || input.documentKind === 'STANDARD' ? {} : { documentKind: input.documentKind }),
      ...input.anchors,
    };
    return submitFinanceCommand(snapshot, command).pipe(
      Effect.tap(load),
      // A 409 means the snapshot revision is stale (another write landed first); reload it so the next try can succeed.
      Effect.tapError((cause) => (financeFailureFeedback(cause) === 'conflict' ? load() : Effect.void)),
      Effect.match({
        onFailure: (error): DraftInvoiceOutcome => ({ feedback: financeFailureFeedback(error), ok: false }),
        onSuccess: (result): DraftInvoiceOutcome =>
          result.invoice === undefined ? { feedback: 'unavailable', ok: false } : { invoice: result.invoice, ok: true },
      }),
    );
  };

  // A cold mount (the page was not prepared) starts the load; a prepared page finds it ready and keeps it.
  useEffect(() => {
    const current = searchInvalid ? Option.none() : customerInvoiceRequest(partyId, counterpartyId, tenantId);
    if (Option.isSome(current)) {
      financeRecords.ensure(current.value);
    }
  }, [counterpartyId, partyId, searchInvalid, tenantId]);

  /** Retry after a failed load; the outcome shows through the ledger's own state. */
  const reload = () => {
    setActionFeedback('loading');
    void financeBrowserRuntime.runPromise(load().pipe(Effect.andThen(Effect.sync(() => setActionFeedback('ready')))));
  };

  const runCommand = (command: FinanceCommand, successTitle: string) => {
    if (snapshot === undefined || !canWrite) {
      return;
    }
    setActionFeedback('saving');
    void financeBrowserRuntime.runPromise(
      submitFinanceCommand(snapshot, command).pipe(
        Effect.tap(load),
        // A 409 means the snapshot revision is stale (another user changed the ledger); reload it so a retry works.
        Effect.tapError((cause) => (financeFailureFeedback(cause) === 'conflict' ? load() : Effect.void)),
        Effect.match({
          onFailure: (error) => {
            const failure = financeFailureFeedback(error);
            setActionFeedback(failure);
            // The detail panel covers the page's status line, so a rejected confirm or void also raises a toast.
            // A known domain refusal (e.g. approving a draft that was not prepared) is explained in Czech.
            const reason = failureReason(error);
            const known = Object.entries(reasonText).find(([key]) => reason?.includes(key) === true)?.[1];
            toaster.create({
              ...(known === undefined ? {} : { description: known }),
              title: t(`finance-billing.demo.feedback.${known === undefined ? failure : 'refused'}`),
              type: 'error',
            });
          },
          onSuccess: (result) => {
            setActionFeedback('ready');
            toaster.create({
              description: result.invoice?.number ?? result.invoice?.documentNumber,
              title: successTitle,
              type: 'success',
            });
          },
        }),
      ),
    );
  };

  /** Runs any command, reloads the ledger on success and reports the outcome (toasts on success when titled). */
  const execute = (command: FinanceCommand, successTitle?: string): Promise<CommandOutcome> => {
    const current = latestSnapshot() ?? snapshot;
    if (current === undefined || !canWrite) {
      return Promise.resolve({ feedback: 'unavailable', ok: false, reason: undefined });
    }
    setActionFeedback('saving');
    return financeBrowserRuntime.runPromise(
      submitFinanceCommand(current, command).pipe(
        Effect.tap(load),
        Effect.tapError((cause) => (financeFailureFeedback(cause) === 'conflict' ? load() : Effect.void)),
        Effect.match({
          onFailure: (error): CommandOutcome => {
            setActionFeedback('ready');
            return { feedback: financeFailureFeedback(error), ok: false, reason: failureReason(error) };
          },
          onSuccess: (result): CommandOutcome => {
            setActionFeedback('ready');
            if (successTitle !== undefined) {
              toaster.create({ title: successTitle, type: 'success' });
            }
            return { invoice: result.invoice, ok: true };
          },
        }),
      ),
    );
  };

  /** Loads the stored bytes of one uploaded document. */
  const fetchDocument = (documentId: string) =>
    financeBrowserRuntime.runPromise(
      executeRecords({ documentId }, 'finance-billing.document').pipe(
        Effect.map((response) => response.document),
        Effect.orElseSucceed(() => undefined),
      ),
    );

  return {
    actorLabel,
    execute,
    fetchDocument,
    busy,
    cancelConfirm: () => setConfirmTarget(undefined),
    cancelVoid: () => setVoidTarget(undefined),
    canWrite,
    closeDetail: () => {
      // Back to the entry the list was on, so the list is not left twice in the history. A detail opened from a
      // deep link has no such entry, so its URL is replaced instead.
      if (detailPushed.current) {
        detailPushed.current = false;
        window.history.back();
        return;
      }
      window.history.replaceState(window.history.state, '', detailUrl());
    },
    /** Asks before confirming; `confirmPending` runs the command once the user agrees. */
    confirmInvoice: (invoice: Invoice) => setConfirmTarget(invoice),
    confirmPending: () => {
      if (confirmTarget !== undefined) {
        runCommand(
          {
            _tag: 'ConfirmInvoice',
            ...(actorLabel === undefined ? {} : { actorLabel }),
            invoiceRef: confirmTarget.ref,
          },
          t('finance-billing.faktury.confirmed'),
        );
      }
      setConfirmTarget(undefined);
    },
    confirmTarget,
    confirmVoid: () => {
      if (voidTarget !== undefined) {
        runCommand({ _tag: 'VoidInvoice', invoiceRef: voidTarget.ref }, t('finance-billing.faktury.voided'));
      }
      setVoidTarget(undefined);
    },
    createDraft,
    feedback: Option.isNone(request) ? ('validation' as const) : feedback,
    indicators: Option.isSome(request) ? snapshot?.indicators : undefined,
    invoices: Option.isSome(request) ? [...(snapshot?.state.invoices ?? [])] : [],
    objects,
    openDetail: (id: string) => {
      detailPushed.current = true;
      pushDetailUrl(id);
    },
    /** Real business date (today in Prague) from the owner; overdue badges are evaluated against it. */
    referenceDate: snapshot?.businessDate ?? snapshot?.referenceDate ?? '',
    references,
    relatedCustomer: partyId !== undefined || counterpartyId !== undefined,
    reload,
    requestVoid: (invoice: Invoice) => setVoidTarget(invoice),
    selected,
    snapshot,
    t,
    voidTarget,
  };
};
