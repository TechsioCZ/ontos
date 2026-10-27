import { failureFeedback } from '../../../../shared/actions/apply-command.ts';
import { browserRuntime } from '../../../runtime/browser-effect-runtime.ts';
import { makeReferenceGatewayCredentials } from '@app/shared-contracts';
import { pageDataPending } from '@app/shared-contracts/page-data';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useNavigate } from '@modern-js/plugin-tanstack/runtime';
import { Crypto, DateTime, Effect, Match, Option, PlatformError } from 'effect';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { AgreementsCommand, Feedback } from '../../../../shared/actions/apply-command.ts';
import type { Contract } from '../../../../shared/apis/records.ts';
import { executeApplyCommand } from '../../../api/apply-command-action-client.ts';
import { agreements, agreementsView, loadRentalReferences } from './agreements-data.ts';
import type { AgreementsInput, RentalReferences } from './agreements-data.ts';
import { contractTitle } from './contract-title.ts';

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
const newUuid = browserCrypto.randomUUIDv4();
/** The optional commercial terms of a contract, carried over when a draft is edited or a contract renewed. */
type ContractTerms = {
  -readonly [Key in 'noticePeriod' | 'rentTerms' | 'responsiblePerson' | 'subject']?: Contract[Key];
};
export const contractTerms = (record: Contract): ContractTerms => {
  const terms: ContractTerms = {};
  if (record.noticePeriod !== undefined) {
    terms.noticePeriod = record.noticePeriod;
  }
  if (record.rentTerms !== undefined) {
    terms.rentTerms = record.rentTerms;
  }
  if (record.responsiblePerson !== undefined) {
    terms.responsiblePerson = record.responsiblePerson;
  }
  if (record.subject !== undefined) {
    terms.subject = record.subject;
  }
  return terms;
};
const crowns = (minor: number) => (minor % 100 === 0 ? String(minor / 100) : (minor / 100).toFixed(2));
const parseCrowns = (value: string) => {
  const normalized = value.replaceAll(/\s/gu, '').replace(',', '.');
  return /^\d+(?:\.\d{1,2})?$/u.test(normalized) ? Math.round(Number(normalized) * 100) : undefined;
};
const optionalText = (value: string) => (value.trim().length === 0 ? undefined : value.trim());
type SetContractTermsCommand = {
  -readonly [Key in keyof Extract<AgreementsCommand, { readonly _tag: 'SetContractTerms' }>]: Extract<
    AgreementsCommand,
    { readonly _tag: 'SetContractTerms' }
  >[Key];
};

const contractReferenceAudiences = (record: Contract | undefined) => {
  const audiences = ['party-registry'];
  if (record !== undefined && record.unitRef !== null) {
    audiences.push('property-portfolio', 'property-portfolio');
  }
  if (record !== undefined && record.occupancyRef !== null) {
    audiences.push('property-leasing');
  }
  return audiences;
};
export const useRecordsPage = (input: AgreementsInput) => {
  const { language, t } = useModernI18n();
  const navigate = useNavigate();
  const cancellation = useRef<AbortController | null>(null);
  const run = <A, E>(effect: Effect.Effect<A, E>) => {
    const controller = cancellation.current ?? new AbortController();
    cancellation.current = controller;
    void browserRuntime.runPromiseExit(effect, { signal: controller.signal });
  };
  const page = useSyncExternalStore(
    agreements.subscribe,
    () => agreements.snapshot(input),
    () => pageDataPending,
  );
  const { legalEntityId, resourceId: linkedResourceId } = input;
  useEffect(
    () => agreements.ensure({ legalEntityId, resourceId: linkedResourceId }),
    [legalEntityId, linkedResourceId],
  );
  useEffect(
    () => () => {
      cancellation.current?.abort();
    },
    [cancellation],
  );
  /** Set when a command was denied or the owner became unavailable; hides the data until the next reload. */
  const [sensitiveHidden, setSensitiveHidden] = useState(false);
  const [actionFeedback, setActionFeedback] = useState<Feedback>();
  /** Rental references read on demand when the person picks a lease and the page did not prepare them. */
  const [requestedRental, setRequestedRental] = useState<RentalReferences>();
  const [requestedRentalFeedback, setRequestedRentalFeedback] = useState<Feedback>();
  const [chosenContractKind, setChosenContractKind] = useState<Contract['kind']>();
  const view = agreementsView(page, {
    actionFeedback,
    chosenContractKind,
    hidden: sensitiveHidden,
    requestedRental,
    requestedRentalFeedback,
  });
  const {
    contractKind,
    customerName,
    customerNameFeedback,
    customers,
    feedback,
    occupancies,
    properties,
    records: snapshot,
    rental,
    rentalFeedback,
  } = view;
  const [formOpen, setFormOpen] = useState(false);
  const [customerId, setCustomerId] = useState('');
  const [signedReference, setSignedReference] = useState('');
  const [signedFileName, setSignedFileName] = useState('');
  const [signedBy, setSignedBy] = useState('');
  const [signedOn, setSignedOn] = useState('');
  const [occupancyId, setOccupancyId] = useState('');
  const [startDate, setStartDate] = useState(DEFAULT_START_DATE);
  const [endDate, setEndDate] = useState(DEFAULT_END_DATE);
  const [editingDraft, setEditingDraft] = useState(false);
  const [expiringOnly, setExpiringOnly] = useState(false);
  const [termsOpen, setTermsOpen] = useState(false);
  const [terms, setTerms] = useState({
    monthly: '',
    noticePeriod: '',
    paymentDay: '15',
    responsiblePerson: '',
    service: '',
    subject: '',
  });
  const selected = snapshot?.contracts.find((record) => record.contractRef.resourceId === linkedResourceId);
  const clearSensitiveState = () => {
    setSensitiveHidden(true);
    setCustomerId('');
    setRequestedRental(undefined);
    setRequestedRentalFeedback(undefined);
    setFormOpen(false);
    setSignedReference('');
    setSignedFileName('');
    setSignedBy('');
    setSignedOn('');
    setOccupancyId('');
    setStartDate(DEFAULT_START_DATE);
    setEndDate(DEFAULT_END_DATE);
    setEditingDraft(false);
    setTermsOpen(false);
  };
  const reportFailure = (failure: { readonly _tag: string; readonly status?: number }) => {
    const nextFeedback = failureFeedback(failure);
    if (nextFeedback === 'forbidden' || nextFeedback === 'unavailable') {
      cancellation.current?.abort();
      cancellation.current = new AbortController();
      clearSensitiveState();
    }
    setActionFeedback(nextFeedback);
  };
  const selectContractKind = (kind: Contract['kind']) => {
    setChosenContractKind(kind);
    setRequestedRentalFeedback(undefined);
    if (kind === 'LEASE' && rental === undefined) {
      run(
        loadRentalReferences.pipe(
          Effect.match({
            onFailure: (error) => setRequestedRentalFeedback(failureFeedback(error)),
            onSuccess: (value) => {
              setRequestedRental(value);
              setRequestedRentalFeedback(undefined);
            },
          }),
        ),
      );
    }
  };
  /** Reloads in place: the current list stays visible until the owners answered. */
  const refresh = () => {
    setActionFeedback('loading');
    setSensitiveHidden(false);
    run(agreements.refresh(input).pipe(Effect.andThen(Effect.sync(() => setActionFeedback(undefined)))));
  };
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
        RecordSignedDocument: () => [],
        RenewContract: ({ successor }) => contractReferenceAudiences(successor),
        SetContractTerms: () => [],
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
    setActionFeedback('saving');
    run(
      Effect.all(
        {
          idempotencyKey: newUuid,
          referenceCredentials: makeReferenceGatewayCredentials(referenceAudiences(command)),
        },
        { concurrency: 2 },
      ).pipe(
        Effect.flatMap(({ idempotencyKey, referenceCredentials }) =>
          executeApplyCommand({ command, expectedRevision: snapshot.revision }, 'legal-agreements.command', {
            idempotencyKey,
            referenceCredentials,
          }),
        ),
        Effect.tap(() => agreements.refresh(input)),
        Effect.tap((result) => {
          const latest = agreements.snapshot(input);
          const record = (
            latest.state === 'ready' ? Option.getOrUndefined(latest.value) : undefined
          )?.records.contracts.find((item) => item.contractRef.resourceId === result.resourceRef?.resourceId);
          return record !== undefined && linkedResourceId !== record.contractRef.resourceId
            ? Effect.sync(() => {
                void navigate({ search: { resourceId: record.contractRef.resourceId }, to: '.' });
              })
            : Effect.void;
        }),
        Effect.match({
          onFailure: reportFailure,
          onSuccess: () => setActionFeedback(undefined),
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
      setActionFeedback('validation');
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
                  moduleId: 'legal.agreements',
                  resourceId,
                  resourceType: 'legal.agreements.contract',
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
    setChosenContractKind(selected.kind);
    setStartDate(selected.startDate);
    setEndDate(selected.endDate ?? '');
    setEditingDraft(true);
    setFormOpen(true);
  };
  const resetDraftForm = () => {
    setFormOpen(true);
    setCustomerId('');
    setEditingDraft(false);
    setOccupancyId('');
    setStartDate(DEFAULT_START_DATE);
    setEndDate(DEFAULT_END_DATE);
  };
  const saveDraft = () => {
    if (selected?.lifecycleState !== 'DRAFT' || selected.signatureState !== 'NOT_SENT') {
      setActionFeedback('validation');
      return;
    }
    runCommand({
      _tag: 'UpdateContract',
      record: {
        ...contractTerms(selected),
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
  const openTerms = () => {
    if (selected === undefined) {
      return;
    }
    setTerms({
      monthly: selected.rentTerms === undefined ? '' : crowns(selected.rentTerms.monthlyRentMinor),
      noticePeriod: selected.noticePeriod ?? '',
      paymentDay: String(selected.rentTerms?.paymentDay ?? 15),
      responsiblePerson: selected.responsiblePerson ?? '',
      service: selected.rentTerms === undefined ? '' : crowns(selected.rentTerms.serviceChargesMinor),
      subject: selected.subject ?? '',
    });
    setTermsOpen(true);
  };
  const saveTerms = () => {
    if (selected === undefined) {
      return;
    }
    const hasRent = terms.monthly.trim().length > 0;
    const monthlyRentMinor = parseCrowns(terms.monthly);
    const serviceChargesMinor = terms.service.trim().length === 0 ? 0 : parseCrowns(terms.service);
    const paymentDay = Number(terms.paymentDay);
    if (
      hasRent &&
      (monthlyRentMinor === undefined ||
        serviceChargesMinor === undefined ||
        !Number.isInteger(paymentDay) ||
        paymentDay < 1 ||
        paymentDay > 31)
    ) {
      setActionFeedback('validation');
      return;
    }
    const subject = optionalText(terms.subject);
    const responsiblePerson = optionalText(terms.responsiblePerson);
    const noticePeriod = optionalText(terms.noticePeriod);
    setTermsOpen(false);
    const command: SetContractTermsCommand = {
      _tag: 'SetContractTerms',
      contractRef: selected.contractRef,
    };
    if (subject !== undefined) {
      command.subject = subject;
    }
    if (responsiblePerson !== undefined) {
      command.responsiblePerson = responsiblePerson;
    }
    if (noticePeriod !== undefined) {
      command.noticePeriod = noticePeriod;
    }
    if (hasRent && monthlyRentMinor !== undefined && serviceChargesMinor !== undefined) {
      command.rentTerms = { currency: 'CZK', monthlyRentMinor, paymentDay, serviceChargesMinor };
    }
    runCommand(command);
  };
  const recordSignature = (record: Contract) => {
    if ([signedReference, signedFileName, signedBy, signedOn].some((value) => value.trim().length === 0)) {
      setActionFeedback('validation');
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
                  moduleId: 'legal.agreements',
                  resourceId,
                  resourceType: 'legal.agreements.document',
                  tenantId: record.contractRef.tenantId,
                },
                fileName: signedFileName,
                kind: record.kind,
                lifecycleState: 'FINAL',
                signedDocumentReference: signedReference,
                title: t('legal-agreements.demo.manualSignedDocument'),
                updatedAt: now,
              },
              signedBy,
              signedOn,
            });
          }),
        ),
        Effect.match({ onFailure: reportFailure, onSuccess: () => setActionFeedback('saving') }),
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
                ...contractTerms(record),
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
    t('legal-agreements.demo.noUnit');
  const titleOf = (record: Contract) =>
    contractTitle(
      record,
      properties?.units.find((unit) => unit.unitRef.resourceId === record.unitRef?.resourceId)?.name,
      customers.find((customer) => customer.counterpartyRef.resourceId === record.counterpartyRef.resourceId)
        ?.displayName,
      t('legal-agreements.demo.unnamedContract'),
    );
  const visible = snapshot?.contracts.filter((record) => !expiringOnly || record.expiringSoon) ?? [];
  const busy = feedback === 'loading' || feedback === 'saving';
  const formView = {
    showCommercialCustomer: !editingDraft && contractKind === 'OTHER',
    showRentalFeedback: rentalFeedback !== undefined && contractKind === 'LEASE',
    showRentalSelector: !editingDraft && contractKind === 'LEASE',
  };
  const counterpartyOf = (record: Contract | undefined) =>
    record === undefined
      ? undefined
      : customers.find((item) => item.counterpartyRef.resourceId === record.counterpartyRef.resourceId);
  const detailView = {
    canActivate: selected?.lifecycleState === 'DRAFT',
    canEdit: selected?.lifecycleState === 'DRAFT' && selected.signatureState === 'NOT_SENT',
    canEditTerms: selected?.lifecycleState === 'DRAFT' || selected?.lifecycleState === 'ACTIVE',
    canRecordSignature:
      selected !== undefined &&
      ['DRAFT', 'ACTIVE'].includes(selected.lifecycleState) &&
      ['NOT_SENT', 'DECLINED'].includes(selected.signatureState),
    canRenew: selected?.lifecycleState === 'ACTIVE',
    documents:
      snapshot?.documents.filter((record) => record.contractRef?.resourceId === selected?.contractRef.resourceId) ?? [],
  };
  return {
    busy,
    contractKind,
    counterpartyOf,
    createContract,
    customerId,
    customerName,
    customerNameFeedback,
    customers,
    detailView,
    editDraft,
    editingDraft,
    endDate,
    expiringOnly,
    feedback,
    formOpen,
    formView,
    language,
    linkedResourceId,
    occupancies,
    occupancyId,
    openTerms,
    properties,
    recordSignature,
    refresh,
    renew,
    rentalFeedback,
    resetDraftForm,
    runCommand,
    saveDraft,
    saveTerms,
    selectContractKind,
    selected,
    setCustomerId,

    setEndDate,
    setExpiringOnly,
    setFormOpen,
    setOccupancyId,
    setSignedBy,
    setSignedFileName,
    setSignedOn,
    setSignedReference,
    setStartDate,
    setTerms,
    setTermsOpen,
    signedBy,
    signedFileName,
    signedOn,
    signedReference,
    snapshot,
    startDate,
    t,
    terms,
    termsOpen,
    titleOf,
    unitName,
    visible,
  };
};
