import type { CustomerListItem } from '@app/party-registry/api/client';
import { CounterpartyRefSchema } from '@app/party-registry/resources/counterparty';
import { makeReferenceGatewayCredentials } from '@app/shared-contracts';
import { definePageData, pageDataPending } from '@app/shared-contracts/page-data';
import type { ModulePageContext, PageDataSnapshot } from '@app/shared-contracts/page-data';
import { useHeldSnapshot } from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useRouterState } from '@modern-js/plugin-tanstack/runtime';
import { defaultParseSearch } from '@tanstack/react-router';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { DateTime, Effect, Match, Option, Ref, Schema } from 'effect';
import { HttpClient, HttpClientResponse } from 'effect/http';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { FinanceCommandSchema } from '../../../../shared/actions/apply-command.ts';
import { ActionProposalAcceptedSchema } from '../../../../shared/apis/apply-command-action.ts';
import {
  FinanceDocumentIdSchema,
  FinancePartyIdSchema,
  RecordsRequestSchema,
} from '../../../../shared/apis/records.ts';
import type {
  CalendarDateSchema,
  Invoice,
  InvoiceLineSchema,
  RecordsResponse,
} from '../../../../shared/apis/records.ts';
import { nextInvoiceNumber } from '../../../../shared/domain/invoice-totals.ts';
import { commandReferenceAudiences } from '../../../../shared/domain/reference-audiences.ts';
import { InvoiceRefSchema } from '../../../../shared/resources/invoice.ts';
import { executeApplyCommand } from '../../../api/apply-command-action-client.ts';
import { browserCrypto } from '../../../api/browser-crypto.ts';
import { executeRecords } from '../../../api/records-client.ts';
import { financeBrowserRuntime } from '../../../runtime/browser.ts';
import { financeRecordDetailConflict } from './finance-document-detail.ts';
import { financePageScope } from './finance-page-scope.ts';
import { reasonText } from './finance-ui.tsx';
import type { FinanceCommandDraft } from './finance-ui.tsx';
import { useFinanceReferences } from './use-finance-references.ts';
import { useRentalObjects } from './use-rental-objects.ts';

type FinanceCommandInput = typeof FinanceCommandSchema.Encoded;

export type CalendarDate = typeof CalendarDateSchema.Encoded;

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
  readonly lines: readonly (typeof InvoiceLineSchema.Encoded)[];
}

export type DraftInvoiceOutcome =
  | { readonly feedback: FinanceFeedback; readonly ok: false }
  | { readonly invoice: Invoice; readonly ok: true };

const searchSchema = Schema.Struct({
  counterpartyId: Schema.optional(CounterpartyRefSchema.fields.resourceId),
  documentId: Schema.optional(FinanceDocumentIdSchema),
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

/** Every state the Finance page reports; the document detail and other consumers read this vocabulary. */
export const FinanceFeedbackSchema = Schema.Literals([
  'loading',
  'ready',
  'saving',
  'forbidden',
  'conflict',
  'validation',
  'unavailable',
  'pendingApproval',
]);
export type FinanceFeedback = typeof FinanceFeedbackSchema.Type;
/**
 * A parked owner command (202) is not a write: no invoice exists or changed yet, so callers report it as waiting
 * for approval and never read an invoice, refresh for one or show a saved result.
 */
const isProposalAccepted = Schema.is(ActionProposalAcceptedSchema);
type ProposalAccepted = typeof ActionProposalAcceptedSchema.Type;

/**
 * The exact intent a proposal parked: the same command against the same ledger revision, within one page scope
 * (see `useFinanceRecords`). A new edit changes the command, and any landed write (including the approved proposal
 * itself) changes the revision, so neither matches.
 */
const FinanceCommandJsonSchema = Schema.fromJsonString(FinanceCommandSchema);
const proposedIntentKey = (snapshot: RecordsResponse, command: FinanceCommandInput) =>
  Schema.decodeEffect(FinanceCommandSchema)(command).pipe(
    Effect.flatMap(Schema.encodeEffect(FinanceCommandJsonSchema)),
    Effect.map((json) => `${snapshot.revision}:${json}`),
  );
type UiFailure = Effect.Error<
  | ReturnType<typeof executeApplyCommand>
  | ReturnType<typeof executeRecords>
  | ReturnType<typeof makeReferenceGatewayCredentials>
  | ReturnType<typeof browserCrypto.randomUUIDv4>
>;
const forbidden = Schema.is(Schema.Struct({ status: Schema.Literal(403) }));
const conflicting = Schema.is(Schema.Struct({ status: Schema.Literal(409) }));
const invalid = Schema.is(Schema.Struct({ status: Schema.Literals([400, 422]) }));
export const financeFailureFeedback = (error: UiFailure): FinanceFeedback =>
  Match.value(error).pipe(
    Match.when(forbidden, () => 'forbidden' as const),
    Match.when(conflicting, () => 'conflict' as const),
    Match.when(invalid, () => 'validation' as const),
    Match.orElse(() => 'unavailable' as const),
  );
const submitFinanceCommand = Effect.fn('Finance.browserSubmit')(function* submitFinanceCommand(
  snapshot: RecordsResponse,
  command: FinanceCommandInput,
) {
  const decodedCommand = yield* Schema.decodeEffect(FinanceCommandSchema)(command);
  // Only the modules the validators will read: asking for an audience outside the composition fails the command.
  const referenceCredentials = yield* makeReferenceGatewayCredentials(
    commandReferenceAudiences(decodedCommand, snapshot.state.invoices, snapshot.state.recurringTemplates ?? []),
  );

  const idempotencyKey = yield* browserCrypto.randomUUIDv4();
  return yield* executeApplyCommand(
    { command: decodedCommand, expectedRevision: snapshot.revision },
    'finance-billing.command',
    {
      idempotencyKey,
      referenceCredentials,
    },
  );
});

/**
 * Proposals parked per cached ledger (`scopedRecordsKey`: verified scope and filter), so no other scope's or
 * ledger's proposal ever applies. Within one ledger, the exact same intent is not proposed again until it expires.
 */
type ProposalMemory = ReadonlyMap<string, ReadonlyMap<string, ProposalAccepted>>;

/**
 * Submits a command once per pending intent: while an identical earlier proposal of the same ledger has not expired,
 * its own acceptance is answered again instead of sending a second proposal for the approver.
 */
const submitIntent = Effect.fn('Finance.submitIntent')(function* submitIntent(
  memory: Ref.Ref<ProposalMemory>,
  ledgerKey: string,
  current: RecordsResponse,
  command: FinanceCommandInput,
) {
  const now = yield* DateTime.now;
  const key = yield* proposedIntentKey(current, command);
  const intents = (yield* Ref.get(memory)).get(ledgerKey);
  const parked = intents?.get(key);
  if (parked !== undefined && DateTime.isLessThan(now, parked.expiresAt)) {
    return parked;
  }
  yield* Ref.update(memory, (ledgers) => {
    const remaining = new Map(ledgers.get(ledgerKey));
    remaining.delete(key);
    return new Map(ledgers).set(ledgerKey, remaining);
  });
  const result = yield* submitFinanceCommand(current, command);
  if (isProposalAccepted(result)) {
    yield* Ref.update(memory, (ledgers) =>
      new Map(ledgers).set(ledgerKey, new Map(ledgers.get(ledgerKey)).set(key, result)),
    );
  }
  return result;
});

const fetchRecords = (request: RecordsRequest) => executeRecords(request, 'finance-billing.records');

/**
 * One cached ledger: the customer filter as sent, within the verified scope it was read for. The scope only keys
 * the cache; the request on the wire stays the filter, and the session's own gateway credentials carry identity.
 */
interface ScopedRecordsRequest {
  readonly request: RecordsRequest;
  readonly scope: string;
}

const ScopedRecordsKeySchema = Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.String]));
const scopedRecordsKey = (input: ScopedRecordsRequest): string =>
  Schema.encodeOption(ScopedRecordsKeySchema)([input.scope, recordsRequestKey(input.request)]).pipe(
    Option.getOrElse(() => 'invalid'),
  );

/** The cache input of a filter, only within a verified scope. */
const scopedRecordsRequest = (
  scope: string | undefined,
  request: Option.Option<RecordsRequest>,
): Option.Option<ScopedRecordsRequest> =>
  scope === undefined ? Option.none() : request.pipe(Option.map((value) => ({ request: value, scope })));

/**
 * The ledger snapshot (invoices and KPI indicators) per scope and customer filter; the Shell preloads it before
 * reveal. Two scopes never share an entry, so an old scope's late read settles only its own entry. A failed refresh
 * must not keep presenting the last-good rows as the current answer: a denied read clears them (and write access)
 * instead of leaving stale data on screen, and a transient failure shows its retry state.
 */
const financeRecords = definePageData({
  changesFrom: ['finance-billing'],
  key: scopedRecordsKey,
  load: (input: ScopedRecordsRequest) => fetchRecords(input.request),
  retainStale: false,
  runtime: financeBrowserRuntime,
});

/** The Shell's prefetch; without a verified scope there is nothing to read for. */
export const preloadFinanceRecords = (query: string, context: ModulePageContext | undefined): Effect.Effect<void> =>
  Option.match(scopedRecordsRequest(financePageScope(context), recordsRequestFromQuery(query)), {
    onNone: () => Effect.void,
    onSome: financeRecords.preload,
  });

type RecordsSnapshot = PageDataSnapshot<RecordsResponse, Effect.Error<ReturnType<typeof fetchRecords>>>;
const readyRecords = (snapshot: RecordsSnapshot): RecordsResponse | undefined =>
  snapshot.state === 'ready' ? snapshot.value : undefined;
const pendingRecords = (): RecordsSnapshot => pageDataPending;
const loadFeedbackOf = (snapshot: RecordsSnapshot): FinanceFeedback => {
  if (snapshot.state === 'pending') {
    return 'loading';
  }
  return snapshot.state === 'failed' ? financeFailureFeedback(snapshot.error) : 'ready';
};
const feedbackOf = (actionFeedback: FinanceFeedback, snapshot: RecordsSnapshot): FinanceFeedback =>
  actionFeedback === 'ready' ? loadFeedbackOf(snapshot) : actionFeedback;
const busyFeedback = (feedback: FinanceFeedback): boolean => feedback === 'loading' || feedback === 'saving';
const canWriteOf = (input: Option.Option<ScopedRecordsRequest>, snapshot: RecordsResponse | undefined): boolean =>
  Option.isSome(input) && snapshot?.canWrite === true;

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

const documentDetailUrl = () => {
  const url = new URL(window.location.href);
  url.searchParams.delete('documentId');
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
  | { readonly feedback: FinanceFeedback; readonly ok: false; readonly reason?: string }
  | { readonly invoice: Invoice | undefined; readonly ok: true };

/** Problem `detail`/`reason` of a failed command, so the UI can explain known domain refusals. */

const ReasonFieldSchema = Schema.Struct({ reason: Schema.String });
const DetailFieldSchema = Schema.Struct({ detail: Schema.String });
const TitleFieldSchema = Schema.Struct({ title: Schema.String });
const failureReason = (error: UiFailure): string | undefined =>
  Schema.decodeUnknownOption(ReasonFieldSchema)(error).pipe(
    Option.map((problem) => problem.reason),
    Option.orElse(() =>
      Schema.decodeUnknownOption(DetailFieldSchema)(error).pipe(Option.map((problem) => problem.detail)),
    ),
    Option.orElse(() =>
      Schema.decodeUnknownOption(TitleFieldSchema)(error).pipe(Option.map((problem) => problem.title)),
    ),
    Option.getOrUndefined,
  );

const ActorSessionSchema = Schema.Struct({
  identity: Schema.optional(
    Schema.Struct({
      displayName: Schema.optional(Schema.String),
      email: Schema.optional(Schema.String),
    }),
  ),
});
/** Signed-in user's display name from the shell session; used as a readable author label next to the principal. */
const loadActorLabel = Effect.fn('Finance.loadActorLabel')(function* loadActorLabel() {
  const response = yield* HttpClient.get(new URL('/shell-super-app-api/auth/session', window.location.href).href);
  yield* HttpClientResponse.filterStatusOk(response);
  const body = yield* HttpClientResponse.schemaBodyJson(ActorSessionSchema)(response);
  const rawName = body.identity?.displayName;
  const email = body.identity?.email;
  let name = email;
  if (rawName !== undefined && rawName.trim() !== '') {
    name = email === undefined ? rawName : `${rawName} (${email})`;
  }
  return name?.slice(0, 200);
}, Effect.timeout('10 seconds'));
/** One label per verified scope (the key is the scope), so a principal switch never shows the previous name. */
const actorLabels = definePageData({
  changesFrom: ['finance-billing', 'shell'],
  key: (scope: string) => scope,
  load: (_scope: string) => loadActorLabel(),
  runtime: financeBrowserRuntime,
});
const pendingActorLabel = (): PageDataSnapshot<string | undefined, Effect.Error<ReturnType<typeof loadActorLabel>>> =>
  pageDataPending;
/** The signed-in user's label for this scope; without a verified scope nothing is read or shown. */
const useActorLabel = (scope: string | undefined) => {
  const snapshot = useSyncExternalStore(
    actorLabels.subscribe,
    () => (scope === undefined ? pageDataPending : actorLabels.snapshot(scope)),
    pendingActorLabel,
  );
  useEffect(() => {
    if (scope !== undefined) {
      actorLabels.ensure(scope);
    }
  }, [scope]);
  return snapshot.state === 'ready' ? snapshot.value : undefined;
};

/** Loads uploaded bytes with the owning records client and keeps transport failures typed. */
const fetchDocument = (documentId: string) =>
  Schema.decodeEffect(RecordsRequestSchema)({ documentId }).pipe(
    Effect.flatMap((request) => executeRecords(request, 'finance-billing.document')),
    Effect.map((response) => Option.fromUndefinedOr(response.document)),
  );

export type FinanceInvoiceDetailState =
  | { readonly invoice: Invoice; readonly state: 'ready' }
  | { readonly state: 'forbidden' | 'loading' | 'unavailable' };

/**
 * State of an explicit invoice deep link (`?resourceId=`). The requested identity is never dropped: the exact
 * invoice from the authorized ledger, or why it cannot be shown. A loaded ledger without the ID (removed, another
 * company, or outside the current customer filter) is unavailable, so the page never falls back to the list or to a
 * different invoice. An invoice the ledger still holds stays ready, so a denied command on the open detail does not
 * blank it; a denied or failed ledger read (no ready ledger) is reported instead of reading as an empty ledger.
 */
export const financeInvoiceDetailState = ({
  feedback,
  invoices,
  resourceId,
}: {
  readonly feedback: FinanceFeedback;
  readonly invoices?: readonly Invoice[] | undefined;
  readonly resourceId?: string | undefined;
}): FinanceInvoiceDetailState | undefined => {
  if (resourceId === undefined) {
    return undefined;
  }
  const invoice = invoices?.find((record) => record.ref.resourceId === resourceId);
  if (invoice !== undefined) {
    return { invoice, state: 'ready' };
  }
  if (feedback === 'forbidden') {
    return { state: 'forbidden' };
  }
  return feedback === 'loading' ? { state: 'loading' } : { state: 'unavailable' };
};

/**
 * Keeps the last ready detail for the same request while a background refresh clears the rows, so an open invoice
 * (and any local edit state) is not unmounted for a loader flash. A failed or denied read drops it: a retry starts
 * from an honest ledger, never from a record the current authorization no longer confirms.
 */
const useRetainedInvoice = (
  detail: FinanceInvoiceDetailState | undefined,
  detailKey: string,
): FinanceInvoiceDetailState | undefined => {
  const [retained, setRetained] = useState<{ readonly invoice: Invoice; readonly key: string } | null>(null);
  if (detail?.state === 'ready' && retained?.invoice !== detail.invoice) {
    setRetained({ invoice: detail.invoice, key: detailKey });
  } else if ((detail?.state === 'forbidden' || detail?.state === 'unavailable') && retained !== null) {
    setRetained(null);
  }
  return detail?.state === 'loading' && retained?.key === detailKey
    ? { invoice: retained.invoice, state: 'ready' }
    : detail;
};

/**
 * Invoice list and detail state. The ledger comes from the page-data store (ready on first paint when the Shell
 * prepared the page); commands refresh it after they succeed and keep the current rows visible meanwhile.
 */
/** `scope` is `financePageScope` of the Shell context; undefined fails closed (no ledger read, no command). */
export const useFinanceRecords = ({ scope }: { readonly scope: string | undefined }) => {
  const [proposalState, setProposalState] = useState(() => ({
    memory: Ref.makeUnsafe<ProposalMemory>(new Map()),
    scope,
  }));
  if (proposalState.scope !== scope) {
    setProposalState({ memory: Ref.makeUnsafe<ProposalMemory>(new Map()), scope });
  }
  const proposalMemory = proposalState.memory;
  const actorLabel = useActorLabel(scope);
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
  const requestedDocumentId = fields.documentId;
  const detailConflict = financeRecordDetailConflict({ documentId: requestedDocumentId, resourceId: requestedId });
  const request = searchInvalid ? Option.none() : customerInvoiceRequest(partyId, counterpartyId, tenantId);
  /** The cached ledger this page shows: none without a verified scope, so no other scope's entry is ever read. */
  const ledgerInput = scopedRecordsRequest(scope, request);
  const requestKey = Option.match(ledgerInput, { onNone: () => 'invalid', onSome: scopedRecordsKey });
  const storeSnapshot = useSyncExternalStore(
    financeRecords.subscribe,
    () => (Option.isSome(ledgerInput) ? financeRecords.snapshot(ledgerInput.value) : pageDataPending),
    pendingRecords,
  );
  // The ledger is strict (`retainStale: false`): every background reload (a live change, the 20 s freshness, a
  // settled write) reads `pending`. Without the held snapshot the plan, price list, accounting and recurring tabs
  // unmount for that moment and their open forms lose what the user typed. A failed or denied read still replaces it.
  const recordsSnapshot = useHeldSnapshot(requestKey, storeSnapshot);
  const snapshot = readyRecords(recordsSnapshot);
  /** Latest snapshot of this scope, so consecutive commands use the revision the previous one produced. */
  const latestSnapshot = () =>
    Option.isSome(ledgerInput) ? readyRecords(financeRecords.snapshot(ledgerInput.value)) : undefined;
  /** Outcome of the user's own reload or command; 'ready' defers to the ledger's load state. */
  const [actionFeedback, setActionFeedback] = useState<FinanceFeedback>('ready');
  // Without a verified Shell scope nothing is authorized to load, so the page says so instead of waiting forever.
  const feedback = scope === undefined ? 'forbidden' : feedbackOf(actionFeedback, recordsSnapshot);
  const [voidTarget, setVoidTarget] = useState<Invoice>();
  /** Confirming numbers the invoice and locks it, so every entry point asks first. */
  const [confirmTarget, setConfirmTarget] = useState<Invoice>();
  /** True while the open detail is a history entry this page pushed, so closing it can step back instead. */
  const detailPushed = useRef(false);
  const detailKey = `${requestKey}:${requestedId ?? ''}`;
  const currentInvoiceDetail = financeInvoiceDetailState({
    feedback,
    invoices: snapshot?.state.invoices,
    resourceId: requestedId,
  });
  const invoiceDetail = useRetainedInvoice(currentInvoiceDetail, detailKey);
  const selected = invoiceDetail?.state === 'ready' ? invoiceDetail.invoice : undefined;
  const busy = busyFeedback(feedback);
  const canWrite = canWriteOf(ledgerInput, snapshot);
  const references = useFinanceReferences({ scope });
  const objects = useRentalObjects();

  /** Never fails; a failed reload reports through the ledger snapshot instead of rejecting. */
  const load = (): Effect.Effect<void> =>
    Option.isSome(ledgerInput) ? financeRecords.refresh(ledgerInput.value) : Effect.void;

  /**
   * Creates a draft from the form. The counterparty ref is the party registry's own ref for the customer, and the
   * number is the next one in the series; the backend stores the lines as given (price snapshots).
   */
  const createDraft = (input: DraftInvoiceInput): Effect.Effect<DraftInvoiceOutcome> => {
    if (snapshot === undefined || !canWrite) {
      return Effect.succeed({ feedback: 'unavailable', ok: false });
    }
    const command: FinanceCommandDraft<'CreateInvoiceDraft'> = {
      _tag: 'CreateInvoiceDraft',
      counterpartyRef: input.customer.counterpartyRef,
      currency: 'CZK',
      direction: 'OUTGOING',
      documentNumber: nextInvoiceNumber(snapshot.state.invoices),
      dueDate: input.dueDate,
      issueDate: input.issueDate,
      lines: [...input.lines],
      partyId: input.customer.partyId,
      ...input.anchors,
    };

    if (input.documentKind !== undefined && input.documentKind !== 'STANDARD') {
      command.documentKind = input.documentKind;
    }
    return submitIntent(proposalMemory, requestKey, snapshot, command).pipe(
      Effect.tap((result) => (isProposalAccepted(result) ? Effect.void : load())),
      // A 409 means the snapshot revision is stale (another write landed first); reload it so the next try can succeed.
      Effect.tapError((cause) => (financeFailureFeedback(cause) === 'conflict' ? load() : Effect.void)),
      Effect.match({
        onFailure: (error): DraftInvoiceOutcome => ({ feedback: financeFailureFeedback(error), ok: false }),
        onSuccess: (result): DraftInvoiceOutcome => {
          if (isProposalAccepted(result)) {
            return { feedback: 'pendingApproval', ok: false };
          }
          return result.invoice === undefined
            ? { feedback: 'unavailable', ok: false }
            : { invoice: result.invoice, ok: true };
        },
      }),
    );
  };

  // A cold mount (the page was not prepared) starts the load; a prepared page finds it ready and keeps it. The
  // snapshot state is a dependency so an expired entry that turned pending starts its revalidation again.
  useEffect(() => {
    const current = scopedRecordsRequest(
      scope,
      searchInvalid ? Option.none() : customerInvoiceRequest(partyId, counterpartyId, tenantId),
    );
    if (Option.isSome(current) && storeSnapshot.state !== 'failed') {
      financeRecords.ensure(current.value);
    }
  }, [counterpartyId, partyId, storeSnapshot.state, scope, searchInvalid, tenantId]);

  /** Retry after a failed load; the outcome shows through the ledger's own state. */
  const reload = () => {
    setActionFeedback('loading');
    void financeBrowserRuntime.runPromise(load().pipe(Effect.andThen(Effect.sync(() => setActionFeedback('ready')))));
  };

  const runCommand = (command: FinanceCommandInput, successTitle: string) => {
    if (snapshot === undefined || !canWrite) {
      return;
    }
    setActionFeedback('saving');
    void financeBrowserRuntime.runPromise(
      submitIntent(proposalMemory, requestKey, snapshot, command).pipe(
        Effect.tap((result) => (isProposalAccepted(result) ? Effect.void : load())),
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

            let notification: Parameters<typeof toaster.create>[0] = {
              title: t(`finance-billing.demo.feedback.${known === undefined ? failure : 'refused'}`),
              type: 'error',
            };
            if (known !== undefined) {
              notification = { ...notification, description: known };
            }
            toaster.create(notification);
          },
          onSuccess: (result) => {
            setActionFeedback('ready');
            if (isProposalAccepted(result)) {
              toaster.create({ title: t('finance-billing.demo.feedback.pendingApproval'), type: 'info' });
              return;
            }
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

  const execute = Effect.fn('Finance.executeCommand')(
    (command: FinanceCommandInput, successTitle?: string): Effect.Effect<CommandOutcome> =>
      Effect.suspend((): Effect.Effect<CommandOutcome> => {
        const current = latestSnapshot() ?? snapshot;
        if (current === undefined || !canWrite) {
          return Effect.succeed({ feedback: 'unavailable', ok: false });
        }
        setActionFeedback('saving');
        return submitIntent(proposalMemory, requestKey, current, command).pipe(
          Effect.tap((result) => (isProposalAccepted(result) ? Effect.void : load())),
          Effect.tapError((cause) => (financeFailureFeedback(cause) === 'conflict' ? load() : Effect.void)),
          Effect.match({
            onFailure: (error): CommandOutcome => {
              setActionFeedback('ready');
              const nextFeedback = financeFailureFeedback(error);
              const reason = failureReason(error);
              return reason === undefined
                ? { feedback: nextFeedback, ok: false }
                : { feedback: nextFeedback, ok: false, reason };
            },
            onSuccess: (result): CommandOutcome => {
              setActionFeedback('ready');
              if (isProposalAccepted(result)) {
                // Titled callers rely on the toast for their outcome, so they hear the approval wait the same way.
                if (successTitle !== undefined) {
                  toaster.create({ title: t('finance-billing.demo.feedback.pendingApproval'), type: 'info' });
                }
                return { feedback: 'pendingApproval', ok: false };
              }
              if (successTitle !== undefined) {
                toaster.create({ title: successTitle, type: 'success' });
              }
              return { invoice: result.invoice, ok: true };
            },
          }),
        );
      }),
  );

  return {
    actorLabel,
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
    closeDocumentDetail: () => {
      window.history.replaceState(window.history.state, '', documentDetailUrl());
    },

    execute,
    fetchDocument,
    /** The URL must name an invoice or a document, never both. */
    detailConflict,
    documentId: requestedDocumentId,
    /** An explicit `?resourceId=` target: the exact invoice, or the honest reason it cannot be shown. */
    invoiceDetail,

    /** Asks before confirming; `confirmPending` runs the command once the user agrees. */
    confirmInvoice: (invoice: Invoice) => setConfirmTarget(invoice),
    confirmPending: () => {
      if (confirmTarget !== undefined) {
        const command: FinanceCommandDraft<'ConfirmInvoice'> = {
          _tag: 'ConfirmInvoice',
          invoiceRef: confirmTarget.ref,
        };
        if (actorLabel !== undefined) {
          command.actorLabel = actorLabel;
        }

        runCommand(command, t('finance-billing.faktury.confirmed'));
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
    /** The verified Shell scope this ledger belongs to; keys every other Finance read of the page. */
    scope,
    selected,
    snapshot,
    t,
    voidTarget,
  };
};
