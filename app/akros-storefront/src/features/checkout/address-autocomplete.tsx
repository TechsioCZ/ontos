"use client";

import { useEffect, useRef, useState } from "react";
import { Combobox } from "@techsio/ui-kit/molecules/combobox";
import { Button } from "@techsio/ui-kit/atoms/button";
import { getSuggestedAddress, suggestAddresses, type AddressSuggestion } from "@/lib/smart-address";

export function AddressAutocomplete({
  id,
  value,
  country,
  error,
  onInput,
  onSelect,
  label = "Ulice, č.p.",
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
    if (!open || query.length < 3 || country !== "CZ" || resolvedQuery.current === query) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      resolvedQuery.current = undefined;
      setState({ query, items: [], loading: true, failed: false });
      suggestAddresses(query, controller.signal)
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
  }, [query, country, open, attempt]);
  const current = state.query === query && country === "CZ";
  const items = current ? state.items : [];
  const failed = current && state.failed;
  const attributions = [
    ...new Map(
      items.flatMap((s) => (s.attribution ? [[s.attribution.label, s.attribution] as const] : [])),
    ).values(),
  ];
  return (
    <div className="akros-address-autocomplete" data-address-autocomplete data-address-field={id}>
      <Combobox
        id={id}
        label={label}
        placeholder="Začněte psát ulici a číslo domu"
        size="sm"
        portalled={false}
        renderItem={(item) => <span className="akros-address-option-label">{item.label}</span>}
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
        loading={open && query.length >= 3 && country === "CZ" && (!current || state.loading)}
        loadingMessage="Hledám adresy…"
        error={failed ? "Našeptávání není dostupné. Adresu můžete zadat ručně." : undefined}
        noResultsMessage={
          query.length < 3
            ? "Napište alespoň 3 znaky."
            : "Služba nenašla návrhy. Adresu můžete zadat ručně."
        }
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
              Zkusit znovu
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
        <output aria-live="polite" className="akros-address-status">
          Našeptávání není dostupné. Adresu můžete zadat ručně.
        </output>
      )}
    </div>
  );
}
