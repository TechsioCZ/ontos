// @effect-diagnostics asyncFunction:off cryptoRandomUUID:off
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { toaster } from '@techsio/ui-kit/molecules/toast';
import { useState } from 'react';
import type { ClipboardEvent } from 'react';
import { canonicalizeNumberValue } from '../../shared/number-value';

export type NumberPropertyFormat = 'number' | 'number_with_separators' | 'percent';

export interface NumberPropertyDraft {
  readonly collectionId: string;
  readonly expectedRevision: number;
  readonly propertyDefinitionId: string;
  readonly taskId: string;
  readonly value: string | null;
}

export interface SavedNumberPropertyValue {
  readonly taskRevision: number;
  readonly value: {
    readonly propertyDefinitionId: string;
    readonly revision: number;
    readonly value: string | null;
  };
}

export interface NumberPropertyEditorProps {
  readonly collectionId: string;
  readonly format: NumberPropertyFormat;
  readonly label: string;
  readonly locale: string;
  readonly onSave: (
    draft: NumberPropertyDraft,
    idempotencyKey: string,
  ) => Promise<SavedNumberPropertyValue>;
  readonly propertyDefinitionId: string;
  readonly readOnly?: boolean;
  readonly revision: number;
  readonly taskId: string;
  readonly value: string | null;
}

interface LocaleNumberSymbols {
  readonly decimal: string;
  readonly group: string;
}

const localeNumberSymbols = (locale: string): LocaleNumberSymbols => {
  const parts = new Intl.NumberFormat(locale).formatToParts(12_345.6);
  return {
    decimal: parts.find(({ type }) => type === 'decimal')?.value ?? '.',
    group: parts.find(({ type }) => type === 'group')?.value ?? ',',
  };
};

const groupInteger = (integer: string, separator: string): string => {
  const groups: string[] = [];
  for (let cursor = integer.length; cursor > 0; cursor -= 3) {
    groups.unshift(integer.slice(Math.max(0, cursor - 3), cursor));
  }
  return groups.join(separator);
};

export const formatNumberPropertyValue = ({
  format,
  locale,
  value,
}: {
  readonly format: NumberPropertyFormat;
  readonly locale: string;
  readonly value: string | null;
}): string => {
  if (value === null) {
    return '';
  }
  const { decimal, group } = localeNumberSymbols(locale);
  const negative = value.startsWith('-');
  const [integer = '0', fraction] = (negative ? value.slice(1) : value).split('.');
  const displayedInteger =
    format === 'number_with_separators' ? groupInteger(integer, group) : integer;
  const localized = `${negative ? '-' : ''}${displayedInteger}${
    fraction === undefined ? '' : `${decimal}${fraction}`
  }`;
  return format === 'percent' ? `${localized} %` : localized;
};

export const parseLocalizedNumberPropertyValue = (
  draft: string,
  locale: string,
): string | null | undefined => {
  const trimmed = draft.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const { decimal, group } = localeNumberSymbols(locale);
  const withoutGroups = trimmed
    .split(group)
    .join('')
    .replaceAll('\u00A0', '')
    .replaceAll('\u202F', '');
  const canonicalDraft = decimal === '.' ? withoutGroups : withoutGroups.replace(decimal, '.');
  return canonicalizeNumberValue(canonicalDraft);
};

const isStaleNumberFailure = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  error.code === 'ticketing.updateNumberPropertyValue.stale_or_missing';

export const NumberPropertyEditor = ({
  collectionId,
  format,
  label,
  locale,
  onSave,
  propertyDefinitionId,
  readOnly = false,
  revision,
  taskId,
  value,
}: NumberPropertyEditorProps) => {
  const { t } = useModernI18n();
  const [committedValue, setCommittedValue] = useState(value);
  const [currentRevision, setCurrentRevision] = useState(revision);
  const [draft, setDraft] = useState(() => formatNumberPropertyValue({ format, locale, value }));
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const showInvalidToast = () =>
    toaster.create({
      description: t('ticketing.number.invalidDescription'),
      title: t('ticketing.number.invalidTitle'),
      type: 'error',
    });

  const handlePaste = (event: ClipboardEvent<HTMLInputElement>) => {
    const pasted = event.clipboardData.getData('text');
    const parsed = parseLocalizedNumberPropertyValue(pasted, locale);
    event.preventDefault();
    if (parsed === undefined) {
      showInvalidToast();
      return;
    }
    setDraft(formatNumberPropertyValue({ format: 'number', locale, value: parsed }));
  };

  const handleSave = async () => {
    const parsed = parseLocalizedNumberPropertyValue(draft, locale);
    if (parsed === undefined) {
      showInvalidToast();
      return;
    }
    if (parsed === committedValue) {
      setDraft(formatNumberPropertyValue({ format, locale, value: committedValue }));
      setIsEditing(false);
      return;
    }

    setIsSaving(true);
    try {
      const saved = await onSave(
        {
          collectionId,
          expectedRevision: currentRevision,
          propertyDefinitionId,
          taskId,
          value: parsed,
        },
        idempotencyKey,
      );
      setCommittedValue(saved.value.value);
      setCurrentRevision(saved.value.revision);
      setDraft(formatNumberPropertyValue({ format, locale, value: saved.value.value }));
      setIdempotencyKey(crypto.randomUUID());
      setIsEditing(false);
    } catch (error) {
      toaster.create(
        isStaleNumberFailure(error)
          ? {
              description: t('ticketing.number.staleDescription'),
              title: t('ticketing.number.staleTitle'),
              type: 'warning',
            }
          : {
              description:
                error instanceof Error
                  ? error.message
                  : t('ticketing.number.saveFailedDescription'),
              title: t('ticketing.number.saveFailedTitle'),
              type: 'error',
            },
      );
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <FormInput
      disabled={isSaving}
      id={`number-property-${propertyDefinitionId}`}
      inputMode="decimal"
      label={label}
      name={`number-property-${propertyDefinitionId}`}
      onBlur={() => void handleSave()}
      onChange={(event) => setDraft(event.currentTarget.value)}
      onFocus={() => {
        if (!isEditing) {
          setDraft(formatNumberPropertyValue({ format: 'number', locale, value: committedValue }));
          setIsEditing(true);
        }
      }}
      onPaste={handlePaste}
      readOnly={readOnly}
      type="text"
      value={draft}
    />
  );
};
