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
import {
  ChoiceField,
  Field,
  FormReact,
  FormRoot,
  OptionalTextField,
  TextField,
  fromPayload,
  useAtomSet,
  useAtomValue,
} from '@app/core-runtime/ui/form';
import { useBlocker } from '@modern-js/plugin-tanstack/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Effect, Option, Schema, Struct } from 'effect';
import type { PlatformError } from 'effect';
import { constVoid } from 'effect/Function';
import { useEffect, useState } from 'react';
import { OccupancyCommandSchema } from '../../../../shared/actions/apply-command.ts';
import type { Feedback } from '../../../../shared/actions/apply-command.ts';
import { RegistrationOccupantSchema, RegistrationSheetIdSchema } from '../../../../shared/apis/records.ts';
import { dossierActionsClass, dossierFieldsClass, dossierStackClass, dossierTileClass } from './dossier-classes.ts';
import { additionSaveOutcome } from './occupancy-command.ts';
import type { AdditionSave } from './occupancy-command.ts';
import { browserAtomRuntime, browserRuntime } from '../../../runtime/browser-effect-runtime.ts';
import type { NoticeContext } from './notice-templates.ts';

const CreateRegistrationSheetSchema = OccupancyCommandSchema.pipe(Schema.toTaggedUnion('_tag')).cases
  .CreateRegistrationSheet;
/** The sheet as CreateRegistrationSheet stores it: what Uložit sends, and what makes the draft complete. */
const SheetPayloadSchema = CreateRegistrationSheetSchema.mapFields(Struct.pick(['note', 'occupants', 'purpose']));

/** Tells a row of the form apart while people are added and removed; never stored. */
const OccupantRowKeySchema = Schema.String.pipe(Schema.brand('OccupantRowKey'));
/** One person staying, with the key of the row. */
const OccupantRowSchema = Schema.Struct({ ...RegistrationOccupantSchema.fields, localKey: OccupantRowKeySchema });

/**
 * The sheet, one row per person staying: every field and check comes from the command's payload. Enter never saves:
 * only Uložit does, through the shared save.
 */
const sheetForm = FormReact.make(
  fromPayload(CreateRegistrationSheetSchema.mapFields(Struct.pick(['note', 'purpose']))).addField(
    Field.makeArrayField('occupants', OccupantRowSchema),
  ),
  {
    fields: {
      note: TextField,
      occupants: {
        address: TextField,
        birthDate: OptionalTextField,
        identityDocument: TextField,
        // The row key is never shown.
        localKey: TextField,
        name: TextField,
        nationality: TextField,
      },
      purpose: ChoiceField,
    },
    onSubmit: () => Effect.void,
    runtime: browserAtomRuntime,
  },
);
type SheetDraft = typeof sheetForm.schema.Encoded;
type OccupantDraft = SheetDraft['occupants'][number];

const purposes = ['Rekreace', 'Služební cesta', 'Bydlení – nájem', 'Podnikání – nájem', 'Jiný účel'] as const;
const emptyOccupant = (localKey: string, name = ''): OccupantDraft => ({
  address: '',
  birthDate: null,
  identityDocument: '',
  localKey,
  name,
  nationality: 'Česká republika',
});
const day = (value: string | null) => (value === null ? 'bez konce' : formatDate(value));
/** What the save compares the suggested sheet with: nothing is saved yet, so the suggestion is a draft Uložit sends. */
const nothingSaved: SheetDraft = { note: '', occupants: [], purpose: '' };
const decodeSheet = Schema.decodeUnknownEffect(SheetPayloadSchema);
const complete = (draft: SheetDraft) => Option.isSome(Schema.decodeUnknownOption(SheetPayloadSchema)(draft));

/** The sheet the record suggests: its guest and purpose, one row per announced person. */
const suggestedSheet = (context: NoticeContext): SheetDraft => {
  const { record } = context;
  const count = Math.min(Math.max(record.peopleCount ?? 1, 1), 20);
  const leasePurpose = context.unitLabel.startsWith('Byt') ? 'Bydlení – nájem' : 'Podnikání – nájem';
  return {
    note: '',
    occupants: Array.from({ length: count }, (_, index) =>
      emptyOccupant(`initial-${index}`, index === 0 && record.kind === 'SHORT_STAY' ? context.partyName : ''),
    ),
    purpose: record.kind === 'SHORT_STAY' ? 'Rekreace' : leasePurpose,
  };
};

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
  readonly onSave: AdditionSave;
}) => {
  const { language, t } = useModernI18n();
  const labels = saveLabelsFor(language);
  const { record } = context;
  // The suggestion as the form opened stays the yardstick of typed input, even when names load later; rows added
  // since are counted for their keys.
  const [sheet, setSheet] = useState(() => ({ added: 0, suggested: suggestedSheet(context) }));
  const { suggested } = sheet;
  const draft = Option.getOrElse(useAtomValue(sheetForm.values), () => suggested);
  const reset = useAtomSet(sheetForm.reset);
  const validate = useAtomSet(sheetForm.validate);
  const [reason, setReason] = useState(() => Option.none<Feedback>());
  const save = useDraftSave<SheetDraft, never>({
    initial: nothingSaved,
    isValid: complete,
    opened: suggested,
    runtime: browserRuntime,
    save: (value) =>
      additionSaveOutcome(
        newId.pipe(
          Effect.flatMap((sheetId) =>
            decodeSheet(value).pipe(
              Effect.flatMap((payload) =>
                onSave({
                  _tag: 'CreateRegistrationSheet',
                  note: payload.note,
                  occupancyRef: record.occupancyRef,
                  occupants: payload.occupants,
                  purpose: payload.purpose,
                  sheetId: RegistrationSheetIdSchema.make(sheetId),
                }),
              ),
            ),
          ),
        ),
        setReason,
      ),
    value: draft,
  });
  // Field messages show once the draft is invalid, the same moment the save bar says so.
  const invalid = save.status === 'invalid';
  useEffect(() => {
    if (invalid) {
      validate();
    }
  }, [invalid, validate]);
  const blocker = useBlocker({ enableBeforeUnload: false, shouldBlockFn: () => save.dirty, withResolver: true });
  const guard = useUnsavedChangesGuard({ draft: save, navigation: blocker, onDiscard: () => reset() });
  const handleCancel = () => guard.request(onClose);
  const addOccupant = (append: (occupant: OccupantDraft) => void) => {
    append(emptyOccupant(`added-${sheet.added}`));
    setSheet((current) => ({ ...current, added: current.added + 1 }));
  };
  const handleSave = () => {
    save.save();
    save.afterSave((status) => {
      if (status === 'saved') {
        onClose();
      }
    });
  };
  // The only field the person can leave invalid is a guest's name.
  const translate = (message: string) =>
    t(message.startsWith('property-leasing.') ? message : 'property-leasing.registration.fullNameRequired');
  return (
    <>
      <FormRoot className={dossierStackClass} defaultValues={suggested} form={sheetForm} translateMessage={translate}>
        <DetailList
          items={[
            { label: 'Jednotka', value: [context.unitLabel, context.propertyLabel].join(', ') },
            { label: 'Období', value: `${formatDate(record.startDate)} – ${day(record.endDate)}` },
            { label: record.kind === 'SHORT_STAY' ? 'Host' : 'Nájemce', value: context.partyName },
          ]}
        />
        <sheetForm.occupants>
          {({ append, items, remove }) => (
            <>
              {items.map((occupant, index) => (
                <sheetForm.occupants.Item index={index} key={occupant.localKey}>
                  <fieldset className={dossierTileClass}>
                    <legend>Ubytovaná osoba {index + 1}</legend>
                    <div className={dossierFieldsClass}>
                      <sheetForm.occupants.name
                        id={`sheet-name-${index}`}
                        label={t('property-leasing.registration.fullName')}
                        maxLength={200}
                      />
                      <sheetForm.occupants.birthDate label={t('property-leasing.registration.birthDate')} type="date" />
                      <sheetForm.occupants.nationality
                        label={t('property-leasing.registration.nationality')}
                        maxLength={200}
                      />
                      <sheetForm.occupants.identityDocument
                        id={`sheet-document-${index}`}
                        label={t('property-leasing.registration.identityDocument')}
                        maxLength={200}
                      />
                    </div>
                    <sheetForm.occupants.address
                      label={t('property-leasing.registration.permanentAddress')}
                      maxLength={300}
                    />
                    {items.length > 1 && (
                      <Button appearance="ghost" onClick={() => remove(index)} severity="secondary" size="sm">
                        Odebrat osobu
                      </Button>
                    )}
                  </fieldset>
                </sheetForm.occupants.Item>
              ))}
              <div className={dossierActionsClass}>
                <Button
                  appearance="outline"
                  disabled={items.length >= 20}
                  onClick={() => addOccupant(append)}
                  severity="secondary"
                  size="sm"
                >
                  Přidat osobu
                </Button>
                <sheetForm.purpose
                  items={purposes.map((value) => ({ label: value, value }))}
                  label={t('property-leasing.registration.purpose')}
                />
              </div>
            </>
          )}
        </sheetForm.occupants>
        <sheetForm.note id="sheet-note" label={t('property-leasing.registration.optionalNote')} maxLength={500} />
        <div className={dossierActionsClass}>
          <Button appearance="outline" onClick={handleCancel} severity="secondary" size="sm">
            {t('property-leasing.demo.cancel')}
          </Button>
          <SaveBar
            error={Option.match(reason, {
              onNone: () => null,
              onSome: (value) => t(`property-leasing.demo.feedback.${value}`),
            })}
            labels={labels}
            onReloadLatest={constVoid}
            onSave={handleSave}
            size="sm"
            status={save.status}
          />
        </div>
      </FormRoot>
      <UnsavedChangesDialog labels={labels} prompt={guard.prompt} />
    </>
  );
};
