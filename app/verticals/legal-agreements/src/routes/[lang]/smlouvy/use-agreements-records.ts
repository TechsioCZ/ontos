import { failureFeedback } from '../../../../shared/actions/apply-command.ts';
import { browserRuntime } from '../../../runtime/browser-effect-runtime.ts';
import type { ActionProposalAccepted } from '@app/core-runtime/http/action-proposal';
import { pageDataPending } from '@app/shared-contracts/page-data';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useNavigate } from '@modern-js/plugin-tanstack/runtime';
import { DateTime, Effect, Match, Option, Schema } from 'effect';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { AgreementsCommand, Feedback } from '../../../../shared/actions/apply-command.ts';
import type { Contract, Document } from '../../../../shared/apis/records.ts';
import { ContractRefSchema } from '../../../../shared/resources/contract.ts';
import type { ContractRef } from '../../../../shared/resources/contract.ts';
import { executeApplyCommand } from '../../../api/apply-command-action-client.ts';
import { createAgreement, newUuid, savePeriodDraft, sendAgreementsCommand } from './agreements-command.ts';
import type { AgreementOutcome } from './agreements-command.ts';
import {
  DEFAULT_END_DATE,
  DEFAULT_START_DATE,
  contractReferenceAudiences,
  contractTerms,
  editableDraft,
} from './agreement-draft.ts';
import type { CreateDraft, PeriodDraft } from './agreement-draft.ts';
import {
  agreements,
  agreementsView,
  loadRentalReferences,
  useAgreementsDataset,
  agreementCustomerData,
  useAgreementDetails,
} from './agreements-data.ts';
import type { AgreementsInput, RentalReferences } from './agreements-data.ts';
import { contractTitle } from './contract-title.ts';
import { useOpenCreated } from './use-open-created.ts';
import { agreementDocumentState, selectorOfFields } from './document-selection.ts';
import { termsSaveResult } from './contract-terms-draft.ts';
import type { ContractTermsCommand } from './contract-terms-draft.ts';
import { executeRecords } from '../../../api/records-client.ts';

const sameContractRef = Schema.toEquivalence(ContractRefSchema);
/**
 * Documents belong to a contract only when every reference part matches. A shared resource id in another tenant,
 * owner module, or resource type identifies a different record and must not appear in the detail.
 */
export const documentsForContract = (
  documents: readonly Document[],
  contract?: { readonly contractRef: ContractRef },
): readonly Document[] =>
  contract === undefined
    ? []
    : documents.filter(
        (document) => document.contractRef !== null && sameContractRef(document.contractRef, contract.contractRef),
      );
/**
 * The Save button of the terms panel: one save against the revision its draft builds on. The revision covers every
 * agreement, so a conflict is resent once against a fresh read while `unchanged` holds for the contracts read then. A
 * change parked for approval is not saved: the draft stays unconfirmed on its base revision.
 */
export const saveTerms = (
  command: ContractTermsCommand,
  expectedRevision: number,
  unchanged: (contracts: readonly Contract[]) => boolean,
  onProposal?: (proposal: ActionProposalAccepted) => void,
) => {
  const send = (revision: number) =>
    newUuid.pipe(
      Effect.flatMap((idempotencyKey) =>
        executeApplyCommand({ command, expectedRevision: revision }, 'legal-agreements.command', {
          idempotencyKey,
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              agreements.invalidate();
              agreementCustomerData.invalidate();
            }),
          ),
        ),
      ),
    );
  return termsSaveResult(
    send(expectedRevision).pipe(
      Effect.catchTag('ApplyCommandActionConflictProblem', (conflict) =>
        conflict.code === 'agreements_conflict'
          ? executeRecords({}, 'legal-agreements.records').pipe(
              Effect.flatMap((fresh) => (unchanged(fresh.contracts) ? send(fresh.revision) : Effect.fail(conflict))),
            )
          : Effect.fail(conflict),
      ),
    ),
    onProposal,
  );
};
/** The open contract form: a new contract, or the period of the draft contract it was opened for. */
export type DraftForm =
  | { readonly kind: Contract['kind']; readonly mode: 'create' }
  | { readonly contract: Contract; readonly mode: 'edit' };
export const useRecordsPage = (input: AgreementsInput) => {
  const { language, t } = useModernI18n();
  const data = useAgreementsDataset(input);
  const navigate = useNavigate();
  const cancellation = useRef<AbortController | null>(null);
  const run = <A, E>(effect: Effect.Effect<A, E>) => {
    const controller = cancellation.current ?? new AbortController();
    cancellation.current = controller;
    void browserRuntime.runPromiseExit(effect, { signal: controller.signal });
  };
  const page = useSyncExternalStore(
    (listener) => data.subscribe(listener, input),
    () => data.snapshot(input),
    () => pageDataPending,
  );
  const { documentId: linkedDocumentId, resourceId: linkedResourceId, selectorIssue } = input;
  useEffect(
    () => () => {
      cancellation.current?.abort();
    },
    [cancellation],
  );
  /** Set when a command was denied or the owner became unavailable; hides the data until the next reload. */
  const [sensitiveHidden, setSensitiveHidden] = useState(false);
  const [actionFeedback, setActionFeedback] = useState<Feedback>();
  /** The person's last change that was parked for approval instead of being applied. */
  const [proposal, setProposal] = useState<ActionProposalAccepted>();
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
    customers,
    feedback,
    occupancies,
    properties,
    records: snapshot,
    rental,
    rentalFeedback,
  } = view;
  const documentState = agreementDocumentState({
    feedback,
    records: snapshot,
    selector: selectorOfFields(input),
    tenantId: input.context?.tenantId,
  });
  /** The open contract form: a new contract, or the period of the draft contract it was opened for. */
  const [draftForm, setDraftForm] = useState<DraftForm>();
  /** The contract a create form saved; the page opens it once, after the form is gone. */
  const setCreated = useOpenCreated(draftForm !== undefined, linkedResourceId, (resourceId) => {
    void navigate({ search: { resourceId }, to: '.' });
  });
  const [signedReference, setSignedReference] = useState('');
  const [signedFileName, setSignedFileName] = useState('');
  const [signedBy, setSignedBy] = useState('');
  const [signedOn, setSignedOn] = useState('');
  const [expiringOnly, setExpiringOnly] = useState(false);
  const [termsOpen, setTermsOpen] = useState(false);
  const selected = snapshot?.contracts.find((record) => record.contractRef.resourceId === linkedResourceId);
  const clearSensitiveState = () => {
    setSensitiveHidden(true);
    setRequestedRental(undefined);
    setRequestedRentalFeedback(undefined);
    setDraftForm(undefined);
    setSignedReference('');
    setSignedFileName('');
    setSignedBy('');
    setSignedOn('');
    setTermsOpen(false);
  };
  const reportFeedback = (nextFeedback: Feedback) => {
    if (nextFeedback === 'forbidden' || nextFeedback === 'unavailable') {
      cancellation.current?.abort();
      cancellation.current = new AbortController();
      clearSensitiveState();
    }
    setActionFeedback(nextFeedback);
    if (nextFeedback === 'conflict') {
      // Someone changed the agreements meanwhile: show their version before the person tries again.
      run(data.refresh(input));
    }
  };
  const reportFailure = (failure: { readonly _tag: string; readonly status?: number }) => {
    reportFeedback(failureFeedback(failure));
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
  /** Retries after a failure in place: the current list stays visible until the owners answered. */
  const retry = () => {
    setActionFeedback('loading');
    setSensitiveHidden(false);
    run(data.refresh(input).pipe(Effect.andThen(Effect.sync(() => setActionFeedback(undefined)))));
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
  /** Opens the contract a committed command created or changed, once the refreshed agreements hold it. */
  const openCommitted = (resourceId: string | undefined) => {
    const latest = data.snapshot(input);
    const record = (latest.state === 'ready' ? Option.getOrUndefined(latest.value) : undefined)?.records.contracts.find(
      (item) => item.contractRef.resourceId === resourceId,
    );
    if (record !== undefined && linkedResourceId !== record.contractRef.resourceId) {
      void navigate({ search: { resourceId: record.contractRef.resourceId }, to: '.' });
    }
  };
  const invalidate = Effect.sync(() => {
    data.invalidate();
    agreementCustomerData.invalidate();
  });
  /** Re-reads the agreements; a failed read shows on the page, the outcome of the write stands. */
  const refreshAgreements = data.refresh(input).pipe(Effect.ignore);
  /**
   * A command's outcome for a form: a saved change re-reads the agreements first, so the form sees what it saved; a
   * conflict re-reads them too, so "Načíst aktuální verzi" offers the newer version; a parked change is reported.
   */
  const settleForm = (outcome: AgreementOutcome) =>
    Match.value(outcome).pipe(
      Match.tags({
        Conflict: () => refreshAgreements,
        Proposed: ({ proposal: parked }) => Effect.sync(() => setProposal(parked)),
        Saved: () => refreshAgreements,
      }),
      Match.orElse(() => Effect.void),
      Effect.as(outcome),
    );
  const showCommitted = (resourceId: string | undefined) => {
    openCommitted(resourceId);
    setActionFeedback(undefined);
  };
  const showProposal = (parked: ActionProposalAccepted) => {
    setProposal(parked);
    setActionFeedback(undefined);
  };
  /** How the page shows the outcome of a one-click command. */
  const settleCommand = (outcome: AgreementOutcome): Effect.Effect<void> =>
    Match.value(outcome).pipe(
      Match.tagsExhaustive({
        Conflict: () => Effect.sync(() => reportFeedback('conflict')),
        Failed: ({ reason }) => Effect.sync(() => reportFeedback(reason)),
        // A change parked for approval changed nothing yet: no reload and no record to open.
        Proposed: ({ proposal: parked }) => Effect.sync(() => showProposal(parked)),
        Saved: ({ resourceRef }) =>
          data
            .refresh(input)
            .pipe(Effect.match({ onFailure: reportFailure, onSuccess: () => showCommitted(resourceRef.resourceId) })),
      }),
    );
  /** One-click commands (activate, renew, terminate, archive, signature): the page's feedback shows the outcome. */
  const runCommand = (command: AgreementsCommand) => {
    if (snapshot === undefined) {
      return;
    }
    setProposal(undefined);
    setActionFeedback('saving');
    run(
      sendAgreementsCommand(command, snapshot.revision, { audiences: referenceAudiences(command) }).pipe(
        Effect.ensuring(invalidate),
        Effect.flatMap(settleCommand),
      ),
    );
  };

  /**
   * The Save button of the new-contract form. It is sent against the agreements as read now; a conflict caused by
   * another agreement is resent once, as a new contract cannot overwrite anyone's change.
   */
  const createContract = (draft: CreateDraft): Effect.Effect<AgreementOutcome> =>
    createAgreement(draft, {
      expectedRevision: snapshot?.revision ?? 0,
      references: { customers, occupancies: occupancies?.occupancies ?? [], units: properties?.units ?? [] },
    }).pipe(Effect.ensuring(invalidate), Effect.flatMap(settleForm));
  const savePeriod = (
    draft: PeriodDraft,
    expectedRevision: number,
    confirmed: PeriodDraft,
  ): Effect.Effect<AgreementOutcome> =>
    savePeriodDraft(draft, expectedRevision, confirmed).pipe(Effect.ensuring(invalidate), Effect.flatMap(settleForm));
  const editDraft = () => {
    if (selected === undefined || !editableDraft(selected)) {
      return;
    }
    setChosenContractKind(selected.kind);
    setDraftForm({ contract: selected, mode: 'edit' });
  };
  const resetDraftForm = () => {
    setDraftForm({ kind: contractKind, mode: 'create' });
  };
  const closeDraftForm = () => {
    setDraftForm(undefined);
  };
  /** The create form saved `resourceId`: the form closes, then the page opens the new contract. */
  const openCreated = (resourceId: string) => {
    setCreated(resourceId);
    setDraftForm(undefined);
  };
  const openTerms = () => {
    if (selected !== undefined) {
      setTermsOpen(true);
    }
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
                endDate: DEFAULT_END_DATE,
                kind: record.kind,
                lifecycleState: 'DRAFT',
                note: record.note,
                occupancyRef: record.occupancyRef,
                propertyRef: record.propertyRef,
                renewalNoticeDate: null,
                signatureState: 'NOT_SENT',
                startDate: record.endDate ?? DEFAULT_START_DATE,
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
  const { customerName, customerNameFeedback } = useAgreementDetails(input, selected, visible, snapshot);
  const busy = feedback === 'loading' || feedback === 'saving';
  const counterpartyOf = (record: Contract | undefined) =>
    record === undefined
      ? undefined
      : customers.find((item) => item.counterpartyRef.resourceId === record.counterpartyRef.resourceId);
  const detailView = {
    canActivate: selected?.lifecycleState === 'DRAFT',
    canEdit: selected !== undefined && editableDraft(selected),
    canEditTerms: selected?.lifecycleState === 'DRAFT' || selected?.lifecycleState === 'ACTIVE',
    canRecordSignature:
      selected !== undefined &&
      ['DRAFT', 'ACTIVE'].includes(selected.lifecycleState) &&
      ['NOT_SENT', 'DECLINED'].includes(selected.signatureState),
    canRenew: selected?.lifecycleState === 'ACTIVE',
    documents: documentsForContract(snapshot?.documents ?? [], selected),
  };
  return {
    busy,
    closeDraftForm,
    contractKind,
    counterpartyOf,
    createContract,
    customerName,
    customerNameFeedback,
    customers,
    detailView,
    documentState,
    draftForm,
    editDraft,
    expiringOnly,
    feedback,
    language,
    linkedDocumentId,
    linkedResourceId,
    occupancies,
    openCreated,
    openTerms,
    properties,
    proposal,
    recordSignature,
    refreshAgreements,
    renew,
    rentalFeedback,
    reportProposal: setProposal,
    resetDraftForm,
    retry,
    runCommand,
    savePeriod,
    selectContractKind,
    selected,
    selectorIssue,
    setExpiringOnly,
    setSignedBy,
    setSignedFileName,
    setSignedOn,
    setSignedReference,
    setTermsOpen,
    signedBy,
    signedFileName,
    signedOn,
    signedReference,
    snapshot,
    t,
    termsOpen,
    titleOf,
    unitName,
    visible,
  };
};
