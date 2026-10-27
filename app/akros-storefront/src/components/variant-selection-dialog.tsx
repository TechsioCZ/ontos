"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ActionIcon } from "@techsio/ui-kit/atoms/action-icon";
import { Button } from "@techsio/ui-kit/atoms/button";
import { Checkbox } from "@techsio/ui-kit/atoms/checkbox";
import { AvailabilityStatus } from "@techsio/ui-kit/molecules/availability-status";
import { Dialog } from "@techsio/ui-kit/molecules/dialog";
import { FormCheckbox } from "@techsio/ui-kit/molecules/form-checkbox";
import { SearchForm } from "@techsio/ui-kit/molecules/search-form";
import { DataTable, type ColumnDef } from "@techsio/ui-kit/organisms/data-table";
import { loadFavoriteProduct, type FavoriteCatalogProduct } from "@/features/favorites/catalog";
import { formatPrice } from "@/lib/format";
import {
  matchesProductVariantSearch,
  normalizeCatalogSearchTerm,
} from "@/lib/product-variant-search";
import type { CatalogProductVariant } from "@/ontos/catalog-types";

export function VariantSelectionDialog({
  productId,
  productName,
  slug,
  initialSelection,
  finalFocusEl,
  onClose,
  onConfirm,
  title,
  confirmLabel,
  description,
  allowEmpty = false,
  requireChange = false,
  submitErrorMessage = "Akci se nepodařilo dokončit. Zkuste to znovu.",
}: {
  productId: string;
  productName: string;
  slug: string;
  initialSelection: string[];
  finalFocusEl: () => HTMLElement | null;
  onClose: () => void;
  onConfirm: (
    variants: CatalogProductVariant[],
    catalog: FavoriteCatalogProduct,
  ) => void | Promise<void>;
  title: string;
  confirmLabel: string;
  description?: string;
  allowEmpty?: boolean;
  requireChange?: boolean;
  submitErrorMessage?: string;
}) {
  const [catalog, setCatalog] = useState<FavoriteCatalogProduct>();
  const [selected, setSelected] = useState(() => new Set(initialSelection));
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const heading = useRef<HTMLSpanElement>(null);
  const checkboxId = useId();
  useEffect(() => {
    const controller = new AbortController();
    loadFavoriteProduct(slug, controller.signal)
      .then((value) => {
        if (value.product.id !== productId) throw new Error("Produkt se změnil. Obnovte stránku.");
        setCatalog(value);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError("Varianty se nepodařilo načíst. Zkuste to znovu.");
      });
    return () => controller.abort();
  }, [slug, productId, attempt]);
  const variants = catalog?.variants ?? [];
  const normalized = normalizeCatalogSearchTerm(query);
  const filtered = variants.filter((item) => matchesProductVariantSearch(item, normalized));
  const visibleSelected = filtered.filter((item) => selected.has(item.id)).length;
  const allFiltered = filtered.length > 0 && visibleSelected === filtered.length;
  const initialIds = new Set(initialSelection);
  const changed =
    selected.size !== initialIds.size || [...selected].some((id) => !initialIds.has(id));
  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  async function save() {
    if (!catalog) return;
    try {
      setSubmitting(true);
      await onConfirm(
        variants.filter((item) => selected.has(item.id)),
        catalog,
      );
      onClose();
    } catch {
      setError(submitErrorMessage);
      setSubmitting(false);
    }
  }
  const columns = useMemo<ColumnDef<CatalogProductVariant, unknown>[]>(
    () => [
      {
        id: "selection",
        header: "Výběr",
        meta: { width: "var(--dimension-60)" },
        cell: ({ row }) => (
          <label className="akros-favorites-check" htmlFor={`${checkboxId}-${row.original.id}`}>
            <Checkbox
              id={`${checkboxId}-${row.original.id}`}
              checked={selected.has(row.original.id)}
              onChange={() => toggle(row.original.id)}
              aria-label={`Vybrat variantu ${row.original.sku}`}
            />
          </label>
        ),
      },
      {
        id: "variant",
        header: "Varianta",
        cell: ({ row }) => <span className="akros-favorites-variant">{row.original.label}</span>,
      },
      {
        id: "sku",
        header: "Kód",
        cell: ({ row }) => <span className="akros-favorites-sku">{row.original.sku}</span>,
      },
      {
        id: "stock",
        header: "Dostupnost",
        cell: ({ row }) => (
          <AvailabilityStatus
            status={
              row.original.availabilityUnknown
                ? "limited"
                : row.original.stockCount <= 0
                  ? "unavailable"
                  : row.original.stockCount < row.original.minimumQuantity
                    ? "limited"
                    : "available"
            }
            label={
              row.original.availabilityUnknown
                ? "Nelze ověřit"
                : row.original.stockCount <= 0
                  ? "Není skladem"
                  : row.original.stockCount < row.original.minimumQuantity
                    ? "Omezeně skladem"
                    : "Skladem"
            }
            showIcon={false}
          />
        ),
      },
      {
        id: "price",
        header: "Cena s DPH",
        cell: ({ row }) => (
          <span className="akros-favorites-price">
            {!row.original.priceUnavailableReason && row.original.priceMinor > 0
              ? `${formatPrice(row.original.priceMinor)} / ${row.original.unit}`
              : "Cena není dostupná"}
          </span>
        ),
      },
    ],
    [selected, checkboxId],
  );
  return (
    <Dialog
      open
      customTrigger
      hideCloseButton
      closeOnInteractOutside={false}
      className="akros-favorites-dialog"
      size="xl"
      placement="center"
      initialFocusEl={() => heading.current}
      finalFocusEl={finalFocusEl}
      onOpenChange={({ open }) => {
        if (!open) onClose();
      }}
      title={
        <span ref={heading} tabIndex={-1}>
          {title}
        </span>
      }
      actions={
        <>
          <span className="akros-favorites-total">Vybráno: {selected.size}</span>
          <Button size="md" theme="outlined" variant="secondary" onClick={onClose}>
            Zrušit
          </Button>
          <Button
            size="md"
            variant="primary"
            disabled={
              !catalog ||
              submitting ||
              (requireChange && !changed) ||
              (!allowEmpty && !variants.some((item) => selected.has(item.id)))
            }
            onClick={save}
          >
            {submitting ? "Zpracovávám…" : confirmLabel}
          </Button>
        </>
      }
    >
      <ActionIcon
        className="akros-favorites-close"
        icon="token-icon-close"
        aria-label="Zavřít výběr variant"
        size="md"
        onClick={onClose}
      />
      <p className="akros-favorites-product" title={productName}>
        {productName}
      </p>
      {error && (
        <div role="alert" className="akros-favorite-message">
          {error}
          {!catalog && (
            <Button
              size="sm"
              theme="outlined"
              variant="secondary"
              onClick={() => {
                setError("");
                setAttempt((value) => value + 1);
              }}
            >
              Zkusit znovu
            </Button>
          )}
        </div>
      )}
      {!catalog && !error && <output>Načítám varianty…</output>}
      {catalog && (
        <>
          <SearchForm
            value={query}
            onValueChange={setQuery}
            onSubmit={(event) => event.preventDefault()}
            size="md"
          >
            <SearchForm.Label>Hledat variantu</SearchForm.Label>
            <SearchForm.Control>
              <SearchForm.Input
                aria-label="Hledat variantu"
                placeholder="Kód, název nebo parametr"
              />
              <SearchForm.ClearButton aria-label="Vymazat hledání" />
            </SearchForm.Control>
          </SearchForm>
          <div className="akros-favorites-selection">
            <FormCheckbox
              checked={allFiltered}
              indeterminate={visibleSelected > 0 && !allFiltered}
              disabled={!filtered.length}
              onCheckedChange={(checked) =>
                setSelected((current) => {
                  const next = new Set(current);
                  for (const item of filtered) {
                    if (checked) next.add(item.id);
                    else next.delete(item.id);
                  }
                  return next;
                })
              }
            >
              Vybrat všechny výsledky ({filtered.length})
            </FormCheckbox>
            <output>
              Vybráno {selected.size}
              {selected.size > visibleSelected
                ? `, z toho ${selected.size - visibleSelected} mimo filtr`
                : ""}
            </output>
          </div>
          <DataTable
            caption={description}
            className="akros-favorites-table"
            data={filtered}
            columns={columns}
            getRowId={(item) => item.id}
            variant="line"
            size="sm"
            enableSorting={false}
            enablePagination={false}
            stickyHeader
            slotProps={{ root: { className: "akros-favorites-table__root" } }}
            renderEmpty={() => <output>Žádná varianta neodpovídá hledání.</output>}
          />
        </>
      )}
    </Dialog>
  );
}
