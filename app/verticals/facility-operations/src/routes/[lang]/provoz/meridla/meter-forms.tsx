import { browserAtomRuntime, browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
// Meter master-data form and reading form (ops-meters lane). Both write through the governed apply-command Action.
import { SaveBar, formatDate, requiredLabelFor, saveLabelsFor, useDraftSave } from '@app/admin-ui';
import type { SaveOutcome } from '@app/admin-ui';
import {
  CheckboxField,
  ChoiceField,
  FileField,
  FormBuilder,
  FormReact,
  FormRoot,
  RuledTextField,
  TextAreaField,
  TextField,
  useAtomSet,
  useAtomSubscribe,
} from '@app/core-runtime/ui/form';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { DateTime, Effect, Option, Schema } from 'effect';
import { Atom } from 'effect/reactivity';
import { useRef, useState } from 'react';
import type { OpsCommand } from '../../../../../shared/agendas.ts';
import { optionalField } from '../../../../../shared/domain/common.ts';
import type { PropertyRef } from '../../../../../shared/domain/common.ts';
import { MeterMediumSchema, meterMedia, readingProblem, readingRows } from '../../../../../shared/domain/meters.ts';
import type { Meter, MeterPhoto, MeterReadingSchema } from '../../../../../shared/domain/meters.ts';
import { usePropertyOptions } from '../../../../ui/property-options.ts';
import { MAX_UPLOAD_BYTES, uploadFile } from '../../../../ui/use-agenda.ts';
import type { CommandOutcome, FailureReason } from '../../../../ui/use-agenda.ts';
import { defaultUnitOf, formatChange, formatQuantity } from './meters-view.ts';
import { meterCreateCommandOf, meterDraftOf, meterUpdateCommandOf, sameMeterDraft } from './meter-draft.ts';
import type { MeterDraft } from './meter-draft.ts';
import { EditGuard } from '../../../../ui/edit-guard.tsx';
import { facilitySaveOutcome } from '../../../../ui/facility-save.ts';
import { useDraftBase } from '../../../../ui/draft-base.ts';
import { FormSaveFooter, commandResult, useFormSave } from '../../../../ui/form-save.tsx';
import type { FormSubmitResult } from '../../../../ui/form-save.tsx';
import { useFormValues } from '../../../../ui/form-values.tsx';

const k = 'facility-operations.meters';
const CANCEL_LABEL = 'facility-operations.common.cancel';
const NONE = 'none';

export type RunCommand = (command: OpsCommand) => Effect.Effect<CommandOutcome>;
type ReadingCommand = Extract<OpsCommand, { readonly _tag: 'MeterReadingRecord' }>;
type MutableReadingCommand = { -readonly [Key in keyof ReadingCommand]: ReadingCommand[Key] };

const pragueDateFormatter = new Intl.DateTimeFormat('en-CA', {
  day: '2-digit',
  month: '2-digit',
  timeZone: 'Europe/Prague',
  year: 'numeric',
});
const pragueToday = (): string => pragueDateFormatter.format(DateTime.toEpochMillis(DateTime.nowUnsafe()));

/** Parses a typed decimal (`1 234,5` or `1234.5`). `undefined` for empty or invalid input. */
export const parseDecimal = (raw: string): number | undefined => {
  const cleaned = raw.replaceAll(/\s/gu, '').replace(',', '.');
  if (cleaned === '' || !/^\d+(?:\.\d+)?$/u.test(cleaned)) {
    return undefined;
  }
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : undefined;
};

const optional = <Key extends string>(key: Key, value: string) =>
  optionalField(key, value.trim() === '' ? undefined : value.trim());

// ---------------------------------------------------------------------------------------------------------------
// Meter master data
// ---------------------------------------------------------------------------------------------------------------

const meterErrorText = (error: FailureReason | 'required' | undefined, t: ReturnType<typeof useModernI18n>['t']) =>
  error === undefined
    ? error
    : t(error === 'required' ? 'facility-operations.common.required' : `facility-operations.common.errors.${error}`);

/**
 * The meter card's values. Uložit sends them through the draft save, so the form only holds them and Enter sends
 * nothing.
 */
const meterFields = FormBuilder.empty
  .addField('consumer', Schema.String)
  .addField('contract', Schema.String)
  .addField('location', Schema.String)
  .addField('medium', Schema.String)
  .addField('note', Schema.String)
  .addField('retired', Schema.Boolean)
  .addField('serialNumber', Schema.String)
  .addField('supplier', Schema.String)
  .addField('supplyPoint', Schema.String)
  .addField('unit', Schema.String);

const makeMeterForm = () =>
  FormReact.make(meterFields, {
    fields: {
      consumer: TextField,
      contract: TextField,
      location: ChoiceField,
      medium: ChoiceField,
      note: TextAreaField,
      retired: CheckboxField,
      serialNumber: TextField,
      supplier: TextField,
      supplyPoint: TextField,
      unit: TextField,
    },
    onSubmit: () => Effect.void,
    runtime: browserAtomRuntime,
  });

/** A new meter and the edit of one are separate forms, so the create panel never shares a meter's edit. */
const meterCreateForm = makeMeterForm();
const meterEditForm = makeMeterForm();

type MeterValues = typeof meterCreateForm.schema.Encoded;

/** The values the meter form shows for a draft: no location is the "none" choice. */
const meterValuesOf = (draft: MeterDraft): MeterValues => ({
  ...draft,
  location: draft.location === '' ? NONE : draft.location,
});

/** The draft the meter form shows: a medium that is not one of the media keeps the opening one. */
const meterDraftFrom = (values: MeterValues, opened: MeterDraft): MeterDraft => ({
  ...values,
  location: values.location === NONE ? '' : values.location,
  medium: Schema.is(MeterMediumSchema)(values.medium) ? values.medium : opened.medium,
});

export const MeterForm = ({
  meter,
  onCancel,
  onSaved,
  run,
}: {
  readonly meter?: Meter;
  readonly onCancel: () => void;
  readonly onSaved: (meterId: string | undefined) => void;
  readonly run: RunCommand;
}) => {
  const { language, t } = useModernI18n();
  const properties = usePropertyOptions();
  const form = meter === undefined ? meterCreateForm : meterEditForm;
  const opened = meterDraftOf(meter);
  const shown = useFormValues(form, meterValuesOf(opened));
  const draft = meterDraftFrom(shown.values, opened);
  const setValues = useAtomSet(form.setValues);
  const [error, setError] = useState<FailureReason | 'required' | undefined>();
  // A new meter's unit follows its medium while it is empty or still the previous medium's default.
  const before = useRef<MeterValues | null>(null);
  useAtomSubscribe(form.values, (next) => {
    if (!shown.initialized || Option.isNone(next)) {
      before.current = null;
      return;
    }
    const previous = before.current;
    before.current = next.value;
    if (meter !== undefined || previous === null || previous.medium === next.value.medium) {
      return;
    }
    const { medium } = meterDraftFrom(next.value, opened);
    const { medium: previousMedium } = meterDraftFrom(previous, opened);
    if (next.value.unit === '' || next.value.unit === defaultUnitOf[previousMedium]) {
      setValues({ ...next.value, unit: defaultUnitOf[medium] });
    }
  });

  /** The stored location of a draft: the picked property, or the one the meter already has. */
  const pickedLocationOf = (value: MeterDraft): PropertyRef | undefined => {
    if (value.location === '') {
      return undefined;
    }
    if (properties.status === 'ready') {
      const found = properties.options.find((option) => option.value === value.location)?.ref;
      if (found !== undefined) {
        return found;
      }
    }
    // Keep the existing snapshot when the property read is unavailable.
    return meter?.location !== undefined && value.location === `${meter.location.kind}:${meter.location.id}`
      ? meter.location
      : undefined;
  };

  // An edit is sent on Uložit only, with the revision of the read the draft was built on.
  const base = useDraftBase(meter, run);
  const record = useDraftSave<MeterDraft, never>({
    equals: sameMeterDraft,
    isValid: (value) =>
      meter !== undefined && Option.isSome(meterUpdateCommandOf(value, meter, pickedLocationOf(value))),
    runtime: browserRuntime,
    save: (value) =>
      meter === undefined
        ? Effect.succeed<SaveOutcome>('failed')
        : Option.match(meterUpdateCommandOf(value, meter, pickedLocationOf(value)), {
            onNone: () => Effect.succeed<SaveOutcome>('failed'),
            onSome: (command) => base.confirm(facilitySaveOutcome(base.run(command))),
          }),
    value: draft,
  });
  base.sync({
    onAdopt: () => {
      const stored = meterDraftOf(meter);
      if (!sameMeterDraft(stored, draft)) {
        record.adopt(stored);
        setValues(meterValuesOf(stored));
      }
    },
    settled: !record.pending && sameMeterDraft(draft, record.confirmed),
  });
  const labels = saveLabelsFor(language);
  const discard = () => {
    setValues(meterValuesOf(record.confirmed));
    setError(undefined);
  };
  const handleSave = record.save;
  const handleReloadLatest = () => {
    const current = meterDraftOf(meter);
    base.rebase();
    record.adopt(current);
    setValues(meterValuesOf(current));
    setError(undefined);
  };

  // A new meter is sent on Uložit only; the draft it opens with is not typed input.
  const create = useFormSave<MeterDraft>({
    equals: sameMeterDraft,
    onDiscard: () => {
      setValues(meterValuesOf(meterDraftOf()));
      setError(undefined);
    },
    open: meter === undefined,
    submit: (value) => {
      const command = meterCreateCommandOf(value, pickedLocationOf(value));
      if (Option.isNone(command)) {
        setError('required');
        return Effect.succeed<FormSubmitResult>('failed');
      }
      setError(undefined);
      return run(command.value).pipe(
        Effect.map((outcome) => commandResult(outcome, (result) => onSaved(result.entityIds[0]), setError)),
      );
    },
    value: draft,
  });

  const requiredLabel = requiredLabelFor(language);
  const locationItems = [{ label: t('facility-operations.property.none'), value: NONE }];
  if (properties.status === 'ready') {
    locationItems.push(...properties.options.map((option) => ({ label: option.ref.label, value: option.value })));
  } else if (meter?.location !== undefined) {
    locationItems.push({ label: meter.location.label, value: `${meter.location.kind}:${meter.location.id}` });
  }

  return (
    <FormRoot
      className="flex flex-col gap-200"
      defaultValues={meterValuesOf(opened)}
      form={form}
      key={meter?.id ?? 'new'}
      translateMessage={(message) => t(message)}
    >
      {shown.ready}
      {error !== undefined && (
        <StatusText showIcon status="error">
          {meterErrorText(error, t)}
        </StatusText>
      )}
      <div className="grid grid-cols-1 gap-200 sm:grid-cols-2">
        <form.serialNumber
          autoComplete="off"
          helpText={t(`${k}.fieldHelp.serialNumber`)}
          id="meter-serial"
          label={t(`${k}.fields.serialNumber`)}
          maxLength={64}
          required
          requiredLabel={requiredLabel}
        />
        <form.medium
          items={meterMedia.map((medium) => ({ label: t(`${k}.medium.${medium}`), value: medium }))}
          label={t(`${k}.fields.medium`)}
        />
        <form.unit
          autoComplete="off"
          helpText={t(`${k}.fieldHelp.unit`)}
          id="meter-unit"
          label={t(`${k}.fields.unit`)}
          maxLength={16}
          required
          requiredLabel={requiredLabel}
        />
        <form.location items={locationItems} label={t(`${k}.fields.location`)} />
        <form.supplyPoint
          autoComplete="off"
          helpText={t(`${k}.fieldHelp.supplyPoint`)}
          id="meter-supply-point"
          label={t(`${k}.fields.supplyPoint`)}
          maxLength={120}
        />
        <form.supplier autoComplete="off" id="meter-supplier" label={t(`${k}.fields.supplier`)} maxLength={200} />
        <form.consumer
          autoComplete="off"
          helpText={t(`${k}.fieldHelp.consumer`)}
          id="meter-consumer"
          label={t(`${k}.fields.consumer`)}
          maxLength={200}
        />
        <form.contract autoComplete="off" id="meter-contract" label={t(`${k}.fields.contract`)} maxLength={200} />
      </div>
      <form.note id="meter-note" label={t(`${k}.fields.note`)} maxLength={4000} rows={2} />
      {meter !== undefined && <form.retired id="meter-retired" label={t(`${k}.edit.retire`)} />}
      {meter === undefined ? (
        <FormSaveFooter
          cancelLabel={t(CANCEL_LABEL)}
          error={meterErrorText(error, t)}
          form={create}
          onCancel={onCancel}
        />
      ) : (
        // The panel around the form asks this guard before it closes as well.
        <EditGuard draft={record} labels={labels} onDiscard={discard}>
          {(guard) => (
            <div className="flex flex-wrap items-center justify-end gap-100">
              <Button
                appearance="outline"
                onClick={() => {
                  guard.request(onCancel);
                }}
                severity="secondary"
              >
                {t('facility-operations.common.close')}
              </Button>
              <SaveBar labels={labels} onReloadLatest={handleReloadLatest} onSave={handleSave} status={record.status} />
            </div>
          )}
        </EditGuard>
      )}
    </FormRoot>
  );
};

// ---------------------------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------------------------

type ReadingError =
  | FailureReason
  | 'invalidValue'
  | 'invalidDate'
  | 'invalidCost'
  | 'pickMeter'
  | 'photoTooLarge'
  | 'photoFailed'
  | `problems.${string}`;

/** Preview of the consumption the new reading would produce (same rules as the history). */
const previewOf = (meter: Meter, date: string, value: number) => {
  // readingRows only looks at date, value, unit and voided; the draft is never stored.
  const draft = { date, unit: meter.unit, value };
  const row = readingRows({ readings: [...(meter.readings ?? []), draft] }).find((entry) => entry.reading === draft);
  if (row === undefined || row.status !== 'ok' || row.consumption === undefined || row.previous === undefined) {
    return { kind: 'first' as const };
  }
  return {
    anomaly: row.anomaly,
    change: row.change,
    consumption: row.consumption,
    kind: 'ok' as const,
    previous: row.previous,
  };
};

interface SubmitMeterReadingInput {
  readonly canRecordCosts: boolean;
  readonly cost: string;
  readonly date: (typeof MeterReadingSchema.Encoded)['date'];
  readonly meter: Meter | undefined;
  readonly note: string;
  readonly onSaved: (meterId: string) => void;
  readonly parsed: number | undefined;
  readonly photo: File | undefined;
  readonly problem: ReturnType<typeof readingProblem>;
  readonly readBy: string;
  readonly run: RunCommand;
  readonly setError: (error: ReadingError | undefined) => void;
}

const submitMeterReading = Effect.fn('Facility.submitMeterReading')(function* submitMeterReading({
  canRecordCosts,
  cost,
  date,
  meter,
  note,
  onSaved,
  parsed,
  photo,
  problem,
  readBy,
  run,
  setError,
}: SubmitMeterReadingInput) {
  if (meter === undefined) {
    setError('pickMeter');
    return 'failed' as const;
  }
  if (date === '') {
    setError('invalidDate');
    return 'failed' as const;
  }
  if (parsed === undefined) {
    setError('invalidValue');
    return 'failed' as const;
  }
  const costValue = cost.trim() === '' ? undefined : parseDecimal(cost);
  if (cost.trim() !== '' && costValue === undefined) {
    setError('invalidCost');
    return 'failed' as const;
  }
  if (problem !== undefined) {
    setError(`problems.${problem}`);
    return 'failed' as const;
  }
  if (photo !== undefined && photo.size > MAX_UPLOAD_BYTES) {
    setError('photoTooLarge');
    return 'failed' as const;
  }
  setError(undefined);
  let stored: MeterPhoto | undefined;
  if (photo !== undefined) {
    const uploaded = yield* uploadFile(photo);
    if (!uploaded.ok) {
      setError(uploaded.reason === 'forbidden' ? 'forbidden' : 'photoFailed');
      return 'failed' as const;
    }
    stored = uploaded.file;
  }
  const command: MutableReadingCommand = {
    _tag: 'MeterReadingRecord',
    date,
    meterId: meter.id,
    value: parsed,
    ...optional('readBy', readBy),
    ...optional('note', note),
  };
  if (canRecordCosts && costValue !== undefined) {
    command.costMinor = Math.round(costValue * 100);
  }
  if (stored !== undefined) {
    command.photo = stored;
  }
  const outcome = yield* run(command);
  const meterId = meter.id;
  return commandResult(outcome, () => onSaved(meterId), setError);
});

/**
 * The values of one reading. Uložit sends them through the form save, so the form only holds them and Enter sends
 * nothing.
 */
const makeReadingForm = () =>
  FormReact.make(
    FormBuilder.empty
      .addField('cost', Schema.String)
      .addField('date', Schema.String)
      .addField('meterId', Schema.String)
      .addField('note', Schema.String)
      .addField('photo', Schema.OptionFromNullOr(Schema.instanceOf(File)))
      .addField('readBy', Schema.String)
      .addField('value', Schema.String),
    {
      fields: {
        cost: RuledTextField,
        date: TextField,
        meterId: ChoiceField,
        note: TextAreaField,
        photo: FileField,
        readBy: TextField,
        value: RuledTextField,
      },
      onSubmit: () => Effect.void,
      runtime: browserAtomRuntime,
    },
  );

/** A reading from the list and a reading of one meter's detail are separate forms. */
const pickedReadingForm = makeReadingForm();
const fixedReadingForm = makeReadingForm();

type ReadingDraft = typeof pickedReadingForm.schema.Encoded;

const readingDraftOf = (fixedMeterId: string | undefined): ReadingDraft => ({
  cost: '',
  date: pragueToday(),
  meterId: fixedMeterId ?? '',
  note: '',
  photo: null,
  readBy: '',
  value: '',
});

/** The picked meter as a plain string, which changes only when the pick does. */
const pickedMeterOf = (form: typeof pickedReadingForm) =>
  form.getFieldAtoms(form.fields.meterId).value.pipe(Atom.map(Option.getOrElse(() => '')));
const pickedMeters = { fixed: pickedMeterOf(fixedReadingForm), picked: pickedMeterOf(pickedReadingForm) };

const ReadingPreview = ({
  meter,
  parsed,
  preview,
  problem,
}: {
  readonly meter: Meter | undefined;
  readonly parsed: number | undefined;
  readonly preview: ReturnType<typeof previewOf> | undefined;
  readonly problem: ReturnType<typeof readingProblem>;
}) => {
  const { t } = useModernI18n();
  if (meter === undefined || parsed === undefined) {
    return null;
  }
  if (problem !== undefined) {
    return (
      <StatusText showIcon status="error">
        {t(`${k}.reading.problems.${problem}`)}
      </StatusText>
    );
  }
  if (preview === undefined) {
    return null;
  }
  return (
    <div
      className={`rounded-lg p-150 text-sm ${preview.kind === 'ok' && preview.anomaly ? 'bg-bg-danger-subtle' : 'bg-surface'}`}
      data-testid="reading-preview"
    >
      {preview.kind === 'first' ? (
        t(`${k}.reading.previewFirst`)
      ) : (
        <div className="flex flex-col gap-50">
          <span>
            {t(`${k}.reading.preview`, {
              date: formatDate(preview.previous.date),
              value: formatQuantity(preview.consumption, meter.unit),
            })}
          </span>
          {preview.anomaly && preview.change !== undefined && (
            <strong>{t(`${k}.reading.previewAnomaly`, { change: formatChange(preview.change) })}</strong>
          )}
        </div>
      )}
    </div>
  );
};

const readingValueStatus = (value: string, parsed: number | undefined, problem: ReturnType<typeof readingProblem>) => {
  if (value !== '' && parsed === undefined) {
    return 'error' as const;
  }
  return problem === undefined ? ('default' as const) : ('error' as const);
};
const readingErrorKey = (error: ReadingError) => {
  if (['conflict', 'forbidden', 'invalid', 'rejected', 'unavailable'].includes(error)) {
    return `facility-operations.common.errors.${error}`;
  }
  return `${k}.reading.${error}`;
};
const readingErrorText = (error: ReadingError | undefined, t: ReturnType<typeof useModernI18n>['t']) =>
  error === undefined ? undefined : t(readingErrorKey(error));

export const ReadingForm = ({
  canRecordCosts,
  canUploadPhoto,
  fixedMeterId,
  meters,
  onCancel,
  onSaved,
  run,
}: {
  readonly canRecordCosts: boolean;
  readonly canUploadPhoto: boolean;
  readonly fixedMeterId?: string;
  readonly meters: readonly Meter[];
  readonly onCancel: () => void;
  readonly onSaved: (meterId: string) => void;
  readonly run: RunCommand;
}) => {
  const { language, t } = useModernI18n();
  const readingForm = fixedMeterId === undefined ? pickedReadingForm : fixedReadingForm;
  // Read before this mount initialized the form only, so a later day's date never replaces the one it opened with.
  const opened = readingDraftOf(fixedMeterId);
  const { ready, values: draft } = useFormValues(readingForm, opened);
  const { cost, date, meterId, note, photo, readBy, value } = draft;
  const setValues = useAtomSet(readingForm.setValues);
  const setPhoto = useAtomSet(readingForm.getFieldAtoms(readingForm.fields.photo).setValue);
  const [error, setError] = useState<ReadingError | undefined>();
  // Picking another meter clears the message about the previous pick.
  useAtomSubscribe(
    fixedMeterId === undefined ? pickedMeters.picked : pickedMeters.fixed,
    () => {
      setError(undefined);
    },
    { immediate: false },
  );
  const meter = meters.find((entry) => entry.id === meterId);
  const parsed = parseDecimal(value);
  const preview =
    meter !== undefined && parsed !== undefined && date !== '' ? previewOf(meter, date, parsed) : undefined;
  const problem =
    meter !== undefined && parsed !== undefined && date !== ''
      ? readingProblem(meter, { date, value: parsed }, pragueToday())
      : undefined;

  // A reading is sent on Uložit only, with the same checks and command as before.
  const form = useFormSave<ReadingDraft>({
    onDiscard: () => {
      setValues(readingDraftOf(fixedMeterId));
      setError(undefined);
    },
    submit: () =>
      submitMeterReading({
        canRecordCosts,
        cost,
        date,
        meter,
        note,
        onSaved,
        parsed,
        photo: photo ?? undefined,
        problem,
        readBy,
        run,
        setError,
      }).pipe(
        // A photo the browser could not read is the photo's failure, said on the form like a failed upload.
        Effect.catchTag('FileReadFailed', () =>
          Effect.sync((): FormSubmitResult => {
            setError('photoFailed');
            return 'failed';
          }),
        ),
      ),
    value: draft,
  });

  const activeMeters = meters.filter((entry) => entry.status !== 'RETIRED');
  const errorText = readingErrorText(error, t);
  const requiredLabel = requiredLabelFor(language);

  return (
    <FormRoot
      className="flex flex-col gap-200"
      defaultValues={opened}
      form={readingForm}
      translateMessage={(message) => t(message)}
    >
      {ready}
      {errorText !== undefined && (
        <StatusText showIcon status="error">
          {errorText}
        </StatusText>
      )}
      {fixedMeterId === undefined && (
        <readingForm.meterId
          items={activeMeters.map((entry) => {
            const mediumLabel = t(`${k}.medium.${entry.medium}`);
            const locationLabel = entry.location === undefined ? '' : ` · ${entry.location.label}`;
            return { label: `${entry.serialNumber} · ${mediumLabel}${locationLabel}`, value: entry.id };
          })}
          label={t(`${k}.reading.meter`)}
          placeholder={t(`${k}.reading.pickMeter`)}
        />
      )}
      <div className="grid grid-cols-1 gap-200 sm:grid-cols-2">
        <readingForm.date
          id="reading-date"
          label={t(`${k}.reading.date`)}
          max={pragueToday()}
          required
          requiredLabel={requiredLabel}
          type="date"
        />
        <readingForm.value
          autoComplete="off"
          helpText={t(`${k}.reading.valueHelp`)}
          id="reading-value"
          inputMode="decimal"
          invalid={readingValueStatus(value, parsed, problem) === 'error'}
          label={t(`${k}.reading.value`, { unit: meter?.unit ?? '—' })}
          required
          requiredLabel={requiredLabel}
        />
      </div>
      <ReadingPreview meter={meter} parsed={parsed} preview={preview} problem={problem} />
      <div className="grid grid-cols-1 gap-200 sm:grid-cols-2">
        <readingForm.readBy autoComplete="off" id="reading-read-by" label={t(`${k}.reading.readBy`)} maxLength={120} />
        {canRecordCosts && (
          <readingForm.cost
            autoComplete="off"
            helpText={t(`${k}.reading.costHelp`)}
            id="reading-cost"
            inputMode="decimal"
            invalid={cost.trim() !== '' && parseDecimal(cost) === undefined}
            label={t(`${k}.reading.cost`)}
          />
        )}
      </div>
      <readingForm.note id="reading-note" label={t(`${k}.reading.note`)} maxLength={4000} rows={2} />
      {canUploadPhoto ? (
        <div className="flex flex-col gap-50">
          <span className="font-medium text-sm">{t(`${k}.reading.photo`)}</span>
          <readingForm.photo accept="image/*" className="hidden" id="reading-photo">
            {(pick) => (
              <div className="flex flex-wrap items-center gap-150">
                <Button appearance="outline" onClick={pick} severity="secondary" size="sm">
                  {t(`${k}.reading.photoPick`)}
                </Button>
                <span className="text-sm">
                  {photo === null ? t(`${k}.reading.photoNone`) : `${photo.name} (${Math.ceil(photo.size / 1024)} kB)`}
                </span>
                {photo !== null && (
                  <Button
                    appearance="ghost"
                    onClick={() => {
                      setPhoto(null);
                    }}
                    severity="secondary"
                    size="sm"
                  >
                    {t(CANCEL_LABEL)}
                  </Button>
                )}
              </div>
            )}
          </readingForm.photo>
          <span className="text-fg-secondary text-xs">{t(`${k}.reading.photoHelp`)}</span>
        </div>
      ) : (
        <p className="text-fg-secondary text-xs">{t(`${k}.reading.photoRestricted`)}</p>
      )}
      <FormSaveFooter cancelLabel={t(CANCEL_LABEL)} error={errorText} form={form} onCancel={onCancel} />
    </FormRoot>
  );
};
