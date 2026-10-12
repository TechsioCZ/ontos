import { failureFeedback } from '../../../../../shared/actions/apply-command.ts';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { makeReferenceGatewayCredentials } from '@app/shared-contracts';
import { executeRecords as executePropertyRecords } from '@app/siampark-property/clients/records';
import { executeRecords as executeOccupancyRecords } from '@app/siampark-occupancy/clients/records';
import { FederatedI18nBoundary, useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useRouterState } from '@modern-js/plugin-tanstack/runtime';
import { ContractRefSchema } from '../../../../../shared/resources/contract.ts';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { Select } from '@techsio/ui-kit/molecules/select';
import { Table } from '@techsio/ui-kit/organisms/table';
import { Crypto, DateTime, Effect, Option, PlatformError, Schema } from 'effect';
import { useEffect, useEffectEvent, useRef, useState } from 'react';

import type { AgreementsCommand, Feedback } from '../../../../../shared/actions/apply-command.ts';
import type { Contract, RecordsResponse } from '../../../../../shared/apis/records.ts';
import { executeApplyCommand } from '../../../../api/apply-command-action-client.ts';
import { executeRecords } from '../../../../api/records-client.ts';
import { UltramodernRouteHead } from '../../../ultramodern-route-head';
import csResource from '../../../../../locales/cs/siampark-agreements.json';
import enResource from '../../../../../locales/en/siampark-agreements.json';
import '../../../index.css';

const RecordsSearchSchema = Schema.Struct({ resourceId: Schema.optional(ContractRefSchema.fields.resourceId) });
const LABEL_DETAIL = 'siampark-agreements.demo.detail';
const LABEL_CREATE = 'siampark-agreements.demo.create';
const DEFAULT_START_DATE = '2026-10-05';
const DEFAULT_END_DATE = '2027-10-05';
const siamparkAgreementsI18nResources = {
  cs: { 'siampark-agreements': csResource },
  en: { 'siampark-agreements': enResource },
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
type Properties = Effect.Success<ReturnType<typeof executePropertyRecords>>;
type Occupancies = Effect.Success<ReturnType<typeof executeOccupancyRecords>>;
const useRecordsPage = () => {
  const { language, t } = useModernI18n();
  const { location } = useRouterState();
  const linkedResourceId = Option.getOrUndefined(
    Schema.decodeUnknownOption(RecordsSearchSchema)(location.search),
  )?.resourceId;
  const cancellation = useRef<AbortController | null>(null);
  const run = <A, E>(effect: Effect.Effect<A, E>) => {
    const controller = cancellation.current ?? new AbortController();
    cancellation.current = controller;
    void browserRuntime.runPromiseExit(effect, { signal: controller.signal });
  };
  const [snapshot, setSnapshot] = useState<RecordsResponse>();
  const [properties, setProperties] = useState<Properties>();
  const [occupancies, setOccupancies] = useState<Occupancies>();
  const [feedback, setFeedback] = useState<Feedback>('loading');
  const [selectedId, setSelectedId] = useState('');
  const [signerContact, setSignerContact] = useState('');
  const [occupancyId, setOccupancyId] = useState('');
  const [startDate, setStartDate] = useState(DEFAULT_START_DATE);
  const [endDate, setEndDate] = useState(DEFAULT_END_DATE);
  const [editingDraft, setEditingDraft] = useState(false);
  const [expiringOnly, setExpiringOnly] = useState(false);
  const selected = snapshot?.contracts.find(
    (record) => record.contractRef.resourceId === (selectedId || linkedResourceId),
  );
  const clearSensitiveState = () => {
    setSnapshot(undefined);
    setProperties(undefined);
    setOccupancies(undefined);
    setSelectedId('');
    setSignerContact('');
    setOccupancyId('');
    setStartDate(DEFAULT_START_DATE);
    setEndDate(DEFAULT_END_DATE);
    setEditingDraft(false);
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
            occupancies: executeOccupancyRecords({}, 'siampark-agreements.occupancies'),
            properties: executePropertyRecords({}, 'siampark-agreements.units'),
            records: executeRecords({}, 'siampark-agreements.records'),
          },
          { concurrency: 3 },
        ),
      ),
      Effect.tap((value) =>
        Effect.sync(() => {
          setSnapshot(value.records);
          setProperties(value.properties);
          setOccupancies(value.occupancies);
        }),
      ),
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
  const runCommand = (command: AgreementsCommand) => {
    if (snapshot === undefined) {
      return;
    }
    setFeedback('saving');
    run(
      Effect.all(
        {
          idempotencyKey: newUuid,
          referenceCredentials: makeReferenceGatewayCredentials([
            'party-registry',
            'siampark-occupancy',
            'siampark-property',
            'siampark-property',
          ]),
        },
        { concurrency: 2 },
      ).pipe(
        Effect.flatMap(({ idempotencyKey, referenceCredentials }) =>
          executeApplyCommand({ command, expectedRevision: snapshot.revision }, 'siampark-agreements.command', {
            idempotencyKey,
            referenceCredentials,
          }),
        ),
        Effect.flatMap((result) => load().pipe(Effect.map((value) => ({ records: value.records, result })))),
        Effect.tap(({ records, result }) => {
          setSelectedId(
            records.contracts.find((record) => record.contractRef.resourceId === result.resourceRef?.resourceId)
              ?.contractRef.resourceId ?? '',
          );
          return Effect.void;
        }),
        Effect.match({
          onFailure: reportFailure,
          onSuccess: () => setFeedback('ready'),
        }),
      ),
    );
  };
  const createContract = () => {
    const occupancy = occupancies?.occupancies.find((record) => record.occupancyRef.resourceId === occupancyId);
    const unit = properties?.units.find((record) => record.unitRef.resourceId === occupancy?.unitRef.resourceId);
    if (occupancy === undefined || occupancy.customerCounterpartyRef === null || unit === undefined) {
      setFeedback('validation');
      return;
    }
    const customer = occupancy.customerCounterpartyRef;
    run(
      newUuid.pipe(
        Effect.match({
          onFailure: reportFailure,
          onSuccess: (resourceId) =>
            runCommand({
              _tag: 'CreateContract',
              record: {
                contractRef: {
                  moduleId: 'siampark.agreements',
                  resourceId,
                  resourceType: 'siampark.agreements.contract',
                  tenantId: occupancy.occupancyRef.tenantId,
                },
                counterpartyRef: customer,
                endDate: endDate || null,
                kind: 'LEASE',
                lifecycleState: 'DRAFT',
                note: null,
                occupancyRef: occupancy.occupancyRef,
                propertyRef: unit.propertyRef,
                renewalNoticeDate: null,
                signatureState: 'NOT_SENT',
                startDate,
                supersedesContractRef: null,
                unitRef: occupancy.unitRef,
              },
            }),
        }),
      ),
    );
  };
  const editDraft = () => {
    if (selected?.lifecycleState !== 'DRAFT' || selected.signatureState !== 'NOT_SENT') {
      return;
    }
    setStartDate(selected.startDate);
    setEndDate(selected.endDate ?? '');
    setEditingDraft(true);
  };
  const resetDraftForm = () => {
    setEditingDraft(false);
    setOccupancyId('');
    setStartDate(DEFAULT_START_DATE);
    setEndDate(DEFAULT_END_DATE);
  };
  const saveDraft = () => {
    if (selected?.lifecycleState !== 'DRAFT' || selected.signatureState !== 'NOT_SENT') {
      setFeedback('validation');
      return;
    }
    runCommand({
      _tag: 'UpdateContract',
      record: {
        contractRef: selected.contractRef,
        counterpartyRef: selected.counterpartyRef,
        endDate: endDate || null,
        kind: selected.kind,
        lifecycleState: selected.lifecycleState,
        note: selected.note,
        occupancyRef: selected.occupancyRef,
        propertyRef: selected.propertyRef,
        renewalNoticeDate: selected.renewalNoticeDate,
        signatureState: selected.signatureState,
        startDate,
        supersedesContractRef: selected.supersedesContractRef,
        unitRef: selected.unitRef,
      },
    });
  };
  const observeSignature = (record: Contract) => {
    run(
      Effect.all({ resourceId: newUuid, timestamp: DateTime.now }, { concurrency: 1 }).pipe(
        Effect.map(({ resourceId, timestamp }): AgreementsCommand => {
          const now = DateTime.formatIso(timestamp);
          return {
            _tag: 'ObserveSignature',
            contractRef: record.contractRef,
            document: {
              contractRef: record.contractRef,
              createdAt: now,
              documentRef: {
                moduleId: 'siampark.agreements',
                resourceId,
                resourceType: 'siampark.agreements.document',
                tenantId: record.contractRef.tenantId,
              },
              fileName: `${record.contractRef.resourceId}.pdf`,
              kind: 'LEASE',
              lifecycleState: 'FINAL',
              signedDocumentReference: `SIMULATED:signature:${record.contractRef.resourceId}`,
              title: t('siampark-agreements.demo.signedDocumentTitle'),
              updatedAt: now,
            },
            outcome: 'SIGNED',
          };
        }),
        Effect.tap((command) => Effect.sync(() => runCommand(command))),
        Effect.match({
          onFailure: reportFailure,
          onSuccess: () => setFeedback('saving'),
        }),
      ),
    );
  };
  const renew = (record: Contract) => {
    run(
      newUuid.pipe(
        Effect.match({
          onFailure: reportFailure,
          onSuccess: (resourceId) =>
            runCommand({
              _tag: 'RenewContract',
              contractRef: record.contractRef,
              successor: {
                contractRef: { ...record.contractRef, resourceId },
                counterpartyRef: record.counterpartyRef,
                endDate: endDate || null,
                kind: record.kind,
                lifecycleState: 'DRAFT',
                note: record.note,
                occupancyRef: record.occupancyRef,
                propertyRef: record.propertyRef,
                renewalNoticeDate: null,
                signatureState: 'NOT_SENT',
                startDate: record.endDate ?? startDate,
                supersedesContractRef: record.contractRef,
                unitRef: record.unitRef,
              },
            }),
        }),
      ),
    );
  };
  const unitName = (resourceId: string | undefined) =>
    properties?.units.find((record) => record.unitRef.resourceId === resourceId)?.name ??
    resourceId ??
    t('siampark-agreements.demo.noUnit');
  const visible = snapshot?.contracts.filter((record) => !expiringOnly || record.expiringSoon) ?? [];
  const busy = feedback === 'loading' || feedback === 'saving';
  return {
    busy,
    createContract,
    editDraft,
    editingDraft,
    endDate,
    expiringOnly,
    feedback,
    language,
    observeSignature,
    occupancies,
    occupancyId,
    properties,
    refresh,
    renew,
    resetDraftForm,
    runCommand,
    saveDraft,
    selected,
    setEndDate,
    setExpiringOnly,

    setOccupancyId,
    setSelectedId: (value: string) => {
      setSelectedId(value);
      setSignerContact('');
      resetDraftForm();
    },
    setSignerContact,
    setStartDate,
    signerContact,
    snapshot,
    startDate,
    t,
    unitName,
    visible,
  };
};
const AgreementsDetail = ({ state }: { readonly state: ReturnType<typeof useRecordsPage> }) => {
  const {
    busy,
    editDraft,
    language,
    observeSignature,
    renew,
    runCommand,
    selected,
    setSelectedId,
    setSignerContact,
    signerContact,
    snapshot,
    t,
    unitName,
  } = state;
  if (selected === undefined) {
    return null;
  }
  return (
    <section
      aria-label={t(LABEL_DETAIL)}
      className="siamparkagreements:space-y-4 siamparkagreements:rounded-lg siamparkagreements:border siamparkagreements:border-(--color-border-muted) siamparkagreements:bg-(--color-surface) siamparkagreements:p-5"
    >
      <h2 className="siamparkagreements:text-lg siamparkagreements:font-semibold">
        {unitName(selected.unitRef?.resourceId)}
      </h2>
      <p className="siamparkagreements:break-words siamparkagreements:font-mono siamparkagreements:text-xs siamparkagreements:text-(--color-fg-secondary)">
        {selected.contractRef.resourceId}
      </p>
      <div className="siamparkagreements:flex siamparkagreements:flex-wrap siamparkagreements:gap-2">
        <Badge
          size="sm"
          variant={
            ({ ACTIVE: 'success', DRAFT: 'outline', EXPIRED: 'warning', TERMINATED: 'danger' } as const)[
              selected.lifecycleState
            ]
          }
        >
          {t(`siampark-agreements.demo.lifecycleLabels.${selected.lifecycleState}`)}
        </Badge>
        <Badge
          size="sm"
          variant={
            ({ DECLINED: 'danger', NOT_SENT: 'outline', SENT: 'info', SIGNED: 'success' } as const)[
              selected.signatureState
            ]
          }
        >
          {t(`siampark-agreements.demo.signatureLabels.${selected.signatureState}`)}
        </Badge>
      </div>
      <p className="siamparkagreements:text-sm">
        {selected.startDate} → {selected.endDate ?? t('siampark-agreements.demo.openEnd')}
      </p>
      <p className="siamparkagreements:break-words siamparkagreements:text-sm siamparkagreements:text-(--color-fg-secondary)">
        {t('siampark-agreements.demo.customer')}: {selected.counterpartyRef.resourceId}
      </p>
      {selected.supersedesContractRef !== null && (
        <p>
          {t('siampark-agreements.demo.supersedes')}:{' '}
          <Button
            onClick={() => setSelectedId(selected.supersedesContractRef?.resourceId ?? '')}
            size="sm"
            theme="outlined"
            variant="secondary"
          >
            {t(LABEL_DETAIL)}
          </Button>
        </p>
      )}
      <div className="siamparkagreements:flex siamparkagreements:flex-wrap siamparkagreements:gap-2">
        {selected.lifecycleState === 'DRAFT' && selected.signatureState === 'NOT_SENT' && (
          <Button disabled={busy} onClick={editDraft} size="sm" theme="outlined" variant="secondary">
            {t('siampark-agreements.demo.editDraft')}
          </Button>
        )}
        {selected.lifecycleState === 'DRAFT' &&
          (selected.signatureState === 'NOT_SENT' || selected.signatureState === 'DECLINED') && (
            <div className="siamparkagreements:flex siamparkagreements:w-full siamparkagreements:flex-wrap siamparkagreements:items-end siamparkagreements:gap-3 siamparkagreements:rounded-lg siamparkagreements:bg-(--color-surface-subtle) siamparkagreements:p-4">
              <div className="siamparkagreements:min-w-0 siamparkagreements:flex-1 siamparkagreements:basis-full">
                <FormInput
                  id="signature-contact"
                  label={t('siampark-agreements.demo.signerContact')}
                  onChange={(event) => setSignerContact(event.target.value)}
                  placeholder={t('siampark-agreements.demo.signerContactPlaceholder')}
                  value={signerContact}
                />
              </div>
              <Button
                disabled={busy || signerContact.trim().length === 0}
                onClick={() => runCommand({ _tag: 'SendSignature', contractRef: selected.contractRef, signerContact })}
                size="sm"
                variant="warning"
              >
                {t('siampark-agreements.demo.sendSignature')}
              </Button>
            </div>
          )}
        {selected.lifecycleState === 'DRAFT' && selected.signatureState === 'SENT' && (
          <>
            <Button disabled={busy} onClick={() => observeSignature(selected)} size="sm" variant="warning">
              {t('siampark-agreements.demo.simulateSigned')}
            </Button>
            <Button
              disabled={busy}
              onClick={() =>
                runCommand({
                  _tag: 'ObserveSignature',
                  contractRef: selected.contractRef,
                  document: null,
                  outcome: 'DECLINED',
                })
              }
              size="sm"
              theme="outlined"
              variant="danger"
            >
              {t('siampark-agreements.demo.simulateDeclined')}
            </Button>
          </>
        )}
        {selected.lifecycleState === 'DRAFT' && (
          <Button
            disabled={busy}
            onClick={() => runCommand({ _tag: 'ActivateContract', contractRef: selected.contractRef })}
            size="sm"
            variant="warning"
          >
            {t('siampark-agreements.demo.activate')}
          </Button>
        )}
        {selected.lifecycleState === 'ACTIVE' && (
          <>
            <Button
              disabled={busy || selected.hasSuccessorDraft}
              onClick={() => renew(selected)}
              size="sm"
              variant="warning"
            >
              {t('siampark-agreements.demo.renew')}
            </Button>
            <Button
              disabled={busy}
              onClick={() => runCommand({ _tag: 'TerminateContract', contractRef: selected.contractRef })}
              size="sm"
              theme="outlined"
              variant="danger"
            >
              {t('siampark-agreements.demo.terminate')}
            </Button>
          </>
        )}
        <a
          className="siamparkagreements:inline-flex siamparkagreements:items-center siamparkagreements:text-sm siamparkagreements:underline siamparkagreements:underline-offset-4"
          href={`/${language}/siampark/occupancy`}
        >
          {t('siampark-agreements.demo.occupancy')}
        </a>
      </div>
      <h3 className="siamparkagreements:text-sm siamparkagreements:font-semibold">
        {t('siampark-agreements.demo.documents')}
      </h3>
      {snapshot?.documents.flatMap((record) =>
        record.contractRef?.resourceId === selected.contractRef.resourceId
          ? [
              <p
                className="siamparkagreements:flex siamparkagreements:flex-wrap siamparkagreements:items-center siamparkagreements:gap-3 siamparkagreements:rounded-lg siamparkagreements:border siamparkagreements:border-(--color-border-muted) siamparkagreements:p-4 siamparkagreements:text-sm"
                key={record.documentRef.resourceId}
              >
                {record.title} · {record.fileName} ·{' '}
                <Badge size="sm" variant={record.lifecycleState === 'FINAL' ? 'success' : 'outline'}>
                  {t(`siampark-agreements.demo.documentLabels.${record.lifecycleState}`)}
                </Badge>{' '}
                {record.signedDocumentReference ?? t('siampark-agreements.demo.metadataOnly')}
                {record.lifecycleState !== 'ARCHIVED' && (
                  <Button
                    disabled={busy}
                    onClick={() => runCommand({ _tag: 'ArchiveDocument', documentRef: record.documentRef })}
                    size="sm"
                    theme="outlined"
                    variant="secondary"
                  >
                    {t('siampark-agreements.demo.archive')}
                  </Button>
                )}
              </p>,
            ]
          : [],
      )}
      {snapshot?.signatureObservations.flatMap((record) =>
        record.contractRef.resourceId === selected.contractRef.resourceId
          ? [
              <p
                className="siamparkagreements:space-y-2 siamparkagreements:break-words siamparkagreements:rounded-lg siamparkagreements:bg-(--color-surface-subtle) siamparkagreements:p-4 siamparkagreements:text-sm siamparkagreements:text-(--color-fg-secondary)"
                key={record.observationId}
              >
                <Badge variant="info">{t('siampark-agreements.demo.simulated')}</Badge> {record.correlation} ·{' '}
                {t(`siampark-agreements.demo.signatureLabels.${record.state}`)}
                <br />
                {t('siampark-agreements.demo.provider')}: {record.providerLabel} · {record.integrationKind}
                <br />
                {t('siampark-agreements.demo.attemptedAt')}: {record.attemptedAt}
                {record.completedAt !== null && (
                  <>
                    <br />
                    {t('siampark-agreements.demo.completedAt')}: {record.completedAt}
                  </>
                )}
                <br />
                {t('siampark-agreements.demo.ownerReference')}: {record.ownerResourceRef.resourceId}
                <br />
                {t('siampark-agreements.demo.signer')}: {record.signer.displayName ?? record.signer.partyRef.resourceId}{' '}
                · {record.signer.contact}
                <br />
                {t('siampark-agreements.demo.requestSummary')}: {record.requestSummary}
                <br />
                {t('siampark-agreements.demo.resultSummary')}: {record.resultSummary}
              </p>,
            ]
          : [],
      )}
    </section>
  );
};
const AgreementsDraftForm = ({ state }: { readonly state: ReturnType<typeof useRecordsPage> }) => {
  const {
    busy,
    createContract,
    editingDraft,
    endDate,
    feedback,
    occupancies,
    occupancyId,
    resetDraftForm,
    saveDraft,
    selected,
    setEndDate,
    setOccupancyId,
    setStartDate,
    snapshot,
    startDate,
    t,
    unitName,
  } = state;
  if (snapshot === undefined || feedback === 'forbidden') {
    return null;
  }
  const confirmedLeases = (occupancies?.occupancies ?? []).filter(
    (record) => record.kind === 'LONG_TERM_LEASE' && record.state === 'CONFIRMED',
  );
  const formLabel = editingDraft ? 'siampark-agreements.demo.editDraft' : LABEL_CREATE;
  return (
    <section
      aria-label={t(formLabel)}
      className="siamparkagreements:space-y-4 siamparkagreements:rounded-lg siamparkagreements:border siamparkagreements:border-(--color-border-muted) siamparkagreements:bg-(--color-surface) siamparkagreements:p-5"
    >
      <h2 className="siamparkagreements:text-lg siamparkagreements:font-semibold">{t(formLabel)}</h2>
      {editingDraft ? (
        <p>{unitName(selected?.unitRef?.resourceId)}</p>
      ) : (
        <Select
          items={confirmedLeases.map((record) => ({
            label: unitName(record.unitRef.resourceId),
            value: record.occupancyRef.resourceId,
          }))}
          onValueChange={({ value }) => {
            setOccupancyId(value[0] ?? '');
            const record = occupancies?.occupancies.find((candidate) => candidate.occupancyRef.resourceId === value[0]);
            if (record !== undefined) {
              setStartDate(record.startDate);
              setEndDate(record.endDate ?? '');
            }
          }}
          value={occupancyId.length > 0 ? [occupancyId] : []}
        >
          <Select.Label>{t('siampark-agreements.demo.occupancy')}</Select.Label>
          <Select.Control>
            <Select.Trigger>
              <Select.ValueText placeholder={t('siampark-agreements.demo.choose')} />
            </Select.Trigger>
          </Select.Control>
          <Select.Positioner>
            <Select.Content>
              {confirmedLeases.map((record) => (
                <Select.Item
                  item={{ label: unitName(record.unitRef.resourceId), value: record.occupancyRef.resourceId }}
                  key={record.occupancyRef.resourceId}
                >
                  <Select.ItemText>{unitName(record.unitRef.resourceId)}</Select.ItemText>
                  <Select.ItemIndicator />
                </Select.Item>
              ))}
            </Select.Content>
          </Select.Positioner>
        </Select>
      )}
      <div className="siamparkagreements:grid siamparkagreements:gap-4 siamparkagreements:md:grid-cols-2">
        <FormInput
          id="contract-start-date"
          label={t('siampark-agreements.demo.startDate')}
          onChange={(event) => setStartDate(event.target.value)}
          type="date"
          value={startDate}
        />
        <FormInput
          id="contract-end-date"
          label={t('siampark-agreements.demo.endDate')}
          onChange={(event) => setEndDate(event.target.value)}
          type="date"
          value={endDate}
        />
      </div>
      <div className="siamparkagreements:flex siamparkagreements:flex-wrap siamparkagreements:gap-2">
        <Button disabled={busy} onClick={editingDraft ? saveDraft : createContract} size="sm" variant="warning">
          {t(editingDraft ? 'siampark-agreements.demo.saveDraft' : LABEL_CREATE)}
        </Button>
        {editingDraft && (
          <Button disabled={busy} onClick={resetDraftForm} size="sm" theme="outlined" variant="secondary">
            {t('siampark-agreements.demo.newContract')}
          </Button>
        )}
      </div>
    </section>
  );
};
const RecordsPageContent = () => {
  const state = useRecordsPage();
  const {
    busy,
    expiringOnly,
    feedback,
    refresh,
    setExpiringOnly,

    setSelectedId,
    snapshot,
    t,
    unitName,
    visible,
  } = state;
  return (
    <>
      <UltramodernRouteHead />
      <section className="siamparkagreements:w-full siamparkagreements:min-w-0 siamparkagreements:max-w-none siamparkagreements:space-y-6 siamparkagreements:p-0 siamparkagreements:text-(--color-page-fg)">
        <header className="siamparkagreements:flex siamparkagreements:flex-wrap siamparkagreements:items-start siamparkagreements:justify-between siamparkagreements:gap-4">
          <div className="siamparkagreements:space-y-1">
            <h1 className="siamparkagreements:text-xl siamparkagreements:font-semibold">
              {t('siampark-agreements.pages.records.title')}
            </h1>
            <p className="siamparkagreements:text-sm siamparkagreements:text-(--color-fg-secondary)">
              {t('siampark-agreements.pages.records.description')}
            </p>
          </div>
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
              {t(`siampark-agreements.demo.feedback.${feedback}`)}
            </Badge>
          </output>
        </header>
        <div className="siamparkagreements:flex siamparkagreements:flex-wrap siamparkagreements:items-center siamparkagreements:justify-between siamparkagreements:gap-4 siamparkagreements:border-b siamparkagreements:border-(--color-border-muted) siamparkagreements:pb-4">
          <div className="siamparkagreements:flex siamparkagreements:flex-wrap siamparkagreements:gap-2">
            <Button
              aria-pressed={!expiringOnly}
              onClick={() => setExpiringOnly(false)}
              size="sm"
              theme="borderless"
              variant={expiringOnly ? 'secondary' : 'warning'}
            >
              {t('siampark-agreements.demo.all')}
            </Button>
            <Button
              aria-pressed={expiringOnly}
              onClick={() => setExpiringOnly(true)}
              size="sm"
              theme="borderless"
              variant={expiringOnly ? 'warning' : 'secondary'}
            >
              {t('siampark-agreements.demo.expiring')}
            </Button>
          </div>
          <Button disabled={busy} onClick={refresh} size="sm" theme="outlined" variant="secondary">
            {t('siampark-agreements.demo.refresh')}
          </Button>
        </div>
        {snapshot !== undefined && visible.length === 0 && (
          <p className="siamparkagreements:rounded-lg siamparkagreements:bg-(--color-surface-subtle) siamparkagreements:p-5 siamparkagreements:text-sm siamparkagreements:text-(--color-fg-secondary)">
            {t('siampark-agreements.demo.empty')}
          </p>
        )}
        <div className="siamparkagreements:overflow-x-auto siamparkagreements:rounded-lg siamparkagreements:bg-(--color-surface)">
          <Table size="sm" variant="outline">
            <Table.Caption>{t('siampark-agreements.demo.list')}</Table.Caption>
            <Table.Header>
              <Table.Row>
                <Table.ColumnHeader>{t('siampark-agreements.demo.unit')}</Table.ColumnHeader>
                <Table.ColumnHeader>{t('siampark-agreements.demo.period')}</Table.ColumnHeader>
                <Table.ColumnHeader>{t('siampark-agreements.demo.lifecycle')}</Table.ColumnHeader>
                <Table.ColumnHeader>{t('siampark-agreements.demo.signature')}</Table.ColumnHeader>
                <Table.ColumnHeader>{t(LABEL_DETAIL)}</Table.ColumnHeader>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {visible.map((record) => (
                <Table.Row key={record.contractRef.resourceId}>
                  <Table.Cell>
                    <span className="siamparkagreements:font-medium">{unitName(record.unitRef?.resourceId)}</span>
                  </Table.Cell>
                  <Table.Cell>
                    {record.startDate} → {record.endDate ?? t('siampark-agreements.demo.openEnd')}
                  </Table.Cell>
                  <Table.Cell>
                    <div className="siamparkagreements:flex siamparkagreements:flex-wrap siamparkagreements:gap-2">
                      <Badge
                        size="sm"
                        variant={
                          ({ ACTIVE: 'success', DRAFT: 'outline', EXPIRED: 'warning', TERMINATED: 'danger' } as const)[
                            record.lifecycleState
                          ]
                        }
                      >
                        {t(`siampark-agreements.demo.lifecycleLabels.${record.lifecycleState}`)}
                      </Badge>
                      {record.expiringSoon && <Badge variant="warning">{t('siampark-agreements.demo.expiring')}</Badge>}
                      {record.hasSuccessorDraft && (
                        <Badge variant="info">{t('siampark-agreements.demo.successorExists')}</Badge>
                      )}
                      {record.isExpired && <Badge variant="warning">{t('siampark-agreements.demo.expired')}</Badge>}
                    </div>
                  </Table.Cell>
                  <Table.Cell>
                    <Badge
                      size="sm"
                      variant={
                        ({ DECLINED: 'danger', NOT_SENT: 'outline', SENT: 'info', SIGNED: 'success' } as const)[
                          record.signatureState
                        ]
                      }
                    >
                      {t(`siampark-agreements.demo.signatureLabels.${record.signatureState}`)}
                    </Badge>
                  </Table.Cell>
                  <Table.Cell>
                    <Button
                      onClick={() => setSelectedId(record.contractRef.resourceId)}
                      size="sm"
                      theme="outlined"
                      variant="secondary"
                    >
                      {t(LABEL_DETAIL)}
                    </Button>
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        </div>
        <div className="siamparkagreements:grid siamparkagreements:items-start siamparkagreements:gap-6 siamparkagreements:xl:grid-cols-2">
          <AgreementsDetail state={state} />
          <AgreementsDraftForm state={state} />
        </div>
      </section>
    </>
  );
};
export const RecordsPage = () => {
  const search = useRouterState({ select: (state) => state.location.searchStr });
  return (
    <FederatedI18nBoundary
      defaultNamespace="siampark-agreements"
      fallbackLanguage="en"
      resources={siamparkAgreementsI18nResources}
      supportedLanguages={['en', 'cs']}
    >
      <RecordsPageContent key={search} />
    </FederatedI18nBoundary>
  );
};
export default RecordsPage;
