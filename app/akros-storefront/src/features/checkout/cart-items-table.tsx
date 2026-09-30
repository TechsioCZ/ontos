"use client";

import NextLink from "next/link";
import { useId, useMemo, useState } from "react";
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
import { formatPrice } from "@/lib/format";

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
        <NumericInput.Control className="w-44 shrink-0">
          <NumericInput.DecrementTrigger
            aria-label={`Snížit množství: ${line.variantLabel ?? line.name}`}
            className="h-full! w-11 flex-none justify-center"
            icon="token-icon-minus"
          />
          <NumericInput.Input
            aria-label={`Množství: ${line.variantLabel ?? line.name}`}
            className="min-w-0 flex-1 px-0! text-center"
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                event.currentTarget.blur();
              }
            }}
          />
          <NumericInput.IncrementTrigger
            aria-label={`Zvýšit množství: ${line.variantLabel ?? line.name}`}
            className="h-full! w-11 flex-none justify-center"
            icon="token-icon-plus"
          />
        </NumericInput.Control>
      </NumericInput>
      <span className="text-xs text-(--color-fg-secondary)">{line.unit}</span>
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
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 whitespace-normal">
            <Link
              as={NextLink}
              href={`/produkt/${line.slug}`}
              className="text-inherit no-underline"
            >
              {line.name}
            </Link>
            {line.variantLabel && (
              <span className="text-xs text-(--color-fg-secondary)">{line.variantLabel}</span>
            )}
          </div>
        ),
      },
      {
        id: "stock",
        header: "Dostupnost",
        meta: { width: "var(--dimension-100)", align: "center" },
        cell: () => (
          <span className="text-xs text-(--color-fg-status-success) uppercase">Skladem</span>
        ),
      },
      {
        id: "quantity",
        header: "Množství",
        meta: { width: "12rem", align: "center" },
        cell: ({ row }) => <CartQuantity line={row.original} />,
      },
      {
        id: "price",
        header: "Cena",
        meta: { width: "var(--dimension-100)", align: "end" },
        cell: ({ row }) => (
          <strong className="whitespace-nowrap">{formatPrice(getLineTotal(row.original))}</strong>
        ),
      },
      {
        id: "remove",
        header: () => <span className="sr-only">Odebrat</span>,
        meta: { width: "var(--dimension-44)", align: "end" },
        cell: ({ row: { original: line } }) => (
          <ActionIcon
            aria-label={`Odebrat ${line.name}`}
            icon="icon-[mdi--close]"
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
            "max-md:[&_thead]:sr-only max-md:[&_tbody]:grid max-md:[&_td]:w-auto! max-md:[&_td:first-child]:col-span-2 max-md:[&_td:last-child]:justify-self-end",
        },
        row: { className: "max-md:grid max-md:grid-cols-[minmax(0,1fr)_auto] max-md:items-center" },
      }}
    />
  );
}
