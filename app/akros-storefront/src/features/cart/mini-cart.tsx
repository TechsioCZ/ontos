"use client";

import NextLink from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { Icon } from "@techsio/ui-kit/atoms/icon";
import { Link } from "@techsio/ui-kit/atoms/link";
import { LinkButton } from "@techsio/ui-kit/atoms/link-button";
import { Popover } from "@techsio/ui-kit/molecules/popover";

import { useCart } from "./cart-provider";

import { cs } from "@/i18n/cs";
import { formatPrice } from "@/lib/format";
import { formatQuantity, getCartSubtotal, getLineTotal } from "@/mock-storefront/cart";

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
  const id = useId();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLAnchorElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { cart, itemCount, ready } = useCart();
  const subtotal = getCartSubtotal(cart);
  const itemCountLabel = getItemCountLabel(itemCount);
  const triggerLabel = ready
    ? `${cs.header.cart}, ${itemCountLabel}, ${formatPrice(subtotal)}`
    : `${cs.header.cart}, ${cs.cart.loading}`;

  function cancelClose() {
    if (closeTimer.current !== null) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }

  function closePreview() {
    cancelClose();
    setOpen(false);
  }

  function openPreview() {
    cancelClose();
    setOpen(true);
  }

  function scheduleClose() {
    cancelClose();
    // Allow crossing the gap between the link and its portalled preview.
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null;
      if (
        !triggerRef.current?.contains(document.activeElement) &&
        !contentRef.current?.contains(document.activeElement)
      ) {
        setOpen(false);
      }
    }, 200);
  }

  useEffect(
    () => () => {
      if (closeTimer.current !== null) clearTimeout(closeTimer.current);
    },
    [],
  );

  return (
    <Popover
      autoFocus={false}
      border={false}
      closeOnEscape
      closeOnInteractOutside
      gutter={17}
      ids={{ trigger: `${id}-trigger`, content: `${id}-content` }}
      onEscapeKeyDown={() => {
        if (contentRef.current?.contains(document.activeElement)) triggerRef.current?.focus();
      }}
      onOpenChange={({ open: nextOpen }) => {
        cancelClose();
        setOpen(nextOpen);
      }}
      open={open}
      placement="bottom-end"
      restoreFocus={false}
      shadow={false}
    >
      <Popover.Anchor className="inline-flex shrink-0">
        <LinkButton
          as={NextLink}
          aria-controls={open ? `${id}-content` : undefined}
          aria-expanded={open}
          aria-haspopup="dialog"
          aria-label={triggerLabel}
          className="akros-header__cart-trigger inline-flex h-(--akros-header-control-height) w-(--akros-header-cart-width) shrink-0 cursor-pointer items-center justify-center gap-5 rounded-sm border-0 bg-(--color-primary) px-4 text-(--color-fg-primary) hover:bg-(--color-primary-hover) data-[state=open]:bg-(--color-primary-hover) max-lg:w-16 max-lg:px-2"
          data-state={open ? "open" : "closed"}
          href="/kosik"
          id={`${id}-trigger`}
          onBlur={(event) => {
            if (!contentRef.current?.contains(event.relatedTarget)) closePreview();
          }}
          onClick={closePreview}
          onFocus={(event) => {
            if (event.currentTarget.matches(":focus-visible")) openPreview();
          }}
          onPointerEnter={(event) => {
            if (event.pointerType !== "touch") openPreview();
          }}
          onPointerLeave={scheduleClose}
          ref={triggerRef}
          size="current"
          theme="unstyled"
        >
          <strong className="shrink-0 whitespace-nowrap text-md leading-tight font-medium uppercase max-lg:hidden">
            {formatPrice(subtotal)}
          </strong>
          <span className="relative inline-flex shrink-0 items-center justify-center">
            <Icon icon="token-icon-cart-button" size="2xl" />
            <span
              className="absolute -top-1 -right-1 grid h-5 min-w-5 place-items-center rounded-full bg-(--color-fg-primary) px-1 text-sm leading-none font-bold text-(--color-base-light)"
              aria-live="polite"
            >
              {itemCount}
            </span>
          </span>
        </LinkButton>
      </Popover.Anchor>

      <Popover.Positioner className="z-70 max-w-[calc(100vw-var(--dimension-32))]">
        <Popover.Content
          className="max-h-[min(70vh,540px)] w-[min(var(--dimension-container-3xl),calc(100vw-var(--dimension-32)))] overflow-y-auto rounded-sm bg-(--color-primary) text-(--color-fg-primary) shadow-md [--padding-popover-md:0px] max-md:w-[calc(100vw-var(--dimension-32))]"
          onBlur={(event) => {
            if (
              !event.currentTarget.contains(event.relatedTarget) &&
              !triggerRef.current?.contains(event.relatedTarget)
            )
              closePreview();
          }}
          onFocus={cancelClose}
          onPointerEnter={cancelClose}
          onPointerLeave={scheduleClose}
          ref={contentRef}
        >
          <Popover.Title className="sr-only">{cs.cart.miniCart.title}</Popover.Title>
          <Link
            as={NextLink}
            className="block text-inherit no-underline"
            href="/kosik"
            onClick={closePreview}
          >
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
                      {formatPrice(getLineTotal(line))}
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
