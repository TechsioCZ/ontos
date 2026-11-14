"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@techsio/ui-kit/atoms/button";
import { FormInput, Combobox } from "@/components/form-controls";
import {
  getSuggestedAddress,
  isSmartAddressCountry,
  suggestAddresses,
  type AddressSuggestion,
} from "@/lib/smart-address";
import { useDictionary } from "@/ontos/market-context";

export function AddressAutocomplete({
  id,
  value,
  country,
  error,
  onInput,
  onSelect,
  label,
  required = true,
}: {
  id: string;
  value: string;
  country: string;
  error?: string;
  onInput: (street: string) => void;
  onSelect: (address: ReturnType<typeof getSuggestedAddress>) => void;
  label?: string;
  required?: boolean;
}) {
  const copy = useDictionary().addressAutocomplete;
  // Suggestions only for address countries the provider covers; others stay manual entry.
  const supported = isSmartAddressCountry(country);
  const [open, setOpen] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const resolvedQuery = useRef<string | undefined>(undefined);
  const [state, setState] = useState<{
    query: string;
    items: AddressSuggestion[];
    loading: boolean;
    failed: boolean;
  }>({ query: "", items: [], loading: false, failed: false });
  const query = value.trim();
  useEffect(() => {
    if (!open || query.length < 3 || !supported || resolvedQuery.current === query) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      resolvedQuery.current = undefined;
      setState({ query, items: [], loading: true, failed: false });
      suggestAddresses(query, controller.signal, country)
        .then((items) => {
          if (!controller.signal.aborted) {
            resolvedQuery.current = query;
            setState({ query, items, loading: false, failed: false });
          }
        })
        .catch(() => {
          if (!controller.signal.aborted)
            setState({ query, items: [], loading: false, failed: true });
        });
    }, 300);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, country, supported, open, attempt]);
  const current = state.query === query && supported;
  const items = current ? state.items : [];
  const failed = current && state.failed;
  const attributions = [
    ...new Map(
      items.flatMap((s) => (s.attribution ? [[s.attribution.label, s.attribution] as const] : [])),
    ).values(),
  ];
  if (!supported)
    return (
      <FormInput
        id={id}
        label={label ?? copy.label}
        autoComplete="street-address"
        size="sm"
        required={required}
        value={value}
        onChange={(event) => onInput(event.target.value)}
        validateStatus={error ? "error" : "default"}
        helpText={error}
      />
    );
  return (
    <div className="sf-address-autocomplete" data-address-autocomplete data-address-field={id}>
      <Combobox
        id={id}
        label={label ?? copy.label}
        placeholder={copy.placeholder}
        size="sm"
        portalled={false}
        renderItem={(item) => <span className="sf-address-option-label">{item.label}</span>}
        required={required}
        inputValue={value}
        value={[]}
        open={open}
        onOpenChange={setOpen}
        allowCustomValue
        selectionBehavior="preserve"
        closeOnSelect
        filterBehavior="external"
        inputBehavior="none"
        clearable={false}
        items={items.map((s) => ({ value: s.id, label: s.displayLabel }))}
        onInputValueChange={(text) => {
          onInput(text);
          setOpen(text.trim().length >= 3);
        }}
        onChange={(selected) => {
          const item = items.find(
            (s) => s.id === (Array.isArray(selected) ? selected[0] : selected),
          );
          if (item) {
            setOpen(false);
            onSelect(getSuggestedAddress(item));
          }
        }}
        loading={open && query.length >= 3 && supported && (!current || state.loading)}
        loadingMessage={copy.loading}
        error={failed ? copy.unavailable : undefined}
        noResultsMessage={query.length < 3 ? copy.tooShort : copy.noResults}
        validateStatus={error ? "error" : "default"}
        helpText={error}
        showHelpTextIcon={false}
        footer={
          failed ? (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => {
                setOpen(true);
                setAttempt((v) => v + 1);
              }}
            >
              {copy.retry}
            </Button>
          ) : attributions.length ? (
            <span>
              {attributions.map((a) =>
                /^https?:\/\//i.test(a.url ?? "") ? (
                  <a key={a.label} href={a.url} target="_blank" rel="noreferrer">
                    {a.label}
                  </a>
                ) : (
                  <span key={a.label}>{a.label}</span>
                ),
              )}
            </span>
          ) : undefined
        }
      />
      {failed && (
        <output aria-live="polite" className="sf-address-status">
          {copy.unavailable}
        </output>
      )}
    </div>
  );
}
