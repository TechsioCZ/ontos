import {
  SaveBar,
  SidePanel,
  UnsavedChangesDialog,
  saveLabelsFor,
  useDraftSave,
  useUnsavedChangesGuard,
} from '@app/admin-ui';
import type { SaveOutcome } from '@app/admin-ui';
import { withNativeLabels } from '@app/admin-ui/select-template';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useBlocker } from '@modern-js/plugin-tanstack/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { Select } from '@techsio/ui-kit/molecules/select';
import { Effect, Match, Option } from 'effect';
import { useRef, useState } from 'react';
import type { Feedback } from '../../../../shared/actions/apply-command.ts';
import type { Contract } from '../../../../shared/apis/records.ts';
import { browserRuntime } from '../../../runtime/browser-effect-runtime.ts';
import { failureReasonOf } from './agreements-command.ts';
import type { AgreementOutcome } from './agreements-command.ts';
import { createDraftComplete, createDraftOf } from './agreement-draft.ts';
import type { CreateDraft, CreateReferences } from './agreement-draft.ts';

const KINDS = ['OTHER', 'LEASE'] as const;
const nothingCreated = Option.none<string>();

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

/** One single-choice select of the form; `value` empty means nothing chosen. */
const ChoiceSelect = ({
  items,
  label,
  onChange,
  placeholder,
  value,
}: {
  readonly items: readonly Choice[];
  readonly label: string;
  readonly onChange: (value: string) => void;
  readonly placeholder?: string | undefined;
  readonly value: string;
}) => (
  <Select
    items={withNativeLabels(items.map((item) => ({ label: item.label, value: item.value })))}
    onValueChange={({ value: chosen }) => onChange(chosen[0] ?? '')}
    value={value.length > 0 ? [value] : []}
  >
    <Select.Label>{label}</Select.Label>
    <Select.Control>
      <Select.Trigger>
        <Select.ValueText {...(placeholder === undefined ? {} : { placeholder })} />
      </Select.Trigger>
    </Select.Control>
    <Select.Positioner>
      <Select.Content>
        {items.map((item) => (
          <Select.Item item={{ label: item.label, value: item.value }} key={item.value}>
            <Select.ItemText>{item.label}</Select.ItemText>
            <Select.ItemIndicator />
          </Select.Item>
        ))}
      </Select.Content>
    </Select.Positioner>
  </Select>
);

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
  /** Why the leases could not be read, when they could not. */
  readonly rentalFeedback?: string | undefined;
}

/**
 * A new contract. Typing changes the draft only; Uložit creates the contract once and the page opens it. Leaving
 * with unsaved input asks Uložit / Zahodit změny / Zůstat; an untouched form closes at once.
 */
export const ContractCreatePanel = (props: ContractCreatePanelProps) => {
  const { customers, leases, onClose, onCreate, onCreated, onKindChange, references, rentalFeedback } = props;
  const { language, t } = useModernI18n();
  const labels = saveLabelsFor(language);
  /** The form as it opens: the draft starts from it, and it is what discarding goes back to. */
  const opening = createDraftOf(props.kind);
  const [draft, setDraft] = useState(opening);
  const [reason, setReason] = useState(() => Option.none<Feedback>());
  /** The contract the last save created. */
  const created = useRef(nothingCreated);
  const record = useDraftSave<CreateDraft, never>({
    initial: opening,
    isValid: (value) => createDraftComplete(value, references),
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
  const handleDiscard = () => {
    setDraft(opening);
    record.adopt(opening);
  };
  /** Nothing to reload for a new contract: the typed draft stays and Uložit sends it again. */
  const handleReloadLatest = () => {
    record.adopt(opening);
  };
  const savable = { ...record, save: handleSave };
  const blocker = useBlocker({ enableBeforeUnload: false, shouldBlockFn: () => record.dirty, withResolver: true });
  const guard = useUnsavedChangesGuard({ draft: savable, navigation: blocker, onDiscard: handleDiscard });
  const change = (patch: Partial<CreateDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
  };
  const handleKindChange = (value: string) => {
    const kind = value === 'LEASE' ? 'LEASE' : 'OTHER';
    change({ kind });
    onKindChange(kind);
  };
  const handleLeaseChange = (occupancyId: string) => {
    const lease = leases.find((item) => item.value === occupancyId);
    change(lease === undefined ? { occupancyId } : { endDate: lease.endDate, occupancyId, startDate: lease.startDate });
  };
  const requestClose = () => {
    guard.request(onClose);
  };
  return (
    <SidePanel
      actions={
        <>
          <Button onClick={requestClose} theme="outlined" variant="secondary">
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
      title={t('legal-agreements.demo.create')}
    >
      <form
        className="legalagreements:space-y-4 legalagreements:py-2"
        noValidate
        onSubmit={(event) => {
          // Enter never saves: only Uložit in the panel footer sends the draft.
          event.preventDefault();
        }}
      >
        <ChoiceSelect
          items={KINDS.map((value) => ({ label: t(`legal-agreements.demo.kinds.${value}`), value }))}
          label={t('legal-agreements.demo.contractKind')}
          onChange={handleKindChange}
          value={draft.kind}
        />
        {draft.kind === 'OTHER' && (
          <ChoiceSelect
            items={customers}
            label={t('legal-agreements.demo.customer')}
            onChange={(customerId) => change({ customerId })}
            placeholder={t('legal-agreements.demo.choose')}
            value={draft.customerId}
          />
        )}
        {draft.kind === 'LEASE' && rentalFeedback !== undefined && <output aria-live="polite">{rentalFeedback}</output>}
        {draft.kind === 'LEASE' && (
          <ChoiceSelect
            items={leases}
            label={t('legal-agreements.demo.occupancy')}
            onChange={handleLeaseChange}
            placeholder={t('legal-agreements.demo.choose')}
            value={draft.occupancyId}
          />
        )}
        <div className="legalagreements:grid legalagreements:gap-4 legalagreements:md:grid-cols-2">
          <FormInput
            id="contract-start-date"
            label={t('legal-agreements.demo.startDate')}
            onChange={(event) => change({ startDate: event.target.value })}
            type="date"
            value={draft.startDate}
          />
          <FormInput
            id="contract-end-date"
            label={t('legal-agreements.demo.endDate')}
            onChange={(event) => change({ endDate: event.target.value })}
            type="date"
            value={draft.endDate}
          />
        </div>
      </form>
      <UnsavedChangesDialog labels={labels} prompt={guard.prompt} />
    </SidePanel>
  );
};
