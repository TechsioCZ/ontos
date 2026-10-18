import { failureFeedback } from '../../../../../shared/actions/apply-command.ts';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { makeReferenceGatewayCredentials } from '@app/shared-contracts';
import { listCustomers } from '@app/party-registry/api/client';
import { executeRecords as executePropertyRecords } from '@app/siampark-property/clients/records';
import { executeRecords as executeOccupancyRecords } from '@app/siampark-occupancy/clients/records';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useRouterState } from '@modern-js/plugin-tanstack/runtime';
import { ContractRefSchema } from '../../../../../shared/resources/contract.ts';
import { Crypto, DateTime, Effect, Match, Option, PlatformError, Schema } from 'effect';
import { useEffect, useEffectEvent, useRef, useState } from 'react';
import type { AgreementsCommand, Feedback } from '../../../../../shared/actions/apply-command.ts';
import type { Contract, RecordsResponse } from '../../../../../shared/apis/records.ts';
import { executeApplyCommand } from '../../../../api/apply-command-action-client.ts';
import { executeRecords } from '../../../../api/records-client.ts';

const RecordsSearchSchema = Schema.Struct({ resourceId: Schema.optional(ContractRefSchema.fields.resourceId) });
const DEFAULT_START_DATE = '2026-10-05';
const DEFAULT_END_DATE = '2027-10-05';
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
const contractReferenceAudiences = (record: Contract | undefined) => {
  const audiences = ['party-registry'];
  if (record !== undefined && record.unitRef !== null) {
    audiences.push('siampark-property', 'siampark-property');
  }
  if (record !== undefined && record.occupancyRef !== null) {
    audiences.push('siampark-occupancy');
  }
  return audiences;
};
export const useRecordsPage = () => {
  const { language, t } = useModernI18n();
  const { location } = useRouterState();
  const linkedResourceId = Option.getOrUndefined(Schema.decodeOption(RecordsSearchSchema)(location.search))?.resourceId;
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
  const [customers, setCustomers] = useState<Effect.Success<ReturnType<typeof listCustomers>>>([]);
  const [customerId, setCustomerId] = useState('');
  const [contractKind, setContractKind] = useState<Contract['kind']>('OTHER');
  const [rentalFeedback, setRentalFeedback] = useState<Feedback>();
  const [signedReference, setSignedReference] = useState('');
  const [signedFileName, setSignedFileName] = useState('');
  const [signedBy, setSignedBy] = useState('');
  const [signedOn, setSignedOn] = useState('');
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
    setCustomers([]);
    setCustomerId('');
    setRentalFeedback(undefined);
    setProperties(undefined);
    setOccupancies(undefined);
    setSelectedId('');
    setSignedReference('');
    setSignedFileName('');
    setSignedBy('');
    setSignedOn('');
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
  const loadRentalReferences = () =>
    Effect.all(
      {
        occupancies: executeOccupancyRecords({}, 'siampark-agreements.occupancies'),
        properties: executePropertyRecords({}, 'siampark-agreements.units'),
      },
      { concurrency: 2 },
    ).pipe(
      Effect.tap((value) =>
        Effect.sync(() => {
          setProperties(value.properties);
          setOccupancies(value.occupancies);
          setRentalFeedback(undefined);
        }),
      ),
    );
  const selectContractKind = (kind: Contract['kind']) => {
    setContractKind(kind);
    setRentalFeedback(undefined);
    if (kind === 'LEASE') {
      run(
        loadRentalReferences().pipe(
          Effect.match({
            onFailure: (error) => setRentalFeedback(failureFeedback(error)),
            onSuccess: () => setRentalFeedback(undefined),
          }),
        ),
      );
    }
  };
  const load = () =>
    Effect.sync(clearSensitiveState).pipe(
      Effect.flatMap(() =>
        Effect.all(
          {
            customers: listCustomers({ includeArchived: false }),
            records: executeRecords({}, 'siampark-agreements.records'),
          },
          { concurrency: 2 },
        ),
      ),
      Effect.tap((value) =>
        Effect.sync(() => {
          setSnapshot(value.records);
          setCustomers(value.customers);
        }),
      ),
      Effect.tap((value) =>
        value.records.contracts.some((record) => record.kind === 'LEASE')
          ? loadRentalReferences().pipe(
              Effect.match({
                onFailure: (error) => setRentalFeedback(failureFeedback(error)),
                onSuccess: () => setContractKind('LEASE'),
              }),
            )
          : Effect.void,
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
  const referenceAudiences = (command: AgreementsCommand): readonly string[] =>
    Match.value(command).pipe(
      Match.tags({
        ActivateContract: ({ contractRef }) =>
          contractReferenceAudiences(
            snapshot?.contracts.find((item) => item.contractRef.resourceId === contractRef.resourceId),
          ),
        ArchiveDocument: () => [],
        CreateContract: ({ record }) => contractReferenceAudiences(record),
        CreateDocument: () => [],
        FinalizeDocument: () => [],
        ObserveSignature: () => [],
        RecordSignedDocument: () => [],
        RenewContract: ({ successor }) => contractReferenceAudiences(successor),
        SendSignature: () => ['party-registry'],
        TerminateContract: () => [],
        UpdateContract: ({ record }) => contractReferenceAudiences(record),
        UpdateDocument: () => [],
      }),
      Match.exhaustive,
    );
  const runCommand = (command: AgreementsCommand) => {
    if (snapshot === undefined) {
      return;
    }
    setFeedback('saving');
    run(
      Effect.all(
        {
          idempotencyKey: newUuid,
          referenceCredentials: makeReferenceGatewayCredentials(referenceAudiences(command)),
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
    const customer = customers.find((record) => record.partyId === customerId && record.status === 'ACTIVE');
    const counterpartyRef = contractKind === 'LEASE' ? occupancy?.customerCounterpartyRef : customer?.counterpartyRef;
    if (
      counterpartyRef === null ||
      counterpartyRef === undefined ||
      (contractKind === 'LEASE' && (occupancy === undefined || unit === undefined))
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
              _tag: 'CreateContract',
              record: {
                contractRef: {
                  moduleId: 'siampark.agreements',
                  resourceId,
                  resourceType: 'siampark.agreements.contract',
                  tenantId: counterpartyRef.tenantId,
                },
                counterpartyRef,
                endDate: endDate || null,
                kind: contractKind,
                lifecycleState: 'DRAFT',
                note: null,
                occupancyRef: contractKind === 'LEASE' ? (occupancy?.occupancyRef ?? null) : null,
                propertyRef: contractKind === 'LEASE' ? (unit?.propertyRef ?? null) : null,
                renewalNoticeDate: null,
                signatureState: 'NOT_SENT',
                startDate,
                supersedesContractRef: null,
                unitRef: contractKind === 'LEASE' ? (occupancy?.unitRef ?? null) : null,
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
    setContractKind(selected.kind);
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
  const recordSignature = (record: Contract) => {
    if ([signedReference, signedFileName, signedBy, signedOn].some((value) => value.trim().length === 0)) {
      setFeedback('validation');
      return;
    }
    run(
      Effect.all({ resourceId: newUuid, timestamp: DateTime.now }, { concurrency: 1 }).pipe(
        Effect.tap(({ resourceId, timestamp }) =>
          Effect.sync(() => {
            const now = DateTime.formatIso(timestamp);
            runCommand({
              _tag: 'RecordSignedDocument',
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
                fileName: signedFileName,
                kind: record.kind,
                lifecycleState: 'FINAL',
                signedDocumentReference: signedReference,
                title: t('siampark-agreements.demo.manualSignedDocument'),
                updatedAt: now,
              },
              signedBy,
              signedOn,
            });
          }),
        ),
        Effect.match({ onFailure: reportFailure, onSuccess: () => setFeedback('saving') }),
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
  const formView = {
    showCommercialCustomer: !editingDraft && contractKind === 'OTHER',
    showRentalFeedback: rentalFeedback !== undefined && contractKind === 'LEASE',
    showRentalSelector: !editingDraft && contractKind === 'LEASE',
  };
  return {
    busy,
    contractKind,
    createContract,
    customerId,
    customers,
    editDraft,
    editingDraft,
    endDate,
    expiringOnly,
    feedback,
    formView,
    language,
    occupancies,
    occupancyId,
    properties,
    recordSignature,
    refresh,
    renew,
    rentalFeedback,
    resetDraftForm,
    runCommand,

    saveDraft,
    selectContractKind,
    selected,
    setCustomerId,
    setEndDate,
    setExpiringOnly,
    setOccupancyId,
    setSelectedId: (value: string) => {
      setSelectedId(value);
      resetDraftForm();
    },
    setSignedBy,
    setSignedFileName,
    setSignedOn,
    setSignedReference,
    setStartDate,
    signedBy,
    signedFileName,
    signedOn,
    signedReference,
    snapshot,
    startDate,
    t,
    unitName,
    visible,
  };
};
