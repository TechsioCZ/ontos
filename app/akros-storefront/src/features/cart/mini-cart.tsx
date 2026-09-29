"use client";

import NextLink from "next/link";
import { Icon } from "@techsio/ui-kit/atoms/icon";
import { Link } from "@techsio/ui-kit/atoms/link";
import { Popover } from "@techsio/ui-kit/molecules/popover";

import styles from "./mini-cart.module.css";
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
        className={styles.trigger}
        size="current"
        theme="unstyled"
      >
        <strong className={styles.total}>{formatPrice(subtotal)}</strong>
        <span className={styles.iconWrap}>
          <Icon className={styles.cartIcon} icon="token-icon-cart-button" aria-hidden="true" />
          <span className={styles.badge} aria-live="polite">
            {itemCount}
          </span>
        </span>
      </Popover.Trigger>

      <Popover.Positioner className={styles.positioner}>
        <Popover.Content className={styles.content}>
          <Popover.Title className={styles.srOnly}>{cs.cart.miniCart.title}</Popover.Title>
          <Link as={NextLink} className={styles.panelLink} href="/kosik">
            {!ready ? (
              <span className={styles.state}>{cs.cart.loading}</span>
            ) : cart.lines.length === 0 ? (
              <span className={styles.state}>
                <span>{cs.cart.empty}</span>
                <strong>{cs.cart.miniCart.openCart}</strong>
              </span>
            ) : (
              <span className={styles.lines}>
                {cart.lines.map((line) => (
                  <span
                    className={styles.line}
                    key={`${line.productId}:${line.variantId ?? "base"}`}
                  >
                    <strong className={styles.quantity}>
                      {formatQuantity(line.quantity)} {line.unit}
                    </strong>
                    <span className={styles.product}>
                      <span className={styles.productName}>{line.name}</span>
                      {line.variantLabel && (
                        <span className={styles.variant}>{line.variantLabel}</span>
                      )}
                    </span>
                    <strong className={styles.linePrice}>
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
