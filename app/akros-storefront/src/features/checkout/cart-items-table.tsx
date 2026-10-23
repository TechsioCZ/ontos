"use client";

import StoreLink from "@/components/store-link";
import { type CSSProperties, useId, useState } from "react";
import { ActionIcon } from "@techsio/ui-kit/atoms/action-icon";
import { Link } from "@techsio/ui-kit/atoms/link";
import { NumericInput } from "@techsio/ui-kit/atoms/numeric-input";
import { Table } from "@techsio/ui-kit/organisms/table";
import { useCart } from "@/features/cart/cart-provider";
import {
  type CartLine,
  getLineTotal,
  getMaximumOrderQuantity,
  normalizeOrderQuantity,
} from "@/features/cart/cart-state";
import { formatCheckoutPrice } from "./checkout-format";
import { formatCartProductName } from "./cart-product-name";
import { useCartQuote, type CartQuoteState } from "@/ontos/cart-revalidation";

const blockedLabels: Record<string, string> = {
  AVAILABILITY_UNKNOWN: "Nelze ověřit",
  PRICE_UNAVAILABLE: "Cena není dostupná",
  NOT_AVAILABLE: "Není v nabídce",
  OUT_OF_STOCK: "Není skladem",
  INSUFFICIENT_STOCK: "Nedostatek kusů",
  MINIMUM_QUANTITY: "Upravte množství",
  PACKAGE_QUANTITY: "Upravte množství",
};

function LineAvailability({ line, quote }: { line: CartLine; quote: CartQuoteState | null }) {
  const base =
    "text-(length:--akros-cart-secondary-size) font-(weight:--akros-cart-primary-weight) uppercase";
  if (!quote?.enabled)
    return <span className={`${base} text-(--color-fg-status-success)`}>Skladem</span>;
  if (quote.status !== "ready")
    return (
      <span className={`${base} text-(--color-fg-secondary)`} data-akros-line-state="unverified">
        {quote.status === "error" ? "Neověřeno" : "Ověřuji…"}
      </span>
    );
  const [issue] = quote.lineIssues(line.productId, line.variantId);
  if (issue)
    return (
      <span
        className={`${base} text-(--color-danger)`}
        data-akros-line-state="blocked"
        title={issue.message}
      >
        {blockedLabels[issue.code] ?? "Nelze objednat"}
      </span>
    );
  return (
    <span className={`${base} text-(--color-fg-status-success)`} data-akros-line-state="verified">
      Skladem
    </span>
  );
}

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
        step={line.quantityStep ?? line.minimumQuantity}
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
          className="w-(--akros-cart-control-width) shrink-0 gap-(--akros-cart-control-gap) overflow-visible"
        >
          <NumericInput.DecrementTrigger
            aria-label={`Snížit množství: ${line.variantLabel ?? line.name}`}
            className="h-full w-(--akros-cart-trigger-width) flex-none rounded-(--akros-cart-control-radius) bg-(--akros-cart-trigger-bg)"
            icon="token-icon-minus"
          />
          <NumericInput.Input
            aria-label={`Množství: ${line.variantLabel ?? line.name}`}
            className="min-w-0 flex-1 rounded-(--akros-cart-control-radius)! border-solid! border-(length:--akros-cart-value-border-width)! border-(--akros-cart-value-border-color)! text-center leading-(--akros-checkout-heading-leading)"
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                event.currentTarget.blur();
              }
            }}
          />
          <NumericInput.IncrementTrigger
            aria-label={`Zvýšit množství: ${line.variantLabel ?? line.name}`}
            className="h-full w-(--akros-cart-trigger-width) flex-none rounded-(--akros-cart-control-radius) bg-(--akros-cart-trigger-bg)"
            icon="token-icon-plus"
          />
        </NumericInput.Control>
      </NumericInput>
    </div>
  );
}

export function CartItemsTable({ showHeader = false }: { showHeader?: boolean }) {
  const { cart, dispatch } = useCart();
  const quote = useCartQuote();

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
      <Table
        aria-label="Položky objednávky"
        size="sm"
        variant="line"
        className="table-auto @max-akros-cart-wide/akros-cart:block @max-akros-cart-wide/akros-cart:[&_thead]:sr-only @max-akros-cart-wide/akros-cart:[&_tbody]:grid @max-akros-cart-wide/akros-cart:[&_td]:block @max-akros-cart-wide/akros-cart:[&_td]:w-auto! @max-akros-cart-wide/akros-cart:[&_td]:min-w-0 @max-akros-cart-wide/akros-cart:[&_td]:p-0! @max-akros-cart-wide/akros-cart:[&_td:first-child]:col-span-2 @max-akros-cart-wide/akros-cart:[&_td:last-child]:justify-self-end @max-akros-cart-narrow/akros-cart:[&_td:nth-child(2)]:col-span-2 @max-akros-cart-narrow/akros-cart:[&_td:nth-child(3)]:col-span-2 @max-akros-cart-narrow/akros-cart:[&_td:nth-child(3)]:justify-self-start"
      >
        <Table.Header
          className={`${showHeader ? "" : "sr-only "}[&_th]:text-(length:--akros-cart-secondary-size)`}
        >
          <Table.Row>
            <Table.ColumnHeader scope="col">Položka</Table.ColumnHeader>
            <Table.ColumnHeader scope="col" style={{ width: "var(--akros-cart-stock-width)" }}>
              Dostupnost
            </Table.ColumnHeader>
            <Table.ColumnHeader
              scope="col"
              align="center"
              style={{ width: "var(--akros-cart-quantity-width)" }}
            >
              Množství
            </Table.ColumnHeader>
            <Table.ColumnHeader
              scope="col"
              align="end"
              style={{ width: "var(--akros-cart-price-width)" }}
            >
              Cena
            </Table.ColumnHeader>
            <Table.ColumnHeader
              scope="col"
              align="end"
              style={{ width: "var(--akros-cart-remove-width)" }}
            >
              <span className="sr-only">Odebrat</span>
            </Table.ColumnHeader>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {cart.lines.map((line) => (
            <Table.Row
              key={`${line.productId}:${line.variantId ?? "base"}`}
              className="@max-akros-cart-wide/akros-cart:grid @max-akros-cart-wide/akros-cart:grid-cols-[minmax(0,1fr)_auto] @max-akros-cart-wide/akros-cart:items-center @max-akros-cart-wide/akros-cart:gap-(--akros-cart-row-gap) @max-akros-cart-wide/akros-cart:py-(--dimension-16)"
            >
              <Table.Cell>
                <div className="flex min-w-0 flex-wrap items-baseline gap-x-(--akros-cart-detail-gap) gap-y-1 whitespace-normal">
                  <Link
                    as={StoreLink}
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
                  {quote?.status === "ready" &&
                    quote.lineIssues(line.productId, line.variantId).map((issue) => (
                      <span
                        key={issue.message}
                        className="basis-full wrap-anywhere text-(length:--akros-cart-secondary-size) text-(--color-danger)"
                      >
                        {issue.message}
                      </span>
                    ))}
                </div>
              </Table.Cell>
              <Table.Cell style={{ width: "var(--akros-cart-stock-width)" }}>
                <LineAvailability line={line} quote={quote} />
              </Table.Cell>
              <Table.Cell align="center" style={{ width: "var(--akros-cart-quantity-width)" }}>
                <CartQuantity line={line} />
              </Table.Cell>
              <Table.Cell align="end" style={{ width: "var(--akros-cart-price-width)" }}>
                <div className="grid min-w-0 justify-items-end gap-1 text-right @max-akros-cart-wide/akros-cart:justify-items-start @max-akros-cart-wide/akros-cart:text-left">
                  <strong className="whitespace-normal font-(weight:--akros-cart-price-weight)">
                    {formatCheckoutPrice(getLineTotal(line))}
                  </strong>
                </div>
              </Table.Cell>
              <Table.Cell align="end" style={{ width: "var(--akros-cart-remove-width)" }}>
                <ActionIcon
                  aria-label={`Odebrat ${line.name}`}
                  icon="token-icon-akros-checkout-remove"
                  size="md"
                  onClick={() =>
                    dispatch({
                      type: "remove",
                      productId: line.productId,
                      variantId: line.variantId,
                    })
                  }
                />
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table>
    </div>
  );
}
