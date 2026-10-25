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
  surfaceCardClassName,
  surfaceTileClassName,
} from '@app/admin-ui';
import { Combobox } from '@techsio/ui-kit/molecules/combobox';
import { failureFeedback } from '../../../../shared/actions/apply-command.ts';
import { browserRuntime } from '../../../runtime/browser-effect-runtime.ts';
import { makeReferenceGatewayCredentials } from '@app/shared-contracts';
import { definePageData, modulePagePreload, pageDataPending } from '@app/shared-contracts/page-data';
import type { ModulePageProps, PageDataSnapshot } from '@app/shared-contracts/page-data';
import {
  createCustomer,
  executeCounterpartyRead,
  executePartyDetail,
  listCustomers,
  loadPartiesClient,
} from '@app/party-registry/api/client';
import { PartyDocuments, PropertyEquipment } from '@app/facility-operations/ui/record-discussion';
import { executeRecords as executePropertyRecords } from '@app/property-portfolio/clients/records';
import { executeRecords as executeAgreementsRecords } from '@app/legal-agreements/clients/records';
import { executeRecords as executeFinanceRecords } from '@app/finance-billing/clients/records';
import { executeRecords as executeWorkRecords } from '@app/work-tasks/clients/records';
import { FederatedI18nBoundary, useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useRouterState } from '@modern-js/plugin-tanstack/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { Select } from '@techsio/ui-kit/molecules/select';
import { Table } from '@techsio/ui-kit/organisms/table';
import { Crypto, DateTime, Effect, Match, Option, PlatformError, Predicate } from 'effect';
import { useEffect, useEffectEvent, useRef, useState, useSyncExternalStore } from 'react';

import type { OccupancyCommand, Feedback } from '../../../../shared/actions/apply-command.ts';
import type { Occupancy, RecordsResponse, RentTerms } from '../../../../shared/apis/records.ts';
import { decodeRecordsSearch } from '../../../../shared/apis/records-search.ts';
import type { RecordsSearch } from '../../../../shared/apis/records-search.ts';
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
import { executeApplyCommand } from '../../../api/apply-command-action-client.ts';
import { executeRecords } from '../../../api/records-client.ts';
import { UltramodernRouteHead } from '../../ultramodern-route-head';
import csResource from '../../../../locales/cs/property-leasing.json';
import enResource from '../../../../locales/en/property-leasing.json';
import '../../index.css';
import { TenantDirectory, TenantDossierCard } from './tenant-dossier.tsx';
import type { DossierChanges, NewCounterpartyInput } from './tenant-dossier.tsx';
import { CounterpartyDossierView } from './counterparty-dossier.tsx';
import { NoticeCard, OccupancyHistoryCard, RegistrationSheetCard } from './stay-documents.tsx';
import type { NoticeContext } from './notice-templates.ts';
import { OccupancyCalendar } from './occupancy-calendar.tsx';
import './occupancy-form.css';

const LABEL_CHOOSE = 'property-leasing.demo.choose';
const LABEL_UNIT = 'property-leasing.demo.unit';
const LABEL_DETAIL = 'property-leasing.demo.detail';
const currentPragueDay = () =>
  new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Prague',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(DateTime.toEpochMillis(DateTime.nowUnsafe()));
const DEFAULT_START_DATE = currentPragueDay();
const DEFAULT_END_DATE = '';
const LABEL_EDIT_DRAFT = 'property-leasing.demo.editDraft';
const LABEL_CREATE = 'property-leasing.demo.create';
const propertyLeasingI18nResources = {
  cs: { 'property-leasing': csResource },
  en: { 'property-leasing': enResource },
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
const loadOccupantName = Effect.fn('Occupancy.loadOccupantName')(function* resolveOccupantName(
  record: Occupancy | undefined,
) {
  if (record === undefined) {
    return Option.none<string>();
  }
  if (record.customerCounterpartyRef !== null) {
    const customer = yield* executeCounterpartyRead(
      { counterpartyRef: record.customerCounterpartyRef },
      'property-leasing.customer-detail',
    );
    return Option.fromNullishOr(customer.party.displayName);
  }
  if (record.guestPartyRef !== null) {
    const guest = yield* executePartyDetail({ partyRef: record.guestPartyRef }, 'property-leasing.guest-detail');
    return guest.party.displayName;
  }
  return Option.none<string>();
});
interface LeaseInput {
  readonly legalEntityId: string;
}
interface LeaseDetailInput extends LeaseInput {
  readonly resourceId: string;
}
const leaseInputOf = (context: ModulePageProps['context']): LeaseInput => ({
  legalEntityId: context?.legalEntityId ?? '',
});
/** Guest names of short stays for the list column; a guest the role cannot read stays unnamed. */
const loadGuestNames = (records: RecordsResponse) =>
  Effect.forEach(
    [
      ...new Map(
        records.occupancies.flatMap((record) =>
          record.guestPartyRef === null ? [] : [[record.guestPartyRef.resourceId, record.guestPartyRef] as const],
        ),
      ).values(),
    ],
    (partyRef) =>
      executePartyDetail({ partyRef }, 'property-leasing.guest-names').pipe(
        Effect.map((detail) => [partyRef.resourceId, Option.getOrUndefined(detail.party.displayName)] as const),
        Effect.orElseSucceed(() => [partyRef.resourceId, undefined] as const),
      ),
    { concurrency: 4 },
  ).pipe(
    Effect.map((entries): Readonly<Record<string, string>> =>
      Object.fromEntries(entries.flatMap(([id, name]) => (name === undefined ? [] : [[id, name]]))),
    ),
  );
const loadLeaseRecords = Effect.fn('PropertyLeasing.loadLeaseRecords')(function* loadLeaseRecordsData() {
  const { agreements, directory, properties, records } = yield* Effect.all(
    {
      agreements: executeAgreementsRecords({}, 'property-leasing.contracts'),
      // The tenant column and card are optional: a role without the customer list still sees its leases.
      directory: listCustomers({ includeArchived: true, limit: 500 }).pipe(Effect.option),
      properties: executePropertyRecords({}, 'property-leasing.units'),
      records: executeRecords({}, 'property-leasing.records'),
    },
    { concurrency: 4 },
  );
  const guestNames = yield* loadGuestNames(records);
  const tenantDirectory: readonly TenantDirectoryEntry[] = Option.getOrElse(directory, () => []);
  return { agreements, guestNames, properties, records, tenantDirectory };
});
/** Primary data of the page: leases and stays, units, contracts, the tenant directory and guest names. */
const leaseRecords = definePageData({
  key: (input: LeaseInput) => input.legalEntityId,
  load: () => loadLeaseRecords(),
  runtime: browserRuntime,
});
/** Name of the tenant or guest of the lease or stay opened by URL. */
const leaseOccupant = definePageData({
  key: (input: LeaseDetailInput) => `${input.legalEntityId}:${input.resourceId}`,
  load: (input: LeaseDetailInput) =>
    leaseRecords.preload(input).pipe(
      Effect.andThen(() => {
        const current = leaseRecords.snapshot(input);
        return loadOccupantName(
          current.state === 'ready'
            ? current.value.records.occupancies.find((record) => record.occupancyRef.resourceId === input.resourceId)
            : undefined,
        );
      }),
      Effect.map(Option.getOrUndefined),
    ),
  runtime: browserRuntime,
});
export const preloadPage = modulePagePreload(
  (props) => leaseRecords.preload(leaseInputOf(props.context)),
  (props) => {
    const resourceId = Option.getOrUndefined(decodeRecordsSearch(props.search))?.resourceId;
    return resourceId === undefined
      ? Effect.void
      : leaseOccupant.preload({ ...leaseInputOf(props.context), resourceId });
  },
);
type FailureLike = Parameters<typeof failureFeedback>[0];
const loadFeedbackOf = <A, E extends FailureLike>(snapshot: PageDataSnapshot<A, E>): Feedback => {
  if (snapshot.state === 'pending') {
    return 'loading';
  }
  return snapshot.state === 'failed' ? failureFeedback(snapshot.error) : 'ready';
};
/** Reads the page's data and the opened record's occupant from their stores; a cold mount starts their loads. */
const useLeaseData = (context: ModulePageProps['context'], search: Option.Option<RecordsSearch>) => {
  const legalEntityId = context?.legalEntityId ?? '';
  const resourceId = Option.getOrUndefined(search)?.resourceId;
  const leaseInput: LeaseInput = { legalEntityId };
  const detailInput: LeaseDetailInput | undefined =
    resourceId === undefined ? undefined : { legalEntityId, resourceId };
  const records = useSyncExternalStore(
    leaseRecords.subscribe,
    () => leaseRecords.snapshot(leaseInput),
    () => pageDataPending,
  );
  const occupant = useSyncExternalStore(
    leaseOccupant.subscribe,
    () => (detailInput === undefined ? pageDataPending : leaseOccupant.snapshot(detailInput)),
    () => pageDataPending,
  );
  useEffect(() => {
    leaseRecords.ensure({ legalEntityId });
    if (resourceId !== undefined) {
      leaseOccupant.ensure({ legalEntityId, resourceId });
    }
  }, [legalEntityId, resourceId]);
  return { detailInput, leaseInput, occupant, records };
};
/** What the page shows from its data; a read that refused this role hides the loaded records. */
const leaseViewOf = <E1 extends FailureLike, E2 extends FailureLike>(
  records: PageDataSnapshot<Effect.Success<ReturnType<typeof loadLeaseRecords>>, E1>,
  occupant: PageDataSnapshot<string | undefined, E2>,
  cleared: boolean,
) => {
  const loaded = records.state === 'ready' && !cleared ? records.value : undefined;
  return {
    agreements: loaded?.agreements,
    customerName: occupant.state === 'ready' ? occupant.value : undefined,
    customerNameFeedback: occupant.state === 'failed' ? failureFeedback(occupant.error) : undefined,
    customerNamePending: occupant.state === 'pending',
    directoryLoaded: loaded !== undefined,
    guestNames: loaded?.guestNames ?? {},
    properties: loaded?.properties,
    snapshot: loaded?.records,
    tenantDirectory: loaded?.tenantDirectory ?? [],
  };
};
const useRecordsPage = (context: ModulePageProps['context']) => {
  const { language, t } = useModernI18n();
  const searchStr = useRouterState({ select: (state) => state.location.searchStr });
  const search = decodeRecordsSearch(searchStr);
  const linkedResourceId = Option.getOrUndefined(search)?.resourceId;
  const { detailInput, leaseInput, occupant, records } = useLeaseData(context, search);
  const linkedCounterpartyId = Option.getOrUndefined(search)?.counterpartyId;
  const cancellation = useRef<AbortController | null>(null);
  const run = <A, E>(effect: Effect.Effect<A, E>) => {
    const controller = cancellation.current ?? new AbortController();
    cancellation.current = controller;
    void browserRuntime.runPromiseExit(effect, { signal: controller.signal });
  };
  /** Set when a read refused this role: the loaded records stay hidden until the next refresh. */
  const [cleared, setCleared] = useState(false);
  const {
    agreements,
    customerName,
    customerNameFeedback,
    customerNamePending,
    directoryLoaded,
    guestNames,
    properties,
    snapshot,
    tenantDirectory,
  } = leaseViewOf(records, occupant, cleared);
  const [customers, setCustomers] = useState<Customers>([]);
  const [guests, setGuests] = useState<Guests>([]);
  const [guestId, setGuestId] = useState('');
  const [guestQuery, setGuestQuery] = useState('');
  const [peopleCount, setPeopleCount] = useState('2');
  const [stayNote, setStayNote] = useState('');
  /** Outcome of the person's own action; the page's read state shows when there is none. */
  const [actionFeedback, setActionFeedback] = useState<Feedback>();
  const feedback: Feedback = actionFeedback ?? (cleared ? 'forbidden' : loadFeedbackOf(records));
  const [unitId, setUnitId] = useState('');
  const [customerId, setCustomerId] = useState('');
  const [customersLoading, setCustomersLoading] = useState(false);
  const [customerOpen, setCustomerOpen] = useState(false);
  const [editor, setEditor] = useState<'lease' | 'stay'>();
  const [startDate, setStartDate] = useState(DEFAULT_START_DATE);
  const [endDate, setEndDate] = useState(DEFAULT_END_DATE);
  const [editingId, setEditingId] = useState('');
  const [kindFilter, setKindFilter] = useState<'ALL' | 'LONG_TERM_LEASE' | 'SHORT_STAY'>('ALL');
  const [collision, setCollision] = useState<{ readonly text: string; readonly href: string }>();
  const [createError, setCreateError] = useState<string>();
  const [related, setRelated] = useState<LeaseRelated>({ invoices: undefined, tasks: undefined });
  const [rentMonthly, setRentMonthly] = useState('');
  const [rentService, setRentService] = useState('');
  const [rentPaymentDay, setRentPaymentDay] = useState('15');
  const [rentEditorOpen, setRentEditorOpen] = useState(false);
  const selected = snapshot?.occupancies.find((record) => record.occupancyRef.resourceId === linkedResourceId);
  const clearSensitiveState = () => {
    setEditor(undefined);
    setCustomersLoading(false);
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
    setRelated({ invoices: undefined, tasks: undefined });
    setRentEditorOpen(false);
  };
  const reportFailure = (failure: { readonly _tag: string; readonly status?: number }) => {
    const nextFeedback = failureFeedback(failure);
    if (nextFeedback === 'forbidden' || nextFeedback === 'unavailable') {
      cancellation.current?.abort();
      cancellation.current = new AbortController();
      clearSensitiveState();
      setCleared(true);
    }
    setActionFeedback(nextFeedback);
  };
  const loadRelated = (record: Occupancy) =>
    Effect.all(
      {
        invoices: executeFinanceRecords({}, 'property-leasing.lease-invoices').pipe(
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
        tasks: executeWorkRecords({ contextResourceId: record.unitRef.resourceId }, 'property-leasing.unit-tasks').pipe(
          Effect.map((value) => value.items),
          Effect.orElseSucceed(() => 'unavailable' as const),
        ),
      },
      { concurrency: 2 },
    ).pipe(Effect.tap((value) => Effect.sync(() => setRelated(value))));
  /** Re-reads the page's data after the person's own write; the loaded values stay on screen meanwhile. */
  const reload = () =>
    Effect.all(
      [leaseRecords.refresh(leaseInput), detailInput === undefined ? Effect.void : leaseOccupant.refresh(detailInput)],
      { concurrency: 2, discard: true },
    );
  const refresh = () => {
    cancellation.current?.abort();
    cancellation.current = new AbortController();
    clearSensitiveState();
    setCleared(false);
    setActionFeedback(undefined);
    run(reload());
  };
  const loadRelatedOf = useEffectEvent((record: Occupancy) => {
    run(loadRelated(record));
  });
  // Invoices and tasks of the opened lease are secondary: they load once the lease itself is on screen, and again
  // whenever its records are re-read.
  useEffect(() => {
    if (selected !== undefined) {
      loadRelatedOf(selected);
    }
  }, [selected]);
  useEffect(
    () => () => {
      cancellation.current?.abort();
    },
    [],
  );
  /** S10-01: names the confirmed stay or lease that blocks the second confirmation of the same unit. */
  const collisionFor = (command: OccupancyCommand) => {
    if (snapshot === undefined || (!Predicate.isTagged(command, 'Confirm') && !Predicate.isTagged(command, 'Activate')))
      return undefined;
    const record = snapshot.occupancies.find(
      (item) => item.occupancyRef.resourceId === command.occupancyRef.resourceId,
    );
    if (record === undefined) return undefined;
    const other = snapshot.occupancies.find(
      (item) =>
        item.occupancyRef.resourceId !== record.occupancyRef.resourceId &&
        item.unitRef.resourceId === record.unitRef.resourceId &&
        (item.state === 'CONFIRMED' || item.state === 'ACTIVE') &&
        (item.endDate === null || record.startDate < item.endDate) &&
        (record.endDate === null || item.startDate < record.endDate),
    );
    if (other === undefined) return undefined;
    const party =
      other.customerCounterpartyRef === null
        ? other.guestPartyRef === null
          ? undefined
          : guestNames[other.guestPartyRef.resourceId]
        : (tenantDirectory.find((item) => item.counterpartyRef.resourceId === other.customerCounterpartyRef?.resourceId)
            ?.displayName ?? undefined);
    const unit = properties?.units.find((item) => item.unitRef.resourceId === other.unitRef.resourceId)?.name;
    return {
      href: `/${language}/najmy?resourceId=${other.occupancyRef.resourceId}`,
      text: `Termínová kolize: jednotka ${unit ?? ''} je v období ${formatDate(other.startDate)} – ${
        other.endDate === null ? 'bez konce' : formatDate(other.endDate)
      } již ${other.state === 'ACTIVE' ? 'obsazena' : 'potvrzeně rezervována'} (${
        other.kind === 'LONG_TERM_LEASE' ? 'nájem' : 'pobyt'
      }${party === undefined ? '' : ` – ${party}`}). ${Match.value(command).pipe(
        Match.tag('Confirm', () => 'Potvrzení'),
        Match.tag('Activate', () => 'Zahájení'),
        Match.exhaustive,
      )} bylo odmítnuto, tento záznam zůstává ve stavu ${t(`property-leasing.demo.stateLabels.${record.state}`)}.`,
    };
  };
  const runCommand = (command: OccupancyCommand) => {
    if (snapshot === undefined) {
      return;
    }
    setCollision(undefined);
    setActionFeedback('saving');
    run(
      Effect.all(
        {
          idempotencyKey: newUuid,
          referenceCredentials: makeReferenceGatewayCredentials([
            'property-portfolio',
            'property-portfolio',
            'party-registry',
            'legal-agreements',
          ]),
        },
        { concurrency: 2 },
      ).pipe(
        Effect.flatMap(({ idempotencyKey, referenceCredentials }) =>
          executeApplyCommand({ command, expectedRevision: snapshot.revision }, 'property-leasing.command', {
            idempotencyKey,
            referenceCredentials,
          }),
        ),
        Effect.tap(() => reload()),
        Effect.tap((result) => {
          const current = leaseRecords.snapshot(leaseInput);
          const record =
            current.state === 'ready'
              ? current.value.records.occupancies.find(
                  (item) => item.occupancyRef.resourceId === result.resourceRef?.resourceId,
                )
              : undefined;
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
          // A refused command keeps the loaded records on screen; only reads clear them.
          onFailure: (failure) => {
            const next = failureFeedback(failure);
            setCollision(next === 'conflict' ? collisionFor(command) : undefined);
            setActionFeedback(next);
          },
          onSuccess: () => setActionFeedback(undefined),
        }),
      ),
    );
  };
  const updateCounterpartyDossier = (counterpartyId: string) => (changes: DossierChanges) => {
    const entry = tenantDirectory.find((item) => item.counterpartyRef.resourceId === counterpartyId);
    if (entry !== undefined)
      runCommand({ _tag: 'UpdateCounterpartyDossier', counterpartyRef: entry.counterpartyRef, ...changes });
  };
  /** S01-01: a firm or person becomes a counterparty of this company with its first timeline note. */
  const createCounterparty = (input: NewCounterpartyInput) => {
    if (snapshot === undefined) return;
    setCreateError(undefined);
    setActionFeedback('saving');
    run(
      createCustomer({
        partyType: input.partyType,
        displayName: input.displayName.trim(),
        ...(input.partyType === 'ORGANIZATION' && input.companyId.trim() !== ''
          ? { companyId: input.companyId.trim() }
          : {}),
        email: input.email.trim(),
        phone: input.phone.trim(),
        evidenceReference: 'Siampark – evidence nájemců a zájemců',
      }).pipe(
        Effect.flatMap((created) =>
          Effect.all(
            {
              idempotencyKey: newUuid,
              referenceCredentials: makeReferenceGatewayCredentials(['party-registry']),
            },
            { concurrency: 2 },
          ).pipe(
            Effect.flatMap(({ idempotencyKey, referenceCredentials }) =>
              executeApplyCommand(
                {
                  command: {
                    _tag: 'UpdateCounterpartyDossier',
                    counterpartyRef: created.counterpartyRef,
                    activity: {
                      kind: 'NOTE',
                      summary:
                        input.note.trim() === ''
                          ? `${input.partyType === 'PERSON' ? 'Osoba' : 'Firma'} založena jako protistrana Siampark.`
                          : input.note.trim(),
                    },
                  },
                  expectedRevision: snapshot.revision,
                },
                'property-leasing.counterparty-create',
                { idempotencyKey, referenceCredentials },
              ),
            ),
            Effect.as(created),
          ),
        ),
        Effect.match({
          onFailure: (failure) => {
            const status = 'status' in failure && typeof failure.status === 'number' ? failure.status : undefined;
            setCreateError(
              status === 403
                ? 'Pro zakládání protistran nemáte oprávnění.'
                : Predicate.isTagged(failure, 'CustomerCreateAmbiguous')
                  ? 'Protistrana se shoduje s více existujícími záznamy. Vyřešte shodu v registru zákazníků.'
                  : 'Protistranu se nepodařilo uložit. Zkontrolujte údaje a zkuste to znovu.',
            );
            setActionFeedback(status === 403 ? 'forbidden' : undefined);
          },
          onSuccess: (created) => {
            const url = new URL(window.location.href);
            url.search = '';
            url.searchParams.set('counterpartyId', created.counterpartyRef.resourceId);
            url.hash = 'tenant';
            window.location.assign(url);
          },
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
      setActionFeedback('validation');
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
      setActionFeedback('validation');
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
                  moduleId: 'property.leasing',
                  resourceId,
                  resourceType: 'property.leasing.occupancy',
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
      setActionFeedback('validation');
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
                  moduleId: 'property.leasing',
                  resourceId,
                  resourceType: 'property.leasing.occupancy',
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
  const newDraft = (mode: 'lease' | 'stay' = 'lease') => {
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
      setActionFeedback('validation');
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
      setActionFeedback('validation');
      return;
    }
    run(
      loadPartiesClient({ includeArchived: false, query: guestQuery }, 'property-leasing.guest-picker').pipe(
        Effect.match({
          onFailure: reportFailure,
          onSuccess: (values) => {
            setGuests(values);
            setGuestId('');
            setActionFeedback(undefined);
          },
        }),
      ),
    );
  };
  const unitName = (resourceId: string) =>
    properties?.units.find((record) => record.unitRef.resourceId === resourceId)?.name ?? resourceId;
  const [showCancelled, setShowCancelled] = useState(false);
  const cancelledCount = snapshot?.occupancies.filter((record) => record.state === 'CANCELLED').length ?? 0;
  // Cancelled stays and leases keep their audit but do not crowd the working list unless asked for.
  const visible =
    snapshot?.occupancies.filter(
      (record) =>
        (kindFilter === 'ALL' || record.kind === kindFilter) && (showCancelled || record.state !== 'CANCELLED'),
    ) ?? [];
  const tenantOf = (record: Occupancy | undefined) =>
    record?.customerCounterpartyRef === null || record === undefined
      ? undefined
      : tenantDirectory.find((item) => item.counterpartyRef.resourceId === record.customerCounterpartyRef?.resourceId);
  /** Tenant of a lease or guest of a stay, for list rows. */
  const partyNameOf = (record: Occupancy) =>
    record.guestPartyRef === null ? tenantOf(record)?.displayName : guestNames[record.guestPartyRef.resourceId];
  // Owner decides; older owner builds without the flag keep the previous behaviour.
  const canWrite = snapshot?.canWrite !== false;
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
    canWrite,
    cancelledCount,
    showCancelled,
    setShowCancelled,
    collision,
    createCounterparty,
    createError,
    directoryLoaded,
    linkedCounterpartyId,
    partyNameOf,
    tenantDirectory,
    updateCounterpartyDossier,
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
    customerNamePending,
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
    kindFilter,
    language,
    linkedResourceId,
    newDraft,
    properties,
    refresh,
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
          className="propertyleasing:inline-flex propertyleasing:text-sm propertyleasing:underline"
          href={`/${language}/najmy`}
        >
          {t('property-leasing.detail.back')}
        </a>
        <PageHeader title={t(LABEL_DETAIL)} />
        {feedback !== 'loading' && (
          <output aria-live="polite">
            {t(
              feedback === 'ready' ? 'property-leasing.detail.notFound' : `property-leasing.demo.feedback.${feedback}`,
            )}
          </output>
        )}
      </>
    );
  }
  const customerLabel =
    customerName ?? (state.customerNamePending ? '—' : t('property-leasing.detail.customerUnknown'));
  const unit = state.unitOf(selected);
  const property = state.propertyOf(selected);
  const tenant = state.tenantOf(selected);
  const contract = leaseContract(selected, state.agreements?.contracts);
  const tasks = loadedList(state.related.tasks);
  const invoices = loadedList(state.related.invoices);
  const isLease = selected.kind === 'LONG_TERM_LEASE';
  const canEditRent =
    state.canWrite &&
    isLease &&
    (selected.state === 'DRAFT' || selected.state === 'CONFIRMED' || selected.state === 'ACTIVE');
  const firstInvoice = invoices[0];
  const partyName = (isLease ? tenant?.displayName : undefined) ?? customerName ?? customerLabel;
  const noticeContext: NoticeContext = {
    partyName,
    propertyAddress: property?.address ?? '',
    propertyLabel: property?.name ?? '',
    record: selected,
    unitLabel: unitName(selected.unitRef.resourceId),
  };
  const occupancyId = selected.occupancyRef.resourceId;
  const tenantDossier = snapshot?.tenantDossiers?.find(
    (item) => item.counterpartyId === selected.customerCounterpartyRef?.resourceId,
  );
  return (
    <>
      <div>
        <LinkButton
          href={`/${language}/najmy`}
          icon="icon-[mdi--arrow-left]"
          size="sm"
          theme="borderless"
          variant="secondary"
        >
          {t('property-leasing.detail.back')}
        </LinkButton>
      </div>
      <PageHeader
        description={[
          t(`property-leasing.demo.kind.${selected.kind}`),
          property?.name,
          `${formatDate(selected.startDate)} – ${
            selected.endDate === null ? t('property-leasing.demo.openEnd') : formatDate(selected.endDate)
          }`,
        ]
          .filter((part) => part !== undefined)
          .join(' · ')}
        meta={
          <Badge size="sm" variant={stateBadge[selected.state]}>
            {t(`property-leasing.demo.stateLabels.${selected.state}`)}
          </Badge>
        }
        title={`${unitName(selected.unitRef.resourceId)}${tenant?.displayName == null ? '' : ` · ${tenant.displayName}`}`}
      />
      {feedback !== 'ready' && feedback !== 'loading' && (
        <output aria-live="polite" className="sp-occupancy-feedback">
          {state.collision === undefined ? t(`property-leasing.demo.feedback.${feedback}`) : state.collision.text}
          {state.collision !== undefined && (
            <>
              {' '}
              <a href={state.collision.href}>Otevřít kolidující záznam →</a>
            </>
          )}
        </output>
      )}
      {!state.canWrite && (
        <p className="propertyleasing:text-sm propertyleasing:text-(--color-fg-secondary)">
          Máte oprávnění tento záznam pouze číst. Změny provádí vedení, provoz nebo obchod.
        </p>
      )}
      {isLease && (
        <LeaseStoryNav
          steps={[
            {
              href:
                property === undefined
                  ? undefined
                  : `/${language}/nemovitosti?resourceId=${property.propertyRef.resourceId}`,
              label: t('property-leasing.story.property'),
              value: property?.name,
            },
            {
              href: `/${language}/nemovitosti?resourceId=${selected.unitRef.resourceId}`,
              label: t('property-leasing.story.unit'),
              value: unitName(selected.unitRef.resourceId),
            },
            {
              href: `/${language}/najmy?resourceId=${selected.occupancyRef.resourceId}#tenant`,
              label: t('property-leasing.story.tenant'),
              value: tenant?.displayName ?? customerName,
            },
            {
              href:
                contract === undefined
                  ? undefined
                  : `/${language}/smlouvy?resourceId=${contract.contractRef.resourceId}`,
              label: t('property-leasing.story.contract'),
              value:
                contract === undefined
                  ? t('property-leasing.related.notProvided')
                  : t(`property-leasing.related.contractStates.${contract.lifecycleState}`),
            },
            {
              current: true,
              label: t('property-leasing.story.lease'),
              value:
                selected.rentTerms === undefined
                  ? t(`property-leasing.demo.stateLabels.${selected.state}`)
                  : t('property-leasing.rent.perMonth', { amount: formatMoney(monthlyTotal(selected.rentTerms)) }),
            },
            {
              href: `/${language}/ukoly`,
              label: t('property-leasing.story.tasks'),
              value:
                state.related.tasks === 'unavailable' ? t('property-leasing.story.unavailable') : String(tasks.length),
            },
            {
              href:
                firstInvoice === undefined
                  ? undefined
                  : `/${language}/finance?resourceId=${firstInvoice.ref.resourceId}`,
              label: t('property-leasing.story.invoice'),
              value:
                firstInvoice === undefined
                  ? t('property-leasing.related.notProvided')
                  : (firstInvoice.number ?? firstInvoice.documentNumber),
            },
          ]}
          t={t}
        />
      )}
      <div className="propertyleasing:grid propertyleasing:grid-cols-1 propertyleasing:items-start propertyleasing:gap-6 propertyleasing:xl:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="propertyleasing:min-w-0 propertyleasing:space-y-6">
          {isLease && (
            <RentTermsCard
              action={
                canEditRent ? (
                  <Button disabled={busy} onClick={state.openRentEditor} size="sm" theme="outlined" variant="secondary">
                    {t(selected.rentTerms === undefined ? 'property-leasing.rent.set' : 'property-leasing.rent.edit')}
                  </Button>
                ) : undefined
              }
              contract={contract}
              record={selected}
              t={t}
            />
          )}
          <div className="propertyleasing:grid propertyleasing:gap-6 propertyleasing:md:grid-cols-2">
            <SectionCard title={t('property-leasing.detail.lease')}>
              <DetailList
                items={[
                  { label: t(LABEL_UNIT), value: unitName(selected.unitRef.resourceId) },
                  {
                    label: t('property-leasing.detail.type'),
                    value: t(`property-leasing.demo.kind.${selected.kind}`),
                  },
                  { label: t('property-leasing.demo.startDate'), value: formatDate(selected.startDate) },
                  ...(!isLease ? [{ label: 'Počet osob', value: String(selected.peopleCount ?? 'Neuvedeno') }] : []),
                  {
                    label: t('property-leasing.demo.endDate'),
                    value:
                      selected.endDate === null ? t('property-leasing.demo.openEnd') : formatDate(selected.endDate),
                  },
                ]}
              />
            </SectionCard>
            {isLease ? (
              <TenantCard
                fallbackName={customerLabel}
                language={language}
                t={t}
                tenant={tenant}
                title={t('property-leasing.related.tenantCard')}
              />
            ) : (
              <SectionCard title={t('property-leasing.demo.guest')}>
                <DetailList
                  items={[
                    {
                      label: t('property-leasing.detail.customerName'),
                      value: customerLabel,
                    },
                  ]}
                />
              </SectionCard>
            )}
          </div>
          {isLease && snapshot !== undefined && (
            <TenantDossierCard
              busy={busy}
              canWrite={state.canWrite}
              counterpartyName={tenant?.displayName ?? customerLabel}
              leaseHref={
                selected.customerCounterpartyRef === null
                  ? undefined
                  : `/${language}/najmy?counterpartyId=${selected.customerCounterpartyRef.resourceId}#tenant`
              }
              contractHref={
                contract === undefined
                  ? undefined
                  : `/${language}/smlouvy?resourceId=${contract.contractRef.resourceId}`
              }
              taskHref={tasks[0] === undefined ? undefined : `/${language}/ukoly?resourceId=${tasks[0].ref.resourceId}`}
              dossier={snapshot.tenantDossiers?.find(
                (item) => item.counterpartyId === selected.customerCounterpartyRef?.resourceId,
              )}
              key={`tenant:${snapshot.revision}`}
              newContactId={newUuid}
              onUpdate={(changes) =>
                state.runCommand({ _tag: 'UpdateTenantDossier', occupancyRef: selected.occupancyRef, ...changes })
              }
            />
          )}
          {customerNameFeedback !== undefined && (
            <p className="propertyleasing:text-sm propertyleasing:text-(--color-fg-secondary)">
              {t('property-leasing.detail.customerUnavailable')}{' '}
              {t(`property-leasing.demo.feedback.${customerNameFeedback}`)}
            </p>
          )}
          {isLease && <InvoicesCard invoices={state.related.invoices} language={language} t={t} />}
          {isLease && selected.customerCounterpartyRef !== null && (
            <SectionCard title="Dokumenty nájemce">
              <PartyDocuments
                counterpartyId={selected.customerCounterpartyRef.resourceId}
                label={tenant?.displayName ?? customerLabel}
                language={language}
              />
            </SectionCard>
          )}
          <TasksCard language={language} t={t} tasks={state.related.tasks} />
          {snapshot !== undefined && (
            <RegistrationSheetCard
              busy={busy}
              canWrite={state.canWrite}
              context={noticeContext}
              key={`sheet:${snapshot.revision}`}
              newId={newUuid}
              onCommand={runCommand}
              sheets={(snapshot.registrationSheets ?? []).filter((sheet) => sheet.occupancyId === occupancyId)}
            />
          )}
          {snapshot !== undefined && (
            <NoticeCard
              busy={busy}
              canWrite={state.canWrite}
              context={noticeContext}
              defaultEmail={
                tenant?.email ?? tenantDossier?.contacts.find((contact) => contact.email !== '')?.email ?? ''
              }
              defaultPhone={
                tenant?.phone ?? tenantDossier?.contacts.find((contact) => contact.phone !== '')?.phone ?? ''
              }
              key={`notice:${snapshot.revision}`}
              newId={newUuid}
              notices={(snapshot.preparedNotices ?? []).filter((notice) => notice.occupancyId === occupancyId)}
              onCommand={runCommand}
            />
          )}
          {selected.note !== null && (
            <SectionCard title={t('property-leasing.detail.note')}>
              <p className="propertyleasing:whitespace-pre-wrap propertyleasing:text-sm">{selected.note}</p>
            </SectionCard>
          )}
        </div>
        <div className="propertyleasing:min-w-0 propertyleasing:space-y-6">
          <SectionCard title={t('property-leasing.demo.state')}>
            <div>
              <Badge size="sm" variant={stateBadge[selected.state]}>
                {t(`property-leasing.demo.stateLabels.${selected.state}`)}
              </Badge>
            </div>
            <div
              className="propertyleasing:flex propertyleasing:flex-wrap propertyleasing:gap-2"
              hidden={!state.canWrite}
            >
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
                  {t('property-leasing.demo.confirm')}
                </Button>
              )}
              {selected.state === 'CONFIRMED' && (
                <>
                  {isLease && (
                    <a
                      className="propertyleasing:inline-flex propertyleasing:items-center propertyleasing:text-sm propertyleasing:underline propertyleasing:underline-offset-4"
                      href={`/${language}/smlouvy`}
                    >
                      {t('property-leasing.demo.contract')}
                    </a>
                  )}
                  <Button disabled={busy} onClick={() => activate(selected)} size="sm" variant="warning">
                    {t('property-leasing.demo.activate')}
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
                  {t('property-leasing.demo.complete')}
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
                  {t('property-leasing.demo.cancel')}
                </Button>
              )}
            </div>
          </SectionCard>
          {isLease && <ContractCard contract={contract} language={language} t={t} />}
          <UnitCard language={language} property={property} t={t} unit={unit} />
          {property !== undefined && (
            <div className={`${surfaceCardClassName} propertyleasing:min-w-0 propertyleasing:p-4`}>
              <PropertyEquipment
                language={language}
                propertyId={property.propertyRef.resourceId}
                unitId={selected.unitRef.resourceId}
              />
            </div>
          )}
          {snapshot !== undefined && (
            <OccupancyHistoryCard
              entries={(snapshot.occupancyHistory ?? []).filter((entry) => entry.occupancyId === occupancyId)}
            />
          )}
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
            {t('property-leasing.demo.close')}
          </Button>
          <Button disabled={busy} isLoading={feedback === 'saving'} onClick={state.saveRentTerms} variant="primary">
            {t('property-leasing.rent.save')}
          </Button>
        </>
      }
      closeLabel={t('property-leasing.demo.close')}
      closeOnInteractOutside={false}
      initialFocusEl={() => globalThis.document.querySelector<HTMLElement>('#occupancy-rent-monthly')}
      onOpenChange={(open) => {
        if (!open && !busy) {
          state.setRentEditorOpen(false);
        }
      }}
      open
      resizeLabel={t('property-leasing.demo.resizePanel')}
      size="md"
      title={t('property-leasing.rent.formTitle')}
    >
      <div className="propertyleasing:space-y-4 propertyleasing:py-2">
        <p className="propertyleasing:text-sm propertyleasing:text-(--color-fg-secondary)">
          {t('property-leasing.rent.formHint')}
        </p>
        {feedback === 'validation' && (
          <output aria-live="polite">{t('property-leasing.demo.feedback.validation')}</output>
        )}
        <RentFields state={state} />
      </div>
    </SidePanel>
  );
};
const RentFields = ({ state }: { readonly state: ReturnType<typeof useRecordsPage> }) => (
  <div className="propertyleasing:grid propertyleasing:gap-4 propertyleasing:md:grid-cols-3">
    <FormInput
      id="occupancy-rent-monthly"
      inputMode="decimal"
      label={state.t('property-leasing.rent.monthlyRentInput')}
      onChange={(event) => state.setRentMonthly(event.target.value)}
      value={state.rentMonthly}
    />
    <FormInput
      id="occupancy-rent-service"
      inputMode="decimal"
      label={state.t('property-leasing.rent.serviceChargesInput')}
      onChange={(event) => state.setRentService(event.target.value)}
      value={state.rentService}
    />
    <FormInput
      id="occupancy-rent-payment-day"
      label={state.t('property-leasing.rent.paymentDayInput')}
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
  const { guestId, guestQuery, guests, searchGuests, setGuestId, setGuestQuery } = state;
  const panelTitle = editor === 'stay' ? 'property-leasing.demo.newBooking' : LABEL_EDIT_DRAFT;
  const title = editor === 'lease' && editingId.length === 0 ? 'property-leasing.demo.newLease' : panelTitle;
  // Only units in operation inside a building in operation are offered for a new stay or lease.
  const activeUnits = (properties?.units ?? []).filter(
    (record) =>
      record.lifecycleState === 'ACTIVE' &&
      properties?.properties.some(
        (item) => item.propertyRef.resourceId === record.propertyRef.resourceId && item.lifecycleState === 'ACTIVE',
      ) === true,
  );
  return (
    <SidePanel
      actions={
        <div className="sp-occupancy-form-actions">
          <Button disabled={busy} onClick={() => state.setEditor(undefined)} theme="outlined" variant="secondary">
            {t('property-leasing.demo.close')}
          </Button>
          {editor === 'lease' ? (
            <Button
              disabled={busy || state.customersLoading}
              isLoading={feedback === 'saving'}
              onClick={state.editingId.length > 0 ? state.saveDraft : state.createDraft}
              variant="primary"
            >
              {t(state.editingId.length > 0 ? 'property-leasing.demo.saveDraft' : LABEL_CREATE)}
            </Button>
          ) : (
            <Button disabled={busy} isLoading={feedback === 'saving'} onClick={state.createStay} variant="primary">
              Uložit rezervaci
            </Button>
          )}
        </div>
      }
      closeLabel={t('property-leasing.demo.close')}
      closeOnInteractOutside={false}
      initialFocusEl={() => globalThis.document.querySelector<HTMLElement>('#occupancy-start-date')}
      onOpenChange={(open) => {
        if (!open && !busy) {
          state.setEditor(undefined);
        }
      }}
      open
      resizeLabel={t('property-leasing.demo.resizePanel')}
      size="lg"
      title={t(title)}
    >
      <div className="propertyleasing:space-y-4 propertyleasing:py-2">
        {feedback !== 'ready' && <output aria-live="polite">{t(`property-leasing.demo.feedback.${feedback}`)}</output>}
        <div className="propertyleasing:space-y-4">
          {editingId.length === 0 && (
            <div className="propertyleasing:grid propertyleasing:gap-4 propertyleasing:md:grid-cols-2">
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
                    footer={state.customersEmpty ? t('property-leasing.demo.customersEmpty') : undefined}
                    items={customers.map((record) => ({
                      label: record.displayName ?? record.partyId,
                      value: record.counterpartyRef.resourceId,
                    }))}
                    label={t('property-leasing.demo.customer')}
                    loading={customersLoading}
                    loadingMessage={t('property-leasing.demo.customersLoading')}
                    name="customer"
                    noResultsMessage={t('property-leasing.demo.customersEmpty')}
                    onChange={(value) => setCustomerId((Array.isArray(value) ? value[0] : value) ?? '')}
                    onOpenChange={setCustomerOpen}
                    open={customerOpen}
                    placeholder={t('property-leasing.demo.customerPlaceholder')}
                    translations={comboboxTranslations}
                    value={customerId.length > 0 ? [customerId] : []}
                  />
                </div>
              )}
            </div>
          )}
          <div className="propertyleasing:grid propertyleasing:gap-4 propertyleasing:md:grid-cols-2">
            <FormInput
              id="occupancy-start-date"
              label={t('property-leasing.demo.startDate')}
              onChange={(event) => setStartDate(event.target.value)}
              type="date"
              value={startDate}
            />
            <FormInput
              id="occupancy-end-date"
              label={t('property-leasing.demo.endDate')}
              onChange={(event) => setEndDate(event.target.value)}
              type="date"
              value={endDate}
            />
          </div>
          {editor === 'lease' && (
            <section className="propertyleasing:space-y-3">
              <h3 className="propertyleasing:text-sm propertyleasing:font-semibold">
                {t('property-leasing.rent.title')}
              </h3>
              <RentFields state={state} />
            </section>
          )}
        </div>
        {state.editor === 'stay' && (
          <section className="propertyleasing:space-y-4">
            <p className="propertyleasing:text-sm propertyleasing:text-(--color-fg-secondary)">
              {
                'Ruční rezervace bez napojení na rezervační portál. Po uložení ji můžete potvrdit, zahájit, ukončit nebo zrušit. Potvrzení kontroluje kolize termínů.'
              }
            </p>
            <div className="propertyleasing:flex propertyleasing:items-end propertyleasing:gap-2">
              <div className="propertyleasing:min-w-0 propertyleasing:flex-1">
                <FormInput
                  id="booking-guest-query"
                  label={t('property-leasing.demo.guestSearch')}
                  onChange={(event) => setGuestQuery(event.target.value)}
                  value={guestQuery}
                />
              </div>
              <Button disabled={busy} onClick={searchGuests} size="sm" theme="outlined" variant="secondary">
                {t('property-leasing.demo.search')}
              </Button>
            </div>
            <Select
              items={guests.map((record) => ({ label: record.title, value: record.ref.resourceId }))}
              onValueChange={({ value }) => setGuestId(value[0] ?? '')}
              value={guestId.length > 0 ? [guestId] : []}
            >
              <Select.Label>{t('property-leasing.demo.guest')}</Select.Label>
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
            {
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
            }
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
    <div className="propertyleasing:grid propertyleasing:gap-4 propertyleasing:sm:grid-cols-2 propertyleasing:xl:grid-cols-4">
      <StatCard label={state.t('property-leasing.list.summaryActive')} value={String(active.length)} />
      <StatCard label={state.t('property-leasing.list.summaryUpcoming')} value={String(upcoming.length)} />
      <StatCard label={state.t('property-leasing.list.summaryEnded')} value={String(ended.length)} />
      <StatCard
        {...(withoutRent > 0 ? { hint: state.t('property-leasing.rent.missing') } : {})}
        label={state.t('property-leasing.list.summaryMonthly')}
        value={active.length === withoutRent ? '—' : formatMoney(monthly)}
      />
    </div>
  );
};
const RecordsPageContent = ({ context }: { readonly context: ModulePageProps['context'] }) => {
  const state = useRecordsPage(context);
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
      <section className="propertyleasing:w-full propertyleasing:min-w-0 propertyleasing:max-w-none propertyleasing:space-y-6 propertyleasing:p-0 propertyleasing:text-(--color-page-fg)">
        {state.linkedCounterpartyId !== undefined && state.linkedResourceId === undefined ? (
          <CounterpartyDossierView
            busy={busy}
            canWrite={state.canWrite}
            counterpartyId={state.linkedCounterpartyId}
            directoryLoaded={state.directoryLoaded}
            entry={state.tenantDirectory.find((item) => item.counterpartyRef.resourceId === state.linkedCounterpartyId)}
            feedbackText={
              feedback === 'ready' || feedback === 'loading'
                ? undefined
                : t(`property-leasing.demo.feedback.${feedback}`)
            }
            language={state.language}
            newContactId={newUuid}
            onUpdate={state.updateCounterpartyDossier(state.linkedCounterpartyId)}
            snapshot={snapshot}
            unitName={unitName}
          />
        ) : state.linkedResourceId === undefined ? (
          <>
            <PageHeader
              actions={
                state.canWrite && (
                  <>
                    <Button
                      disabled={busy || snapshot === undefined}
                      onClick={() => state.newDraft('stay')}
                      size="sm"
                      theme="outlined"
                      variant="secondary"
                    >
                      {t('property-leasing.demo.newBooking')}
                    </Button>
                    <Button
                      disabled={busy || snapshot === undefined}
                      onClick={() => state.newDraft()}
                      size="sm"
                      variant="primary"
                    >
                      {t('property-leasing.demo.newLease')}
                    </Button>
                  </>
                )
              }
              description={t('property-leasing.pages.records.description')}
              meta={
                feedback !== 'loading' &&
                feedback !== 'ready' && (
                  <output aria-live="polite">
                    <Badge
                      size="sm"
                      variant={
                        (
                          {
                            conflict: 'warning',
                            forbidden: 'danger',
                            ready: 'success',
                            saving: 'info',
                            unavailable: 'danger',
                            validation: 'warning',
                          } as const
                        )[feedback]
                      }
                    >
                      {t(`property-leasing.demo.feedback.${feedback}`)}
                    </Badge>
                  </output>
                )
              }
              title={t('property-leasing.pages.records.title')}
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
            <div className="propertyleasing:flex propertyleasing:flex-wrap propertyleasing:gap-2">
              <LinkButton href="#tenants" size="sm" theme="outlined" variant="secondary">
                Nájemci, zájemci a kontaktní osoby ↓
              </LinkButton>
              <LinkButton
                href={`/${state.language}/nemovitosti/prehled`}
                size="sm"
                theme="outlined"
                variant="secondary"
              >
                Kalendář a přehled nemovitostí →
              </LinkButton>
            </div>
            <div className="propertyleasing:flex propertyleasing:flex-wrap propertyleasing:items-center propertyleasing:justify-between propertyleasing:gap-4 propertyleasing:pb-4">
              <div className="propertyleasing:flex propertyleasing:flex-wrap propertyleasing:gap-2">
                {(['ALL', 'LONG_TERM_LEASE', 'SHORT_STAY'] as const).map((kind) => (
                  <Button
                    aria-pressed={kindFilter === kind}
                    key={kind}
                    onClick={() => setKindFilter(kind)}
                    size="sm"
                    theme="borderless"
                    variant={kindFilter === kind ? 'warning' : 'secondary'}
                  >
                    {t(`property-leasing.demo.kind.${kind}`)}
                  </Button>
                ))}
              </div>
              <div className="propertyleasing:flex propertyleasing:flex-wrap propertyleasing:items-center propertyleasing:gap-3">
                {state.cancelledCount > 0 && (
                  <label className="propertyleasing:text-sm propertyleasing:text-(--color-fg-secondary)">
                    <input
                      checked={state.showCancelled}
                      onChange={(event) => state.setShowCancelled(event.target.checked)}
                      type="checkbox"
                    />{' '}
                    Zobrazit zrušené ({state.cancelledCount})
                  </label>
                )}
                <Button disabled={busy} onClick={refresh} size="sm" theme="outlined" variant="secondary">
                  {t('property-leasing.demo.refresh')}
                </Button>
              </div>
            </div>
            {snapshot !== undefined && visible.length === 0 && (
              <p
                className={`${surfaceTileClassName} propertyleasing:p-5 propertyleasing:text-sm propertyleasing:text-(--color-fg-secondary)`}
              >
                {t('property-leasing.demo.empty')}
              </p>
            )}
            <div className="propertyleasing:overflow-x-auto">
              <Table size="sm" variant="line">
                <Table.Caption>{t('property-leasing.demo.list')}</Table.Caption>
                <Table.Header>
                  <Table.Row>
                    <Table.ColumnHeader>{t(LABEL_UNIT)}</Table.ColumnHeader>
                    <Table.ColumnHeader>{t('property-leasing.list.tenant')}</Table.ColumnHeader>
                    <Table.ColumnHeader>{t('property-leasing.demo.period')}</Table.ColumnHeader>
                    <Table.ColumnHeader>{t('property-leasing.rent.column')}</Table.ColumnHeader>
                    <Table.ColumnHeader>{t('property-leasing.demo.state')}</Table.ColumnHeader>
                    <Table.ColumnHeader>{t(LABEL_DETAIL)}</Table.ColumnHeader>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {visible.map((record) => (
                    <Table.Row key={record.occupancyRef.resourceId}>
                      <Table.Cell>
                        <span className="propertyleasing:block propertyleasing:font-medium">
                          {unitName(record.unitRef.resourceId)}
                        </span>
                        <span className="propertyleasing:text-xs propertyleasing:text-(--color-fg-secondary)">
                          {state.propertyOf(record)?.name ?? ''}
                        </span>
                      </Table.Cell>
                      <Table.Cell>{state.partyNameOf(record) ?? '—'}</Table.Cell>
                      <Table.Cell>
                        {formatDate(record.startDate)} –{' '}
                        {record.endDate === null ? t('property-leasing.demo.openEnd') : formatDate(record.endDate)}
                      </Table.Cell>
                      <Table.Cell>
                        <span className="propertyleasing:tabular-nums">
                          {record.rentTerms === undefined ? '—' : formatMoney(monthlyTotal(record.rentTerms))}
                        </span>
                      </Table.Cell>
                      <Table.Cell>
                        <div className="propertyleasing:flex propertyleasing:flex-wrap propertyleasing:items-center propertyleasing:gap-2">
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
                            {t(`property-leasing.demo.stateLabels.${record.state}`)}
                          </Badge>
                          <span className="propertyleasing:text-(--color-fg-secondary)">
                            {t(`property-leasing.demo.kind.${record.kind}`)}
                          </span>
                        </div>
                      </Table.Cell>
                      <Table.Cell>
                        <LinkButton
                          href={`/${state.language}/najmy?resourceId=${record.occupancyRef.resourceId}`}
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
                busy={busy}
                canCreate={state.canWrite}
                createError={state.createError}
                directory={state.tenantDirectory}
                language={state.language}
                onCreate={state.createCounterparty}
                snapshot={snapshot}
                unitName={unitName}
              />
            )}
          </>
        ) : (
          <OccupancyDetail state={state} />
        )}
        <OccupancyDraftForm state={state} />
      </section>
    </>
  );
};
/** Exposed page: the Shell passes the person's context; the vertical's own route renders it without one. */
export const RecordsPage = ({ context }: Partial<ModulePageProps>) => {
  const search = useRouterState({ select: (state) => state.location.searchStr });
  return (
    <FederatedI18nBoundary
      defaultNamespace="property-leasing"
      fallbackLanguage="en"
      resources={propertyLeasingI18nResources}
      supportedLanguages={['en', 'cs']}
    >
      <RecordsPageContent context={context} key={search} />
    </FederatedI18nBoundary>
  );
};
export default RecordsPage;
