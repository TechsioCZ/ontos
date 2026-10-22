// Product combobox over the server search: each pause in typing reads one bounded page of list rows.
import { Combobox } from '@techsio/ui-kit/molecules/combobox';
import { comboboxTranslations } from '@app/admin-ui';
import { Effect } from 'effect';
import { useEffect, useState } from 'react';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import type { ProductRecord } from '../../../../../shared/apis/records.ts';
import { SEARCH_DEBOUNCE, searchProducts } from './product-reads.ts';

/** The answer to one search, tagged with the request it answers so a newer request reads as loading. */
type SearchAnswer =
  | { readonly items: readonly ProductRecord[]; readonly request: string; readonly status: 'ready' }
  | { readonly request: string; readonly status: 'error' };

const NO_ITEMS: readonly ProductRecord[] = [];

const productLabel = (product: Pick<ProductRecord, 'name' | 'sku'>) => `${product.name} (${product.sku})`;

export interface ProductSearchComboboxProps {
  readonly activeOnly?: boolean;
  readonly errorMessage: string;
  readonly helpText?: string;
  readonly id: string;
  readonly label: string;
  readonly loadingMessage: string;
  readonly noResultsMessage: string;
  /** Receives the picked list row (no variants), or null. */
  readonly onSelect: (product: ProductRecord | null) => void;
  readonly placeholder: string;
  readonly retryLabel: string;
  /** The picked product, so the closed field keeps showing its label. */
  readonly selected: Pick<ProductRecord, 'id' | 'name' | 'sku'> | null;
  readonly validateStatus?: 'default' | 'error';
}

/**
 * Product combobox over the server search. Opening it lists the first matches; typing searches by name or SKU.
 * The text the field shows after a pick is the picked label, which does not start a new search.
 */
export const ProductSearchCombobox = ({
  activeOnly = false,
  errorMessage,
  helpText,
  id,
  label,
  loadingMessage,
  noResultsMessage,
  onSelect,
  placeholder,
  retryLabel,
  selected,
  validateStatus = 'default',
}: ProductSearchComboboxProps) => {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [answer, setAnswer] = useState<SearchAnswer | null>(null);
  const selectedLabel = selected === null ? '' : productLabel(selected);
  const query = typed === selectedLabel ? '' : typed.trim();
  const request = `${attempt}:${activeOnly ? 'active' : 'all'}:${query}`;

  useEffect(() => {
    const fiber = open
      ? browserRuntime.runFork(
          Effect.sleep(SEARCH_DEBOUNCE).pipe(
            Effect.andThen(searchProducts(query, activeOnly)),
            Effect.match({
              onFailure: (): SearchAnswer => ({ request, status: 'error' }),
              onSuccess: (items): SearchAnswer => ({ items, request, status: 'ready' }),
            }),
            Effect.map(setAnswer),
          ),
        )
      : undefined;
    return () => {
      fiber?.interruptUnsafe();
    };
  }, [activeOnly, open, query, request]);

  const loading = open && answer?.request !== request;
  const failed = !loading && answer?.status === 'error';
  // While a newer search runs, the previous matches stay listed.
  const found = answer?.status === 'ready' ? answer.items : NO_ITEMS;
  // The picked product stays an option even when the current search does not list it.
  const items = [
    ...(selected === null || found.some((product) => product.id === selected.id)
      ? []
      : [{ id: selected.id, label: selectedLabel, value: selected.id }]),
    ...found.map((product) => ({ id: product.id, label: productLabel(product), value: product.id })),
  ];

  return (
    // Not clearable: ui-kit names the clear control "Clear value" in English; picking another product replaces it.
    <Combobox
      clearable={false}
      error={failed ? errorMessage : undefined}
      filterBehavior="external"
      {...(helpText === undefined ? {} : { helpText })}
      id={id}
      items={items}
      label={label}
      loading={loading && found.length === 0}
      loadingMessage={loadingMessage}
      noResultsMessage={noResultsMessage}
      onChange={(values) => {
        const picked = Array.isArray(values) ? values[0] : values;
        if (picked === selected?.id) {
          return;
        }
        onSelect(found.find((product) => product.id === picked) ?? null);
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
      translations={comboboxTranslations}
      validateStatus={validateStatus}
      value={selected === null ? [] : [selected.id]}
    />
  );
};
