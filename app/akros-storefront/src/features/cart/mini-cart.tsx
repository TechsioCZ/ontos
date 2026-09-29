"use client";

import NextLink from "next/link";
import { Icon } from "@techsio/ui-kit/atoms/icon";
import { Link } from "@techsio/ui-kit/atoms/link";
import { Popover } from "@techsio/ui-kit/molecules/popover";

import { useCart } from "./cart-provider";

import { cs } from "@/i18n/cs";
import { formatPrice } from "@/lib/format";
import { formatQuantity, getCartSubtotal } from "@/mock-storefront/cart";

const getItemCountLabel = (count: number) => {
  const lastDigit = count % 10;
  const lastTwoDigits = count % 100;

  if (lastDigit === 1 && lastTwoDigits !== 11) {
    return `${count} ${cs.cart.miniCart.itemSingular}`;
  }
  if (lastDigit >= 2 && lastDigit <= 4 && (lastTwoDigits < 12 || lastTwoDigits > 14)) {
    return `${count} ${cs.cart.miniCart.itemFew}`;
  }
  return `${count} ${cs.cart.miniCart.itemPlural}`;
};

export function MiniCart() {
  const { cart, itemCount, ready } = useCart();
  const subtotal = getCartSubtotal(cart);
  const itemCountLabel = getItemCountLabel(itemCount);
  const triggerLabel = ready
    ? `${cs.header.cart}, ${itemCountLabel}, ${formatPrice(subtotal)}`
    : `${cs.header.cart}, ${cs.cart.loading}`;

  return (
    <Popover
      border={false}
      closeOnEscape
      closeOnInteractOutside
      gutter={17}
      placement="bottom-end"
      shadow={false}
    >
      <Popover.Trigger
        aria-label={triggerLabel}
        className="inline-flex h-12 w-auto shrink-0 cursor-pointer items-center justify-center gap-3 rounded-sm border-0 bg-(--color-primary) px-3 py-2 text-(--color-fg-primary) hover:bg-(--color-primary-hover) data-[state=open]:bg-(--color-primary-hover) max-lg:w-12 max-lg:px-2"
        size="current"
        theme="unstyled"
      >
        <strong className="min-w-0 truncate text-sm leading-tight max-lg:hidden">
          {formatPrice(subtotal)}
        </strong>
        <span className="relative inline-flex shrink-0 items-center justify-center">
          <Icon icon="token-icon-cart-button" size="xl" />
          <span
            className="absolute -top-1 -right-1 grid h-5 min-w-5 place-items-center rounded-full bg-(--color-fg-primary) px-1 text-xs leading-none font-bold text-(--color-base-light)"
            aria-live="polite"
          >
            {itemCount}
          </span>
        </span>
      </Popover.Trigger>

      <Popover.Positioner className="z-70 max-w-[calc(100vw-var(--dimension-32))]">
        <Popover.Content className="max-h-[min(70vh,540px)] w-[min(var(--dimension-container-3xl),calc(100vw-var(--dimension-32)))] overflow-y-auto rounded-sm bg-(--color-primary) text-(--color-fg-primary) shadow-md [--padding-popover-md:0px] max-md:w-[calc(100vw-var(--dimension-32))]">
          <Popover.Title className="sr-only">{cs.cart.miniCart.title}</Popover.Title>
          <Link as={NextLink} className="block text-inherit no-underline" href="/kosik">
            {!ready ? (
              <span className="grid min-h-28 place-content-center gap-2 p-6 text-center">
                {cs.cart.loading}
              </span>
            ) : cart.lines.length === 0 ? (
              <span className="grid min-h-28 place-content-center gap-2 p-6 text-center">
                <span>{cs.cart.empty}</span>
                <strong>{cs.cart.miniCart.openCart}</strong>
              </span>
            ) : (
              <span className="grid">
                {cart.lines.map((line) => (
                  <span
                    className="grid min-h-14 grid-cols-[minmax(72px,auto)_minmax(0,1fr)_auto] items-center gap-3 px-4 py-1 text-sm leading-tight uppercase max-md:grid-cols-[minmax(56px,auto)_minmax(0,1fr)] max-md:gap-x-3 max-md:gap-y-2"
                    key={`${line.productId}:${line.variantId ?? "base"}`}
                  >
                    <strong className="whitespace-nowrap">
                      {formatQuantity(line.quantity)} {line.unit}
                    </strong>
                    <span className="grid min-w-0 gap-0.5">
                      <span className="truncate">{line.name}</span>
                      {line.variantLabel && (
                        <span className="truncate text-xs font-normal">{line.variantLabel}</span>
                      )}
                    </span>
                    <strong className="whitespace-nowrap max-md:col-start-2">
                      {formatPrice(line.priceMinor * line.quantity)}
                    </strong>
                  </span>
                ))}
              </span>
            )}
          </Link>
        </Popover.Content>
      </Popover.Positioner>
    </Popover>
  );
}
