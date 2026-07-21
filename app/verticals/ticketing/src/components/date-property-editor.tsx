// @effect-diagnostics asyncFunction:off cryptoRandomUUID:off
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import * as datePicker from '@zag-js/date-picker';
import { normalizeProps, useMachine } from '@zag-js/react';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Input } from '@techsio/ui-kit/atoms/input';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Popover } from '@techsio/ui-kit/molecules/popover';
import { toaster } from '@techsio/ui-kit/molecules/toast';
import { useId, useState } from 'react';
import { canonicalCalendarDate } from '../../shared/date-value';

export type DatePropertyLocale = 'cs-CZ' | 'en-GB';

export interface DatePropertyDraft {
  readonly collectionId: string;
  readonly expectedRevision: number;
  readonly propertyDefinitionId: string;
  readonly taskId: string;
  readonly value: string | null;
}

export interface SavedDatePropertyValue {
  readonly taskRevision: number;
  readonly value: {
    readonly propertyDefinitionId: string;
    readonly revision: number;
    readonly value: string | null;
  } | null;
}

export interface DatePropertyEditorProps {
  readonly collectionId: string;
  readonly label: string;
  readonly locale: DatePropertyLocale;
  readonly onSave: (
    draft: DatePropertyDraft,
    idempotencyKey: string,
  ) => Promise<SavedDatePropertyValue>;
  readonly propertyDefinitionId: string;
  readonly readOnly?: boolean;
  readonly revision: number;
  readonly taskId: string;
  readonly value: string | null;
}

const dateParts = (value: string): readonly [number, number, number] | null => {
  const matched = /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})$/u.exec(value);
  return matched?.groups === undefined
    ? null
    : [
        Number(matched.groups['year']),
        Number(matched.groups['month']),
        Number(matched.groups['day']),
      ];
};

const formatLocalizedDate = (value: string | null, locale: DatePropertyLocale): string => {
  if (value === null) {
    return '';
  }
  const parts = dateParts(value);
  if (parts === null) {
    return value;
  }
  const [year, month, day] = parts;
  const paddedDay = String(day).padStart(2, '0');
  const paddedMonth = String(month).padStart(2, '0');
  return locale === 'cs-CZ'
    ? `${paddedDay}. ${paddedMonth}. ${year}`
    : `${paddedDay}/${paddedMonth}/${year}`;
};

const parseLocalizedDate = (value: string, locale: DatePropertyLocale): string | null => {
  const matched =
    locale === 'cs-CZ'
      ? /^(?<day>\d{1,2})\.\s*(?<month>\d{1,2})\.\s*(?<year>\d{4})$/u.exec(value.trim())
      : /^(?<day>\d{1,2})\/(?<month>\d{1,2})\/(?<year>\d{4})$/u.exec(value.trim());
  return matched?.groups === undefined
    ? null
    : canonicalCalendarDate(
        Number(matched.groups['year']),
        Number(matched.groups['month']),
        Number(matched.groups['day']),
      );
};

const clientLocalToday = (): string => {
  const today = new Date();
  return [today.getFullYear(), today.getMonth() + 1, today.getDate()]
    .map((part, index) => String(part).padStart(index === 0 ? 4 : 2, '0'))
    .join('-');
};

const isStaleDateFailure = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  error.code === 'ticketing.updateDatePropertyValue.stale_or_missing';

interface DateCalendarProps {
  readonly locale: DatePropertyLocale;
  readonly onSelect: (value: string) => void;
  readonly selectedValue: string | null;
}

const DateCalendar = ({ locale, onSelect, selectedValue }: DateCalendarProps) => {
  const { t } = useModernI18n();
  const service = useMachine(datePicker.machine, {
    defaultFocusedValue: datePicker.parse(selectedValue ?? clientLocalToday()),
    fixedWeeks: true,
    id: useId(),
    inline: true,
    locale,
    onValueChange: ({ value }) => {
      const selected = value.at(0)?.toString();
      if (selected !== undefined) {
        onSelect(selected);
      }
    },
    outsideDaySelectable: true,
    selectionMode: 'single',
    startOfWeek: 1,
    value: selectedValue === null ? [] : [datePicker.parse(selectedValue)],
  });
  const api = datePicker.connect(service, normalizeProps);

  return (
    <div {...api.getContentProps()}>
      <div {...api.getViewControlProps({ view: 'year' })}>
        <Button
          {...api.getPrevTriggerProps()}
          aria-label={t('ticketing.date.previousMonth')}
          size="sm"
          theme="borderless"
          variant="secondary"
        >
          ‹
        </Button>
        <span aria-live="polite">{api.visibleRangeText.start}</span>
        <Button
          {...api.getNextTriggerProps()}
          aria-label={t('ticketing.date.nextMonth')}
          size="sm"
          theme="borderless"
          variant="secondary"
        >
          ›
        </Button>
      </div>
      <table {...api.getTableProps({ view: 'day' })}>
        <thead {...api.getTableHeaderProps({ view: 'day' })}>
          <tr {...api.getTableRowProps({ view: 'day' })}>
            {api.weekDays.map((day) => (
              <th aria-label={day.long} key={day.long} scope="col">
                {day.narrow}
              </th>
            ))}
          </tr>
        </thead>
        <tbody {...api.getTableBodyProps({ view: 'day' })}>
          {api.weeks.map((week, weekIndex) => (
            <tr key={weekIndex} {...api.getTableRowProps({ view: 'day' })}>
              {week.map((day) => (
                <td key={day.toString()} {...api.getDayTableCellProps({ value: day })}>
                  <Button
                    {...api.getDayTableCellTriggerProps({ value: day })}
                    size="current"
                    theme={selectedValue === day.toString() ? 'light' : 'borderless'}
                    variant={selectedValue === day.toString() ? 'primary' : 'tertiary'}
                  >
                    {day.day}
                  </Button>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

export const DatePropertyEditor = ({
  collectionId,
  label,
  locale,
  onSave,
  propertyDefinitionId,
  readOnly = false,
  revision,
  taskId,
  value,
}: DatePropertyEditorProps) => {
  const { t } = useModernI18n();
  const [committedValue, setCommittedValue] = useState(value);
  const [currentRevision, setCurrentRevision] = useState(revision);
  const [draftValue, setDraftValue] = useState(() => formatLocalizedDate(value, locale));
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [invalidDraft, setInvalidDraft] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [hasUnsavedDraft, setHasUnsavedDraft] = useState(false);

  const saveValue = async (nextValue: string | null) => {
    setIsSaving(true);
    setInvalidDraft(false);
    setDraftValue(formatLocalizedDate(nextValue, locale));
    setHasUnsavedDraft(true);

    try {
      const saved = await onSave(
        {
          collectionId,
          expectedRevision: currentRevision,
          propertyDefinitionId,
          taskId,
          value: nextValue,
        },
        idempotencyKey,
      );
      setCommittedValue(saved.value?.value ?? null);
      setCurrentRevision(saved.value?.revision ?? 0);
      setDraftValue(formatLocalizedDate(saved.value?.value ?? null, locale));
      setHasUnsavedDraft(false);
      setIdempotencyKey(crypto.randomUUID());
    } catch (error) {
      toaster.create(
        isStaleDateFailure(error)
          ? {
              description: t('ticketing.date.staleDescription'),
              title: t('ticketing.date.staleTitle'),
              type: 'warning',
            }
          : {
              description:
                error instanceof Error ? error.message : t('ticketing.date.saveFailedDescription'),
              title: t('ticketing.date.saveFailedTitle'),
              type: 'error',
            },
      );
    } finally {
      setIsSaving(false);
    }
  };

  const saveManualDraft = () => {
    if (draftValue.trim().length === 0) {
      void saveValue(null);
      return;
    }
    const parsed = parseLocalizedDate(draftValue, locale);
    if (parsed === null) {
      setInvalidDraft(true);
      return;
    }
    void saveValue(parsed);
  };

  return (
    <Popover
      border
      onOpenChange={({ open }) => {
        if (open) {
          if (!hasUnsavedDraft) {
            setDraftValue(formatLocalizedDate(committedValue, locale));
          }
          setInvalidDraft(false);
        }
      }}
      placement="bottom-start"
      shadow
      size="lg"
    >
      <Popover.Trigger
        aria-label={`${label}: ${
          committedValue === null
            ? t('ticketing.date.empty')
            : formatLocalizedDate(committedValue, locale)
        }`}
        disabled={readOnly}
        theme="outlined"
        variant="secondary"
      >
        {committedValue === null
          ? t('ticketing.date.empty')
          : formatLocalizedDate(committedValue, locale)}
      </Popover.Trigger>
      <Popover.Positioner>
        <Popover.Content>
          <Popover.Arrow />
          <Popover.Title>{label}</Popover.Title>
          <Popover.CloseTrigger aria-label={t('ticketing.date.close')} />
          <Input
            aria-describedby={invalidDraft ? `${propertyDefinitionId}-date-error` : undefined}
            aria-label={label}
            disabled={isSaving}
            onChange={(event) => {
              setDraftValue(event.target.value);
              setHasUnsavedDraft(true);
              setInvalidDraft(false);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                saveManualDraft();
              }
            }}
            placeholder={t('ticketing.date.placeholder')}
            size="md"
            value={draftValue}
            variant={invalidDraft ? 'error' : 'default'}
          />
          {invalidDraft ? (
            <StatusText id={`${propertyDefinitionId}-date-error`} showIcon status="error">
              {t('ticketing.date.invalid')}
            </StatusText>
          ) : null}
          <Button disabled={isSaving} onClick={saveManualDraft} size="sm" variant="primary">
            {t('ticketing.date.save')}
          </Button>
          <DateCalendar
            locale={locale}
            onSelect={(selected) => void saveValue(selected)}
            selectedValue={committedValue}
          />
          <Button
            disabled={isSaving}
            onClick={() => void saveValue(clientLocalToday())}
            size="sm"
            theme="light"
            variant="primary"
          >
            {t('ticketing.date.today')}
          </Button>
          <Button
            disabled={isSaving || committedValue === null}
            onClick={() => void saveValue(null)}
            size="sm"
            theme="borderless"
            variant="secondary"
          >
            {t('ticketing.date.clear')}
          </Button>
        </Popover.Content>
      </Popover.Positioner>
    </Popover>
  );
};
