import type { CustomerListItem } from '@app/party-registry/api/client';
import { makeReferenceGatewayCredentials } from '@app/shared-contracts';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useRouterState } from '@modern-js/plugin-tanstack/runtime';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { Effect, Match, Option, Schema } from 'effect';
import { useEffect, useState } from 'react';
import type { FinanceCommand } from '../../../../../shared/actions/apply-command.ts';
import type { CalendarDateSchema, Invoice, InvoiceLine, RecordsResponse } from '../../../../../shared/apis/records.ts';
import { nextInvoiceNumber } from '../../../../../shared/domain/invoice-totals.ts';
import { InvoiceRefSchema } from '../../../../../shared/resources/invoice.ts';
import { executeApplyCommand } from '../../../../api/apply-command-action-client.ts';
import { browserCrypto } from '../../../../api/browser-crypto.ts';
import { executeRecords } from '../../../../api/records-client.ts';
import { financeBrowserRuntime } from '../../../../runtime/browser.ts';
import { useFinanceReferences } from './use-finance-references.ts';

export type CalendarDate = typeof CalendarDateSchema.Type;

export interface DraftInvoiceInput {
  readonly customer: CustomerListItem;
  readonly dueDate: CalendarDate;
  readonly issueDate: CalendarDate;
  readonly lines: readonly InvoiceLine[];
}

export type DraftInvoiceOutcome =
  | { readonly feedback: Feedback; readonly ok: false }
  | { readonly invoice: Invoice; readonly ok: true };

const searchSchema = Schema.Struct({
  resourceId: Schema.optional(InvoiceRefSchema.fields.resourceId.check(Schema.isUUID())),
});
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
  revision: number,
  command: FinanceCommand,
) {
  const referenceCredentials = yield* makeReferenceGatewayCredentials([
    'party-registry',
    'siampark-property',
    'siampark-property',
    'siampark-occupancy',
    'siampark-agreements',
    'siampark-work',
  ]);
  const idempotencyKey = yield* browserCrypto.randomUUIDv4;
  return yield* executeApplyCommand({ command, expectedRevision: revision }, 'siampark-finance.command', {
    idempotencyKey,
    referenceCredentials,
  });
});

const fetchRecords = () => executeRecords({}, 'siampark-finance.records');

/** Invoice list and detail state. Loads once on mount; commands reload the list after they succeed. */
export const useFinanceRecords = () => {
  const { t } = useModernI18n();
  const toaster = useToast();
  const search = Schema.decodeUnknownOption(searchSchema)(useRouterState().location.search);
  const requestedId = Option.getOrUndefined(search)?.resourceId;
  const [snapshot, setSnapshot] = useState<RecordsResponse>();
  const [feedback, setFeedback] = useState<Feedback>('loading');
  const [detailId, setDetailId] = useState<string | undefined>(requestedId);
  const [voidTarget, setVoidTarget] = useState<Invoice>();
  const selected = snapshot?.state.invoices.find((record) => record.ref.resourceId === detailId);
  const busy = feedback === 'loading' || feedback === 'saving';
  const canWrite = snapshot?.canWrite === true;
  const references = useFinanceReferences();

  const load = () => fetchRecords().pipe(Effect.tap((value) => Effect.sync(() => setSnapshot(value))));

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
    };
    return submitFinanceCommand(snapshot.revision, command).pipe(
      Effect.tap(() => load().pipe(Effect.ignore)),
      Effect.match({
        onFailure: (error): DraftInvoiceOutcome => ({ feedback: financeFailureFeedback(error), ok: false }),
        onSuccess: (result): DraftInvoiceOutcome => ({ invoice: result.invoice, ok: true }),
      }),
    );
  };

  useEffect(() => {
    let active = true;
    void financeBrowserRuntime.runPromise(
      fetchRecords().pipe(
        Effect.match({
          onFailure: (error) => {
            if (active) {
              setFeedback(financeFailureFeedback(error));
            }
          },
          onSuccess: (value) => {
            if (active) {
              setSnapshot(value);
              setFeedback('ready');
            }
          },
        }),
      ),
    );
    return () => {
      active = false;
    };
  }, []);

  const reload = () => {
    setFeedback('loading');
    void financeBrowserRuntime.runPromise(
      load().pipe(
        Effect.match({
          onFailure: (error) => setFeedback(financeFailureFeedback(error)),
          onSuccess: () => setFeedback('ready'),
        }),
      ),
    );
  };

  const runCommand = (command: FinanceCommand, successTitle: string) => {
    if (snapshot === undefined || !canWrite) {
      return;
    }
    setFeedback('saving');
    void financeBrowserRuntime.runPromise(
      submitFinanceCommand(snapshot.revision, command).pipe(
        Effect.flatMap((result) => load().pipe(Effect.map(() => result))),
        Effect.match({
          onFailure: (error) => setFeedback(financeFailureFeedback(error)),
          onSuccess: (result) => {
            setFeedback('ready');
            toaster.create({
              description: result.invoice.number ?? result.invoice.documentNumber,
              title: successTitle,
              type: 'success',
            });
          },
        }),
      ),
    );
  };

  return {
    busy,
    cancelVoid: () => setVoidTarget(undefined),
    canWrite,
    closeDetail: () => setDetailId(undefined),
    confirmInvoice: (invoice: Invoice) =>
      runCommand({ _tag: 'ConfirmInvoice', invoiceRef: invoice.ref }, t('siampark-billing-finance.faktury.confirmed')),
    confirmVoid: () => {
      if (voidTarget !== undefined) {
        runCommand({ _tag: 'VoidInvoice', invoiceRef: voidTarget.ref }, t('siampark-billing-finance.faktury.voided'));
      }
      setVoidTarget(undefined);
    },
    createDraft,
    feedback,
    indicators: snapshot?.indicators,
    invoices: [...(snapshot?.state.invoices ?? [])],
    openDetail: (id: string) => setDetailId(id),
    referenceDate: snapshot?.referenceDate ?? '',
    references,
    reload,
    requestVoid: (invoice: Invoice) => setVoidTarget(invoice),
    selected,
    snapshot,
    t,
    voidTarget,
  };
};
