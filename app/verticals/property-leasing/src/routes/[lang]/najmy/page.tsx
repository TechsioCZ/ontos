import { LinkButton } from '@techsio/ui-kit/atoms/link-button';
import {
  SaveBar,
  DetailList,
  DocumentTitle,
  PageHeader,
  SectionCard,
  SidePanel,
  StatCard,
  UnsavedChangesDialog,
  formatDate,
  formatMoney,
  saveLabelsFor,
  surfaceCardClassName,
  surfaceTileClassName,
  useRecordDraft,
  useUnsavedChangesGuard,
} from '@app/admin-ui';
import type { RevisionedSaveResult, SaveOutcome } from '@app/admin-ui';
import { failureFeedback } from '../../../../shared/actions/apply-command.ts';
import { browserRuntime } from '../../../runtime/browser-effect-runtime.ts';
import { makeReferenceGatewayCredentials } from '@app/shared-contracts';
import type { ModulePageProps, PageDataSnapshot } from '@app/shared-contracts/page-data';
import { modulePagePreload } from '@app/shared-contracts/page-data';
import { createCustomer, listCustomers, loadPartiesClient } from '@app/party-registry/api/client';
import { PartyDocuments, PropertyEquipment } from '@app/facility-operations/ui/record-discussion';
import { FederatedI18nBoundary, useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useBlocker, useRouterState } from '@modern-js/plugin-tanstack/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { FormInput } from '@app/admin-ui/form-controls';
import { Table } from '@techsio/ui-kit/organisms/table';
import { ActionProposalAcceptedSchema } from '@app/core-runtime/http/action-proposal';
import type { ActionProposalAccepted } from '@app/core-runtime/http/action-proposal';
import { DateTime, Effect, Match, Option, Predicate, Schema } from 'effect';
import { useEffect, useEffectEvent, useId, useReducer, useRef, useState } from 'react';

import type { OccupancyCommand, Feedback } from '../../../../shared/actions/apply-command.ts';
import type { Occupancy, RentTerms } from '../../../../shared/apis/records.ts';
import { decodeRecordsSearch } from '../../../../shared/domain/records-search.ts';
import {
  ContractCard,
  InvoicesCard,
  LeaseStoryNav,
  RentTermsCard,
  TasksCard,
  TenantCard,
  UnitCard,
  leaseContract,
  loadedList,
  monthlyTotal,
} from './lease-story.tsx';
import { executeApplyCommand } from '../../../api/apply-command-action-client.ts';
import { UltramodernRouteHead } from '../../ultramodern-route-head';
import csResource from '../../../../locales/cs/property-leasing.json';
import enResource from '../../../../locales/en/property-leasing.json';
import '../../index.css';
import { TenantDirectory, TenantDossierCard } from './tenant-dossier.tsx';
import type { DossierSave, DossierChanges, NewCounterpartyInput } from './tenant-dossier.tsx';
import { CounterpartyDossierView } from './counterparty-dossier.tsx';
import { NoticeCard, OccupancyHistoryCard, RegistrationSheetCard } from './stay-documents.tsx';
import type { NoticeContext } from './notice-templates.ts';
import { OccupancyCalendar } from './occupancy-calendar.tsx';
import './occupancy-form.css';
import {
  initialEditorState,
  occupancyDraftOf,
  occupancyEditorActions,
  occupancyEditorReducer,
} from './editor-state.ts';
import { createOccupancy, failedWith, saveLeaseDraft, sendAddition, settleAddition } from './occupancy-command.ts';
import type { AdditionSave, OccupancyOutcome } from './occupancy-command.ts';
import { leaseDraftRecord, stayDraftRecord, updateDraftCommand } from './occupancy-draft.ts';
import { OccupancyEditorPanel } from './occupancy-editor-panel.tsx';
import type { OccupancySave } from './occupancy-editor-panel.tsx';
import {
  saveLeasingCommand,
  newUuid,
  rentDraftOf,
  rentProblems,
  rentTermsOf,
  rentUnchangedSince,
  sameRentDraft,
} from './leasing-save.ts';
import type { RentDraft } from './leasing-save.ts';
import type { OccupancyDraft, OccupancyEditorMode } from './editor-state.ts';
import {
  leaseInputOf,
  leaseRecords,
  leaseOccupant,
  useLeaseData,
  usePrefetchLeaseOccupants,
  renderedLeaseOccupantRows,
  prepareLeasePage,
} from './lease-occupant.ts';
import type { loadLeaseRecords } from './lease-occupant.ts';
import { invalidateLeaseRelated, preloadLeaseRelated, useLeaseRelated } from './lease-related.ts';

export const preloadPage = modulePagePreload((props) => prepareLeasePage(props, preloadLeaseRelated));

const LABEL_UNIT = 'property-leasing.demo.unit';
const LABEL_DETAIL = 'property-leasing.demo.detail';
const LABEL_OPEN_END = 'property-leasing.demo.openEnd';
const LABEL_CLOSE = 'property-leasing.demo.close';
const pragueDayFormat = new Intl.DateTimeFormat('sv-SE', {
  day: '2-digit',
  month: '2-digit',
  timeZone: 'Europe/Prague',
  year: 'numeric',
});
const currentPragueDay = () => pragueDayFormat.format(DateTime.toEpochMillis(DateTime.nowUnsafe()));
const DEFAULT_START_DATE = currentPragueDay();
const LABEL_EDIT_DRAFT = 'property-leasing.demo.editDraft';
const propertyLeasingI18nResources = {
  cs: { 'property-leasing': csResource },
  en: { 'property-leasing': enResource },
} as const;
type FailureLike = Parameters<typeof failureFeedback>[0];
const loadFeedbackOf = <A, E extends FailureLike>(snapshot: PageDataSnapshot<A, E>): Feedback => {
  if (snapshot.state === 'pending') {
    return 'loading';
  }
  return snapshot.state === 'failed' ? failureFeedback(snapshot.error) : 'ready';
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
  const { detailInput, leaseInput, occupant, records } = useLeaseData(leaseInputOf(context, useId()), search);
  const linkedCounterpartyId = Option.getOrUndefined(search)?.counterpartyId;
  const cancellation = useRef<AbortController | null>(null);
  const run = <A, E>(effect: Effect.Effect<A, E>) => {
    const controller = cancellation.current ?? new AbortController();
    cancellation.current = controller;
    void browserRuntime.runPromiseExit(effect, { signal: controller.signal });
  };
  /** Set when a read refused this role: the loaded records stay hidden until the person retries. */
  const [cleared, setCleared] = useState(false);
  const {
    agreements,
    customerName,
    customerNameFeedback,
    customerNamePending,
    directoryLoaded,
    properties,
    snapshot,
    tenantDirectory,
  } = leaseViewOf(records, occupant, cleared);
  const [draftEditor, dispatchEditor] = useReducer(occupancyEditorReducer, DEFAULT_START_DATE, initialEditorState);
  const {
    customerId,
    customerOpen,
    customers,
    customersLoading,
    editingId,
    endDate,
    guestId,
    guestQuery,
    guests,
    peopleCount,
    rentEditorOpen,
    rentMonthly,
    rentPaymentDay,
    rentService,
    startDate,
    stayNote,
    unitId,
  } = draftEditor;
  const editor = Option.getOrUndefined(draftEditor.editor);
  const setCustomerId = (value: string) =>
    dispatchEditor(occupancyEditorActions.SET_INPUT({ field: 'customerId', value }));
  const setEndDate = (value: string) => dispatchEditor(occupancyEditorActions.SET_INPUT({ field: 'endDate', value }));
  const setGuestId = (value: string) => dispatchEditor(occupancyEditorActions.SET_INPUT({ field: 'guestId', value }));
  const setGuestQuery = (value: string) =>
    dispatchEditor(occupancyEditorActions.SET_INPUT({ field: 'guestQuery', value }));
  const setPeopleCount = (value: string) =>
    dispatchEditor(occupancyEditorActions.SET_INPUT({ field: 'peopleCount', value }));
  const setRentMonthly = (value: string) =>
    dispatchEditor(occupancyEditorActions.SET_INPUT({ field: 'rentMonthly', value }));
  const setRentPaymentDay = (value: string) =>
    dispatchEditor(occupancyEditorActions.SET_INPUT({ field: 'rentPaymentDay', value }));
  const setRentService = (value: string) =>
    dispatchEditor(occupancyEditorActions.SET_INPUT({ field: 'rentService', value }));
  const setStartDate = (value: string) =>
    dispatchEditor(occupancyEditorActions.SET_INPUT({ field: 'startDate', value }));
  const setStayNote = (value: string) => dispatchEditor(occupancyEditorActions.SET_INPUT({ field: 'stayNote', value }));
  const setUnitId = (value: string) => dispatchEditor(occupancyEditorActions.SET_INPUT({ field: 'unitId', value }));
  const setCustomerOpen = (open: boolean) => dispatchEditor(occupancyEditorActions.SET_CUSTOMER_OPEN({ open }));
  const setRentEditorOpen = (open: boolean) => dispatchEditor(occupancyEditorActions.SET_RENT_EDITOR_OPEN({ open }));
  const setEditor = (mode: OccupancyEditorMode | undefined) =>
    dispatchEditor(occupancyEditorActions.SET_EDITOR({ mode: Option.fromUndefinedOr(mode) }));
  /** Outcome of the person's own action; the page's read state shows when there is none. */
  const [actionFeedback, setActionFeedback] = useState<Feedback>();
  const feedback: Feedback = actionFeedback ?? (cleared ? 'forbidden' : loadFeedbackOf(records));
  const [kindFilter, setKindFilter] = useState<'ALL' | 'LONG_TERM_LEASE' | 'SHORT_STAY'>('ALL');
  const [collision, setCollision] = useState<{ readonly href: string; readonly text: string }>();
  const [createError, setCreateError] = useState<string>();
  /** The person's last change that was parked for approval instead of being applied. */
  const [proposal, setProposal] = useState<ActionProposalAccepted>();
  const selected = snapshot?.occupancies.find((record) => record.occupancyRef.resourceId === linkedResourceId);
  const related = useLeaseRelated(
    selected === undefined || snapshot === undefined
      ? undefined
      : { ...leaseInput, record: selected, revision: snapshot.revision },
  );
  const clearSensitiveState = () => {
    dispatchEditor(occupancyEditorActions.CLEAR({ startDate: DEFAULT_START_DATE }));
  };
  /** Re-reads the page's data after the person's own write; the loaded values stay on screen meanwhile. */
  const reload = () =>
    Effect.sync(invalidateLeaseRelated).pipe(
      Effect.andThen(
        Effect.all(
          [
            leaseRecords.refresh(leaseInput),
            detailInput === undefined ? Effect.void : leaseOccupant.refresh(detailInput),
          ],
          { concurrency: 2, discard: true },
        ),
      ),
    );
  const reportFailure = (failure: { readonly _tag: string; readonly status?: number }) => {
    const nextFeedback = failureFeedback(failure);
    if (nextFeedback === 'forbidden' || nextFeedback === 'unavailable') {
      cancellation.current?.abort();
      cancellation.current = new AbortController();
      clearSensitiveState();
      setCleared(true);
    }
    setActionFeedback(nextFeedback);
    if (nextFeedback === 'conflict') {
      // Someone changed the leases meanwhile: show their version before the person tries again.
      run(reload());
    }
  };
  /** Retries after a refused or failed read: clears the hidden state and reads again. */
  const retry = () => {
    cancellation.current?.abort();
    cancellation.current = new AbortController();
    clearSensitiveState();
    setCleared(false);
    setActionFeedback(undefined);
    run(reload());
  };
  useEffect(
    () => () => {
      cancellation.current?.abort();
    },
    [cancellation],
  );
  /** S10-01: names the confirmed stay or lease that blocks the second confirmation of the same unit. */
  const collisionFor = (command: OccupancyCommand): { readonly href: string; readonly text: string } | undefined => {
    if (
      snapshot === undefined ||
      (!Predicate.isTagged(command, 'Confirm') && !Predicate.isTagged(command, 'Activate'))
    ) {
      return undefined;
    }
    const record = snapshot.occupancies.find(
      (item) => item.occupancyRef.resourceId === command.occupancyRef.resourceId,
    );
    if (record === undefined) {
      return undefined;
    }
    const other = snapshot.occupancies.find(
      (item) =>
        item.occupancyRef.resourceId !== record.occupancyRef.resourceId &&
        item.unitRef.resourceId === record.unitRef.resourceId &&
        (item.state === 'CONFIRMED' || item.state === 'ACTIVE') &&
        (item.endDate === null || record.startDate < item.endDate) &&
        (record.endDate === null || item.startDate < record.endDate),
    );
    if (other === undefined) {
      return undefined;
    }
    let party: string | undefined;
    if (other.customerCounterpartyRef !== null) {
      party =
        tenantDirectory.find((item) => item.counterpartyRef.resourceId === other.customerCounterpartyRef?.resourceId)
          ?.displayName ?? undefined;
    } else if (other.guestPartyRef !== null) {
      const cachedOccupant = leaseOccupant.snapshot({ ...leaseInput, record: other, revision: snapshot.revision });
      party = cachedOccupant.state === 'ready' ? cachedOccupant.value : undefined;
    }
    const unit = properties?.units.find((item) => item.unitRef.resourceId === other.unitRef.resourceId)?.name;
    const partySuffix = party === undefined ? '' : ` – ${party}`;
    const stateLabel = t(`property-leasing.demo.stateLabels.${record.state}`);
    return {
      href: `/${language}/najmy?resourceId=${other.occupancyRef.resourceId}`,
      text: `Termínová kolize: jednotka ${unit ?? ''} je v období ${formatDate(other.startDate)} – ${
        other.endDate === null ? 'bez konce' : formatDate(other.endDate)
      } již ${other.state === 'ACTIVE' ? 'obsazena' : 'potvrzeně rezervována'} (${
        other.kind === 'LONG_TERM_LEASE' ? 'nájem' : 'pobyt'
      }${partySuffix}). ${Match.value(command).pipe(
        Match.tag('Confirm', () => 'Potvrzení'),
        Match.tag('Activate', () => 'Zahájení'),
        Match.exhaustive,
      )} bylo odmítnuto, tento záznam zůstává ve stavu ${stateLabel}.`,
    };
  };
  /** Opens the record a committed command created or changed, once the reloaded records hold it. */
  const openCommitted = (resourceId: string | undefined) => {
    const current = leaseRecords.snapshot(leaseInput);
    const record =
      current.state === 'ready'
        ? current.value.records.occupancies.find((item) => item.occupancyRef.resourceId === resourceId)
        : undefined;
    if (record !== undefined && linkedResourceId !== record.occupancyRef.resourceId) {
      const url = new URL(window.location.href);
      url.searchParams.set('resourceId', record.occupancyRef.resourceId);
      url.searchParams.delete('create');
      url.searchParams.delete('unitId');
      window.location.assign(url);
    }
  };
  const runCommand = (command: OccupancyCommand) => {
    if (snapshot === undefined) {
      return;
    }
    setCollision(undefined);
    setProposal(undefined);
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
          }).pipe(Effect.ensuring(Effect.sync(invalidateLeaseRelated))),
        ),
        // A change parked for approval changed nothing yet: no reload and no record to open.
        Effect.flatMap((result) =>
          Schema.is(ActionProposalAcceptedSchema)(result)
            ? Effect.succeed(Option.some(result))
            : reload().pipe(
                Effect.andThen(Effect.sync(() => openCommitted(result.resourceRef?.resourceId))),
                Effect.as(Option.none<ActionProposalAccepted>()),
              ),
        ),
        Effect.match({
          // A refused command keeps the loaded records on screen; only reads clear them.
          onFailure: (failure) => {
            const next = failureFeedback(failure);
            setCollision(next === 'conflict' ? collisionFor(command) : undefined);
            setActionFeedback(next);
          },
          onSuccess: (parked) => {
            setProposal(Option.getOrUndefined(parked));
            setActionFeedback(undefined);
          },
        }),
      ),
    );
  };
  /**
   * Uložit of a form that adds a record (a registration sheet, a prepared notice, a logged entry): one command, resent
   * once against fresh records after an unrelated change, since an addition overwrites nothing; settled as the page's
   * own commands are, so related lists refresh and a saved one is listed.
   */
  const saveAddition: AdditionSave = (command) =>
    snapshot === undefined
      ? Effect.succeed(failedWith('unavailable'))
      : settleAddition(sendAddition(command, snapshot.revision), {
          invalidate: invalidateLeaseRelated,
          onProposal: setProposal,
          reload: reload().pipe(Effect.ignore),
        });
  const logCounterpartyActivity = (counterpartyId: string) => (changes: DossierChanges) => {
    const entry = tenantDirectory.find((item) => item.counterpartyRef.resourceId === counterpartyId);
    return entry === undefined
      ? Effect.succeed(failedWith('unavailable'))
      : saveAddition({ _tag: 'UpdateCounterpartyDossier', counterpartyRef: entry.counterpartyRef, ...changes });
  };
  const updateCounterpartyDossier = (counterpartyId: string) => (changes: DossierChanges) => {
    const entry = tenantDirectory.find((item) => item.counterpartyRef.resourceId === counterpartyId);
    if (entry !== undefined) {
      runCommand({ _tag: 'UpdateCounterpartyDossier', counterpartyRef: entry.counterpartyRef, ...changes });
    }
  };
  const saveCounterpartyDossier =
    (counterpartyId: string): DossierSave =>
    (changes, expectedRevision, unchanged) => {
      const entry = tenantDirectory.find((item) => item.counterpartyRef.resourceId === counterpartyId);
      return entry === undefined
        ? Effect.succeed<RevisionedSaveResult>('failed')
        : saveLeasingCommand(
            { _tag: 'UpdateCounterpartyDossier', counterpartyRef: entry.counterpartyRef, ...changes },
            expectedRevision,
            unchanged,
            setProposal,
          );
    };
  /** The counterparty the create form saved; the page opens its dossier once the form is gone. */
  const [createdCounterparty, setCreatedCounterparty] = useState<string>();
  /** S01-01: a firm or person becomes a counterparty of this company with its first timeline note. */
  const createCounterparty = (input: NewCounterpartyInput): Effect.Effect<SaveOutcome> => {
    if (snapshot === undefined) {
      return Effect.succeed('failed');
    }
    setCreateError(undefined);
    setProposal(undefined);
    setActionFeedback('saving');
    type CustomerRequest = Parameters<typeof createCustomer>[0];
    const request: { -readonly [Key in keyof CustomerRequest]: CustomerRequest[Key] } = {
      displayName: input.displayName.trim(),
      email: input.email.trim(),
      evidenceReference: 'Nájempark – evidence nájemců a zájemců',
      partyType: input.partyType,
      phone: input.phone.trim(),
    };
    if (input.partyType === 'ORGANIZATION' && input.companyId.trim() !== '') {
      request.companyId = input.companyId.trim();
    }
    return createCustomer(request).pipe(
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
                  activity: {
                    kind: 'NOTE',
                    summary:
                      input.note.trim() === ''
                        ? `${input.partyType === 'PERSON' ? 'Osoba' : 'Firma'} založena jako protistrana Nájempark.`
                        : input.note.trim(),
                  },
                  counterpartyRef: created.counterpartyRef,
                },
                expectedRevision: snapshot.revision,
              },
              'property-leasing.counterparty-create',
              { idempotencyKey, referenceCredentials },
            ),
          ),
          Effect.map((result) => ({
            created,
            parked: Schema.is(ActionProposalAcceptedSchema)(result) ? result : undefined,
          })),
        ),
      ),
      Effect.match({
        onFailure: (failure) => {
          const status = 'status' in failure && Predicate.isNumber(failure.status) ? failure.status : undefined;
          let message = 'Protistranu se nepodařilo uložit. Zkontrolujte údaje a zkuste to znovu.';
          if (status === 403) {
            message = 'Pro zakládání protistran nemáte oprávnění.';
          } else if (Predicate.isTagged(failure, 'CustomerCreateAmbiguous')) {
            message = 'Protistrana se shoduje s více existujícími záznamy. Vyřešte shodu v registru zákazníků.';
          }
          setCreateError(message);
          setActionFeedback(status === 403 ? 'forbidden' : undefined);
          return 'failed';
        },
        onSuccess: ({ created, parked }): SaveOutcome => {
          setActionFeedback(undefined);
          if (parked !== undefined) {
            // The leasing counterparty and its first note exist only once the proposal is approved.
            setProposal(parked);
            return 'proposed';
          }
          setCreatedCounterparty(created.counterpartyRef.resourceId);
          return 'saved';
        },
      }),
    );
  };
  useEffect(() => {
    if (createdCounterparty !== undefined) {
      const url = new URL(window.location.href);
      url.search = '';
      url.searchParams.set('counterpartyId', createdCounterparty);
      url.hash = 'tenant';
      window.location.assign(url);
    }
  }, [createdCounterparty]);
  const openRentEditor = () => {
    dispatchEditor(occupancyEditorActions.OPEN_RENT({ terms: Option.fromUndefinedOr(selected?.rentTerms) }));
  };
  /** A new lease or stay the form created; the page opens it once the form is gone. */
  const [created, setCreated] = useState<string>();
  // Opened only once the form is gone, so leaving the page does not ask about the saved form.
  useEffect(() => {
    if (created !== undefined) {
      const url = new URL(window.location.href);
      url.searchParams.set('resourceId', created);
      url.searchParams.delete('create');
      url.searchParams.delete('unitId');
      window.location.assign(url);
    }
  }, [created]);
  /** The form's Save outcome: a saved change re-reads the page first, a parked one is reported. */
  const settleSave = (outcome: OccupancyOutcome) =>
    Match.value(outcome).pipe(
      Match.tag('Saved', () => reload().pipe(Effect.ignore)),
      // A conflict re-reads too, so "Načíst aktuální verzi" offers the newer version.
      Match.tag('Conflict', () => reload().pipe(Effect.ignore)),
      Match.tag('Proposed', ({ proposal: parked }) => Effect.sync(() => setProposal(parked))),
      Match.orElse(() => Effect.void),
      Effect.as(outcome),
    );
  /**
   * The Save button of the lease and stay form: a new lease or stay against the leases as read now, or the edited
   * lease draft against the revision its draft was read at.
   */
  const saveOccupancy = (draft: OccupancyDraft, save: OccupancySave): Effect.Effect<OccupancyOutcome> => {
    // Only a lease that is still a draft can change; anything else is refused before it is sent.
    const record = snapshot?.occupancies.find((item) => item.occupancyRef.resourceId === editingId);
    const send =
      editingId.length === 0
        ? createOccupancy(draft, {
            expectedRevision: snapshot?.revision ?? 0,
            kind: editor === 'stay' ? 'stay' : 'lease',
            references: {
              customers,
              guests: guests.map((item) => ({ ref: item.ref })),
              units: properties?.units ?? [],
            },
          })
        : Option.match(
            Option.filter(Option.fromUndefinedOr(record), (item) => item.state === 'DRAFT'),
            {
              onNone: () => Effect.succeed(failedWith('validation')),
              onSome: (occupancy) => saveLeaseDraft(occupancy, draft, save),
            },
          );
    return send.pipe(Effect.ensuring(Effect.sync(invalidateLeaseRelated)), Effect.flatMap(settleSave));
  };
  /** The form created `resourceId`: it closes, then the page opens the new record. */
  const openCreated = (resourceId: string) => {
    setEditor(undefined);
    setCreated(resourceId);
  };
  const restoreDraft = (draft: OccupancyDraft) => dispatchEditor(occupancyEditorActions.RESTORE_DRAFT({ draft }));
  const editDraft = () => {
    if (selected?.state !== 'DRAFT') {
      return;
    }
    dispatchEditor(occupancyEditorActions.EDIT_DRAFT({ record: selected }));
  };
  const loadCustomers = () => {
    run(
      listCustomers({ includeArchived: false, limit: 500 }).pipe(
        Effect.match({
          onFailure: reportFailure,
          onSuccess: (values) => {
            dispatchEditor(
              occupancyEditorActions.CUSTOMERS_LOADED({ customers: values.filter((item) => item.status === 'ACTIVE') }),
            );
          },
        }),
        Effect.ensuring(
          Effect.sync(() => dispatchEditor(occupancyEditorActions.CUSTOMERS_LOADING({ loading: false }))),
        ),
      ),
    );
  };
  const newDraft = (mode: OccupancyEditorMode = 'lease', initialUnitId = '') => {
    dispatchEditor(occupancyEditorActions.OPEN_DRAFT({ initialUnitId, mode, startDate: DEFAULT_START_DATE }));
    if (mode === 'lease') {
      loadCustomers();
    }
  };
  const consumedCreationLink = useRef(false);
  const loadLinkedCustomers = useEffectEvent(loadCustomers);
  useEffect(() => {
    if (
      !consumedCreationLink.current &&
      linkedResourceId === undefined &&
      Option.getOrUndefined(search)?.create === 'lease' &&
      properties !== undefined &&
      feedback === 'ready'
    ) {
      consumedCreationLink.current = true;
      dispatchEditor(
        occupancyEditorActions.OPEN_DRAFT({
          initialUnitId: Option.getOrUndefined(search)?.unitId ?? '',
          mode: 'lease',
          startDate: DEFAULT_START_DATE,
        }),
      );
      loadLinkedCustomers();
    }
  }, [properties, feedback, linkedResourceId, search]);
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
            dispatchEditor(occupancyEditorActions.GUESTS_LOADED({ guests: values }));
            setActionFeedback(undefined);
          },
        }),
      ),
    );
  };
  const unitName = (resourceId: string) =>
    properties?.units.find((record) => record.unitRef.resourceId === resourceId)?.name ?? 'Jednotka bez názvu';
  const [showCancelled, setShowCancelled] = useState(false);
  const cancelledCount = snapshot?.occupancies.filter((record) => record.state === 'CANCELLED').length ?? 0;
  // Cancelled stays and leases keep their audit but do not crowd the working list unless asked for.
  const visible =
    snapshot?.occupancies.filter(
      (record) =>
        (kindFilter === 'ALL' || record.kind === kindFilter) && (showCancelled || record.state !== 'CANCELLED'),
    ) ?? [];
  const occupantNameOf = usePrefetchLeaseOccupants(
    leaseInput,
    renderedLeaseOccupantRows(linkedResourceId, linkedCounterpartyId, visible),
    snapshot?.revision ?? 0,
    preloadLeaseRelated,
  );
  const tenantOf = (record: Occupancy | undefined) =>
    record?.customerCounterpartyRef === null || record === undefined
      ? undefined
      : tenantDirectory.find((item) => item.counterpartyRef.resourceId === record.customerCounterpartyRef?.resourceId);
  /** Tenant of a lease or guest of a stay, for list rows. */
  const partyNameOf = (record: Occupancy) =>
    occupantNameOf(record) ?? (record.guestPartyRef === null ? tenantOf(record)?.displayName : undefined);
  // Owner decides; older owner builds without the flag keep the previous behaviour.
  const canWrite = snapshot !== undefined && snapshot.canWrite !== false;
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
    cancelledCount,
    canWrite,
    collision,
    createCounterparty,
    createError,
    customerId,
    customerName,
    customerNameFeedback,
    customerNamePending,
    customerOpen,
    customers,
    customersEmpty: !customersLoading && customers.length === 0,
    customersLoading,
    directoryLoaded,
    dispatchEditor,
    draft: occupancyDraftOf(draftEditor),
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
    linkedCounterpartyId,
    linkedResourceId,
    logCounterpartyActivity,
    newDraft,
    openCreated,
    openRentEditor,
    partyNameOf,
    peopleCount,
    properties,
    propertyOf,
    proposal,
    related,
    rentEditorOpen,
    rentMonthly,
    rentPaymentDay,
    rentService,
    reportProposal: setProposal,
    restoreDraft,
    retry,
    runCommand,
    runReload: () => run(reload()),
    saveAddition,
    saveCounterpartyDossier,
    saveOccupancy,
    searchGuests,
    selected,
    setCustomerId,
    setCustomerOpen,
    setEditor,
    setEndDate,
    setGuestId,
    setGuestQuery,
    setKindFilter,
    setPeopleCount,
    setRentEditorOpen,
    setRentMonthly,
    setRentPaymentDay,
    setRentService,
    setShowCancelled,
    setStartDate,
    setStayNote,
    setUnitId,
    showCancelled,
    snapshot,
    startDate,
    stayNote,
    t,
    tenantDirectory,
    tenantOf,
    unitId,
    unitName,
    unitOf,
    updateCounterpartyDossier,
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
type PageState = ReturnType<typeof useRecordsPage>;
/** Tells the person their last change was parked for approval and has not been applied. */
const ProposalNotice = ({ state }: { readonly state: ReturnType<typeof useRecordsPage> }) =>
  state.proposal === undefined ? null : (
    <output aria-live="polite">{state.t('property-leasing.demo.approvalRequired')}</output>
  );
/**
 * The agreed rent of the selected lease. Edits stay on screen until Uložit is clicked, against the revision the draft
 * builds on; when someone else changed this rent, the panel offers the current version instead. Leaving with unsaved
 * changes asks first.
 */
const RentTermsPanel = ({ occupancy, state }: { readonly occupancy: Occupancy; readonly state: PageState }) => {
  const { t } = state;
  const labels = saveLabelsFor(state.language);
  const server = rentDraftOf(occupancy.rentTerms);
  /** The rent the draft builds on: what the panel opened with, last saved or reloaded. */
  const base = useRef(server);
  const rememberSaved = (value: RentDraft, result: RevisionedSaveResult) => {
    if (Predicate.isNumber(result) || result === 'saved') {
      base.current = value;
    }
  };
  const send = (value: RentDraft, expectedRevision: number, rentTerms: RentTerms) =>
    saveLeasingCommand(
      { _tag: 'SetRentTerms', occupancyRef: occupancy.occupancyRef, rentTerms },
      expectedRevision,
      rentUnchangedSince(occupancy.occupancyRef.resourceId, base.current),
      state.reportProposal,
    ).pipe(Effect.tap((result) => Effect.sync(() => rememberSaved(value, result))));
  const record = useRecordDraft<RentDraft, never>({
    equals: sameRentDraft,
    isValid: (value) => Option.isSome(rentTermsOf(value)),
    revision: state.snapshot?.revision ?? 0,
    runtime: browserRuntime,
    save: (value, expectedRevision) =>
      Option.match(rentTermsOf(value), {
        onNone: () => Effect.succeed<RevisionedSaveResult>('failed'),
        onSome: (rentTerms) => send(value, expectedRevision, rentTerms),
      }),
    server,
  });
  const settledOnServer = !record.pending && sameRentDraft(record.draft, server);
  useEffect(() => {
    if (settledOnServer) {
      base.current = server;
    }
  }, [base, server, settledOnServer]);
  const { draft } = record;
  const problems = rentProblems(draft);
  const invalid = (problem: boolean, key: string) =>
    problem ? { helpText: t(key), validateStatus: 'error' as const } : {};
  const change = (field: keyof RentDraft) => (value: string) =>
    record.setDraft((current) => ({ ...current, [field]: value }));
  const blocker = useBlocker({ enableBeforeUnload: false, shouldBlockFn: () => record.dirty, withResolver: true });
  const guard = useUnsavedChangesGuard({ draft: record, navigation: blocker, onDiscard: record.discard });
  const close = () => {
    guard.request(() => {
      state.setRentEditorOpen(false);
    });
  };
  const handleSave = record.save;
  const handleReloadLatest = record.reloadLatest;
  return (
    <SidePanel
      actions={
        <>
          <Button onClick={close} theme="outlined" variant="secondary">
            {t(LABEL_CLOSE)}
          </Button>
          <SaveBar labels={labels} onReloadLatest={handleReloadLatest} onSave={handleSave} status={record.status} />
        </>
      }
      closeLabel={t(LABEL_CLOSE)}
      guard={guard}
      initialFocusEl={() => globalThis.document.querySelector<HTMLElement>('#occupancy-rent-monthly')}
      onOpenChange={(open) => {
        if (!open) {
          close();
        }
      }}
      open
      resizeLabel={t('property-leasing.demo.resizePanel')}
      size="md"
      title={t('property-leasing.rent.formTitle')}
    >
      <UnsavedChangesDialog labels={labels} prompt={guard.prompt} />
      <div className="propertyleasing:space-y-4 propertyleasing:py-2">
        <p className="propertyleasing:text-sm propertyleasing:text-(--color-fg-secondary)">
          {t('property-leasing.rent.formHint')}
        </p>
        <div className="propertyleasing:grid propertyleasing:gap-4 propertyleasing:md:grid-cols-3">
          <FormInput
            id="occupancy-rent-monthly"
            inputMode="decimal"
            label={t('property-leasing.rent.monthlyRentInput')}
            onChange={(event) => change('monthly')(event.target.value)}
            value={draft.monthly}
            {...invalid(problems.monthly, 'property-leasing.rent.invalidAmount')}
          />
          <FormInput
            id="occupancy-rent-service"
            inputMode="decimal"
            label={t('property-leasing.rent.serviceChargesInput')}
            onChange={(event) => change('service')(event.target.value)}
            value={draft.service}
            {...invalid(problems.service, 'property-leasing.rent.invalidAmount')}
          />
          <FormInput
            id="occupancy-rent-payment-day"
            label={t('property-leasing.rent.paymentDayInput')}
            max={31}
            min={1}
            onChange={(event) => change('paymentDay')(event.target.value)}
            type="number"
            value={draft.paymentDay}
            {...invalid(problems.paymentDay, 'property-leasing.rent.invalidPaymentDay')}
          />
        </div>
      </div>
    </SidePanel>
  );
};
const RentTermsForm = ({ state }: { readonly state: PageState }) =>
  state.rentEditorOpen && state.selected !== undefined ? (
    <RentTermsPanel key={state.selected.occupancyRef.resourceId} occupancy={state.selected} state={state} />
  ) : null;
const occupancyDetailModel = (state: ReturnType<typeof useRecordsPage>, selected: Occupancy) => {
  const { customerName, snapshot, t, unitName } = state;
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
  const [firstInvoice] = invoices;
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
  return {
    canEditRent,
    contract,
    customerLabel,
    firstInvoice,
    isLease,
    noticeContext,
    occupancyId,
    property,
    selected,
    tasks,
    tenant,
    tenantDossier,
    unit,
  };
};
type OccupancyDetailModel = ReturnType<typeof occupancyDetailModel>;
interface OccupancyDetailProps {
  readonly model: OccupancyDetailModel;
  readonly state: ReturnType<typeof useRecordsPage>;
}
const OccupancyDetailHeader = ({ model, state }: OccupancyDetailProps) => {
  const { property, selected, tenant } = model;
  const { feedback, language, t, unitName } = state;
  const tenantSuffix =
    tenant?.displayName === null || tenant?.displayName === undefined ? '' : ` · ${tenant.displayName}`;
  return (
    <>
      <DocumentTitle title={`${unitName(selected.unitRef.resourceId)}${tenantSuffix}`} />
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
            selected.endDate === null ? t(LABEL_OPEN_END) : formatDate(selected.endDate)
          }`,
        ]
          .filter((part) => part !== undefined)
          .join(' · ')}
        meta={
          <Badge size="sm" variant={stateBadge[selected.state]}>
            {t(`property-leasing.demo.stateLabels.${selected.state}`)}
          </Badge>
        }
        title={`${unitName(selected.unitRef.resourceId)}${tenantSuffix}`}
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
    </>
  );
};
const OccupancyStory = ({ model, state }: OccupancyDetailProps) => {
  const { contract, firstInvoice, isLease, property, selected, tasks, tenant } = model;
  const { customerName, language, t, unitName } = state;
  if (!isLease) {
    return null;
  }
  return (
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
            contract === undefined ? undefined : `/${language}/smlouvy?resourceId=${contract.contractRef.resourceId}`,
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
            Option.getOrUndefined(state.related.tasks) === 'unavailable'
              ? t('property-leasing.story.unavailable')
              : String(tasks.length),
        },
        {
          href:
            firstInvoice === undefined ? undefined : `/${language}/finance?resourceId=${firstInvoice.ref.resourceId}`,
          label: t('property-leasing.story.invoice'),
          value:
            firstInvoice === undefined
              ? t('property-leasing.related.notProvided')
              : (firstInvoice.number ?? firstInvoice.documentNumber),
        },
      ]}
      t={t}
    />
  );
};
const OccupancyOverview = ({ model, state }: OccupancyDetailProps) => {
  const { canEditRent, contract, customerLabel, isLease, selected, tenant } = model;
  const { busy, language, t, unitName } = state;
  return (
    <>
      {isLease && (
        <RentTermsCard
          action={
            canEditRent ? (
              <Button
                disabled={busy}
                onClick={() => state.openRentEditor()}
                size="sm"
                theme="outlined"
                variant="secondary"
              >
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
              ...(isLease ? [] : [{ label: 'Počet osob', value: String(selected.peopleCount ?? 'Neuvedeno') }]),
              {
                label: t('property-leasing.demo.endDate'),
                value: selected.endDate === null ? t(LABEL_OPEN_END) : formatDate(selected.endDate),
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
    </>
  );
};
const OccupancyRelations = ({ model, state }: OccupancyDetailProps) => {
  const { contract, customerLabel, isLease, selected, tasks, tenant } = model;
  const { busy, customerNameFeedback, language, snapshot, t } = state;
  return (
    <>
      {isLease && snapshot !== undefined && (
        <TenantDossierCard
          busy={busy}
          canWrite={state.canWrite}
          contractHref={
            contract === undefined ? undefined : `/${language}/smlouvy?resourceId=${contract.contractRef.resourceId}`
          }
          counterpartyId={selected.customerCounterpartyRef?.resourceId ?? ''}
          counterpartyName={tenant?.displayName ?? customerLabel}
          dossier={snapshot.tenantDossiers?.find(
            (item) => item.counterpartyId === selected.customerCounterpartyRef?.resourceId,
          )}
          key={`tenant:${selected.customerCounterpartyRef?.resourceId ?? ''}`}
          leaseHref={
            selected.customerCounterpartyRef === null
              ? undefined
              : `/${language}/najmy?counterpartyId=${selected.customerCounterpartyRef.resourceId}#tenant`
          }
          newContactId={newUuid}
          onLog={(changes) =>
            state.saveAddition({ _tag: 'UpdateTenantDossier', occupancyRef: selected.occupancyRef, ...changes })
          }
          onSave={(changes, expectedRevision, unchanged) =>
            saveLeasingCommand(
              { _tag: 'UpdateTenantDossier', occupancyRef: selected.occupancyRef, ...changes },
              expectedRevision,
              unchanged,
              state.reportProposal,
            )
          }
          onUpdate={(changes) =>
            state.runCommand({ _tag: 'UpdateTenantDossier', occupancyRef: selected.occupancyRef, ...changes })
          }
          revision={snapshot.revision}
          taskHref={tasks[0] === undefined ? undefined : `/${language}/ukoly?resourceId=${tasks[0].ref.resourceId}`}
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
        <SectionCard title={t('property-leasing.documents.tenantTitle')}>
          <PartyDocuments
            counterpartyId={selected.customerCounterpartyRef.resourceId}
            label={tenant?.displayName ?? customerLabel}
            language={language}
          />
        </SectionCard>
      )}
      <TasksCard language={language} t={t} tasks={state.related.tasks} />
    </>
  );
};
const OccupancyDocuments = ({ model, state }: OccupancyDetailProps) => {
  const { noticeContext, occupancyId, selected, tenant, tenantDossier } = model;
  const { busy, snapshot, t } = state;
  const handleSaveAddition = state.saveAddition;
  return (
    <>
      {snapshot !== undefined && (
        <RegistrationSheetCard
          busy={busy}
          canWrite={state.canWrite}
          context={noticeContext}
          newId={newUuid}
          onSave={handleSaveAddition}
          sheets={(snapshot.registrationSheets ?? []).filter((sheet) => sheet.occupancyId === occupancyId)}
        />
      )}
      {snapshot !== undefined && (
        <NoticeCard
          canWrite={state.canWrite}
          context={noticeContext}
          defaultEmail={tenant?.email ?? tenantDossier?.contacts.find((contact) => contact.email !== '')?.email ?? ''}
          defaultPhone={tenant?.phone ?? tenantDossier?.contacts.find((contact) => contact.phone !== '')?.phone ?? ''}
          newId={newUuid}
          notices={(snapshot.preparedNotices ?? []).filter((notice) => notice.occupancyId === occupancyId)}
          onSave={handleSaveAddition}
        />
      )}
      {selected.note !== null && (
        <SectionCard title={t('property-leasing.detail.note')}>
          <p className="propertyleasing:whitespace-pre-wrap propertyleasing:text-sm">{selected.note}</p>
        </SectionCard>
      )}{' '}
    </>
  );
};
const OccupancyAside = ({ model, state }: OccupancyDetailProps) => {
  const { contract, isLease, occupancyId, property, selected, unit } = model;
  const { activate, busy, editDraft, language, runCommand, snapshot, t } = state;
  return (
    <>
      <SectionCard title={t('property-leasing.demo.state')}>
        <div>
          <Badge size="sm" variant={stateBadge[selected.state]}>
            {t(`property-leasing.demo.stateLabels.${selected.state}`)}
          </Badge>
        </div>
        <div className="propertyleasing:flex propertyleasing:flex-wrap propertyleasing:gap-2" hidden={!state.canWrite}>
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
      )}{' '}
    </>
  );
};
const OccupancyDetail = ({ state }: { readonly state: ReturnType<typeof useRecordsPage> }) => {
  const { feedback, language, selected, t } = state;
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
  const model = occupancyDetailModel(state, selected);
  return (
    <>
      <OccupancyDetailHeader model={model} state={state} />
      <OccupancyStory model={model} state={state} />
      <div className="propertyleasing:grid propertyleasing:grid-cols-1 propertyleasing:items-start propertyleasing:gap-6 propertyleasing:xl:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="propertyleasing:min-w-0 propertyleasing:space-y-6">
          <OccupancyOverview model={model} state={state} />
          <OccupancyRelations model={model} state={state} />
          <OccupancyDocuments model={model} state={state} />
        </div>
        <div className="propertyleasing:min-w-0 propertyleasing:space-y-6">
          <OccupancyAside model={model} state={state} />
        </div>
      </div>
      <RentTermsForm state={state} />
    </>
  );
};
const OccupancyDraftForm = ({ state }: { readonly state: ReturnType<typeof useRecordsPage> }) => {
  const { editingId, editor, properties, t } = state;
  if (editor === undefined) {
    return null;
  }
  // Only units in operation inside a building in operation are offered for a new stay or lease.
  const activeUnits = (properties?.units ?? []).filter(
    (record) =>
      record.lifecycleState === 'ACTIVE' &&
      properties?.properties.some(
        (item) => item.propertyRef.resourceId === record.propertyRef.resourceId && item.lifecycleState === 'ACTIVE',
      ) === true,
  );
  const references = {
    customers: state.customers,
    guests: state.guests.map((item) => ({ ref: item.ref })),
    units: properties?.units ?? [],
  };
  const editing = Option.fromUndefinedOr(
    state.snapshot?.occupancies.find((record) => record.occupancyRef.resourceId === editingId),
  );
  const isValid = (draft: OccupancyDraft) =>
    Option.match(editing, {
      onNone: () =>
        Option.isSome((editor === 'stay' ? stayDraftRecord : leaseDraftRecord)(draft, references, editingId)),
      onSome: (record) => Option.isSome(updateDraftCommand(record.occupancyRef, draft)),
    });
  const handleChange = (field: keyof OccupancyDraft, value: string) =>
    state.dispatchEditor(occupancyEditorActions.SET_INPUT({ field, value }));
  const handleClose = () => state.setEditor(undefined);
  const handleCreated = state.openCreated;
  const handleReload = () => state.runReload();
  const handleRestore = state.restoreDraft;
  const handleSave = state.saveOccupancy;
  const handleSearch = state.searchGuests;
  const handleQueryChange = state.setGuestQuery;
  const handleCustomerOpenChange = state.setCustomerOpen;
  const { feedback } = state;
  return (
    <OccupancyEditorPanel
      customers={{
        empty: state.customersEmpty,
        items: state.customers.map((record) => ({
          label: record.displayName ?? t('property-leasing.demo.unnamedCustomer'),
          value: record.counterpartyRef.resourceId,
        })),
        loading: state.customersLoading,
        onOpenChange: handleCustomerOpenChange,
        open: state.customerOpen,
      }}
      draft={state.draft}
      editing={editing}
      feedbackText={
        feedback === 'ready' || feedback === 'saving' || feedback === 'loading'
          ? undefined
          : t(`property-leasing.demo.feedback.${feedback}`)
      }
      guests={{
        busy: state.busy,
        items: state.guests.map((record) => ({
          label: record.title ?? t('property-leasing.demo.unnamedGuest'),
          value: record.ref.resourceId,
        })),
        onQueryChange: handleQueryChange,
        onSearch: handleSearch,
        query: state.guestQuery,
      }}
      isValid={isValid}
      key={`${editor}:${editingId}`}
      mode={editor}
      onChange={handleChange}
      onClose={handleClose}
      onCreated={handleCreated}
      onReload={handleReload}
      onRestore={handleRestore}
      onSave={handleSave}
      revision={state.snapshot?.revision ?? 0}
      units={activeUnits.map((record) => ({ label: record.name, value: record.unitRef.resourceId }))}
    />
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
/** Only a refused or failed read offers a retry; everything else updates by itself. */
const RetryAfterFailure = ({
  busy,
  feedback,
  label,
  onRetry,
}: {
  readonly busy: boolean;
  readonly feedback: Feedback;
  readonly label: string;
  readonly onRetry: () => void;
}) =>
  feedback === 'unavailable' || feedback === 'forbidden' ? (
    <Button disabled={busy} onClick={onRetry} size="sm" theme="outlined" variant="secondary">
      {label}
    </Button>
  ) : null;

const RecordsPageContent = ({ context }: { readonly context: ModulePageProps['context'] }) => {
  const state = useRecordsPage(context);
  const [calendarMonth, setCalendarMonth] = useState('');
  const {
    busy,
    feedback,
    kindFilter,
    retry,

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
        <ProposalNotice state={state} />
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
            onLog={state.logCounterpartyActivity(state.linkedCounterpartyId)}
            onSave={state.saveCounterpartyDossier(state.linkedCounterpartyId)}
            onUpdate={state.updateCounterpartyDossier(state.linkedCounterpartyId)}
            snapshot={snapshot}
            unitName={unitName}
          />
        ) : null}
        {state.linkedResourceId === undefined && state.linkedCounterpartyId === undefined && (
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
                language={state.language}
                monthValue={calendarMonth}
                onMonthChange={setCalendarMonth}
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
                <RetryAfterFailure
                  busy={busy}
                  feedback={feedback}
                  label={t('property-leasing.demo.retry')}
                  onRetry={retry}
                />
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
                        {record.endDate === null ? t(LABEL_OPEN_END) : formatDate(record.endDate)}
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
                onCreate={(input) => state.createCounterparty(input)}
                snapshot={snapshot}
                unitName={unitName}
              />
            )}
          </>
        )}
        {state.linkedResourceId !== undefined && <OccupancyDetail state={state} />}
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
      <RecordsPageContent context={context} key={`${leaseInputOf(context).scope}:${search}`} />
    </FederatedI18nBoundary>
  );
};
export default RecordsPage;
