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
import { useDictionary, useMoney } from "@/ontos/market-context";
import type { Dictionary } from "@/i18n";

const blockedLabel = (cs: Dictionary, code: string) =>
  code in cs.cart.issue
    ? cs.cart.issue[code as keyof Dictionary["cart"]["issue"]]
    : cs.cart.lineState.blocked;

function LineAvailability({ line, quote }: { line: CartLine; quote: CartQuoteState | null }) {
  const cs = useDictionary();
  const base =
    "text-(length:--sf-cart-secondary-size) font-(weight:--sf-cart-primary-weight) uppercase";
  if (!quote?.enabled)
    return (
      <span className={`${base} text-(--color-fg-status-success)`}>
        {cs.cart.lineState.inStock}
      </span>
    );
  if (quote.status !== "ready")
    return (
      <span className={`${base} text-(--color-fg-secondary)`} data-sf-line-state="unverified">
        {quote.status === "error" ? cs.cart.lineState.unchecked : cs.cart.lineState.checking}
      </span>
    );
  const [issue] = quote.lineIssues(line.productId, line.variantId);
  if (issue)
    return (
      <span
        className={`${base} text-(--color-danger)`}
        data-sf-line-state="blocked"
        title={issue.message}
      >
        {blockedLabel(cs, issue.code)}
      </span>
    );
  return (
    <span className={`${base} text-(--color-fg-status-success)`} data-sf-line-state="verified">
      {cs.cart.lineState.inStock}
    </span>
  );
}

function CartQuantity({ line }: { line: CartLine }) {
  const cs = useDictionary();
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
          // An emptied field reports NaN. Keep it as the draft, so the field stays empty while the shopper retypes;
          // blur then restores the cart quantity.
          setDraftQuantity(quantity);
          if (!Number.isFinite(quantity)) return;
          // Preserve unfinished typing (e.g. "2" on the way to "20" with a minimum of 10).
          if (quantity > 0 && normalizeOrderQuantity(line, quantity) === quantity) commit(quantity);
        }}
        onBlur={() => {
          if (draftQuantity !== null && draftQuantity > 0) commit(draftQuantity);
          setDraftQuantity(null);
        }}
      >
        <NumericInput.Control
          data-sf-cart-quantity
          style={
            {
              "--sf-cart-quantity-characters": Math.max(
                2,
                new Intl.NumberFormat("cs-CZ", { maximumFractionDigits: 6 }).format(
                  draftQuantity === null || Number.isNaN(draftQuantity)
                    ? line.quantity
                    : draftQuantity,
                ).length,
              ),
            } as CSSProperties
          }
          className="w-(--sf-cart-control-width) shrink-0 gap-(--sf-cart-control-gap) overflow-visible"
        >
          <NumericInput.DecrementTrigger
            aria-label={cs.cart.decrementQuantityOf(line.variantLabel ?? line.name)}
            className="h-full w-(--sf-cart-trigger-width) flex-none rounded-(--sf-cart-control-radius) bg-(--sf-cart-trigger-bg)"
            icon="token-icon-minus"
          />
          <NumericInput.Input
            aria-label={cs.cart.quantityOf(line.variantLabel ?? line.name)}
            className="min-w-0 flex-1 rounded-(--sf-cart-control-radius)! border-solid! border-(length:--sf-cart-value-border-width)! border-(--sf-cart-value-border-color)! text-center leading-(--sf-checkout-heading-leading)"
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                event.currentTarget.blur();
              }
            }}
          />
          <NumericInput.IncrementTrigger
            aria-label={cs.cart.incrementQuantityOf(line.variantLabel ?? line.name)}
            className="h-full w-(--sf-cart-trigger-width) flex-none rounded-(--sf-cart-control-radius) bg-(--sf-cart-trigger-bg)"
            icon="token-icon-plus"
          />
        </NumericInput.Control>
      </NumericInput>
    </div>
  );
}

export function CartItemsTable({ showHeader = false }: { showHeader?: boolean }) {
  const cs = useDictionary();
  const money = useMoney();
  const { cart, dispatch } = useCart();
  const quote = useCartQuote();

  return (
    <div
      data-sf-cart-items
      style={
        {
          "--sf-cart-max-quantity-characters": Math.max(
            2,
            ...cart.lines.map(
              (line) =>
                new Intl.NumberFormat("cs-CZ", { maximumFractionDigits: 6 }).format(line.quantity)
                  .length,
            ),
          ),
        } as CSSProperties
      }
      className="@container/sf-cart min-w-0 font-medium"
    >
      <Table
        aria-label={cs.cart.itemsLabel}
        size="sm"
        variant="line"
        className="table-auto @max-sf-cart-wide/sf-cart:block @max-sf-cart-wide/sf-cart:[&_thead]:sr-only @max-sf-cart-wide/sf-cart:[&_tbody]:grid @max-sf-cart-wide/sf-cart:[&_td]:block @max-sf-cart-wide/sf-cart:[&_td]:w-auto! @max-sf-cart-wide/sf-cart:[&_td]:min-w-0 @max-sf-cart-wide/sf-cart:[&_td]:p-0! @max-sf-cart-wide/sf-cart:[&_td:first-child]:col-span-2 @max-sf-cart-wide/sf-cart:[&_td:last-child]:justify-self-end @max-sf-cart-narrow/sf-cart:[&_td:nth-child(2)]:col-span-2 @max-sf-cart-narrow/sf-cart:[&_td:nth-child(3)]:col-span-2 @max-sf-cart-narrow/sf-cart:[&_td:nth-child(3)]:justify-self-start"
      >
        <Table.Header
          className={`${showHeader ? "" : "sr-only "}[&_th]:text-(length:--sf-cart-secondary-size)`}
        >
          <Table.Row>
            <Table.ColumnHeader scope="col">{cs.cart.item}</Table.ColumnHeader>
            <Table.ColumnHeader scope="col" style={{ width: "var(--sf-cart-stock-width)" }}>
              {cs.cart.availability}
            </Table.ColumnHeader>
            <Table.ColumnHeader
              scope="col"
              align="center"
              style={{ width: "var(--sf-cart-quantity-width)" }}
            >
              {cs.cart.quantity}
            </Table.ColumnHeader>
            <Table.ColumnHeader
              scope="col"
              align="end"
              style={{ width: "var(--sf-cart-price-width)" }}
            >
              {cs.cart.price}
            </Table.ColumnHeader>
            <Table.ColumnHeader
              scope="col"
              align="end"
              style={{ width: "var(--sf-cart-remove-width)" }}
            >
              <span className="sr-only">{cs.cart.remove}</span>
            </Table.ColumnHeader>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {cart.lines.map((line) => (
            <Table.Row
              key={`${line.productId}:${line.variantId ?? "base"}`}
              className="@max-sf-cart-wide/sf-cart:grid @max-sf-cart-wide/sf-cart:grid-cols-[minmax(0,1fr)_auto] @max-sf-cart-wide/sf-cart:items-center @max-sf-cart-wide/sf-cart:gap-(--sf-cart-row-gap) @max-sf-cart-wide/sf-cart:py-(--dimension-16)"
            >
              <Table.Cell>
                <div className="flex min-w-0 flex-wrap items-baseline gap-x-(--sf-cart-detail-gap) gap-y-1 whitespace-normal">
                  <Link
                    as={StoreLink}
                    href={`/produkt/${line.slug}`}
                    className="min-w-0 wrap-anywhere text-inherit no-underline"
                  >
                    {formatCartProductName(line.name)}
                  </Link>
                  {line.variantLabel && (
                    <span className="wrap-anywhere text-(length:--sf-cart-secondary-size) text-(--color-fg-secondary)">
                      {line.variantLabel}
                    </span>
                  )}
                  {quote?.status === "ready" &&
                    quote.lineIssues(line.productId, line.variantId).map((issue) => (
                      <span
                        key={issue.message}
                        className="basis-full wrap-anywhere text-(length:--sf-cart-secondary-size) text-(--color-danger)"
                      >
                        {issue.message}
                      </span>
                    ))}
                </div>
              </Table.Cell>
              <Table.Cell style={{ width: "var(--sf-cart-stock-width)" }}>
                <LineAvailability line={line} quote={quote} />
              </Table.Cell>
              <Table.Cell align="center" style={{ width: "var(--sf-cart-quantity-width)" }}>
                <CartQuantity line={line} />
              </Table.Cell>
              <Table.Cell align="end" style={{ width: "var(--sf-cart-price-width)" }}>
                <div className="grid min-w-0 justify-items-end gap-1 text-right @max-sf-cart-wide/sf-cart:justify-items-start @max-sf-cart-wide/sf-cart:text-left">
                  <strong className="whitespace-normal font-(weight:--sf-cart-price-weight)">
                    {formatCheckoutPrice(getLineTotal(line), money)}
                  </strong>
                </div>
              </Table.Cell>
              <Table.Cell align="end" style={{ width: "var(--sf-cart-remove-width)" }}>
                <ActionIcon
                  aria-label={cs.cart.removeItem(line.name)}
                  icon="token-icon-sf-checkout-remove"
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
