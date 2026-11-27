// Logs a call, e-mail, meeting or note in the counterparty timeline. Typing changes only the draft; the shared
// Uložit records it once, then the form starts empty again; leaving the page with a typed summary asks first. A failed
// entry shows why and stays in the form for another Uložit.
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { SaveBar, UnsavedChangesDialog, saveLabelsFor, useDraftSave, useUnsavedChangesGuard } from '@app/admin-ui';
import {
  ChoiceLensField,
  FormReact,
  FormRoot,
  TextField,
  fromPayload,
  useAtomSet,
  useAtomValue,
} from '@app/core-runtime/ui/form';
import { useBlocker } from '@modern-js/plugin-tanstack/runtime';
import { Effect, Option, Schema } from 'effect';
import { constVoid } from 'effect/Function';
import { useState } from 'react';
import type { Feedback } from '../../../../shared/actions/apply-command.ts';
import { TenantActivityInputSchema } from '../../../../shared/apis/records.ts';
import { browserAtomRuntime, browserRuntime } from '../../../runtime/browser-effect-runtime.ts';
import type { DossierChanges } from './leasing-save.ts';
import { additionSaveOutcome } from './occupancy-command.ts';
import type { OccupancyOutcome } from './occupancy-command.ts';

/** Logs one entry in the timeline: an addition, sent once against the records as read now. */
export type DossierLog = (changes: DossierChanges) => Effect.Effect<OccupancyOutcome>;

type CommunicationKind = typeof TenantActivityInputSchema.fields.kind.Type;

/** The kind picked in the list; a choice that is no kind of entry keeps the current one. */
const kindChoice = {
  read: (kind: CommunicationKind) => kind,
  write: (kind: CommunicationKind, choice: string) =>
    Option.getOrElse(Schema.decodeUnknownOption(TenantActivityInputSchema.fields.kind)(choice), () => kind),
};

/** The entry as the timeline takes it: every field and check comes from the activity payload. Enter never logs. */
const communicationForm = FormReact.make(fromPayload(TenantActivityInputSchema), {
  fields: { kind: ChoiceLensField<CommunicationKind>, summary: TextField },
  onSubmit: () => Effect.void,
  runtime: browserAtomRuntime,
});
type CommunicationDraft = typeof communicationForm.schema.Encoded;

const emptyCommunication: CommunicationDraft = { kind: 'CALL', summary: '' };
const KINDS: readonly CommunicationKind[] = ['CALL', 'EMAIL', 'MEETING', 'NOTE'];
const decodeCommunication = Schema.decodeUnknownEffect(communicationForm.schema);
const decodesAsActivity = (draft: CommunicationDraft) =>
  Option.isSome(Schema.decodeUnknownOption(communicationForm.schema)(draft));

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
  const draft = Option.getOrElse(useAtomValue(communicationForm.values), () => emptyCommunication);
  const reset = useAtomSet(communicationForm.reset);
  const [reason, setReason] = useState(() => Option.none<Feedback>());
  const record = useDraftSave<CommunicationDraft, never>({
    equals: sameCommunication,
    initial: emptyCommunication,
    isValid: decodesAsActivity,
    runtime: browserRuntime,
    save: (value) =>
      additionSaveOutcome(
        decodeCommunication(value).pipe(Effect.flatMap((activity) => onSave({ activity }))),
        setReason,
      ),
    value: draft,
  });
  const blocker = useBlocker({ enableBeforeUnload: false, shouldBlockFn: () => record.dirty, withResolver: true });
  const guard = useUnsavedChangesGuard({ draft: record, navigation: blocker, onDiscard: () => reset() });
  const handleSave = () => {
    record.save();
    // A logged entry is in the timeline: the form is ready for the next one.
    record.afterSave((status) => {
      if (status === 'saved') {
        reset();
        record.adopt(emptyCommunication);
      }
    });
  };
  if (!canWrite) {
    return null;
  }
  return (
    <>
      <FormRoot
        className="sp-tenant-contact"
        defaultValues={emptyCommunication}
        form={communicationForm}
        translateMessage={() => t('property-leasing.demo.feedback.validation')}
      >
        <h3>Zapsat komunikaci</h3>
        <div className="sp-tenant-fields">
          <communicationForm.kind
            items={KINDS.map((value) => ({ label: activityLabels[value], value }))}
            label={t('property-leasing.dossier.communicationKind')}
            {...kindChoice}
          />
          <communicationForm.summary
            id="communication-summary"
            label={t('property-leasing.dossier.communicationSummary')}
            maxLength={500}
            placeholder={t('property-leasing.dossier.communicationPlaceholder')}
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
      </FormRoot>
      <UnsavedChangesDialog labels={labels} prompt={guard.prompt} />
    </>
  );
};
