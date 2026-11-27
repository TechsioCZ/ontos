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
import {
  matchesProductVariantSearch,
  normalizeCatalogSearchTerm,
} from "@/lib/product-variant-search";
import { describeVariantAvailability } from "@/lib/variant-availability";
import type { CatalogProductVariant } from "@/ontos/catalog-types";
import { useDictionary, useFormatPrice } from "@/ontos/market-context";

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
  submitErrorMessage,
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
  const cs = useDictionary();
  const formatPrice = useFormatPrice();
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
        // The slug now names another product: never offer its variants for this one.
        if (value.product.id !== productId) throw new Error("Product changed.");
        setCatalog(value);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(cs.variants.loadFailed);
      });
    return () => controller.abort();
  }, [slug, productId, attempt, cs]);
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
      setError(submitErrorMessage ?? cs.variants.submitFailed);
      setSubmitting(false);
    }
  }
  const columns = useMemo<ColumnDef<CatalogProductVariant, unknown>[]>(
    () => [
      {
        id: "selection",
        header: cs.variants.selection,
        meta: { width: "var(--dimension-60)" },
        cell: ({ row }) => (
          <label className="sf-favorites-check" htmlFor={`${checkboxId}-${row.original.id}`}>
            <Checkbox
              id={`${checkboxId}-${row.original.id}`}
              checked={selected.has(row.original.id)}
              onChange={() => toggle(row.original.id)}
              aria-label={cs.variants.selectVariant(row.original.sku)}
            />
          </label>
        ),
      },
      {
        id: "variant",
        header: cs.variants.variant,
        cell: ({ row }) => <span className="sf-favorites-variant">{row.original.label}</span>,
      },
      {
        id: "sku",
        header: cs.product.table.code,
        cell: ({ row }) => <span className="sf-favorites-sku">{row.original.sku}</span>,
      },
      {
        id: "stock",
        header: cs.product.table.availability,
        cell: ({ row }) => (
          <AvailabilityStatus {...describeVariantAvailability(cs, row.original)} showIcon={false} />
        ),
      },
      {
        id: "price",
        header: cs.product.priceIncludingVat,
        cell: ({ row }) => (
          <span className="sf-favorites-price">
            {row.original.priceUnavailableReason || row.original.priceMinor <= 0
              ? cs.product.priceUnavailable
              : `${formatPrice(row.original.priceMinor)} / ${row.original.unit}`}
          </span>
        ),
      },
    ],
    [selected, checkboxId, cs, formatPrice],
  );
  return (
    <Dialog
      open
      customTrigger
      hideCloseButton
      closeOnInteractOutside={false}
      className="sf-favorites-dialog"
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
          <span className="sf-favorites-total">{cs.variants.selectedTotal(selected.size)}</span>
          <Button size="md" theme="outlined" variant="secondary" onClick={onClose}>
            {cs.variants.cancel}
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
            {submitting ? cs.variants.processing : confirmLabel}
          </Button>
        </>
      }
    >
      <ActionIcon
        className="sf-favorites-close"
        icon="token-icon-close"
        aria-label={cs.variants.closeSelection}
        size="md"
        onClick={onClose}
      />
      <p className="sf-favorites-product" title={productName}>
        {productName}
      </p>
      {error && (
        <div role="alert" className="sf-favorite-message">
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
              {cs.variants.retry}
            </Button>
          )}
        </div>
      )}
      {!catalog && !error && <output>{cs.variants.loading}</output>}
      {catalog && (
        <>
          <SearchForm
            value={query}
            onValueChange={setQuery}
            onSubmit={(event) => event.preventDefault()}
            size="md"
          >
            <SearchForm.Label>{cs.variants.search}</SearchForm.Label>
            <SearchForm.Control>
              <SearchForm.Input
                aria-label={cs.variants.search}
                placeholder={cs.variants.searchPlaceholder}
              />
              <SearchForm.ClearButton aria-label={cs.variants.clearSearch} />
            </SearchForm.Control>
          </SearchForm>
          <div className="sf-favorites-selection">
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
              {cs.variants.selectAllResults(filtered.length)}
            </FormCheckbox>
            <output>
              {cs.variants.selectedCount(selected.size)}
              {selected.size > visibleSelected
                ? cs.variants.outsideFilter(selected.size - visibleSelected)
                : ""}
            </output>
          </div>
          <DataTable
            caption={description}
            className="sf-favorites-table"
            data={filtered}
            columns={columns}
            getRowId={(item) => item.id}
            variant="line"
            size="sm"
            enableSorting={false}
            enablePagination={false}
            stickyHeader
            slotProps={{ root: { className: "sf-favorites-table__root" } }}
            renderEmpty={() => <output>{cs.variants.noSearchMatch}</output>}
          />
        </>
      )}
    </Dialog>
  );
}
