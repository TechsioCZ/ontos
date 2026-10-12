"use client";

import NextLink from "next/link";
import { type CSSProperties, useId, useMemo, useState } from "react";
import { ActionIcon } from "@techsio/ui-kit/atoms/action-icon";
import { Link } from "@techsio/ui-kit/atoms/link";
import { NumericInput } from "@techsio/ui-kit/atoms/numeric-input";
import { DataTable, type ColumnDef } from "@techsio/ui-kit/organisms/data-table";
import { useCart } from "@/features/cart/cart-provider";
import {
  type CartLine,
  getLineTotal,
  getMaximumOrderQuantity,
  normalizeOrderQuantity,
} from "@/mock-storefront/cart";
import { formatCheckoutPrice } from "./checkout-format";
import { formatCartProductName } from "./cart-product-name";

function CartQuantity({ line }: { line: CartLine }) {
  const id = useId();
  const { dispatch } = useCart();
  const [draftQuantity, setDraftQuantity] = useState<number | null>(null);
  const commit = (quantity: number) =>
    dispatch({
      type: "set-quantity",
      productId: line.productId,
      variantId: line.variantId,
      quantity,
    });
  return (
    <div className="flex items-center justify-center gap-1">
      <NumericInput
        className="@max-akros-cart-narrow/akros-cart:[--text-numeric-input-sm:var(--akros-cart-compact-quantity-size)]"
        id={id}
        locale="cs-CZ"
        formatOptions={{ maximumFractionDigits: 6 }}
        min={line.minimumQuantity}
        max={getMaximumOrderQuantity(line)}
        step={line.minimumQuantity}
        value={draftQuantity ?? line.quantity}
        size="sm"
        allowMouseWheel={false}
        onChange={(quantity) => {
          if (!Number.isFinite(quantity)) return;
          setDraftQuantity(quantity);
          // Preserve unfinished typing (e.g. "2" on the way to "20" with a minimum of 10).
          if (quantity > 0 && normalizeOrderQuantity(line, quantity) === quantity) commit(quantity);
        }}
        onBlur={() => {
          if (draftQuantity !== null && draftQuantity > 0) commit(draftQuantity);
          setDraftQuantity(null);
        }}
      >
        <NumericInput.Control
          data-akros-cart-quantity
          style={
            {
              "--akros-cart-quantity-characters": Math.max(
                2,
                new Intl.NumberFormat("cs-CZ", { maximumFractionDigits: 6 }).format(
                  draftQuantity ?? line.quantity,
                ).length,
              ),
            } as CSSProperties
          }
          className="w-(--akros-cart-control-width) shrink-0 gap-(--akros-cart-control-gap) border-0! bg-transparent! overflow-visible"
        >
          <NumericInput.DecrementTrigger
            aria-label={`Snížit množství: ${line.variantLabel ?? line.name}`}
            className="h-full! w-(--akros-cart-trigger-width) flex-none justify-center rounded-(--akros-cart-control-radius) bg-(--akros-cart-trigger-bg)"
            icon="token-icon-minus"
          />
          <NumericInput.Input
            aria-label={`Množství: ${line.variantLabel ?? line.name}`}
            className="min-w-0 flex-1 rounded-(--akros-cart-control-radius)! border-solid! border-(length:--akros-cart-value-border-width)! border-(--akros-cart-value-border-color)! bg-base! px-(--dimension-4)! text-center leading-(--akros-checkout-heading-leading) font-bold"
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                event.currentTarget.blur();
              }
            }}
          />
          <NumericInput.IncrementTrigger
            aria-label={`Zvýšit množství: ${line.variantLabel ?? line.name}`}
            className="h-full! w-(--akros-cart-trigger-width) flex-none justify-center rounded-(--akros-cart-control-radius) bg-(--akros-cart-trigger-bg)"
            icon="token-icon-plus"
          />
        </NumericInput.Control>
      </NumericInput>
    </div>
  );
}

export function CartItemsTable({ showHeader = false }: { showHeader?: boolean }) {
  const { cart, dispatch } = useCart();
  const columns = useMemo<ColumnDef<CartLine, unknown>[]>(
    () => [
      {
        id: "product",
        header: "Položka",
        cell: ({ row: { original: line } }) => (
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-(--akros-cart-detail-gap) gap-y-1 whitespace-normal">
            <Link
              as={NextLink}
              href={`/produkt/${line.slug}`}
              className="min-w-0 wrap-anywhere text-inherit no-underline"
            >
              {formatCartProductName(line.name)}
            </Link>
            {line.variantLabel && (
              <span className="wrap-anywhere text-(length:--akros-cart-secondary-size) text-(--color-fg-secondary)">
                {line.variantLabel}
              </span>
            )}
          </div>
        ),
      },
      {
        id: "stock",
        header: "Dostupnost",
        meta: { width: "var(--akros-cart-stock-width)", align: "start" },
        cell: () => (
          <span className="text-(length:--akros-cart-secondary-size) font-(weight:--akros-cart-primary-weight) text-(--color-fg-status-success) uppercase">
            Skladem
          </span>
        ),
      },
      {
        id: "quantity",
        header: "Množství",
        meta: { width: "var(--akros-cart-quantity-width)", align: "center" },
        cell: ({ row }) => <CartQuantity line={row.original} />,
      },
      {
        id: "price",
        header: "Cena",
        meta: { width: "var(--akros-cart-price-width)", align: "end" },
        cell: ({ row: { original: line } }) => (
          <div className="grid min-w-0 justify-items-end gap-1 text-right @max-akros-cart-wide/akros-cart:justify-items-start @max-akros-cart-wide/akros-cart:text-left">
            <strong className="whitespace-normal font-(weight:--akros-cart-price-weight)">
              {formatCheckoutPrice(getLineTotal(line))}
            </strong>
          </div>
        ),
      },
      {
        id: "remove",
        header: () => <span className="sr-only">Odebrat</span>,
        meta: { width: "var(--akros-cart-remove-width)", align: "end" },
        cell: ({ row: { original: line } }) => (
          <ActionIcon
            aria-label={`Odebrat ${line.name}`}
            icon="token-icon-akros-checkout-remove"
            size="md"
            onClick={() =>
              dispatch({ type: "remove", productId: line.productId, variantId: line.variantId })
            }
          />
        ),
      },
    ],
    [dispatch],
  );

  return (
    <div
      data-akros-cart-items
      style={
        {
          "--akros-cart-max-quantity-characters": Math.max(
            2,
            ...cart.lines.map(
              (line) =>
                new Intl.NumberFormat("cs-CZ", { maximumFractionDigits: 6 }).format(line.quantity)
                  .length,
            ),
          ),
        } as CSSProperties
      }
      className="@container/akros-cart min-w-0 font-medium"
    >
      <DataTable
        data={cart.lines}
        columns={columns}
        getRowId={(line) => `${line.productId}:${line.variantId ?? "base"}`}
        hideHeader={!showHeader}
        size="sm"
        variant="line"
        tableLayout="auto"
        enableSorting={false}
        enablePagination={false}
        slotProps={{
          root: {
            "aria-label": "Položky objednávky",
            className:
              "@max-akros-cart-wide/akros-cart:block @max-akros-cart-wide/akros-cart:[&_thead]:sr-only @max-akros-cart-wide/akros-cart:[&_tbody]:grid @max-akros-cart-wide/akros-cart:[&_td]:block @max-akros-cart-wide/akros-cart:[&_td]:w-auto! @max-akros-cart-wide/akros-cart:[&_td]:min-w-0 @max-akros-cart-wide/akros-cart:[&_td]:p-0! @max-akros-cart-wide/akros-cart:[&_td:first-child]:col-span-2 @max-akros-cart-wide/akros-cart:[&_td:last-child]:justify-self-end @max-akros-cart-narrow/akros-cart:[&_td:nth-child(2)]:col-span-2 @max-akros-cart-narrow/akros-cart:[&_td:nth-child(3)]:col-span-2 @max-akros-cart-narrow/akros-cart:[&_td:nth-child(3)]:justify-self-start",
          },
          header: {
            className: "[&_th]:text-(length:--akros-cart-secondary-size)",
          },
          row: {
            className:
              "@max-akros-cart-wide/akros-cart:grid @max-akros-cart-wide/akros-cart:grid-cols-[minmax(0,1fr)_auto] @max-akros-cart-wide/akros-cart:items-center @max-akros-cart-wide/akros-cart:gap-(--akros-cart-row-gap) @max-akros-cart-wide/akros-cart:py-(--dimension-16)",
          },
        }}
      />
    </div>
  );
}
