import { LinkButton } from '@techsio/ui-kit/atoms/link-button';
import { DetailList, PageHeader, SectionCard, SidePanel, comboboxTranslations, formatDate } from '@app/admin-ui';
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
import { FederatedI18nBoundary, useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useRouterState } from '@modern-js/plugin-tanstack/runtime';
import { OccupancyRefSchema } from '../../../../../shared/resources/occupancy.ts';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { Select } from '@techsio/ui-kit/molecules/select';
import { Table } from '@techsio/ui-kit/organisms/table';
import { Crypto, Effect, Option, PlatformError, Schema } from 'effect';
import { useEffect, useEffectEvent, useRef, useState } from 'react';

import type { OccupancyCommand, Feedback } from '../../../../../shared/actions/apply-command.ts';
import type { Occupancy, RecordsResponse } from '../../../../../shared/apis/records.ts';
import { executeApplyCommand } from '../../../../api/apply-command-action-client.ts';
import { executeRecords } from '../../../../api/records-client.ts';
import { UltramodernRouteHead } from '../../../ultramodern-route-head';
import csResource from '../../../../../locales/cs/siampark-occupancy.json';
import enResource from '../../../../../locales/en/siampark-occupancy.json';
import '../../../index.css';

const RecordsSearchSchema = Schema.Struct({ resourceId: Schema.optional(OccupancyRefSchema.fields.resourceId) });
const LABEL_CHOOSE = 'siampark-occupancy.demo.choose';
const LABEL_UNIT = 'siampark-occupancy.demo.unit';
const LABEL_DETAIL = 'siampark-occupancy.demo.detail';
const DEFAULT_START_DATE = '2026-10-05';
const DEFAULT_END_DATE = '2027-10-05';
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
  const [feedback, setFeedback] = useState<Feedback>('loading');
  const [unitId, setUnitId] = useState('');
  const [customerId, setCustomerId] = useState('');
  const [customersLoading, setCustomersLoading] = useState(false);
  const [customerOpen, setCustomerOpen] = useState(false);
  const [editor, setEditor] = useState<'lease' | 'booking'>();
  const [retryObservationId, setRetryObservationId] = useState<string>();
  const [startDate, setStartDate] = useState(DEFAULT_START_DATE);
  const [endDate, setEndDate] = useState(DEFAULT_END_DATE);
  const [customerName, setCustomerName] = useState<string>();
  const [customerNameFeedback, setCustomerNameFeedback] = useState<Feedback>();
  const [editingId, setEditingId] = useState('');
  const [kindFilter, setKindFilter] = useState<'ALL' | 'LONG_TERM_LEASE' | 'SHORT_STAY'>('ALL');
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
  const createDraft = () => {
    const unit = properties?.units.find((record) => record.unitRef.resourceId === unitId);
    const customer = customers.find((record) => record.counterpartyRef.resourceId === customerId);
    if (unit === undefined || customer === undefined) {
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
                startDate,
                state: 'DRAFT',
                unitRef: unit.unitRef,
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
  const newDraft = (mode: 'lease' | 'booking' = 'lease', retryId?: string) => {
    setRetryObservationId(retryId);
    setEditingId('');
    setStartDate(DEFAULT_START_DATE);
    setEndDate(DEFAULT_END_DATE);
    setUnitId('');
    setCustomerId('');
    setCustomers([]);
    setGuestId('');
    setGuests([]);
    setGuestQuery('');
    setEditor(mode);
    if (mode === 'lease') {
      loadCustomers();
    }
  };
  const saveDraft = () => {
    if (selected?.state !== 'DRAFT' || selected.occupancyRef.resourceId !== editingId) {
      setFeedback('validation');
      return;
    }
    runCommand({
      _tag: 'UpdateDraft',
      endDate: endDate || null,
      occupancyRef: selected.occupancyRef,
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
  const busy = feedback === 'loading' || feedback === 'saving';
  return {
    activate,
    busy,
    createDraft,
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
        description={t(`siampark-occupancy.demo.kind.${selected.kind}`)}
        title={unitName(selected.unitRef.resourceId)}
      />
      {feedback !== 'ready' && <output aria-live="polite">{t(`siampark-occupancy.demo.feedback.${feedback}`)}</output>}
      <div className="siamparkoccupancy:grid siamparkoccupancy:grid-cols-1 siamparkoccupancy:items-start siamparkoccupancy:gap-6 siamparkoccupancy:xl:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="siamparkoccupancy:min-w-0 siamparkoccupancy:space-y-6">
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
                  {
                    label: t('siampark-occupancy.demo.endDate'),
                    value:
                      selected.endDate === null ? t('siampark-occupancy.demo.openEnd') : formatDate(selected.endDate),
                  },
                ]}
              />
            </SectionCard>
            <SectionCard
              title={t(
                selected.kind === 'SHORT_STAY' ? 'siampark-occupancy.demo.guest' : 'siampark-occupancy.demo.customer',
              )}
            >
              <DetailList
                items={[
                  {
                    label: t('siampark-occupancy.detail.customerName'),
                    value: feedback === 'loading' ? t('siampark-occupancy.demo.customersLoading') : customerLabel,
                  },
                ]}
              />
              {customerNameFeedback !== undefined && (
                <p className="siamparkoccupancy:text-sm siamparkoccupancy:text-(--color-fg-secondary)">
                  {t('siampark-occupancy.detail.customerUnavailable')}{' '}
                  {t(`siampark-occupancy.demo.feedback.${customerNameFeedback}`)}
                </p>
              )}
            </SectionCard>
          </div>
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
                )[selected.state]
              }
            >
              {t(`siampark-occupancy.demo.stateLabels.${selected.state}`)}
            </Badge>
          </SectionCard>
          <SectionCard title={t('siampark-occupancy.demo.contract')}>
            <p className="siamparkoccupancy:text-sm">
              {t(
                selected.contractRef === null
                  ? 'siampark-occupancy.detail.noContract'
                  : 'siampark-occupancy.detail.linkedContract',
              )}
            </p>
          </SectionCard>
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
                <a
                  className="siamparkoccupancy:inline-flex siamparkoccupancy:items-center siamparkoccupancy:text-sm siamparkoccupancy:underline siamparkoccupancy:underline-offset-4"
                  href={`/${language}/siampark/agreements`}
                >
                  {t('siampark-occupancy.demo.contract')}
                </a>
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
        </div>
      </div>
    </>
  );
};
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
  const panelTitle = editor === 'booking' ? 'siampark-occupancy.demo.importBooking' : LABEL_EDIT_DRAFT;
  const title = editor === 'lease' && editingId.length === 0 ? 'siampark-occupancy.demo.newLease' : panelTitle;
  const activeUnits = (properties?.units ?? []).filter((record) => record.lifecycleState === 'ACTIVE');
  return (
    <SidePanel
      actions={
        <>
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
        </>
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
        </div>
        {state.editor === 'booking' && (
          <section className="siamparkoccupancy:space-y-4">
            <p className="siamparkoccupancy:text-sm siamparkoccupancy:text-(--color-fg-secondary)">
              {t('siampark-occupancy.demo.bookingFormContext')}
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
            <Badge variant="info">{t(LABEL_SIMULATED)}</Badge>
          </section>
        )}
      </div>
    </SidePanel>
  );
};
const RecordsPageContent = () => {
  const state = useRecordsPage();
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
                    onClick={() => state.newDraft('booking')}
                    size="sm"
                    theme="outlined"
                    variant="secondary"
                  >
                    {t('siampark-occupancy.demo.newBooking')}
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
                    <Table.ColumnHeader>{t('siampark-occupancy.demo.period')}</Table.ColumnHeader>
                    <Table.ColumnHeader>{t('siampark-occupancy.demo.state')}</Table.ColumnHeader>
                    <Table.ColumnHeader>{t(LABEL_DETAIL)}</Table.ColumnHeader>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {visible.map((record) => (
                    <Table.Row key={record.occupancyRef.resourceId}>
                      <Table.Cell>
                        <span className="siamparkoccupancy:font-medium">{unitName(record.unitRef.resourceId)}</span>
                      </Table.Cell>
                      <Table.Cell>
                        {record.startDate} → {record.endDate ?? t('siampark-occupancy.demo.openEnd')}
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
