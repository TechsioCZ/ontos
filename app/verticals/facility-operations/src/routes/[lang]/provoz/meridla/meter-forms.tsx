import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
// Meter master-data form and reading form (ops-meters lane). Both write through the governed apply-command Action.
import { SaveBar, formatDate, saveLabelsFor, useDraftSave } from '@app/admin-ui';
import type { SaveOutcome } from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { FormInput, FormTextarea } from '@app/admin-ui/form-controls';
import { SelectTemplate as Select } from '@app/admin-ui/select-template';
import { DateTime, Effect, Option, Result, Schema } from 'effect';
import { useReducer, useRef, useState } from 'react';
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
  const [draft, setDraft] = useState<MeterDraft>(() => meterDraftOf(meter));
  const [error, setError] = useState<FailureReason | 'required' | undefined>();
  const set = <Key extends keyof MeterDraft>(key: Key, value: MeterDraft[Key]) =>
    setDraft((current) => ({ ...current, [key]: value }));

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
        setDraft(stored);
      }
    },
    settled: !record.pending && sameMeterDraft(draft, record.confirmed),
  });
  const labels = saveLabelsFor(language);
  const discard = () => {
    setDraft(record.confirmed);
    setError(undefined);
  };
  const handleSave = record.save;
  const handleReloadLatest = () => {
    const current = meterDraftOf(meter);
    base.rebase();
    record.adopt(current);
    setDraft(current);
    setError(undefined);
  };

  // A new meter is sent on Uložit only; the draft it opens with is not typed input.
  const create = useFormSave<MeterDraft>({
    equals: sameMeterDraft,
    onDiscard: () => {
      setDraft(meterDraftOf());
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

  const locationItems = [
    {
      displayValue: t('facility-operations.property.none'),
      label: t('facility-operations.property.none'),
      value: NONE,
    },
  ];
  if (properties.status === 'ready') {
    locationItems.push(
      ...properties.options.map((option) => ({
        displayValue: option.ref.label,
        label: option.ref.label,
        value: option.value,
      })),
    );
  } else if (meter?.location !== undefined) {
    locationItems.push({
      displayValue: meter.location.label,
      label: meter.location.label,
      value: `${meter.location.kind}:${meter.location.id}`,
    });
  }

  return (
    <div className="flex flex-col gap-200">
      {error !== undefined && (
        <StatusText showIcon status="error">
          {meterErrorText(error, t)}
        </StatusText>
      )}
      <div className="grid grid-cols-1 gap-200 sm:grid-cols-2">
        <FormInput
          autoComplete="off"
          helpText={t(`${k}.fieldHelp.serialNumber`)}
          id="meter-serial"
          label={t(`${k}.fields.serialNumber`)}
          maxLength={64}
          onChange={(event) => set('serialNumber', event.target.value)}
          required
          value={draft.serialNumber}
        />
        <Select
          items={meterMedia.map((medium) => ({
            displayValue: t(`${k}.medium.${medium}`),
            label: t(`${k}.medium.${medium}`),
            value: medium,
          }))}
          label={t(`${k}.fields.medium`)}
          name="medium"
          onValueChange={({ value }) => {
            const parsed = Schema.decodeUnknownResult(MeterMediumSchema)(value[0] ?? 'ELECTRICITY');
            if (Result.isFailure(parsed)) {
              return;
            }
            const medium = parsed.success;
            setDraft((current) => ({
              ...current,
              medium,
              unit:
                meter === undefined && (current.unit === '' || current.unit === defaultUnitOf[current.medium])
                  ? defaultUnitOf[medium]
                  : current.unit,
            }));
          }}
          size="md"
          value={[draft.medium]}
        />
        <FormInput
          autoComplete="off"
          helpText={t(`${k}.fieldHelp.unit`)}
          id="meter-unit"
          label={t(`${k}.fields.unit`)}
          maxLength={16}
          onChange={(event) => set('unit', event.target.value)}
          required
          value={draft.unit}
        />
        <Select
          items={locationItems}
          label={t(`${k}.fields.location`)}
          name="location"
          onValueChange={({ value }) => set('location', value[0] === undefined || value[0] === NONE ? '' : value[0])}
          size="md"
          value={[draft.location === '' ? NONE : draft.location]}
        />
        <FormInput
          autoComplete="off"
          helpText={t(`${k}.fieldHelp.supplyPoint`)}
          id="meter-supply-point"
          label={t(`${k}.fields.supplyPoint`)}
          maxLength={120}
          onChange={(event) => set('supplyPoint', event.target.value)}
          value={draft.supplyPoint}
        />
        <FormInput
          autoComplete="off"
          id="meter-supplier"
          label={t(`${k}.fields.supplier`)}
          maxLength={200}
          onChange={(event) => set('supplier', event.target.value)}
          value={draft.supplier}
        />
        <FormInput
          autoComplete="off"
          helpText={t(`${k}.fieldHelp.consumer`)}
          id="meter-consumer"
          label={t(`${k}.fields.consumer`)}
          maxLength={200}
          onChange={(event) => set('consumer', event.target.value)}
          value={draft.consumer}
        />
        <FormInput
          autoComplete="off"
          id="meter-contract"
          label={t(`${k}.fields.contract`)}
          maxLength={200}
          onChange={(event) => set('contract', event.target.value)}
          value={draft.contract}
        />
      </div>
      <FormTextarea
        id="meter-note"
        label={t(`${k}.fields.note`)}
        maxLength={4000}
        onChange={(event) => set('note', event.target.value)}
        rows={2}
        value={draft.note}
      />
      {meter !== undefined && (
        <label className="flex items-center gap-100 text-sm">
          <input checked={draft.retired} onChange={(event) => set('retired', event.target.checked)} type="checkbox" />
          {t(`${k}.edit.retire`)}
        </label>
      )}
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
                onClick={() => {
                  guard.request(onCancel);
                }}
                theme="outlined"
                variant="secondary"
              >
                {t('facility-operations.common.close')}
              </Button>
              <SaveBar labels={labels} onReloadLatest={handleReloadLatest} onSave={handleSave} status={record.status} />
            </div>
          )}
        </EditGuard>
      )}
    </div>
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

interface ReadingDraft {
  readonly cost: string;
  readonly date: (typeof MeterReadingSchema.Encoded)['date'];
  readonly meterId: string;
  readonly note: string;
  readonly photo?: File;
  readonly readBy: string;
  readonly value: string;
}
const readingDraftOf = (fixedMeterId: string | undefined): ReadingDraft => ({
  cost: '',
  date: pragueToday(),
  meterId: fixedMeterId ?? '',
  note: '',
  readBy: '',
  value: '',
});
type ReadingDraftChange = Partial<ReadingDraft> | { readonly clearPhoto: true } | { readonly reset: ReadingDraft };
const updateReadingDraft = (draft: ReadingDraft, changes: ReadingDraftChange): ReadingDraft => {
  if ('reset' in changes) {
    return changes.reset;
  }
  if ('clearPhoto' in changes) {
    const { photo: _photo, ...withoutPhoto } = draft;
    return withoutPhoto;
  }
  return { ...draft, ...changes };
};

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
  const { t } = useModernI18n();
  const [draft, updateDraft] = useReducer(updateReadingDraft, fixedMeterId, readingDraftOf);
  const { cost, date, meterId, note, photo, readBy, value } = draft;
  const setMeterId = (nextValue: string) => updateDraft({ meterId: nextValue });
  const setDate = (nextValue: (typeof MeterReadingSchema.Encoded)['date']) => updateDraft({ date: nextValue });
  const setValue = (nextValue: string) => updateDraft({ value: nextValue });
  const setReadBy = (nextValue: string) => updateDraft({ readBy: nextValue });
  const setCost = (nextValue: string) => updateDraft({ cost: nextValue });
  const setNote = (nextValue: string) => updateDraft({ note: nextValue });
  const setPhoto = (nextPhoto: File | undefined) => {
    if (nextPhoto === undefined) {
      updateDraft({ clearPhoto: true });
    } else {
      updateDraft({ photo: nextPhoto });
    }
  };
  const photoInput = useRef<HTMLInputElement | null>(null);
  const [error, setError] = useState<ReadingError | undefined>();
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
      updateDraft({ reset: readingDraftOf(fixedMeterId) });
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
        photo,
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

  return (
    <div className="flex flex-col gap-200">
      {errorText !== undefined && (
        <StatusText showIcon status="error">
          {errorText}
        </StatusText>
      )}
      {fixedMeterId === undefined && (
        <Select
          items={activeMeters.map((entry) => {
            const mediumLabel = t(`${k}.medium.${entry.medium}`);
            const locationLabel = entry.location === undefined ? '' : ` · ${entry.location.label}`;
            const label = `${entry.serialNumber} · ${mediumLabel}${locationLabel}`;
            return { displayValue: label, label, value: entry.id };
          })}
          label={t(`${k}.reading.meter`)}
          name="meter"
          onValueChange={({ value: picked }) => {
            setMeterId(picked[0] ?? '');
            setError(undefined);
          }}
          placeholder={t(`${k}.reading.pickMeter`)}
          size="md"
          value={meterId === '' ? [] : [meterId]}
        />
      )}
      <div className="grid grid-cols-1 gap-200 sm:grid-cols-2">
        <FormInput
          id="reading-date"
          label={t(`${k}.reading.date`)}
          max={pragueToday()}
          onChange={(event) => setDate(event.target.value)}
          required
          type="date"
          value={date}
        />
        <FormInput
          autoComplete="off"
          helpText={t(`${k}.reading.valueHelp`)}
          id="reading-value"
          inputMode="decimal"
          label={t(`${k}.reading.value`, { unit: meter?.unit ?? '—' })}
          onChange={(event) => setValue(event.target.value)}
          required
          validateStatus={readingValueStatus(value, parsed, problem)}
          value={value}
        />
      </div>
      <ReadingPreview meter={meter} parsed={parsed} preview={preview} problem={problem} />
      <div className="grid grid-cols-1 gap-200 sm:grid-cols-2">
        <FormInput
          autoComplete="off"
          id="reading-read-by"
          label={t(`${k}.reading.readBy`)}
          maxLength={120}
          onChange={(event) => setReadBy(event.target.value)}
          value={readBy}
        />
        {canRecordCosts && (
          <FormInput
            autoComplete="off"
            helpText={t(`${k}.reading.costHelp`)}
            id="reading-cost"
            inputMode="decimal"
            label={t(`${k}.reading.cost`)}
            onChange={(event) => setCost(event.target.value)}
            validateStatus={cost.trim() !== '' && parseDecimal(cost) === undefined ? 'error' : 'default'}
            value={cost}
          />
        )}
      </div>
      <FormTextarea
        id="reading-note"
        label={t(`${k}.reading.note`)}
        maxLength={4000}
        onChange={(event) => setNote(event.target.value)}
        rows={2}
        value={note}
      />
      {canUploadPhoto ? (
        <div className="flex flex-col gap-50">
          <span className="font-medium text-sm">{t(`${k}.reading.photo`)}</span>
          <input
            accept="image/*"
            className="hidden"
            id="reading-photo"
            onChange={(event) => setPhoto(event.target.files?.[0])}
            ref={photoInput}
            type="file"
          />
          <div className="flex flex-wrap items-center gap-150">
            <Button onClick={() => photoInput.current?.click()} size="sm" theme="outlined" variant="secondary">
              {t(`${k}.reading.photoPick`)}
            </Button>
            <span className="text-sm">
              {photo === undefined ? t(`${k}.reading.photoNone`) : `${photo.name} (${Math.ceil(photo.size / 1024)} kB)`}
            </span>
            {photo !== undefined && (
              <Button
                onClick={() => {
                  setPhoto(undefined);
                  if (photoInput.current !== null) {
                    photoInput.current.value = '';
                  }
                }}
                size="sm"
                theme="borderless"
                variant="secondary"
              >
                {t(CANCEL_LABEL)}
              </Button>
            )}
          </div>
          <span className="text-fg-secondary text-xs">{t(`${k}.reading.photoHelp`)}</span>
        </div>
      ) : (
        <p className="text-fg-secondary text-xs">{t(`${k}.reading.photoRestricted`)}</p>
      )}
      <FormSaveFooter cancelLabel={t(CANCEL_LABEL)} error={errorText} form={form} onCancel={onCancel} />
    </div>
  );
};
