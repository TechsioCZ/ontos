// A new registration sheet of the people staying in a unit (S10). It opens with the guest and purpose the record
// suggests; typing changes only the draft; the shared Uložit creates the sheet once and closes the form; Enter never
// saves; Zrušit and leaving the page with typed input ask first, and an untouched form closes at once.
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import {
  DetailList,
  SaveBar,
  UnsavedChangesDialog,
  formatDate,
  saveLabelsFor,
  useDraftSave,
  useUnsavedChangesGuard,
} from '@app/admin-ui';
import type { SaveOutcome } from '@app/admin-ui';
import { useBlocker } from '@modern-js/plugin-tanstack/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { Effect, Option } from 'effect';
import type { PlatformError } from 'effect';
import { constVoid } from 'effect/Function';
import { useRef, useState } from 'react';
import type { RegistrationOccupant } from '../../../../shared/apis/records.ts';
import { RegistrationSheetIdSchema } from '../../../../shared/apis/records.ts';
import type { OccupancyCommand } from '../../../../shared/actions/apply-command.ts';
import { browserRuntime } from '../../../runtime/browser-effect-runtime.ts';
import type { NoticeContext } from './notice-templates.ts';

const purposes = ['Rekreace', 'Služební cesta', 'Bydlení – nájem', 'Podnikání – nájem', 'Jiný účel'] as const;
const emptyOccupant = (name = ''): RegistrationOccupant => ({
  address: '',
  birthDate: Option.none(),
  identityDocument: '',
  name,
  nationality: 'Česká republika',
});
interface OccupantDraft extends RegistrationOccupant {
  readonly localKey: string;
}
interface SheetDraft {
  readonly note: string;
  readonly occupants: readonly OccupantDraft[];
  readonly purpose: string;
}
const storedOccupant = (occupant: OccupantDraft): RegistrationOccupant => ({
  address: occupant.address.trim(),
  birthDate: occupant.birthDate,
  identityDocument: occupant.identityDocument.trim(),
  name: occupant.name.trim(),
  nationality: occupant.nationality.trim(),
});
const day = (value: string | null) => (value === null ? 'bez konce' : formatDate(value));
/** What the save compares the suggested sheet with: nothing is saved yet, so the suggestion is a draft Uložit sends. */
const nothingSaved: SheetDraft = { note: '', occupants: [], purpose: '' };

/** The sheet the record suggests: its guest and purpose, one row per announced person. */
const suggestedSheet = (context: NoticeContext): SheetDraft => {
  const { record } = context;
  const count = Math.min(Math.max(record.peopleCount ?? 1, 1), 20);
  const leasePurpose = context.unitLabel.startsWith('Byt') ? 'Bydlení – nájem' : 'Podnikání – nájem';
  return {
    note: '',
    occupants: Array.from({ length: count }, (_, index) => ({
      ...emptyOccupant(index === 0 && record.kind === 'SHORT_STAY' ? context.partyName : ''),
      localKey: `initial-${index}`,
    })),
    purpose: record.kind === 'SHORT_STAY' ? 'Rekreace' : leasePurpose,
  };
};

const complete = (draft: SheetDraft) =>
  draft.occupants.length > 0 && draft.occupants.every((occupant) => occupant.name.trim().length > 0);

export const RegistrationSheetForm = ({
  context,
  newId,
  onClose,
  onSave,
}: {
  readonly context: NoticeContext;
  readonly newId: Effect.Effect<string, PlatformError.PlatformError>;
  readonly onClose: () => void;
  /** Sends the command that creates the sheet, once. */
  readonly onSave: (command: OccupancyCommand) => Effect.Effect<SaveOutcome>;
}) => {
  const { language, t } = useModernI18n();
  const labels = saveLabelsFor(language);
  const { record } = context;
  // The suggestion as the form opened stays the yardstick of typed input, even when names load later.
  const [sheet, setSheet] = useState(() => {
    const opening = suggestedSheet(context);
    return { draft: opening, suggested: opening };
  });
  const { draft, suggested } = sheet;
  const setDraft = (next: (current: SheetDraft) => SheetDraft) =>
    setSheet((current) => ({ ...current, draft: next(current.draft) }));
  const occupantSequence = useRef(draft.occupants.length);
  const save = useDraftSave<SheetDraft, never>({
    initial: nothingSaved,
    isValid: complete,
    opened: suggested,
    runtime: browserRuntime,
    save: (value) =>
      newId.pipe(
        Effect.flatMap((sheetId) =>
          onSave({
            _tag: 'CreateRegistrationSheet',
            note: value.note.trim(),
            occupancyRef: record.occupancyRef,
            occupants: value.occupants.map(storedOccupant),
            purpose: value.purpose,
            sheetId: RegistrationSheetIdSchema.make(sheetId),
          }),
        ),
        Effect.orElseSucceed((): SaveOutcome => 'failed'),
      ),
    value: draft,
  });
  const blocker = useBlocker({ enableBeforeUnload: false, shouldBlockFn: () => save.dirty, withResolver: true });
  const guard = useUnsavedChangesGuard({
    draft: save,
    navigation: blocker,
    onDiscard: () => setDraft(() => suggested),
  });
  const showProblems = save.status === 'invalid';
  const update = (index: number, field: keyof RegistrationOccupant, value: string) =>
    setDraft((current) => ({
      ...current,
      occupants: current.occupants.map((occupant, position) => {
        if (position !== index) {
          return occupant;
        }
        if (field === 'birthDate') {
          return { ...occupant, birthDate: value === '' ? Option.none() : Option.some(value) };
        }
        return { ...occupant, [field]: value };
      }),
    }));
  const addOccupant = () => {
    const localKey = `added-${occupantSequence.current}`;
    occupantSequence.current += 1;
    setDraft((current) => ({ ...current, occupants: [...current.occupants, { ...emptyOccupant(), localKey }] }));
  };
  const removeOccupant = (index: number) =>
    setDraft((current) => ({ ...current, occupants: current.occupants.filter((_, position) => position !== index) }));
  const handleCancel = () => guard.request(onClose);
  const handleSave = () => {
    save.save();
    save.afterSave((status) => {
      if (status === 'saved') {
        onClose();
      }
    });
  };
  return (
    <form
      className="sp-tenant-stack"
      noValidate
      onSubmit={(event) => {
        // Enter never saves: only Uložit does.
        event.preventDefault();
      }}
    >
      <DetailList
        items={[
          { label: 'Jednotka', value: [context.unitLabel, context.propertyLabel].join(', ') },
          { label: 'Období', value: `${formatDate(record.startDate)} – ${day(record.endDate)}` },
          { label: record.kind === 'SHORT_STAY' ? 'Host' : 'Nájemce', value: context.partyName },
        ]}
      />
      {draft.occupants.map((occupant, index) => (
        <fieldset className="sp-tenant-contact" key={occupant.localKey}>
          <legend>Ubytovaná osoba {index + 1}</legend>
          <div className="sp-tenant-fields">
            <FormInput
              id={`sheet-name-${index}`}
              label={t('property-leasing.registration.fullName')}
              maxLength={200}
              onChange={(event) => update(index, 'name', event.target.value)}
              value={occupant.name}
              {...(showProblems && occupant.name.trim().length === 0
                ? { helpText: 'Vyplňte jméno a příjmení ubytovaného.', validateStatus: 'error' as const }
                : {})}
            />
            <FormInput
              label={t('property-leasing.registration.birthDate')}
              onChange={(event) => update(index, 'birthDate', event.target.value)}
              type="date"
              value={Option.getOrElse(occupant.birthDate, () => '')}
            />
            <FormInput
              label={t('property-leasing.registration.nationality')}
              maxLength={200}
              onChange={(event) => update(index, 'nationality', event.target.value)}
              value={occupant.nationality}
            />
            <FormInput
              id={`sheet-document-${index}`}
              label={t('property-leasing.registration.identityDocument')}
              maxLength={200}
              onChange={(event) => update(index, 'identityDocument', event.target.value)}
              value={occupant.identityDocument}
            />
          </div>
          <FormInput
            label={t('property-leasing.registration.permanentAddress')}
            maxLength={300}
            onChange={(event) => update(index, 'address', event.target.value)}
            value={occupant.address}
          />
          {draft.occupants.length > 1 && (
            <Button onClick={() => removeOccupant(index)} size="sm" theme="borderless" variant="secondary">
              Odebrat osobu
            </Button>
          )}
        </fieldset>
      ))}
      <div className="sp-tenant-actions">
        <Button
          disabled={draft.occupants.length >= 20}
          onClick={addOccupant}
          size="sm"
          theme="outlined"
          variant="secondary"
        >
          Přidat osobu
        </Button>
        <label className="sp-tenant-stack">
          <span>Účel pobytu</span>
          <select
            aria-label={t('property-leasing.registration.purpose')}
            onChange={(event) => {
              const { value } = event.target;
              setDraft((current) => ({ ...current, purpose: value }));
            }}
            value={draft.purpose}
          >
            {purposes.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
      </div>
      <FormInput
        id="sheet-note"
        label={t('property-leasing.registration.optionalNote')}
        maxLength={500}
        onChange={(event) => {
          const { value } = event.target;
          setDraft((current) => ({ ...current, note: value }));
        }}
        value={draft.note}
      />
      <div className="sp-tenant-actions">
        <Button onClick={handleCancel} size="sm" theme="outlined" variant="secondary">
          {t('property-leasing.demo.cancel')}
        </Button>
        <SaveBar labels={labels} onReloadLatest={constVoid} onSave={handleSave} size="sm" status={save.status} />
      </div>
      <UnsavedChangesDialog labels={labels} prompt={guard.prompt} />
    </form>
  );
};
