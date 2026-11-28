import {
  SaveBar,
  SidePanel,
  UnsavedChangesDialog,
  formatDate,
  saveLabelsFor,
  useDraftSave,
  useUnsavedChangesGuard,
} from '@app/admin-ui';
import type { SaveOutcome } from '@app/admin-ui';
import {
  ChoiceField,
  FlaggedTextField,
  FormBuilder,
  FormReact,
  FormRoot,
  useAtomSet,
  useAtomSubscribe,
  useAtomValue,
} from '@app/core-runtime/ui/form';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useBlocker } from '@modern-js/plugin-tanstack/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Effect, Match, Option, Schema } from 'effect';
import { Atom } from 'effect/reactivity';
import { useRef, useState } from 'react';
import type { Feedback } from '../../../../shared/actions/apply-command.ts';
import type { Contract } from '../../../../shared/apis/records.ts';
import { browserAtomRuntime, browserRuntime } from '../../../runtime/browser-effect-runtime.ts';
import { failureReasonOf } from './agreements-command.ts';
import type { AgreementOutcome } from './agreements-command.ts';
import {
  createDraftComplete,
  createDraftOf,
  renewalEarliestStart,
  renewalPeriodValid,
  renewalStartValid,
} from './agreement-draft.ts';
import type { CreateDraft, CreateReferences, RenewalDraft } from './agreement-draft.ts';
import { useFormDraft } from './form-draft.tsx';

const KINDS = ['OTHER', 'LEASE'] as const;
const nothingCreated = Option.none<string>();
const nothingDiscarded = Option.none<string>();

/** A create form has no older version to conflict with: anything but a created or parked contract failed. */
const createOutcomeOf = (outcome: AgreementOutcome): SaveOutcome =>
  Match.value(outcome).pipe(
    Match.tag('Saved', (): SaveOutcome => 'saved'),
    Match.tag('Proposed', (): SaveOutcome => 'proposed'),
    Match.orElse((): SaveOutcome => 'failed'),
  );

/** The contract a save created, when it created one. */
const createdBy = (outcome: AgreementOutcome): Option.Option<string> =>
  Match.value(outcome).pipe(
    Match.tag('Saved', ({ resourceRef }) => Option.some(resourceRef.resourceId)),
    Match.orElse(() => Option.none<string>()),
  );

interface Choice {
  readonly label: string;
  readonly value: string;
}

/**
 * A new contract as typed: its kind, the customer or lease it binds, and its period as date text. Uložit creates it
 * through the save bar, so the form only holds it and Enter submits nothing. The page opens one contract form at a time.
 */
const createForm = FormReact.make(
  FormBuilder.empty
    .addField('customerId', Schema.String)
    .addField('endDate', Schema.String)
    .addField('kind', Schema.String)
    .addField('occupancyId', Schema.String)
    .addField('startDate', Schema.String),
  {
    fields: {
      customerId: ChoiceField,
      endDate: FlaggedTextField,
      kind: ChoiceField,
      occupancyId: ChoiceField,
      startDate: FlaggedTextField,
    },
    onSubmit: () => Effect.void,
    runtime: browserAtomRuntime,
  },
);

type CreateValues = typeof createForm.schema.Encoded;

const kindOf = (value: string): Contract['kind'] => (value === 'LEASE' ? 'LEASE' : 'OTHER');
const valuesOf = (draft: CreateDraft): CreateValues => draft;
const draftOf = (values: CreateValues): CreateDraft => ({ ...values, kind: kindOf(values.kind) });

/** A choice as a plain string that changes only when the choice does: the field's value atom reports every change. */
const choiceOf = (field: Atom.Atom<Option.Option<string>>) => field.pipe(Atom.map(Option.getOrElse(() => '')));
const chosenKind = choiceOf(createForm.getFieldAtoms(createForm.fields.kind).value);
const chosenLease = choiceOf(createForm.getFieldAtoms(createForm.fields.occupancyId).value);
const startDateField = createForm.getFieldAtoms(createForm.fields.startDate);
const endDateField = createForm.getFieldAtoms(createForm.fields.endDate);

/** A confirmed lease the new contract can be made for, with the period it suggests. */
export interface LeaseChoice extends Choice {
  readonly endDate: CreateDraft['endDate'];
  readonly startDate: CreateDraft['startDate'];
}

export interface ContractCreatePanelProps {
  /** Active customers an other contract can be made with. */
  readonly customers: readonly Choice[];
  /** The kind the form opens with; fixed for one opening of the form. */
  readonly kind: Contract['kind'];
  readonly leases: readonly LeaseChoice[];
  /** Closes the panel; called once the guard let the person leave. */
  readonly onClose: () => void;
  /** Sends the draft as one new contract. */
  readonly onCreate: (draft: CreateDraft) => Effect.Effect<AgreementOutcome>;
  /** The contract was created: the page opens it. */
  readonly onCreated: (resourceId: string) => void;
  /** The person picked another kind; the page reads what that kind needs. */
  readonly onKindChange: (kind: Contract['kind']) => void;
  readonly references: CreateReferences;
  /** The contract this form renews, with the successor period it opens with; absent for a new contract. */
  readonly renewal?: RenewalDraft | undefined;
  /** Why the leases could not be read, when they could not. */
  readonly rentalFeedback?: string | undefined;
}

type Translate = ReturnType<typeof useModernI18n>['t'];
interface DateHint {
  readonly helpText?: string;
  readonly invalid?: boolean;
}
const noHint: DateHint = {};

const renewalStartHintOf = (draft: CreateDraft, renewal: RenewalDraft | undefined, t: Translate): DateHint => {
  if (renewal === undefined) {
    return noHint;
  }
  const helpText = t('legal-agreements.demo.renewalStartHelp', {
    date: formatDate(renewalEarliestStart(renewal.previous)),
  });
  return renewalStartValid(draft, renewal.previous) ? { helpText } : { helpText, invalid: true };
};

const renewalEndHintOf = (draft: CreateDraft, renewal: RenewalDraft | undefined, t: Translate): DateHint =>
  renewal === undefined || draft.endDate > draft.startDate
    ? noHint
    : { helpText: t('legal-agreements.demo.renewalEndInvalid'), invalid: true };

/**
 * A new contract. Typing changes the draft only; Uložit creates the contract once and the page opens it. Leaving
 * with unsaved input asks Uložit / Zahodit změny / Zůstat; an untouched form closes at once.
 */
export const ContractCreatePanel = (props: ContractCreatePanelProps) => {
  const { customers, leases, onClose, onCreate, onCreated, onKindChange, references, renewal, rentalFeedback } = props;
  const { language, t } = useModernI18n();
  const labels = saveLabelsFor(language);
  /** The form as it opens: the draft starts from it, and it is what discarding goes back to. */
  const opening = renewal?.opening ?? createDraftOf(props.kind);
  /**
   * What the draft counts as unsaved against. A renewal opens with a valid suggested period Uložit can send at once,
   * so its opening values are not the saved version; leaving the untouched form still does not ask.
   */
  const unopened = renewal === undefined ? opening : { ...opening, endDate: '', startDate: '' };
  const { draft: values, gate, ready, reset } = useFormDraft(createForm, valuesOf(opening));
  const draft = draftOf(values);
  const setStartDate = useAtomSet(startDateField.setValue);
  const setEndDate = useAtomSet(endDateField.setValue);
  const [reason, setReason] = useState(() => Option.none<Feedback>());
  /** The contract the last save created. */
  const created = useRef(nothingCreated);
  const record = useDraftSave<CreateDraft, never>({
    initial: unopened,
    isValid: (value) =>
      renewal === undefined ? createDraftComplete(value, references) : renewalPeriodValid(value, renewal.previous),
    opened: renewal === undefined ? undefined : opening,
    runtime: browserRuntime,
    save: (value) =>
      onCreate(value).pipe(
        Effect.tap((outcome) =>
          Effect.sync(() => {
            setReason(failureReasonOf(outcome));
            created.current = createdBy(outcome);
          }),
        ),
        Effect.map(createOutcomeOf),
      ),
    value: draft,
  });
  const handleSave = () => {
    record.save();
    record.afterSave((status) => {
      if (status === 'saved' && Option.isSome(created.current)) {
        onCreated(created.current.value);
      }
    });
  };
  /** A kind put back by discarding, which is no pick of the person's: the page is not told about it. */
  const discardedKind = useRef(nothingDiscarded);
  const handleDiscard = () => {
    if (draft.kind !== opening.kind) {
      discardedKind.current = Option.some(opening.kind);
    }
    reset(valuesOf(opening));
    record.adopt(unopened);
  };
  /** Nothing to reload for a new contract: the typed draft stays and Uložit sends it again. */
  const handleReloadLatest = () => {
    record.adopt(unopened);
  };
  const savable = { ...record, save: handleSave };
  const blocker = useBlocker({ enableBeforeUnload: false, shouldBlockFn: () => record.dirty, withResolver: true });
  const guard = useUnsavedChangesGuard({ draft: savable, navigation: blocker, onDiscard: handleDiscard });
  // Reading the picked kind and lease links them to the form's state, so the subscriptions below hear every pick.
  useAtomValue(chosenKind);
  useAtomValue(chosenLease);
  // The person picked another kind: the page reads what that kind needs.
  useAtomSubscribe(
    chosenKind,
    (kind) => {
      const discarded = Option.contains(discardedKind.current, kind);
      discardedKind.current = nothingDiscarded;
      if (ready && !discarded) {
        onKindChange(kindOf(kind));
      }
    },
    { immediate: false },
  );
  // A picked lease suggests its own period.
  useAtomSubscribe(
    chosenLease,
    (occupancyId) => {
      const lease = leases.find((item) => item.value === occupancyId);
      if (ready && lease !== undefined) {
        setStartDate(lease.startDate);
        setEndDate(lease.endDate);
      }
    },
    { immediate: false },
  );
  const requestClose = () => {
    guard.request(onClose);
  };
  // A renewal shows its earliest start before anything is typed, and marks a date the owner would refuse.
  const renewalStartHint = renewalStartHintOf(draft, renewal, t);
  const renewalEndHint = renewalEndHintOf(draft, renewal, t);
  return (
    <SidePanel
      actions={
        <>
          <Button appearance="outline" onClick={requestClose} severity="secondary">
            {t('legal-agreements.detail.close')}
          </Button>
          <SaveBar
            error={Option.match(reason, {
              onNone: () => null,
              onSome: (value) => t(`legal-agreements.demo.feedback.${value}`),
            })}
            labels={labels}
            onReloadLatest={handleReloadLatest}
            onSave={handleSave}
            status={record.status}
          />
        </>
      }
      closeLabel={t('legal-agreements.detail.close')}
      guard={guard}
      initialFocusEl={() => globalThis.document.querySelector<HTMLElement>('#contract-start-date')}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      open
      resizeLabel={t('legal-agreements.detail.resizePanel')}
      size="lg"
      title={t(renewal === undefined ? 'legal-agreements.demo.create' : 'legal-agreements.demo.renew')}
    >
      <FormRoot
        className="space-y-4 py-2"
        defaultValues={valuesOf(opening)}
        form={createForm}
        translateMessage={(message) => t(message, { defaultValue: message })}
      >
        {gate}
        {renewal === undefined && (
          <createForm.kind
            items={KINDS.map((value) => ({ label: t(`legal-agreements.demo.kinds.${value}`), value }))}
            label={t('legal-agreements.demo.contractKind')}
          />
        )}
        {renewal === undefined && draft.kind === 'OTHER' && (
          <createForm.customerId
            items={customers}
            label={t('legal-agreements.demo.customer')}
            placeholder={t('legal-agreements.demo.choose')}
          />
        )}
        {renewal === undefined && draft.kind === 'LEASE' && rentalFeedback !== undefined && (
          <output aria-live="polite">{rentalFeedback}</output>
        )}
        {renewal === undefined && draft.kind === 'LEASE' && (
          <createForm.occupancyId
            items={leases}
            label={t('legal-agreements.demo.occupancy')}
            placeholder={t('legal-agreements.demo.choose')}
          />
        )}
        <div className="grid gap-4 md:grid-cols-2">
          <createForm.startDate
            id="contract-start-date"
            label={t('legal-agreements.demo.startDate')}
            type="date"
            {...renewalStartHint}
          />
          <createForm.endDate
            id="contract-end-date"
            label={t('legal-agreements.demo.endDate')}
            type="date"
            {...renewalEndHint}
          />
        </div>
      </FormRoot>
      <UnsavedChangesDialog labels={labels} prompt={guard.prompt} />
    </SidePanel>
  );
};
