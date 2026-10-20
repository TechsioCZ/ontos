import { LinkButton } from '@techsio/ui-kit/atoms/link-button';
import {
  DetailList,
  PageHeader,
  SectionCard,
  SidePanel,
  StatCard,
  comboboxTranslations,
  formatDate,
  formatMoney,
} from '@app/admin-ui';
import { Combobox } from '@techsio/ui-kit/molecules/combobox';
import { failureFeedback } from '../../../../../shared/actions/apply-command.ts';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { makeReferenceGatewayCredentials } from '@app/shared-contracts';
import {
  executeCounterpartyRead,
  executePartyDetail,
  listCustomers,
  loadPartiesClient,
} from '@app/party-registry/api/client';
import { executeRecords as executePropertyRecords } from '@app/siampark-property/clients/records';
import { executeRecords as executeAgreementsRecords } from '@app/siampark-agreements/clients/records';
import { executeRecords as executeFinanceRecords } from '@app/siampark-billing-finance/clients/records';
import { executeRecords as executeWorkRecords } from '@app/siampark-work/clients/records';
import { FederatedI18nBoundary, useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useRouterState } from '@modern-js/plugin-tanstack/runtime';
import { OccupancyRefSchema } from '../../../../../shared/resources/occupancy.ts';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { Select } from '@techsio/ui-kit/molecules/select';
import { Table } from '@techsio/ui-kit/organisms/table';
import { Crypto, DateTime, Effect, Option, PlatformError, Schema } from 'effect';
import { useEffect, useEffectEvent, useRef, useState } from 'react';

import type { OccupancyCommand, Feedback } from '../../../../../shared/actions/apply-command.ts';
import type { Occupancy, RecordsResponse, RentTerms } from '../../../../../shared/apis/records.ts';
import {
  ContractCard,
  InvoicesCard,
  LeaseStoryNav,
  RentTermsCard,
  TasksCard,
  TenantCard,
  UnitCard,
  crownsInput,
  leaseContract,
  loadedList,
  monthlyTotal,
  parseCrowns,
} from './lease-story.tsx';
import type { LeaseRelated, TenantDirectoryEntry } from './lease-story.tsx';
import { executeApplyCommand } from '../../../../api/apply-command-action-client.ts';
import { executeRecords } from '../../../../api/records-client.ts';
import { UltramodernRouteHead } from '../../../ultramodern-route-head';
import csResource from '../../../../../locales/cs/siampark-occupancy.json';
import enResource from '../../../../../locales/en/siampark-occupancy.json';
import '../../../index.css';
import { TenantDirectory, TenantDossierCard } from './tenant-dossier.tsx';
import { OccupancyCalendar } from './occupancy-calendar.tsx';
import './occupancy-form.css';

const RecordsSearchSchema = Schema.Struct({
  resourceId: Schema.optional(OccupancyRefSchema.fields.resourceId),
  create: Schema.optional(Schema.Literal('lease')),
  unitId: Schema.optional(OccupancyRefSchema.fields.resourceId),
});
const LABEL_CHOOSE = 'siampark-occupancy.demo.choose';
const LABEL_UNIT = 'siampark-occupancy.demo.unit';
const LABEL_DETAIL = 'siampark-occupancy.demo.detail';
const currentPragueDay = () =>
  new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Prague',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(DateTime.toEpochMillis(DateTime.nowUnsafe()));
const DEFAULT_START_DATE = currentPragueDay();
const DEFAULT_END_DATE = '';
const LABEL_EDIT_DRAFT = 'siampark-occupancy.demo.editDraft';
const LABEL_CREATE = 'siampark-occupancy.demo.create';
const LABEL_SIMULATED = 'siampark-occupancy.demo.simulated';
const siamparkOccupancyI18nResources = {
  cs: { 'siampark-occupancy': csResource },
  en: { 'siampark-occupancy': enResource },
} as const;
const browserCrypto = Crypto.make({
  digest: (algorithm, data) =>
    Effect.tryPromise({
      catch: (cause) => PlatformError.systemError({ _tag: 'Unknown', cause, method: 'digest', module: 'WebCrypto' }),
      try: globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle, algorithm, new Uint8Array(data)),
    }).pipe(
      Effect.map((buffer) => new Uint8Array(buffer)),
      Effect.timeoutOrElse({
        duration: '5 seconds',
        orElse: () =>
          Effect.fail(PlatformError.systemError({ _tag: 'TimedOut', method: 'digest', module: 'WebCrypto' })),
      }),
    ),
  randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
});
const newUuid = browserCrypto.randomUUIDv4;
type Guests = Effect.Success<ReturnType<typeof loadPartiesClient>>;
type Customers = Effect.Success<ReturnType<typeof listCustomers>>;
type Properties = Effect.Success<ReturnType<typeof executePropertyRecords>>;
type Agreements = Effect.Success<ReturnType<typeof executeAgreementsRecords>>;
const loadOccupantName = Effect.fn('Occupancy.loadOccupantName')(function* resolveOccupantName(
  record: Occupancy | undefined,
) {
  if (record === undefined) {
    return Option.none<string>();
  }
  if (record.customerCounterpartyRef !== null) {
    const customer = yield* executeCounterpartyRead(
      { counterpartyRef: record.customerCounterpartyRef },
      'siampark-occupancy.customer-detail',
    );
    return Option.fromNullishOr(customer.party.displayName);
  }
  if (record.guestPartyRef !== null) {
    const guest = yield* executePartyDetail({ partyRef: record.guestPartyRef }, 'siampark-occupancy.guest-detail');
    return guest.party.displayName;
  }
  return Option.none<string>();
});
const useRecordsPage = () => {
  const { language, t } = useModernI18n();
  const { location } = useRouterState();
  const rawSearch: unknown = location.search;
  const search = Schema.is(Schema.toEncoded(RecordsSearchSchema))(rawSearch)
    ? Schema.decodeOption(RecordsSearchSchema)(rawSearch)
    : Option.none();
  const linkedResourceId = Option.getOrUndefined(search)?.resourceId;
  const cancellation = useRef<AbortController | null>(null);
  const run = <A, E>(effect: Effect.Effect<A, E>) => {
    const controller = cancellation.current ?? new AbortController();
    cancellation.current = controller;
    void browserRuntime.runPromiseExit(effect, { signal: controller.signal });
  };
  const [snapshot, setSnapshot] = useState<RecordsResponse>();
  const [properties, setProperties] = useState<Properties>();
  const [agreements, setAgreements] = useState<Agreements>();
  const [customers, setCustomers] = useState<Customers>([]);
  const [guests, setGuests] = useState<Guests>([]);
  const [guestId, setGuestId] = useState('');
  const [guestQuery, setGuestQuery] = useState('');
  const [peopleCount, setPeopleCount] = useState('2');
  const [stayNote, setStayNote] = useState('');
  const [feedback, setFeedback] = useState<Feedback>('loading');
  const [unitId, setUnitId] = useState('');
  const [customerId, setCustomerId] = useState('');
  const [customersLoading, setCustomersLoading] = useState(false);
  const [customerOpen, setCustomerOpen] = useState(false);
  const [editor, setEditor] = useState<'lease' | 'stay' | 'booking'>();
  const [retryObservationId, setRetryObservationId] = useState<string>();
  const [startDate, setStartDate] = useState(DEFAULT_START_DATE);
  const [endDate, setEndDate] = useState(DEFAULT_END_DATE);
  const [customerName, setCustomerName] = useState<string>();
  const [customerNameFeedback, setCustomerNameFeedback] = useState<Feedback>();
  const [editingId, setEditingId] = useState('');
  const [kindFilter, setKindFilter] = useState<'ALL' | 'LONG_TERM_LEASE' | 'SHORT_STAY'>('ALL');
  const [tenantDirectory, setTenantDirectory] = useState<readonly TenantDirectoryEntry[]>([]);
  const [related, setRelated] = useState<LeaseRelated>({ invoices: undefined, tasks: undefined });
  const [rentMonthly, setRentMonthly] = useState('');
  const [rentService, setRentService] = useState('');
  const [rentPaymentDay, setRentPaymentDay] = useState('15');
  const [rentEditorOpen, setRentEditorOpen] = useState(false);
  const selected = snapshot?.occupancies.find((record) => record.occupancyRef.resourceId === linkedResourceId);
  const clearSensitiveState = () => {
    setEditor(undefined);
    setRetryObservationId(undefined);
    setCustomersLoading(false);
    setSnapshot(undefined);
    setProperties(undefined);
    setAgreements(undefined);
    setCustomerName(undefined);
    setCustomerNameFeedback(undefined);
    setEditingId('');
    setCustomers([]);
    setGuests([]);
    setCustomerId('');
    setCustomerOpen(false);
    setGuestId('');
    setGuestQuery('');
    setUnitId('');
    setStartDate(DEFAULT_START_DATE);
    setEndDate(DEFAULT_END_DATE);
    setTenantDirectory([]);
    setRelated({ invoices: undefined, tasks: undefined });
    setRentEditorOpen(false);
  };
  const reportFailure = (failure: { readonly _tag: string; readonly status?: number }) => {
    const nextFeedback = failureFeedback(failure);
    if (nextFeedback === 'forbidden' || nextFeedback === 'unavailable') {
      cancellation.current?.abort();
      cancellation.current = new AbortController();
      clearSensitiveState();
    }
    setFeedback(nextFeedback);
  };
  const loadRelated = (record: Occupancy) =>
    Effect.all(
      {
        invoices: executeFinanceRecords({}, 'siampark-occupancy.lease-invoices').pipe(
          Effect.map((value) =>
            value.state.invoices.filter(
              (invoice) =>
                invoice.occupancyRef?.resourceId === record.occupancyRef.resourceId ||
                (invoice.occupancyRef === undefined &&
                  invoice.unitRef?.resourceId === record.unitRef.resourceId &&
                  invoice.counterpartyRef.resourceId === record.customerCounterpartyRef?.resourceId),
            ),
          ),
          Effect.orElseSucceed(() => 'unavailable' as const),
        ),
        tasks: executeWorkRecords(
          { contextResourceId: record.unitRef.resourceId },
          'siampark-occupancy.unit-tasks',
        ).pipe(
          Effect.map((value) => value.items),
          Effect.orElseSucceed(() => 'unavailable' as const),
        ),
      },
      { concurrency: 2 },
    ).pipe(Effect.tap((value) => Effect.sync(() => setRelated(value))));
  const load = () =>
    Effect.sync(clearSensitiveState).pipe(
      Effect.flatMap(() =>
        Effect.all(
          {
            agreements: executeAgreementsRecords({}, 'siampark-occupancy.contracts'),
            properties: executePropertyRecords({}, 'siampark-occupancy.units'),
            records: executeRecords({}, 'siampark-occupancy.records'),
          },
          { concurrency: 3 },
        ),
      ),
      Effect.tap((value) =>
        Effect.sync(() => {
          setSnapshot(value.records);
          setProperties(value.properties);
          setAgreements(value.agreements);
        }),
      ),
      Effect.tap(() =>
        // The tenant column and card are optional: a role without the customer list still sees its leases.
        listCustomers({ includeArchived: true, limit: 500 }).pipe(
          Effect.match({ onFailure: () => undefined, onSuccess: (items) => setTenantDirectory(items) }),
        ),
      ),
      Effect.tap((value) => {
        const record = value.records.occupancies.find((item) => item.occupancyRef.resourceId === linkedResourceId);
        return record === undefined ? Effect.void : loadRelated(record);
      }),
      Effect.tap((value) => {
        const record = value.records.occupancies.find((item) => item.occupancyRef.resourceId === linkedResourceId);
        return loadOccupantName(record).pipe(
          Effect.map(Option.getOrUndefined),
          Effect.match({
            onFailure: (failure) => setCustomerNameFeedback(failureFeedback(failure)),
            onSuccess: (name) => setCustomerName(name),
          }),
        );
      }),
    );
  const refresh = () => {
    cancellation.current?.abort();
    cancellation.current = new AbortController();
    clearSensitiveState();
    setFeedback('loading');
    run(
      load().pipe(
        Effect.match({
          onFailure: reportFailure,
          onSuccess: () => setFeedback('ready'),
        }),
      ),
    );
  };
  const loadOnMount = useEffectEvent(() => {
    run(load().pipe(Effect.match({ onFailure: reportFailure, onSuccess: () => setFeedback('ready') })));
  });
  useEffect(() => {
    loadOnMount();
    return () => {
      cancellation.current?.abort();
    };
  }, []);
  const runCommand = (command: OccupancyCommand) => {
    if (snapshot === undefined) {
      return;
    }
    setFeedback('saving');
    run(
      Effect.all(
        {
          idempotencyKey: newUuid,
          referenceCredentials: makeReferenceGatewayCredentials([
            'siampark-property',
            'siampark-property',
            'party-registry',
            'siampark-agreements',
          ]),
        },
        { concurrency: 2 },
      ).pipe(
        Effect.flatMap(({ idempotencyKey, referenceCredentials }) =>
          executeApplyCommand({ command, expectedRevision: snapshot.revision }, 'siampark-occupancy.command', {
            idempotencyKey,
            referenceCredentials,
          }),
        ),
        Effect.flatMap((result) => load().pipe(Effect.map((value) => ({ records: value.records, result })))),
        Effect.tap(({ records, result }) => {
          const record = records.occupancies.find(
            (item) => item.occupancyRef.resourceId === result.resourceRef?.resourceId,
          );
          if (record !== undefined && linkedResourceId !== record.occupancyRef.resourceId) {
            const url = new URL(window.location.href);
            url.searchParams.set('resourceId', record.occupancyRef.resourceId);
            url.searchParams.delete('create');
            url.searchParams.delete('unitId');
            window.location.assign(url);
          }
          return Effect.void;
        }),
        Effect.match({
          onFailure: reportFailure,
          onSuccess: () => setFeedback('ready'),
        }),
      ),
    );
  };
  const rentTermsFromForm = (): RentTerms | 'invalid' | undefined => {
    if (rentMonthly.trim().length === 0 && rentService.trim().length === 0) {
      return undefined;
    }
    const monthlyRentMinor = parseCrowns(rentMonthly);
    const serviceChargesMinor = rentService.trim().length === 0 ? 0 : parseCrowns(rentService);
    const paymentDay = Number(rentPaymentDay);
    if (
      monthlyRentMinor === undefined ||
      serviceChargesMinor === undefined ||
      !Number.isInteger(paymentDay) ||
      paymentDay < 1 ||
      paymentDay > 31
    ) {
      return 'invalid';
    }
    return { currency: 'CZK', monthlyRentMinor, paymentDay, serviceChargesMinor };
  };
  const fillRentForm = (terms: RentTerms | undefined) => {
    setRentMonthly(terms === undefined ? '' : crownsInput(terms.monthlyRentMinor));
    setRentService(terms === undefined ? '' : crownsInput(terms.serviceChargesMinor));
    setRentPaymentDay(String(terms?.paymentDay ?? 15));
  };
  const openRentEditor = () => {
    fillRentForm(selected?.rentTerms);
    setRentEditorOpen(true);
  };
  const saveRentTerms = () => {
    const rentTerms = rentTermsFromForm();
    if (selected === undefined || rentTerms === undefined || rentTerms === 'invalid') {
      setFeedback('validation');
      return;
    }
    setRentEditorOpen(false);
    runCommand({ _tag: 'SetRentTerms', occupancyRef: selected.occupancyRef, rentTerms });
  };
  const createDraft = () => {
    const unit = properties?.units.find((record) => record.unitRef.resourceId === unitId);
    const customer = customers.find((record) => record.counterpartyRef.resourceId === customerId);
    const rentTerms = rentTermsFromForm();
    if (unit === undefined || customer === undefined || rentTerms === 'invalid') {
      setFeedback('validation');
      return;
    }
    run(
      newUuid.pipe(
        Effect.match({
          onFailure: reportFailure,
          onSuccess: (resourceId) =>
            runCommand({
              _tag: 'CreateDraft',
              record: {
                contractRef: null,
                customerCounterpartyRef: customer.counterpartyRef,
                endDate: endDate || null,
                externalBookingCorrelation: null,
                guestPartyRef: null,
                kind: 'LONG_TERM_LEASE',
                note: null,
                occupancyRef: {
                  moduleId: 'siampark.occupancy',
                  resourceId,
                  resourceType: 'siampark.occupancy.occupancy',
                  tenantId: unit.unitRef.tenantId,
                },
                peopleCount: null,
                ...(rentTerms === undefined ? {} : { rentTerms }),
                startDate,
                state: 'DRAFT',
                unitRef: unit.unitRef,
              },
            }),
        }),
      ),
    );
  };
  const createStay = () => {
    const unit = properties?.units.find((item) => item.unitRef.resourceId === unitId);
    const guest = guests.find((item) => item.ref.resourceId === guestId);
    const count = Number(peopleCount);
    if (
      unit === undefined ||
      guest === undefined ||
      !Number.isInteger(count) ||
      count < 1 ||
      endDate.length === 0 ||
      endDate <= startDate ||
      stayNote.length > 500
    ) {
      setFeedback('validation');
      return;
    }
    run(
      newUuid.pipe(
        Effect.match({
          onFailure: reportFailure,
          onSuccess: (resourceId) =>
            runCommand({
              _tag: 'CreateDraft',
              record: {
                contractRef: null,
                customerCounterpartyRef: null,
                endDate,
                externalBookingCorrelation: null,
                guestPartyRef: guest.ref,
                kind: 'SHORT_STAY',
                note: stayNote.trim() || null,
                peopleCount: count,
                startDate,
                state: 'DRAFT',
                unitRef: unit.unitRef,
                occupancyRef: {
                  moduleId: 'siampark.occupancy',
                  resourceId,
                  resourceType: 'siampark.occupancy.occupancy',
                  tenantId: unit.unitRef.tenantId,
                },
              },
            }),
        }),
      ),
    );
  };
  const editDraft = () => {
    if (selected?.state !== 'DRAFT') {
      return;
    }
    setEditingId(selected.occupancyRef.resourceId);
    setStartDate(selected.startDate);
    setEndDate(selected.endDate ?? '');
    fillRentForm(selected.rentTerms);
    setEditor('lease');
  };
  const loadCustomers = () => {
    setCustomersLoading(true);
    run(
      listCustomers({ includeArchived: false, limit: 500 }).pipe(
        Effect.match({
          onFailure: reportFailure,
          onSuccess: (values) => {
            setCustomers(values.filter((item) => item.status === 'ACTIVE'));
          },
        }),
        Effect.ensuring(Effect.sync(() => setCustomersLoading(false))),
      ),
    );
  };
  const newDraft = (mode: 'lease' | 'stay' | 'booking' = 'lease', retryId?: string) => {
    setRetryObservationId(retryId);
    setEditingId('');
    setStartDate(DEFAULT_START_DATE);
    setEndDate(DEFAULT_END_DATE);
    setUnitId('');
    setCustomerId('');
    setCustomers([]);
    fillRentForm(undefined);
    setGuestId('');
    setGuests([]);
    setGuestQuery('');
    setPeopleCount('2');
    setStayNote('');
    setEditor(mode);
    if (mode === 'lease') {
      loadCustomers();
    }
  };
  const consumedCreationLink = useRef(false);
  const openLinkedLease = useEffectEvent(() => {
    newDraft('lease');
    setUnitId(Option.getOrUndefined(search)?.unitId ?? '');
  });
  useEffect(() => {
    if (
      !consumedCreationLink.current &&
      linkedResourceId === undefined &&
      Option.getOrUndefined(search)?.create === 'lease' &&
      properties !== undefined &&
      feedback === 'ready'
    ) {
      consumedCreationLink.current = true;
      openLinkedLease();
    }
  }, [properties, feedback, linkedResourceId, search]);
  const saveDraft = () => {
    const rentTerms = rentTermsFromForm();
    if (selected?.state !== 'DRAFT' || selected.occupancyRef.resourceId !== editingId || rentTerms === 'invalid') {
      setFeedback('validation');
      return;
    }
    runCommand({
      _tag: 'UpdateDraft',
      endDate: endDate || null,
      occupancyRef: selected.occupancyRef,
      ...(rentTerms === undefined ? {} : { rentTerms }),
      startDate,
    });
  };
  const activate = (record: Occupancy) => {
    const contract = agreements?.contracts.find(
      (value) =>
        value.lifecycleState === 'ACTIVE' &&
        !value.isExpired &&
        value.unitRef?.resourceId === record.unitRef.resourceId &&
        value.counterpartyRef.resourceId === record.customerCounterpartyRef?.resourceId,
    );
    runCommand({
      _tag: 'Activate',
      contractRef: record.kind === 'SHORT_STAY' ? null : (contract?.contractRef ?? null),
      occupancyRef: record.occupancyRef,
    });
  };
  const searchGuests = () => {
    if (guestQuery.trim().length === 0) {
      setFeedback('validation');
      return;
    }
    run(
      loadPartiesClient({ includeArchived: false, query: guestQuery }, 'siampark-occupancy.guest-picker').pipe(
        Effect.match({
          onFailure: reportFailure,
          onSuccess: (values) => {
            setGuests(values);
            setGuestId('');
            setFeedback('ready');
          },
        }),
      ),
    );
  };
  const importBooking = (outcome: 'SUCCESS' | 'FAILED', retryId?: string) => {
    const unit = properties?.units.find((record) => record.unitRef.resourceId === unitId);
    const guest = guests.find((record) => record.ref.resourceId === guestId);
    if (unit === undefined || guest === undefined || endDate.length === 0) {
      setFeedback('validation');
      return;
    }
    run(
      Effect.all({ observationId: newUuid, resourceId: newUuid }, { concurrency: 1 }).pipe(
        Effect.match({
          onFailure: reportFailure,
          onSuccess: ({ observationId, resourceId }) => {
            const record: Occupancy = {
              contractRef: null,
              customerCounterpartyRef: null,
              endDate,
              externalBookingCorrelation: null,
              guestPartyRef: guest.ref,
              kind: 'SHORT_STAY',
              note: null,
              occupancyRef: {
                moduleId: 'siampark.occupancy',
                resourceId,
                resourceType: 'siampark.occupancy.occupancy',
                tenantId: unit.unitRef.tenantId,
              },
              peopleCount: 2,
              startDate,
              state: 'CONFIRMED',
              unitRef: unit.unitRef,
            };
            if (retryId === undefined) {
              runCommand({
                _tag: 'ImportBooking',
                correlation: `SIMULATED:booking:${observationId}`,
                observationId,
                outcome,
                record,
              });
            } else {
              runCommand({ _tag: 'RetryBooking', observationId: retryId, record });
            }
          },
        }),
      ),
    );
  };
  const unitName = (resourceId: string) =>
    properties?.units.find((record) => record.unitRef.resourceId === resourceId)?.name ?? resourceId;
  const visible = snapshot?.occupancies.filter((record) => kindFilter === 'ALL' || record.kind === kindFilter) ?? [];
  const tenantOf = (record: Occupancy | undefined) =>
    record?.customerCounterpartyRef === null || record === undefined
      ? undefined
      : tenantDirectory.find((item) => item.counterpartyRef.resourceId === record.customerCounterpartyRef?.resourceId);
  const unitOf = (record: Occupancy) =>
    properties?.units.find((item) => item.unitRef.resourceId === record.unitRef.resourceId);
  const propertyOf = (record: Occupancy) => {
    const unit = unitOf(record);
    return properties?.properties.find((item) => item.propertyRef.resourceId === unit?.propertyRef.resourceId);
  };
  const busy = feedback === 'loading' || feedback === 'saving';
  return {
    activate,
    agreements,
    busy,
    openRentEditor,
    propertyOf,
    related,
    rentEditorOpen,
    rentMonthly,
    rentPaymentDay,
    rentService,
    saveRentTerms,
    setRentEditorOpen,
    setRentMonthly,
    setRentPaymentDay,
    setRentService,
    tenantOf,
    unitOf,
    createDraft,
    createStay,
    peopleCount,
    setPeopleCount,
    stayNote,
    setStayNote,
    customerId,
    customerName,
    customerNameFeedback,
    customerOpen,
    customers,
    customersEmpty: !customersLoading && customers.length === 0,
    customersLoading,
    editDraft,
    editingId,
    editor,
    endDate,
    feedback,
    guestId,
    guestQuery,
    guests,
    importBooking,
    kindFilter,
    language,
    linkedResourceId,
    newDraft,
    properties,
    refresh,
    retryObservationId,
    runCommand,
    saveDraft,
    searchGuests,
    selected,
    setCustomerId,
    setCustomerOpen,
    setEditor,
    setEndDate,

    setGuestId,
    setGuestQuery,
    setKindFilter,
    setStartDate,
    setUnitId,
    snapshot,
    startDate,
    t,
    unitId,
    unitName,
    visible,
  };
};
const stateBadge = {
  ACTIVE: 'success',
  CANCELLED: 'danger',
  COMPLETED: 'secondary',
  CONFIRMED: 'info',
  DRAFT: 'outline',
} as const;
const OccupancyDetail = ({ state }: { readonly state: ReturnType<typeof useRecordsPage> }) => {
  const {
    activate,
    busy,
    customerName,
    customerNameFeedback,
    editDraft,
    feedback,
    language,
    runCommand,
    selected,
    snapshot,
    t,
    unitName,
  } = state;
  if (selected === undefined) {
    return (
      <>
        <a
          className="siamparkoccupancy:inline-flex siamparkoccupancy:text-sm siamparkoccupancy:underline"
          href={`/${language}/siampark/occupancy`}
        >
          {t('siampark-occupancy.detail.back')}
        </a>
        <PageHeader title={t(LABEL_DETAIL)} />
        <output aria-live="polite">
          {t(
            feedback === 'ready'
              ? 'siampark-occupancy.detail.notFound'
              : `siampark-occupancy.demo.feedback.${feedback}`,
          )}
        </output>
      </>
    );
  }
  const customerLabel = customerName ?? t('siampark-occupancy.detail.customerUnknown');
  const unit = state.unitOf(selected);
  const property = state.propertyOf(selected);
  const tenant = state.tenantOf(selected);
  const contract = leaseContract(selected, state.agreements?.contracts);
  const tasks = loadedList(state.related.tasks);
  const invoices = loadedList(state.related.invoices);
  const isLease = selected.kind === 'LONG_TERM_LEASE';
  const canEditRent =
    isLease && (selected.state === 'DRAFT' || selected.state === 'CONFIRMED' || selected.state === 'ACTIVE');
  const firstInvoice = invoices[0];
  return (
    <>
      <div>
        <LinkButton
          href={`/${language}/siampark/occupancy`}
          icon="icon-[mdi--arrow-left]"
          size="sm"
          theme="borderless"
          variant="secondary"
        >
          {t('siampark-occupancy.detail.back')}
        </LinkButton>
      </div>
      <PageHeader
        description={[
          t(`siampark-occupancy.demo.kind.${selected.kind}`),
          property?.name,
          `${formatDate(selected.startDate)} – ${
            selected.endDate === null ? t('siampark-occupancy.demo.openEnd') : formatDate(selected.endDate)
          }`,
        ]
          .filter((part) => part !== undefined)
          .join(' · ')}
        meta={
          <Badge size="sm" variant={stateBadge[selected.state]}>
            {t(`siampark-occupancy.demo.stateLabels.${selected.state}`)}
          </Badge>
        }
        title={`${unitName(selected.unitRef.resourceId)}${tenant?.displayName == null ? '' : ` · ${tenant.displayName}`}`}
      />
      {feedback !== 'ready' && <output aria-live="polite">{t(`siampark-occupancy.demo.feedback.${feedback}`)}</output>}
      {isLease && (
        <LeaseStoryNav
          steps={[
            {
              href:
                property === undefined
                  ? undefined
                  : `/${language}/siampark/properties?resourceId=${property.propertyRef.resourceId}`,
              label: t('siampark-occupancy.story.property'),
              value: property?.name,
            },
            {
              href: `/${language}/siampark/properties?resourceId=${selected.unitRef.resourceId}`,
              label: t('siampark-occupancy.story.unit'),
              value: unitName(selected.unitRef.resourceId),
            },
            {
              href: `/${language}/siampark/occupancy?resourceId=${selected.occupancyRef.resourceId}#tenant`,
              label: t('siampark-occupancy.story.tenant'),
              value: tenant?.displayName ?? customerName,
            },
            {
              href:
                contract === undefined
                  ? undefined
                  : `/${language}/siampark/agreements?resourceId=${contract.contractRef.resourceId}`,
              label: t('siampark-occupancy.story.contract'),
              value:
                contract === undefined
                  ? t('siampark-occupancy.related.notProvided')
                  : t(`siampark-occupancy.related.contractStates.${contract.lifecycleState}`),
            },
            {
              current: true,
              label: t('siampark-occupancy.story.lease'),
              value:
                selected.rentTerms === undefined
                  ? t(`siampark-occupancy.demo.stateLabels.${selected.state}`)
                  : t('siampark-occupancy.rent.perMonth', { amount: formatMoney(monthlyTotal(selected.rentTerms)) }),
            },
            {
              href: `/${language}/siampark/work`,
              label: t('siampark-occupancy.story.tasks'),
              value:
                state.related.tasks === 'unavailable'
                  ? t('siampark-occupancy.story.unavailable')
                  : String(tasks.length),
            },
            {
              href:
                firstInvoice === undefined
                  ? undefined
                  : `/${language}/siampark/finance?resourceId=${firstInvoice.ref.resourceId}`,
              label: t('siampark-occupancy.story.invoice'),
              value:
                firstInvoice === undefined
                  ? t('siampark-occupancy.related.notProvided')
                  : (firstInvoice.number ?? firstInvoice.documentNumber),
            },
          ]}
          t={t}
        />
      )}
      <div className="siamparkoccupancy:grid siamparkoccupancy:grid-cols-1 siamparkoccupancy:items-start siamparkoccupancy:gap-6 siamparkoccupancy:xl:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="siamparkoccupancy:min-w-0 siamparkoccupancy:space-y-6">
          {isLease && (
            <RentTermsCard
              action={
                canEditRent ? (
                  <Button disabled={busy} onClick={state.openRentEditor} size="sm" theme="outlined" variant="secondary">
                    {t(
                      selected.rentTerms === undefined ? 'siampark-occupancy.rent.set' : 'siampark-occupancy.rent.edit',
                    )}
                  </Button>
                ) : undefined
              }
              contract={contract}
              record={selected}
              t={t}
            />
          )}
          <div className="siamparkoccupancy:grid siamparkoccupancy:gap-6 siamparkoccupancy:md:grid-cols-2">
            <SectionCard title={t('siampark-occupancy.detail.lease')}>
              <DetailList
                items={[
                  { label: t(LABEL_UNIT), value: unitName(selected.unitRef.resourceId) },
                  {
                    label: t('siampark-occupancy.detail.type'),
                    value: t(`siampark-occupancy.demo.kind.${selected.kind}`),
                  },
                  { label: t('siampark-occupancy.demo.startDate'), value: formatDate(selected.startDate) },
                  ...(!isLease ? [{ label: 'Počet osob', value: String(selected.peopleCount ?? 'Neuvedeno') }] : []),
                  {
                    label: t('siampark-occupancy.demo.endDate'),
                    value:
                      selected.endDate === null ? t('siampark-occupancy.demo.openEnd') : formatDate(selected.endDate),
                  },
                ]}
              />
            </SectionCard>
            {isLease ? (
              <TenantCard
                fallbackName={feedback === 'loading' ? t('siampark-occupancy.demo.customersLoading') : customerLabel}
                language={language}
                t={t}
                tenant={tenant}
                title={t('siampark-occupancy.related.tenantCard')}
              />
            ) : (
              <SectionCard title={t('siampark-occupancy.demo.guest')}>
                <DetailList
                  items={[
                    {
                      label: t('siampark-occupancy.detail.customerName'),
                      value: feedback === 'loading' ? t('siampark-occupancy.demo.customersLoading') : customerLabel,
                    },
                  ]}
                />
              </SectionCard>
            )}
          </div>
          {isLease && snapshot !== undefined && (
            <TenantDossierCard
              busy={busy}
              counterpartyName={tenant?.displayName ?? customerLabel}
              contractHref={
                contract === undefined
                  ? undefined
                  : `/${language}/siampark/agreements?resourceId=${contract.contractRef.resourceId}`
              }
              taskHref={
                tasks[0] === undefined ? undefined : `/${language}/siampark/work?resourceId=${tasks[0].ref.resourceId}`
              }
              dossier={snapshot.tenantDossiers?.find(
                (item) => item.counterpartyId === selected.customerCounterpartyRef?.resourceId,
              )}
              key={`tenant:${snapshot.revision}`}
              language={language}
              newContactId={newUuid}
              onCommand={state.runCommand}
              record={selected}
            />
          )}
          {customerNameFeedback !== undefined && (
            <p className="siamparkoccupancy:text-sm siamparkoccupancy:text-(--color-fg-secondary)">
              {t('siampark-occupancy.detail.customerUnavailable')}{' '}
              {t(`siampark-occupancy.demo.feedback.${customerNameFeedback}`)}
            </p>
          )}
          {isLease && <InvoicesCard invoices={state.related.invoices} language={language} t={t} />}
          <TasksCard language={language} t={t} tasks={state.related.tasks} />
          {selected.note !== null && (
            <SectionCard title={t('siampark-occupancy.detail.note')}>
              <p className="siamparkoccupancy:whitespace-pre-wrap siamparkoccupancy:text-sm">{selected.note}</p>
            </SectionCard>
          )}
          {selected.externalBookingCorrelation !== null && (
            <SectionCard title={t('siampark-occupancy.demo.importBooking')}>
              <Badge variant="info">{t(LABEL_SIMULATED)}</Badge>
              <p className="siamparkoccupancy:break-words siamparkoccupancy:text-sm">
                {selected.externalBookingCorrelation}
              </p>
              {snapshot?.bookingObservations.flatMap((value) =>
                value.occupancyRef?.resourceId === selected.occupancyRef.resourceId
                  ? [
                      <p
                        className="siamparkoccupancy:space-y-2 siamparkoccupancy:break-words siamparkoccupancy:rounded-lg siamparkoccupancy:bg-(--color-surface-subtle) siamparkoccupancy:p-4 siamparkoccupancy:text-sm siamparkoccupancy:text-(--color-fg-secondary)"
                        key={value.observationId}
                      >
                        {t(`siampark-occupancy.demo.bookingStates.${value.state}`)} · {value.correlation} ·{' '}
                        {t('siampark-occupancy.demo.attempts', { attemptCount: value.attempts })}
                        <br />
                        {t('siampark-occupancy.demo.provider')}: {value.providerLabel}
                        <br />
                        {t('siampark-occupancy.demo.attemptedAt')}: {value.attemptedAt}
                        <br />
                        {t('siampark-occupancy.demo.requestSummary')}: {value.requestSummary}
                        <br />
                        {t('siampark-occupancy.demo.resultSummary')}: {value.resultSummary}
                      </p>,
                    ]
                  : [],
              )}
            </SectionCard>
          )}
        </div>
        <div className="siamparkoccupancy:min-w-0 siamparkoccupancy:space-y-6">
          <SectionCard title={t('siampark-occupancy.demo.state')}>
            <div>
              <Badge size="sm" variant={stateBadge[selected.state]}>
                {t(`siampark-occupancy.demo.stateLabels.${selected.state}`)}
              </Badge>
            </div>
            <div className="siamparkoccupancy:flex siamparkoccupancy:flex-wrap siamparkoccupancy:gap-2">
              {selected.state === 'DRAFT' && (
                <Button disabled={busy} onClick={editDraft} size="sm" theme="outlined" variant="secondary">
                  {t(LABEL_EDIT_DRAFT)}
                </Button>
              )}
              {selected.state === 'DRAFT' && (
                <Button
                  disabled={busy}
                  onClick={() => runCommand({ _tag: 'Confirm', occupancyRef: selected.occupancyRef })}
                  size="sm"
                  variant="warning"
                >
                  {t('siampark-occupancy.demo.confirm')}
                </Button>
              )}
              {selected.state === 'CONFIRMED' && (
                <>
                  {isLease && (
                    <a
                      className="siamparkoccupancy:inline-flex siamparkoccupancy:items-center siamparkoccupancy:text-sm siamparkoccupancy:underline siamparkoccupancy:underline-offset-4"
                      href={`/${language}/siampark/agreements`}
                    >
                      {t('siampark-occupancy.demo.contract')}
                    </a>
                  )}
                  <Button disabled={busy} onClick={() => activate(selected)} size="sm" variant="warning">
                    {t('siampark-occupancy.demo.activate')}
                  </Button>
                </>
              )}
              {selected.state === 'ACTIVE' && (
                <Button
                  disabled={busy}
                  onClick={() => runCommand({ _tag: 'Complete', occupancyRef: selected.occupancyRef })}
                  size="sm"
                  variant="warning"
                >
                  {t('siampark-occupancy.demo.complete')}
                </Button>
              )}
              {(selected.state === 'DRAFT' || selected.state === 'CONFIRMED') && (
                <Button
                  disabled={busy}
                  onClick={() => runCommand({ _tag: 'Cancel', occupancyRef: selected.occupancyRef })}
                  size="sm"
                  theme="outlined"
                  variant="danger"
                >
                  {t('siampark-occupancy.demo.cancel')}
                </Button>
              )}
            </div>
          </SectionCard>
          {isLease && <ContractCard contract={contract} language={language} t={t} />}
          <UnitCard language={language} property={property} t={t} unit={unit} />
        </div>
      </div>
      <RentTermsForm state={state} />
    </>
  );
};
const RentTermsForm = ({ state }: { readonly state: ReturnType<typeof useRecordsPage> }) => {
  const { busy, feedback, t } = state;
  if (!state.rentEditorOpen) {
    return null;
  }
  return (
    <SidePanel
      actions={
        <>
          <Button disabled={busy} onClick={() => state.setRentEditorOpen(false)} theme="outlined" variant="secondary">
            {t('siampark-occupancy.demo.close')}
          </Button>
          <Button disabled={busy} isLoading={feedback === 'saving'} onClick={state.saveRentTerms} variant="primary">
            {t('siampark-occupancy.rent.save')}
          </Button>
        </>
      }
      closeLabel={t('siampark-occupancy.demo.close')}
      closeOnInteractOutside={false}
      initialFocusEl={() => globalThis.document.querySelector<HTMLElement>('#occupancy-rent-monthly')}
      onOpenChange={(open) => {
        if (!open && !busy) {
          state.setRentEditorOpen(false);
        }
      }}
      open
      resizeLabel={t('siampark-occupancy.demo.resizePanel')}
      size="md"
      title={t('siampark-occupancy.rent.formTitle')}
    >
      <div className="siamparkoccupancy:space-y-4 siamparkoccupancy:py-2">
        <p className="siamparkoccupancy:text-sm siamparkoccupancy:text-(--color-fg-secondary)">
          {t('siampark-occupancy.rent.formHint')}
        </p>
        {feedback === 'validation' && (
          <output aria-live="polite">{t('siampark-occupancy.demo.feedback.validation')}</output>
        )}
        <RentFields state={state} />
      </div>
    </SidePanel>
  );
};
const RentFields = ({ state }: { readonly state: ReturnType<typeof useRecordsPage> }) => (
  <div className="siamparkoccupancy:grid siamparkoccupancy:gap-4 siamparkoccupancy:md:grid-cols-3">
    <FormInput
      id="occupancy-rent-monthly"
      inputMode="decimal"
      label={state.t('siampark-occupancy.rent.monthlyRentInput')}
      onChange={(event) => state.setRentMonthly(event.target.value)}
      value={state.rentMonthly}
    />
    <FormInput
      id="occupancy-rent-service"
      inputMode="decimal"
      label={state.t('siampark-occupancy.rent.serviceChargesInput')}
      onChange={(event) => state.setRentService(event.target.value)}
      value={state.rentService}
    />
    <FormInput
      id="occupancy-rent-payment-day"
      label={state.t('siampark-occupancy.rent.paymentDayInput')}
      max={31}
      min={1}
      onChange={(event) => state.setRentPaymentDay(event.target.value)}
      type="number"
      value={state.rentPaymentDay}
    />
  </div>
);
const OccupancyDraftForm = ({ state }: { readonly state: ReturnType<typeof useRecordsPage> }) => {
  const {
    busy,
    customerId,
    customerOpen,
    customers,
    customersLoading,
    editingId,
    editor,
    endDate,
    feedback,
    properties,
    setCustomerId,
    setCustomerOpen,
    setEndDate,
    setStartDate,
    setUnitId,
    startDate,
    t,
    unitId,
  } = state;
  if (editor === undefined) {
    return null;
  }
  const { guestId, guestQuery, guests, importBooking, searchGuests, setGuestId, setGuestQuery } = state;
  const panelTitle =
    editor === 'booking'
      ? 'siampark-occupancy.demo.importBooking'
      : editor === 'stay'
        ? 'siampark-occupancy.demo.newBooking'
        : LABEL_EDIT_DRAFT;
  const title = editor === 'lease' && editingId.length === 0 ? 'siampark-occupancy.demo.newLease' : panelTitle;
  const activeUnits = (properties?.units ?? []).filter((record) => record.lifecycleState === 'ACTIVE');
  return (
    <SidePanel
      actions={
        <div className="sp-occupancy-form-actions">
          <Button disabled={busy} onClick={() => state.setEditor(undefined)} theme="outlined" variant="secondary">
            {t('siampark-occupancy.demo.close')}
          </Button>
          {editor === 'lease' ? (
            <Button
              disabled={busy || state.customersLoading}
              isLoading={feedback === 'saving'}
              onClick={state.editingId.length > 0 ? state.saveDraft : state.createDraft}
              variant="primary"
            >
              {t(state.editingId.length > 0 ? 'siampark-occupancy.demo.saveDraft' : LABEL_CREATE)}
            </Button>
          ) : editor === 'stay' ? (
            <Button disabled={busy} isLoading={feedback === 'saving'} onClick={state.createStay} variant="primary">
              Uložit rezervaci
            </Button>
          ) : (
            <>
              <Button disabled={busy} onClick={() => importBooking('FAILED')} theme="outlined" variant="danger">
                {t('siampark-occupancy.demo.simulateFailure')}
              </Button>
              <Button
                disabled={busy}
                isLoading={feedback === 'saving'}
                onClick={() => importBooking('SUCCESS', state.retryObservationId)}
                variant="primary"
              >
                {t('siampark-occupancy.demo.simulateImport')}
              </Button>
            </>
          )}
        </div>
      }
      closeLabel={t('siampark-occupancy.demo.close')}
      closeOnInteractOutside={false}
      initialFocusEl={() => globalThis.document.querySelector<HTMLElement>('#occupancy-start-date')}
      onOpenChange={(open) => {
        if (!open && !busy) {
          state.setEditor(undefined);
        }
      }}
      open
      resizeLabel={t('siampark-occupancy.demo.resizePanel')}
      size="lg"
      title={t(title)}
    >
      <div className="siamparkoccupancy:space-y-4 siamparkoccupancy:py-2">
        {feedback !== 'ready' && (
          <output aria-live="polite">{t(`siampark-occupancy.demo.feedback.${feedback}`)}</output>
        )}
        <div className="siamparkoccupancy:space-y-4">
          {editingId.length === 0 && (
            <div className="siamparkoccupancy:grid siamparkoccupancy:gap-4 siamparkoccupancy:md:grid-cols-2">
              <Select
                items={activeUnits.map((record) => ({ label: record.name, value: record.unitRef.resourceId }))}
                onValueChange={({ value }) => setUnitId(value[0] ?? '')}
                value={unitId.length > 0 ? [unitId] : []}
              >
                <Select.Label>{t(LABEL_UNIT)}</Select.Label>
                <Select.Control>
                  <Select.Trigger>
                    <Select.ValueText placeholder={t(LABEL_CHOOSE)} />
                  </Select.Trigger>
                </Select.Control>
                <Select.Positioner>
                  <Select.Content>
                    {activeUnits.map((record) => (
                      <Select.Item
                        item={{ label: record.name, value: record.unitRef.resourceId }}
                        key={record.unitRef.resourceId}
                      >
                        <Select.ItemText>{record.name}</Select.ItemText>
                        <Select.ItemIndicator />
                      </Select.Item>
                    ))}
                  </Select.Content>
                </Select.Positioner>
              </Select>
              {editor === 'lease' && (
                <div onFocus={() => setCustomerOpen(true)}>
                  <Combobox
                    clearable
                    disabled={busy}
                    footer={state.customersEmpty ? t('siampark-occupancy.demo.customersEmpty') : undefined}
                    items={customers.map((record) => ({
                      label: record.displayName ?? record.partyId,
                      value: record.counterpartyRef.resourceId,
                    }))}
                    label={t('siampark-occupancy.demo.customer')}
                    loading={customersLoading}
                    loadingMessage={t('siampark-occupancy.demo.customersLoading')}
                    name="customer"
                    noResultsMessage={t('siampark-occupancy.demo.customersEmpty')}
                    onChange={(value) => setCustomerId((Array.isArray(value) ? value[0] : value) ?? '')}
                    onOpenChange={setCustomerOpen}
                    open={customerOpen}
                    placeholder={t('siampark-occupancy.demo.customerPlaceholder')}
                    translations={comboboxTranslations}
                    value={customerId.length > 0 ? [customerId] : []}
                  />
                </div>
              )}
            </div>
          )}
          <div className="siamparkoccupancy:grid siamparkoccupancy:gap-4 siamparkoccupancy:md:grid-cols-2">
            <FormInput
              id="occupancy-start-date"
              label={t('siampark-occupancy.demo.startDate')}
              onChange={(event) => setStartDate(event.target.value)}
              type="date"
              value={startDate}
            />
            <FormInput
              id="occupancy-end-date"
              label={t('siampark-occupancy.demo.endDate')}
              onChange={(event) => setEndDate(event.target.value)}
              type="date"
              value={endDate}
            />
          </div>
          {editor === 'lease' && (
            <section className="siamparkoccupancy:space-y-3">
              <h3 className="siamparkoccupancy:text-sm siamparkoccupancy:font-semibold">
                {t('siampark-occupancy.rent.title')}
              </h3>
              <RentFields state={state} />
            </section>
          )}
        </div>
        {(state.editor === 'booking' || state.editor === 'stay') && (
          <section className="siamparkoccupancy:space-y-4">
            <p className="siamparkoccupancy:text-sm siamparkoccupancy:text-(--color-fg-secondary)">
              {state.editor === 'stay'
                ? 'Ruční rezervace bez napojení na rezervační portál. Po uložení ji můžete potvrdit, zahájit, ukončit nebo zrušit. Potvrzení kontroluje kolize termínů.'
                : t('siampark-occupancy.demo.bookingFormContext')}
            </p>
            <div className="siamparkoccupancy:flex siamparkoccupancy:items-end siamparkoccupancy:gap-2">
              <div className="siamparkoccupancy:min-w-0 siamparkoccupancy:flex-1">
                <FormInput
                  id="booking-guest-query"
                  label={t('siampark-occupancy.demo.guestSearch')}
                  onChange={(event) => setGuestQuery(event.target.value)}
                  value={guestQuery}
                />
              </div>
              <Button disabled={busy} onClick={searchGuests} size="sm" theme="outlined" variant="secondary">
                {t('siampark-occupancy.demo.search')}
              </Button>
            </div>
            <Select
              items={guests.map((record) => ({ label: record.title, value: record.ref.resourceId }))}
              onValueChange={({ value }) => setGuestId(value[0] ?? '')}
              value={guestId.length > 0 ? [guestId] : []}
            >
              <Select.Label>{t('siampark-occupancy.demo.guest')}</Select.Label>
              <Select.Control>
                <Select.Trigger>
                  <Select.ValueText placeholder={t(LABEL_CHOOSE)} />
                </Select.Trigger>
              </Select.Control>
              <Select.Positioner>
                <Select.Content>
                  {guests.map((record) => (
                    <Select.Item
                      item={{ label: record.title, value: record.ref.resourceId }}
                      key={record.ref.resourceId}
                    >
                      <Select.ItemText>{record.title}</Select.ItemText>
                      <Select.ItemIndicator />
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select.Positioner>
            </Select>
            {state.editor === 'stay' ? (
              <>
                <FormInput
                  id="stay-people-count"
                  label="Počet osob"
                  type="number"
                  min={1}
                  required
                  value={state.peopleCount}
                  onChange={(event) => state.setPeopleCount(event.target.value)}
                />
                <FormInput
                  id="stay-note"
                  label="Poznámka k rezervaci"
                  maxLength={500}
                  value={state.stayNote}
                  onChange={(event) => state.setStayNote(event.target.value)}
                />
              </>
            ) : (
              <Badge variant="info">{t(LABEL_SIMULATED)}</Badge>
            )}
          </section>
        )}
      </div>
    </SidePanel>
  );
};
const OccupancySummary = ({ state }: { readonly state: ReturnType<typeof useRecordsPage> }) => {
  const leases = state.snapshot?.occupancies.filter((record) => record.kind === 'LONG_TERM_LEASE') ?? [];
  const active = leases.filter((record) => record.state === 'ACTIVE');
  const upcoming = leases.filter((record) => record.state === 'CONFIRMED' || record.state === 'DRAFT');
  const ended = leases.filter((record) => record.state === 'COMPLETED');
  const monthly = active.reduce(
    (sum, record) => sum + (record.rentTerms === undefined ? 0 : monthlyTotal(record.rentTerms)),
    0,
  );
  const withoutRent = active.filter((record) => record.rentTerms === undefined).length;
  return (
    <div className="siamparkoccupancy:grid siamparkoccupancy:gap-4 siamparkoccupancy:sm:grid-cols-2 siamparkoccupancy:xl:grid-cols-4">
      <StatCard label={state.t('siampark-occupancy.list.summaryActive')} value={String(active.length)} />
      <StatCard label={state.t('siampark-occupancy.list.summaryUpcoming')} value={String(upcoming.length)} />
      <StatCard label={state.t('siampark-occupancy.list.summaryEnded')} value={String(ended.length)} />
      <StatCard
        {...(withoutRent > 0 ? { hint: state.t('siampark-occupancy.rent.missing') } : {})}
        label={state.t('siampark-occupancy.list.summaryMonthly')}
        value={active.length === withoutRent ? '—' : formatMoney(monthly)}
      />
    </div>
  );
};
const RecordsPageContent = () => {
  const state = useRecordsPage();
  const [calendarMonth, setCalendarMonth] = useState('');
  const {
    busy,
    feedback,
    kindFilter,
    refresh,

    setKindFilter,
    snapshot,
    t,
    unitName,
    visible,
  } = state;
  return (
    <>
      <UltramodernRouteHead />
      <section className="siamparkoccupancy:w-full siamparkoccupancy:min-w-0 siamparkoccupancy:max-w-none siamparkoccupancy:space-y-6 siamparkoccupancy:p-0 siamparkoccupancy:text-(--color-page-fg)">
        {state.linkedResourceId === undefined ? (
          <>
            <PageHeader
              actions={
                <>
                  <Button
                    disabled={busy || snapshot === undefined}
                    onClick={() => state.newDraft('stay')}
                    size="sm"
                    theme="outlined"
                    variant="secondary"
                  >
                    {t('siampark-occupancy.demo.newBooking')}
                  </Button>
                  <Button
                    disabled={busy || snapshot === undefined}
                    onClick={() => state.newDraft('booking')}
                    size="sm"
                    theme="borderless"
                    variant="secondary"
                  >
                    Simulace importu
                  </Button>
                  <Button
                    disabled={busy || snapshot === undefined}
                    onClick={() => state.newDraft()}
                    size="sm"
                    variant="primary"
                  >
                    {t('siampark-occupancy.demo.newLease')}
                  </Button>
                </>
              }
              description={t('siampark-occupancy.pages.records.description')}
              meta={
                <output aria-live="polite">
                  <Badge
                    size="sm"
                    variant={
                      (
                        {
                          conflict: 'warning',
                          forbidden: 'danger',
                          loading: 'info',
                          ready: 'success',
                          saving: 'info',
                          unavailable: 'danger',
                          validation: 'warning',
                        } as const
                      )[feedback]
                    }
                  >
                    {t(`siampark-occupancy.demo.feedback.${feedback}`)}
                  </Badge>
                </output>
              }
              title={t('siampark-occupancy.pages.records.title')}
            />
            {snapshot !== undefined && <OccupancySummary state={state} />}
            {snapshot !== undefined && state.properties !== undefined && (
              <OccupancyCalendar
                monthValue={calendarMonth}
                onMonthChange={setCalendarMonth}
                language={state.language}
                properties={state.properties}
                snapshot={snapshot}
              />
            )}
            <div className="siamparkoccupancy:flex siamparkoccupancy:flex-wrap siamparkoccupancy:gap-2">
              <LinkButton href="#tenants" size="sm" theme="outlined" variant="secondary">
                Nájemci a kontaktní osoby ↓
              </LinkButton>
              <LinkButton href={`/${state.language}/siampark/overview`} size="sm" theme="outlined" variant="secondary">
                Kalendář a přehled nemovitostí →
              </LinkButton>
            </div>
            <div className="siamparkoccupancy:flex siamparkoccupancy:flex-wrap siamparkoccupancy:items-center siamparkoccupancy:justify-between siamparkoccupancy:gap-4 siamparkoccupancy:border-b siamparkoccupancy:border-(--color-border-muted) siamparkoccupancy:pb-4">
              <div className="siamparkoccupancy:flex siamparkoccupancy:flex-wrap siamparkoccupancy:gap-2">
                {(['ALL', 'LONG_TERM_LEASE', 'SHORT_STAY'] as const).map((kind) => (
                  <Button
                    aria-pressed={kindFilter === kind}
                    key={kind}
                    onClick={() => setKindFilter(kind)}
                    size="sm"
                    theme="borderless"
                    variant={kindFilter === kind ? 'warning' : 'secondary'}
                  >
                    {t(`siampark-occupancy.demo.kind.${kind}`)}
                  </Button>
                ))}
              </div>
              <Button disabled={busy} onClick={refresh} size="sm" theme="outlined" variant="secondary">
                {t('siampark-occupancy.demo.refresh')}
              </Button>
            </div>
            {snapshot !== undefined && visible.length === 0 && (
              <p className="siamparkoccupancy:rounded-lg siamparkoccupancy:bg-(--color-surface-subtle) siamparkoccupancy:p-5 siamparkoccupancy:text-sm siamparkoccupancy:text-(--color-fg-secondary)">
                {t('siampark-occupancy.demo.empty')}
              </p>
            )}
            <div className="siamparkoccupancy:overflow-x-auto siamparkoccupancy:rounded-lg siamparkoccupancy:bg-(--color-surface)">
              <Table size="sm" variant="outline">
                <Table.Caption>{t('siampark-occupancy.demo.list')}</Table.Caption>
                <Table.Header>
                  <Table.Row>
                    <Table.ColumnHeader>{t(LABEL_UNIT)}</Table.ColumnHeader>
                    <Table.ColumnHeader>{t('siampark-occupancy.list.tenant')}</Table.ColumnHeader>
                    <Table.ColumnHeader>{t('siampark-occupancy.demo.period')}</Table.ColumnHeader>
                    <Table.ColumnHeader>{t('siampark-occupancy.rent.column')}</Table.ColumnHeader>
                    <Table.ColumnHeader>{t('siampark-occupancy.demo.state')}</Table.ColumnHeader>
                    <Table.ColumnHeader>{t(LABEL_DETAIL)}</Table.ColumnHeader>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {visible.map((record) => (
                    <Table.Row key={record.occupancyRef.resourceId}>
                      <Table.Cell>
                        <span className="siamparkoccupancy:block siamparkoccupancy:font-medium">
                          {unitName(record.unitRef.resourceId)}
                        </span>
                        <span className="siamparkoccupancy:text-xs siamparkoccupancy:text-(--color-fg-secondary)">
                          {state.propertyOf(record)?.name ?? ''}
                        </span>
                      </Table.Cell>
                      <Table.Cell>{state.tenantOf(record)?.displayName ?? '—'}</Table.Cell>
                      <Table.Cell>
                        {formatDate(record.startDate)} –{' '}
                        {record.endDate === null ? t('siampark-occupancy.demo.openEnd') : formatDate(record.endDate)}
                      </Table.Cell>
                      <Table.Cell>
                        <span className="siamparkoccupancy:tabular-nums">
                          {record.rentTerms === undefined ? '—' : formatMoney(monthlyTotal(record.rentTerms))}
                        </span>
                      </Table.Cell>
                      <Table.Cell>
                        <div className="siamparkoccupancy:flex siamparkoccupancy:flex-wrap siamparkoccupancy:items-center siamparkoccupancy:gap-2">
                          <Badge
                            size="sm"
                            variant={
                              (
                                {
                                  ACTIVE: 'success',
                                  CANCELLED: 'danger',
                                  COMPLETED: 'secondary',
                                  CONFIRMED: 'info',
                                  DRAFT: 'outline',
                                } as const
                              )[record.state]
                            }
                          >
                            {t(`siampark-occupancy.demo.stateLabels.${record.state}`)}
                          </Badge>
                          <span className="siamparkoccupancy:text-(--color-fg-secondary)">
                            {t(`siampark-occupancy.demo.kind.${record.kind}`)}
                          </span>
                        </div>
                      </Table.Cell>
                      <Table.Cell>
                        <LinkButton
                          href={`/${state.language}/siampark/occupancy?resourceId=${record.occupancyRef.resourceId}`}
                          size="sm"
                          theme="outlined"
                          variant="secondary"
                        >
                          {t(LABEL_DETAIL)}
                        </LinkButton>
                      </Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table>
            </div>
            {snapshot !== undefined && (
              <TenantDirectory
                language={state.language}
                snapshot={snapshot}
                tenantOf={state.tenantOf}
                unitName={unitName}
              />
            )}
            <section className="siamparkoccupancy:space-y-4 siamparkoccupancy:rounded-lg siamparkoccupancy:border siamparkoccupancy:border-(--color-border-muted) siamparkoccupancy:bg-(--color-surface) siamparkoccupancy:p-5">
              <h2 className="siamparkoccupancy:text-lg siamparkoccupancy:font-semibold">
                {t('siampark-occupancy.demo.bookingObservations')}
              </h2>
              {snapshot?.bookingObservations.map((value) => (
                <p
                  className="siamparkoccupancy:space-y-2 siamparkoccupancy:break-words siamparkoccupancy:rounded-lg siamparkoccupancy:bg-(--color-surface-subtle) siamparkoccupancy:p-4 siamparkoccupancy:text-sm siamparkoccupancy:text-(--color-fg-secondary)"
                  key={value.observationId}
                >
                  <Badge variant="info">{t(LABEL_SIMULATED)}</Badge> {value.correlation} ·{' '}
                  {t(`siampark-occupancy.demo.bookingStates.${value.state}`)}
                  <br />
                  {t('siampark-occupancy.demo.provider')}: {value.providerLabel} · {value.integrationKind}
                  <br />
                  {t('siampark-occupancy.demo.attemptedAt')}: {value.attemptedAt}
                  {value.completedAt !== null && (
                    <>
                      <br />
                      {t('siampark-occupancy.demo.completedAt')}: {value.completedAt}
                    </>
                  )}
                  <br />
                  {t('siampark-occupancy.demo.ownerReference')}: {value.ownerResourceRef.resourceId}
                  <br />
                  {t('siampark-occupancy.demo.requestSummary')}: {value.requestSummary}
                  <br />
                  {t('siampark-occupancy.demo.resultSummary')}: {value.resultSummary}
                  {value.state !== 'SUCCESS' && (
                    <Button
                      disabled={busy}
                      onClick={() => state.newDraft('booking', value.observationId)}
                      size="sm"
                      variant="warning"
                    >
                      {t('siampark-occupancy.demo.retry')}
                    </Button>
                  )}
                </p>
              ))}
            </section>
          </>
        ) : (
          <OccupancyDetail state={state} />
        )}
        <OccupancyDraftForm state={state} />
      </section>
    </>
  );
};
export const RecordsPage = () => {
  const search = useRouterState({ select: (state) => state.location.searchStr });
  return (
    <FederatedI18nBoundary
      defaultNamespace="siampark-occupancy"
      fallbackLanguage="en"
      resources={siamparkOccupancyI18nResources}
      supportedLanguages={['en', 'cs']}
    >
      <RecordsPageContent key={search} />
    </FederatedI18nBoundary>
  );
};
export default RecordsPage;
