// Storefront tree category combobox over the server search: each pause in typing reads one bounded page of
// matching categories with their path labels, so no page loads the whole tree (thousands of nodes for AKROS).
import { Combobox } from '@techsio/ui-kit/molecules/combobox';
import { comboboxTranslations } from '@app/admin-ui';
import { Effect } from 'effect';
import { useEffect, useState } from 'react';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import type { CategoryTrail } from '../../../../../shared/apis/records.ts';
import { SEARCH_DEBOUNCE, searchCategoryTrails } from './product-reads.ts';

type SearchAnswer =
  | {
      readonly matches: readonly CategoryTrail[];
      readonly request: string;
      readonly status: 'ready';
      readonly total: number;
    }
  | { readonly request: string; readonly status: 'error' };

const NO_MATCHES: readonly CategoryTrail[] = [];
const ALL = '__all__';

export interface CategorySearchComboboxProps {
  /** An extra first option that picks no category (the list filter's „all categories“). */
  readonly allLabel?: string;
  readonly errorMessage: string;
  readonly id: string;
  readonly label: string;
  readonly loadingMessage: string;
  /** „Showing {shown} of {total}“ under the list when the search matched more than it lists. */
  readonly moreMessage: (shown: number, total: number) => string;
  readonly noResultsMessage: string;
  readonly onSelect: (category: CategoryTrail | null) => void;
  readonly placeholder: string;
  readonly retryLabel: string;
  /** The picked category, so the closed field keeps showing its path. */
  readonly selected: CategoryTrail | null;
  readonly size?: 'sm';
}

/**
 * Opening the combobox lists the top-level categories; typing searches any part of the path (`din 912 a 2`),
 * case- and diacritics-insensitive. The text the field shows after a pick is the picked path, which does not
 * start a new search.
 */
export const CategorySearchCombobox = ({
  allLabel,
  errorMessage,
  id,
  label,
  loadingMessage,
  moreMessage,
  noResultsMessage,
  onSelect,
  placeholder,
  retryLabel,
  selected,
  size,
}: CategorySearchComboboxProps) => {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [answer, setAnswer] = useState<SearchAnswer | null>(null);
  const selectedLabel = selected === null ? (allLabel ?? '') : selected.trail;
  const query = typed === selectedLabel ? '' : typed.trim();
  const request = `${attempt}:${query}`;

  useEffect(() => {
    const fiber = open
      ? browserRuntime.runFork(
          Effect.sleep(SEARCH_DEBOUNCE).pipe(
            Effect.andThen(searchCategoryTrails(query)),
            Effect.match({
              onFailure: (): SearchAnswer => ({ request, status: 'error' }),
              onSuccess: ({ matches, total }): SearchAnswer => ({ matches, request, status: 'ready', total }),
            }),
            Effect.map(setAnswer),
          ),
        )
      : undefined;
    return () => {
      fiber?.interruptUnsafe();
    };
  }, [open, query, request]);

  const loading = open && answer?.request !== request;
  const failed = !loading && answer?.status === 'error';
  // While a newer search runs, the previous matches stay listed.
  const found = answer?.status === 'ready' ? answer.matches : NO_MATCHES;
  const total = answer?.status === 'ready' ? answer.total : 0;
  const items = [
    ...(allLabel === undefined ? [] : [{ id: ALL, label: allLabel, value: ALL }]),
    // The picked category stays an option even when the current search does not list it.
    ...(selected === null || found.some((category) => category.id === selected.id)
      ? []
      : [{ id: selected.id, label: selected.trail, value: selected.id }]),
    ...found.map((category) => ({ id: category.id, label: category.trail, value: category.id })),
  ];

  return (
    // Not clearable: ui-kit names the clear control "Clear value" in English; the „all“ option clears instead.
    <Combobox
      clearable={false}
      error={failed ? errorMessage : undefined}
      filterBehavior="external"
      {...(total > found.length ? { helpText: moreMessage(found.length, total) } : {})}
      id={id}
      items={items}
      label={label}
      loading={loading && found.length === 0}
      loadingMessage={loadingMessage}
      noResultsMessage={noResultsMessage}
      onChange={(values) => {
        const picked = Array.isArray(values) ? values[0] : values;
        if (picked === (selected?.id ?? ALL)) {
          return;
        }
        onSelect(picked === ALL ? null : (found.find((category) => category.id === picked) ?? null));
      }}
      onInputValueChange={setTyped}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setTyped(selectedLabel);
        }
      }}
      onRetry={() => setAttempt((current) => current + 1)}
      openOnClick
      placeholder={placeholder}
      retryLabel={retryLabel}
      {...(size === undefined ? {} : { size })}
      translations={comboboxTranslations}
      value={selected === null ? (allLabel === undefined ? [] : [ALL]) : [selected.id]}
    />
  );
};
