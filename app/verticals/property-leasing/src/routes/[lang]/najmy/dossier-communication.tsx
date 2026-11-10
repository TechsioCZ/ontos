// Logs a call, e-mail, meeting or note in the counterparty timeline. Typing changes only the draft; the shared
// Uložit records it once, then the form starts empty again; leaving the page with a typed summary asks first. A failed
// entry shows why and stays in the form for another Uložit.
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { SaveBar, UnsavedChangesDialog, saveLabelsFor, useDraftSave, useUnsavedChangesGuard } from '@app/admin-ui';
import { useBlocker } from '@modern-js/plugin-tanstack/runtime';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { Option, Schema } from 'effect';
import type { Effect } from 'effect';
import { constVoid } from 'effect/Function';
import { useState } from 'react';
import type { Feedback } from '../../../../shared/actions/apply-command.ts';
import { TenantActivityInputSchema } from '../../../../shared/apis/records.ts';
import { browserRuntime } from '../../../runtime/browser-effect-runtime.ts';
import type { DossierChanges } from './leasing-save.ts';
import { additionSaveOutcome } from './occupancy-command.ts';
import type { OccupancyOutcome } from './occupancy-command.ts';

/** Logs one entry in the timeline: an addition, sent once against the records as read now. */
export type DossierLog = (changes: DossierChanges) => Effect.Effect<OccupancyOutcome>;

type CommunicationKind = typeof TenantActivityInputSchema.fields.kind.Type;

interface CommunicationDraft {
  readonly kind: CommunicationKind;
  readonly summary: string;
}

const emptyCommunication: CommunicationDraft = { kind: 'CALL', summary: '' };
const KINDS: readonly CommunicationKind[] = ['CALL', 'EMAIL', 'MEETING', 'NOTE'];

/** Two drafts are the same when they would log the same entry; the kind alone is not input yet. */
const sameCommunication = (left: CommunicationDraft, right: CommunicationDraft) =>
  left.summary.trim() === right.summary.trim() && (left.summary.trim() === '' || left.kind === right.kind);

export const DossierCommunication = ({
  activityLabels,
  canWrite,
  onSave,
}: {
  /** The readable name of each kind of entry. */
  readonly activityLabels: Readonly<Record<CommunicationKind, string>>;
  readonly canWrite: boolean;
  /** Logs the entry; a logged entry only appends to the timeline, so it never waits on a newer version. */
  readonly onSave: DossierLog;
}) => {
  const { language, t } = useModernI18n();
  const labels = saveLabelsFor(language);
  const [draft, setDraft] = useState(emptyCommunication);
  const [reason, setReason] = useState(() => Option.none<Feedback>());
  const record = useDraftSave<CommunicationDraft, never>({
    equals: sameCommunication,
    initial: emptyCommunication,
    isValid: (value) => value.summary.trim().length > 0,
    runtime: browserRuntime,
    save: (value) =>
      additionSaveOutcome(onSave({ activity: { kind: value.kind, summary: value.summary.trim() } }), setReason),
    value: draft,
  });
  const blocker = useBlocker({ enableBeforeUnload: false, shouldBlockFn: () => record.dirty, withResolver: true });
  const guard = useUnsavedChangesGuard({
    draft: record,
    navigation: blocker,
    onDiscard: () => setDraft(emptyCommunication),
  });
  const handleSave = () => {
    record.save();
    // A logged entry is in the timeline: the form is ready for the next one.
    record.afterSave((status) => {
      if (status === 'saved') {
        setDraft(emptyCommunication);
        record.adopt(emptyCommunication);
      }
    });
  };
  if (!canWrite) {
    return null;
  }
  return (
    <form
      className="sp-tenant-contact"
      noValidate
      onSubmit={(event) => {
        // Enter never logs: only Uložit does.
        event.preventDefault();
      }}
    >
      <h3>Zapsat komunikaci</h3>
      <div className="sp-tenant-fields">
        <label className="sp-tenant-stack">
          <span>{t('property-leasing.dossier.communicationKind')}</span>
          <select
            aria-label={t('property-leasing.dossier.communicationKind')}
            id="communication-kind"
            onChange={(event) => {
              const selected = Schema.decodeUnknownOption(TenantActivityInputSchema.fields.kind)(event.target.value);
              if (Option.isSome(selected)) {
                setDraft((current) => ({ ...current, kind: selected.value }));
              }
            }}
            value={draft.kind}
          >
            {KINDS.map((value) => (
              <option key={value} value={value}>
                {activityLabels[value]}
              </option>
            ))}
          </select>
        </label>
        <FormInput
          id="communication-summary"
          label={t('property-leasing.dossier.communicationSummary')}
          maxLength={500}
          onChange={(event) => {
            const { value } = event.target;
            setDraft((current) => ({ ...current, summary: value }));
          }}
          placeholder={t('property-leasing.dossier.communicationPlaceholder')}
          value={draft.summary}
        />
      </div>
      <p className="sp-tenant-muted">{t('property-leasing.dossier.communicationManual')}</p>
      <SaveBar
        error={Option.match(reason, {
          onNone: () => null,
          onSome: (value) => t(`property-leasing.demo.feedback.${value}`),
        })}
        labels={labels}
        onReloadLatest={constVoid}
        onSave={handleSave}
        size="sm"
        status={record.status}
      />
      <UnsavedChangesDialog labels={labels} prompt={guard.prompt} />
    </form>
  );
};
