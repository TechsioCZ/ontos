import { Button } from '@techsio/ui-kit/atoms/button';

import { toggleShellSearchFamily } from './shell-search-match.ts';
import type { ShellSearchFamilyKey } from './shell-search-match.ts';

export interface ShellSearchFamilyOption {
  readonly key: ShellSearchFamilyKey;
  /** The family name in the reader's language; the caller owns the translation. */
  readonly label: string;
}

export interface ShellSearchFiltersProps {
  /** Shown while any family is selected: clearing the filter asks the server for everything again. */
  readonly clearLabel?: string;
  readonly disabled?: boolean;
  /** Accessible name of the filter group, e.g. "Typ záznamu". */
  readonly label: string;
  /** A whole new selection; the caller stores it and requests the narrowed search. */
  readonly onChange: (families: readonly ShellSearchFamilyKey[]) => void;
  readonly options: readonly ShellSearchFamilyOption[];
  /** The selected families. None selected means no narrowing, which is also the reset state. */
  readonly selected: readonly ShellSearchFamilyKey[];
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
                onClick={() => onChange(toggleShellSearchFamily(selected, option.key))}
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
            <Button disabled={disabled} onClick={() => onChange([])} size="sm" theme="borderless" variant="secondary">
              {clearLabel}
            </Button>
          </li>
        )}
      </ul>
    </section>
  );
};
