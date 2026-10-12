import { InvoiceRefSchema } from '../../../../../shared/resources/invoice.ts';
import { makeReferenceGatewayCredentials } from '@app/shared-contracts';
import { executeCounterpartyRead, loadCounterpartiesClient } from '@app/party-registry/api/client';
import { executeRecords as readProperty } from '@app/siampark-property/clients/records';
import { executeRecords as readOccupancy } from '@app/siampark-occupancy/clients/records';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useRouterState } from '@modern-js/plugin-tanstack/runtime';
import { Effect, Match, Option, Schema } from 'effect';
import { useEffect, useState } from 'react';
import type { FinanceCommand } from '../../../../../shared/actions/apply-command.ts';
import type { Invoice, RecordsResponse } from '../../../../../shared/apis/records.ts';
import { InvoiceDraftFields } from '../../../../../shared/apis/records.ts';
import { executeApplyCommand } from '../../../../api/apply-command-action-client.ts';
import { executeRecords } from '../../../../api/records-client.ts';
import { browserCrypto } from '../../../../api/browser-crypto.ts';
import { financeBrowserRuntime } from '../../../../runtime/browser.ts';

type Parties = Effect.Success<ReturnType<typeof loadCounterpartiesClient>>;
type Properties = Effect.Success<ReturnType<typeof readProperty>>;
type Occupancies = Effect.Success<ReturnType<typeof readOccupancy>>;
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
  | ReturnType<typeof readProperty>
  | ReturnType<typeof readOccupancy>
  | ReturnType<typeof loadCounterpartiesClient>
  | ReturnType<typeof executeCounterpartyRead>
  | typeof browserCrypto.randomUUIDv4
  | ReturnType<typeof makeReferenceGatewayCredentials>
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
export const parseMoney = (value: string): number | undefined => {
  if (!/^\d{1,10}(?:[.,]\d{1,2})?$/u.test(value)) {
    return undefined;
  }
  const [whole = '0', fractional = ''] = value.replace(',', '.').split('.');
  const amount = Number(whole) * 100 + Number(fractional.padEnd(2, '0'));
  return amount > 0 && amount <= 1_000_000_000_000 ? amount : undefined;
};
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
type DraftFields = Pick<Invoice, 'direction' | 'documentNumber' | 'dueDate' | 'issueDate'> & {
  readonly amount: string;
  readonly occupancyId: string;
  readonly partyId: string;
  readonly partyQuery: string;
  readonly propertyId: string;
};
const existingDraftSchema = Schema.Struct(InvoiceDraftFields);
const initialDraft: DraftFields = {
  amount: String(15_000),
  direction: 'OUTGOING',
  documentNumber: '',
  dueDate: '2026-10-15',
  issueDate: '2026-10-05',
  occupancyId: '',
  partyId: '',
  partyQuery: '',
  propertyId: '',
};
const currencyFormatters = {
  cs: new Intl.NumberFormat('cs-CZ', { currency: 'CZK', style: 'currency' }),
  en: new Intl.NumberFormat('en-GB', { currency: 'CZK', style: 'currency' }),
};
export const useFinanceRecords = () => {
  const { language, t } = useModernI18n();
  const search = Schema.decodeOption(searchSchema)(useRouterState().location.search);
  const requestedId = Option.getOrUndefined(search)?.resourceId;
  const [snapshot, setSnapshot] = useState<RecordsResponse>();
  const [properties, setProperties] = useState<Properties>();
  const [occupancies, setOccupancies] = useState<Occupancies>();
  const [parties, setParties] = useState<Parties>([]);
  const [counterpartyCard, setCounterpartyCard] =
    useState<Effect.Success<ReturnType<typeof executeCounterpartyRead>>>();
  const [feedback, setFeedback] = useState<Feedback>('loading');
  const [selectedId, setSelectedId] = useState('');
  const [directionFilter, setDirectionFilter] = useState('ALL');
  const [filterPropertyId, setFilterPropertyId] = useState('');
  const [paymentAmount, setPaymentAmount] = useState('');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<DraftFields>(initialDraft);
  const { amount, direction, documentNumber, dueDate, issueDate, occupancyId, partyId, partyQuery, propertyId } = draft;
  const setDirection = (value: Invoice['direction']) => setDraft((current) => ({ ...current, direction: value }));
  const setPropertyId = (value: string) => setDraft((current) => ({ ...current, propertyId: value }));
  const setPartyId = (value: string) => setDraft((current) => ({ ...current, partyId: value }));
  const setPartyQuery = (value: string) => setDraft((current) => ({ ...current, partyQuery: value }));
  const setOccupancyId = (value: string) => setDraft((current) => ({ ...current, occupancyId: value }));
  const setDocumentNumber = (value: string) => setDraft((current) => ({ ...current, documentNumber: value }));
  const setAmount = (value: string) => setDraft((current) => ({ ...current, amount: value }));
  const setIssueDate = (value: string) => setDraft((current) => ({ ...current, issueDate: value }));
  const setDueDate = (value: string) => setDraft((current) => ({ ...current, dueDate: value }));
  const selected = snapshot?.state.invoices.find((record) => record.ref.resourceId === (selectedId || requestedId));
  const selectedCounterparty =
    counterpartyCard !== undefined &&
    selected !== undefined &&
    counterpartyCard.counterpartyRef.tenantId === selected.counterpartyRef.tenantId &&
    counterpartyCard.counterpartyRef.resourceId === selected.counterpartyRef.resourceId
      ? counterpartyCard
      : undefined;
  const readCounterparty = (invoice: Invoice) => {
    setCounterpartyCard(undefined);
    setFeedback('loading');
    void financeBrowserRuntime.runPromise(
      executeCounterpartyRead(
        { counterpartyRef: invoice.counterpartyRef },
        'siampark-finance.counterparty-detail',
      ).pipe(
        Effect.match({
          onFailure: (error) => setFeedback(financeFailureFeedback(error)),
          onSuccess: (value) => {
            setCounterpartyCard(value);
            setFeedback('ready');
          },
        }),
      ),
    );
  };
  const busy = feedback === 'loading' || feedback === 'saving';
  const canWrite = snapshot?.canWrite === true;
  const formatter = language === 'cs' ? currencyFormatters.cs : currencyFormatters.en;
  const money = (minor: number) => formatter.format(minor / 100);
  const load = () =>
    executeRecords({}, 'siampark-finance.records').pipe(
      Effect.tap((value) => {
        setSnapshot(value);
        return Effect.void;
      }),
      Effect.tapError(() =>
        Effect.sync(() => {
          setSnapshot(undefined);
          setProperties(undefined);
          setOccupancies(undefined);
          setParties([]);
          setCounterpartyCard(undefined);
          setSelectedId('');
        }),
      ),
    );
  useEffect(() => {
    let active = true;
    void financeBrowserRuntime.runPromise(
      Effect.all(
        {
          finance: executeRecords({}, 'siampark-finance.records'),
          occupancies: readOccupancy({}, 'siampark-finance.occupancies'),
          properties: readProperty({}, 'siampark-finance.properties'),
        },
        { concurrency: 3 },
      ).pipe(
        Effect.match({
          onFailure: (error) => {
            if (active) {
              setSnapshot(undefined);
              setProperties(undefined);
              setOccupancies(undefined);
              setParties([]);
              setCounterpartyCard(undefined);
              setFeedback(financeFailureFeedback(error));
            }
          },
          onSuccess: (value) => {
            if (active) {
              setSnapshot(value.finance);
              setProperties(value.properties);
              setOccupancies(value.occupancies);
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
  const runCommand = (command: FinanceCommand) => {
    if (snapshot === undefined || !canWrite) {
      return;
    }
    setFeedback('saving');
    void financeBrowserRuntime.runPromise(
      submitFinanceCommand(snapshot.revision, command).pipe(
        Effect.flatMap((result) =>
          load().pipe(
            Effect.tap(() => {
              setSelectedId(result.invoice.ref.resourceId);
              setEditing(false);
              return Effect.void;
            }),
          ),
        ),
        Effect.match({
          onFailure: (error) => setFeedback(financeFailureFeedback(error)),
          onSuccess: () => setFeedback('ready'),
        }),
      ),
    );
  };
  const saveDraft = () => {
    if (!canWrite) {
      return;
    }
    const totalMinor = parseMoney(amount);
    if (totalMinor === undefined || documentNumber.trim().length === 0) {
      setFeedback('validation');
      return;
    }
    if (editing) {
      const fields = Option.getOrUndefined(Schema.decodeUnknownOption(existingDraftSchema)(selected));
      if (fields === undefined || selected?.businessState !== 'DRAFT') {
        setFeedback('validation');
        return;
      }
      runCommand({
        ...fields,
        _tag: 'UpdateInvoiceDraft',
        documentNumber,
        dueDate,
        invoiceRef: selected.ref,
        issueDate,
        totalMinor,
      });
      return;
    }
    const party = parties.find((record) => record.ref.resourceId === partyId);
    const property = properties?.properties.find((record) => record.propertyRef.resourceId === propertyId);
    const occupancy = occupancies?.occupancies.find((record) => record.occupancyRef.resourceId === occupancyId);
    if (party === undefined) {
      setFeedback('validation');
      return;
    }
    const baseFields = {
      counterpartyRef: party.ref,
      currency: 'CZK' as const,
      direction,
      documentNumber,
      dueDate,
      issueDate,
      totalMinor,
    };
    const propertyFields = property === undefined ? baseFields : { ...baseFields, propertyRef: property.propertyRef };
    const occupancyFields =
      occupancy === undefined
        ? propertyFields
        : { ...propertyFields, occupancyRef: occupancy.occupancyRef, unitRef: occupancy.unitRef };
    const fields =
      occupancy?.contractRef === null || occupancy?.contractRef === undefined
        ? occupancyFields
        : { ...occupancyFields, contractRef: occupancy.contractRef };
    runCommand({ _tag: 'CreateInvoiceDraft', ...fields });
  };
  const searchParties = () => {
    if (partyQuery.trim().length === 0) {
      setFeedback('validation');
      return;
    }
    void financeBrowserRuntime.runPromise(
      loadCounterpartiesClient(
        { includeArchived: false, query: partyQuery, role: direction === 'INCOMING' ? 'SUPPLIER' : 'CUSTOMER' },
        'siampark-finance.counterparties',
      ).pipe(
        Effect.match({
          onFailure: (error) => setFeedback(financeFailureFeedback(error)),
          onSuccess: (value) => {
            setParties(value);
            setFeedback('ready');
          },
        }),
      ),
    );
  };
  const editDraft = (invoice: Invoice) => {
    if (!canWrite || invoice.businessState !== 'DRAFT') {
      return;
    }
    setDraft({
      amount: (invoice.totalMinor / 100).toFixed(2),
      direction: invoice.direction,
      documentNumber: invoice.documentNumber,
      dueDate: invoice.dueDate,
      issueDate: invoice.issueDate,
      occupancyId: invoice.occupancyRef?.resourceId ?? '',
      partyId: invoice.counterpartyRef.resourceId,
      partyQuery: '',
      propertyId: invoice.propertyRef?.resourceId ?? '',
    });
    setEditing(true);
  };
  const resetDraft = () => {
    setEditing(false);
    setDraft(initialDraft);
    setParties([]);
  };
  const visible =
    snapshot?.state.invoices.filter(
      (record) =>
        (directionFilter === 'ALL' || record.direction === directionFilter) &&
        (filterPropertyId === '' || record.propertyRef?.resourceId === filterPropertyId),
    ) ?? [];
  const propertyName = (id: string | undefined) =>
    properties?.properties.find((record) => record.propertyRef.resourceId === id)?.name ??
    t('siampark-billing-finance.demo.none');

  return {
    amount,
    busy,
    canWrite,
    direction,
    directionFilter,
    documentNumber,
    dueDate,
    editDraft,
    editing,
    feedback,
    filterPropertyId,
    issueDate,
    load,
    money,
    occupancies,
    occupancyId,
    parties,
    partyId,
    partyQuery,
    paymentAmount,
    properties,
    propertyId,
    propertyName,
    readCounterparty,
    requestedId,
    resetDraft,
    runCommand,
    saveDraft,
    searchParties,
    selected,
    selectedCounterparty,
    setAmount,
    setDirection,
    setDirectionFilter,
    setDocumentNumber,
    setDueDate,
    setEditing,
    setFeedback,
    setFilterPropertyId,
    setIssueDate,
    setOccupancyId,
    setParties,
    setPartyId,
    setPartyQuery,
    setPaymentAmount,
    setPropertyId,
    setSelectedId,
    snapshot,
    t,
    visible,
  };
};
