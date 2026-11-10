import {
  SaveBar,
  SidePanel,
  UnsavedChangesDialog,
  saveLabelsFor,
  useDraftSave,
  useUnsavedChangesGuard,
} from '@app/admin-ui';
import type { SaveOutcome } from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useBlocker } from '@modern-js/plugin-tanstack/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Effect, Match, Option, Predicate } from 'effect';
import { useRef, useState } from 'react';
import type { Feedback } from '../../../../shared/actions/apply-command.ts';
import type { Occupancy } from '../../../../shared/apis/records.ts';
import { browserRuntime } from '../../../runtime/browser-effect-runtime.ts';
import { withRecordInputs } from './editor-state.ts';
import type { OccupancyDraft } from './editor-state.ts';
import { failureReasonOf, revisionedResultOf } from './occupancy-command.ts';
import type { OccupancyOutcome } from './occupancy-command.ts';
import { ChoiceSelect, CustomerField, PeriodFields, RentFields, StayFields } from './occupancy-editor-fields.tsx';
import type { Choice, CustomerPicker, GuestSearch } from './occupancy-editor-fields.tsx';

const LABEL_CLOSE = 'property-leasing.demo.close';
const nothingCreated = Option.none<string>();

/** What one Save of the form sends: the draft, the version it was last confirmed at, and the revision it builds on. */
export interface OccupancySave {
  readonly confirmed: OccupancyDraft;
  readonly expectedRevision: number;
}

export interface OccupancyEditorPanelProps {
  readonly customers: CustomerPicker;
  /** The form's draft as the page holds it. */
  readonly draft: OccupancyDraft;
  /** The lease draft as the page reads it now, when the form edits one; None for a new lease or stay. */
  readonly editing: Option.Option<Occupancy>;
  /** Page feedback of the form's reads (the guest search), when there is some. */
  readonly feedbackText?: string | undefined;
  readonly guests: GuestSearch;
  /** Whether the draft can be sent; Uložit stays disabled until it can. */
  readonly isValid: (draft: OccupancyDraft) => boolean;
  readonly mode: 'lease' | 'stay';
  readonly onChange: (field: keyof OccupancyDraft, value: string) => void;
  /** Closes the form; called once the guard let the person leave. */
  readonly onClose: () => void;
  /** A new lease or stay was created: the page opens it. */
  readonly onCreated: (resourceId: string) => void;
  /** Re-reads the leases, for "Načíst aktuální verzi". */
  readonly onReload: () => void;
  /** Puts `draft` back on screen ("Zahodit změny", "Načíst aktuální verzi"). */
  readonly onRestore: (draft: OccupancyDraft) => void;
  /** Sends one save of the draft. */
  readonly onSave: (draft: OccupancyDraft, save: OccupancySave) => Effect.Effect<OccupancyOutcome>;
  /** Revision of the leases as the page reads them now. */
  readonly revision: number;
  /** Units a new lease or stay can be made in. */
  readonly units: readonly Choice[];
}

const createdBy = (outcome: OccupancyOutcome): Option.Option<string> =>
  Match.value(outcome).pipe(
    Match.tag('Saved', ({ resourceRef }) =>
      Option.map(Option.fromNullOr(resourceRef), (reference) => reference.resourceId),
    ),
    Match.orElse(() => Option.none<string>()),
  );

/**
 * A new lease, a new stay or a lease draft. Typing changes the draft only; Uložit sends it once, an edit against the
 * revision the draft was read at, so someone else's change of the draft comes back as a conflict that offers the
 * newer version. Leaving with unsaved input asks Uložit / Zahodit změny / Zůstat; an untouched form closes at once.
 */
export const OccupancyEditorPanel = (props: OccupancyEditorPanelProps) => {
  const { customers, draft, editing, guests, mode, onChange, onClose, onCreated, onRestore, onSave } = props;
  const { language, t } = useModernI18n();
  const labels = saveLabelsFor(language);
  /** The revision the draft builds on: the read it was opened from, then the revision its own saves returned. */
  const base = useRef(props.revision);
  const created = useRef(nothingCreated);
  /** The version the server last confirmed: what the form opened with, then each saved or reloaded draft. */
  const confirmed = useRef(draft);
  const [reason, setReason] = useState(() => Option.none<Feedback>());
  const record = useDraftSave<OccupancyDraft, never>({
    isValid: props.isValid,
    runtime: browserRuntime,
    save: (value) =>
      onSave(value, { confirmed: confirmed.current, expectedRevision: base.current }).pipe(
        Effect.tap((outcome) =>
          Effect.sync(() => {
            setReason(failureReasonOf(outcome));
            created.current = createdBy(outcome);
          }),
        ),
        Effect.map((outcome): SaveOutcome => {
          const result = revisionedResultOf(outcome);
          if (Predicate.isNumber(result)) {
            base.current = Math.max(base.current, result);
            confirmed.current = value;
            return 'saved';
          }
          return result;
        }),
      ),
    value: draft,
  });
  const handleSave = () => {
    record.save();
    record.afterSave((status) => {
      if (status === 'saved' && Option.isNone(editing) && Option.isSome(created.current)) {
        onCreated(created.current.value);
      }
    });
  };
  const handleDiscard = () => {
    onRestore(record.confirmed);
  };
  /** The newer version of the edited draft replaces this one and becomes its base; a new record keeps its input. */
  const handleReloadLatest = () => {
    const latest = Option.match(editing, {
      onNone: () => draft,
      onSome: (occupancy) => withRecordInputs(draft, occupancy),
    });
    base.current = props.revision;
    confirmed.current = latest;
    onRestore(latest);
    record.adopt(latest);
    props.onReload();
  };
  const blocker = useBlocker({ enableBeforeUnload: false, shouldBlockFn: () => record.dirty, withResolver: true });
  const guard = useUnsavedChangesGuard({
    draft: { ...record, save: handleSave },
    navigation: blocker,
    onDiscard: handleDiscard,
  });
  const requestClose = () => {
    guard.request(onClose);
  };
  const creating = Option.isNone(editing);
  let title = 'property-leasing.demo.editDraft';
  if (mode === 'stay') {
    title = 'property-leasing.demo.newBooking';
  } else if (creating) {
    title = 'property-leasing.demo.newLease';
  }
  return (
    <SidePanel
      actions={
        <div className="sp-occupancy-form-actions">
          <Button onClick={requestClose} theme="outlined" variant="secondary">
            {t(LABEL_CLOSE)}
          </Button>
          <SaveBar
            error={Option.match(reason, {
              onNone: () => null,
              onSome: (value) => t(`property-leasing.demo.feedback.${value}`),
            })}
            labels={labels}
            onReloadLatest={handleReloadLatest}
            onSave={handleSave}
            status={record.status}
          />
        </div>
      }
      closeLabel={t(LABEL_CLOSE)}
      guard={guard}
      initialFocusEl={() => globalThis.document.querySelector<HTMLElement>('#occupancy-start-date')}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      open
      resizeLabel={t('property-leasing.demo.resizePanel')}
      size="lg"
      title={t(title)}
    >
      <div className="propertyleasing:space-y-4 propertyleasing:py-2">
        {props.feedbackText !== undefined && <output aria-live="polite">{props.feedbackText}</output>}
        {creating && (
          <div className="propertyleasing:grid propertyleasing:gap-4 propertyleasing:md:grid-cols-2">
            <ChoiceSelect
              items={props.units}
              label={t('property-leasing.demo.unit')}
              onChange={(value) => onChange('unitId', value)}
              value={draft.unitId}
            />
            {mode === 'lease' && <CustomerField customers={customers} draft={draft} onChange={onChange} />}
          </div>
        )}
        <PeriodFields draft={draft} onChange={onChange} />
        {mode === 'lease' && <RentFields draft={draft} onChange={onChange} />}
        {mode === 'stay' && <StayFields draft={draft} guests={guests} onChange={onChange} />}
      </div>
      <UnsavedChangesDialog labels={labels} prompt={guard.prompt} />
    </SidePanel>
  );
};
