import { Button } from '@techsio/ui-kit/atoms/button';
import type { FocusEvent as ReactFocusEvent, KeyboardEvent as ReactKeyboardEvent } from 'react';

import { toggleShellSearchFamily } from './shell-search-match.ts';
import type { ShellSearchFamilyAvailability } from './shell-search-match.ts';

export interface ShellSearchFamilyOption {
  readonly key: string;
  /** The family name the owner declared, in the reader's language. */
  readonly label: string;
}

const labelFor = (label: { readonly cs: string; readonly en: string }, language: string): string =>
  language.startsWith('en') ? label.en : label.cs;

/** Filter buttons are the families the current validated answer inventory declares, never a static taxonomy. */
export const shellSearchFamilyFilterOptions = (
  families: readonly ShellSearchFamilyAvailability[],
  language: string,
): readonly ShellSearchFamilyOption[] =>
  families.map(({ family, key }) => ({ key, label: labelFor(family.label, language) }));

export interface ShellSearchFiltersProps {
  /** Shown while any family is selected: clearing the filter asks the server for everything again. */
  readonly clearLabel?: string;
  readonly disabled?: boolean;
  /** Accessible name of the filter group, e.g. "Typ záznamu". */
  readonly label: string;
  /** A whole new selection; the caller stores it and requests the narrowed search. */
  readonly onButtonBlur?: (event: ReactFocusEvent<HTMLButtonElement>) => void;
  readonly onButtonKeyDown?: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
  readonly onChange: (families: readonly string[]) => void;
  readonly options: readonly ShellSearchFamilyOption[];
  /** The selected families. None selected means no narrowing, which is also the reset state. */
  readonly selected: readonly string[];
}

/**
 * Record families as native toggle buttons. On a phone the row scrolls sideways instead of pushing the results down,
 * on a wider screen it wraps in place; selecting one only reports the new selection, so the narrowed search stays a
 * server request with real owner resource types behind it, never a filter over an answer already received.
 */
export const ShellSearchFilters = ({
  clearLabel,
  disabled = false,
  label,
  onButtonBlur,
  onButtonKeyDown,
  onChange,
  options,
  selected,
}: ShellSearchFiltersProps) => {
  const selectedSet = new Set(selected);
  return (
    <section aria-label={label} className="grid gap-100">
      <ul className="flex snap-x gap-100 overflow-x-auto pb-50 sm:flex-wrap sm:overflow-visible sm:pb-0">
        {options.map((option) => {
          const pressed = selectedSet.has(option.key);
          return (
            <li className="shrink-0 snap-start" key={option.key}>
              <Button
                aria-pressed={pressed}
                disabled={disabled}
                onBlur={onButtonBlur}
                onClick={() => onChange(toggleShellSearchFamily(selected, option.key))}
                onKeyDown={onButtonKeyDown}
                size="sm"
                theme={pressed ? 'solid' : 'outlined'}
                variant={pressed ? 'primary' : 'secondary'}
              >
                {option.label}
              </Button>
            </li>
          );
        })}
        {selected.length === 0 || clearLabel === undefined ? null : (
          <li className="shrink-0 snap-start">
            <Button
              disabled={disabled}
              onBlur={onButtonBlur}
              onClick={() => onChange([])}
              onKeyDown={onButtonKeyDown}
              size="sm"
              theme="borderless"
              variant="secondary"
            >
              {clearLabel}
            </Button>
          </li>
        )}
      </ul>
    </section>
  );
};
