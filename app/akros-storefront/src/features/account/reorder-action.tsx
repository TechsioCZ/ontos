"use client";

import { useEffect, useId, useRef, useState } from "react";
import NextLink from "next/link";
import { Button } from "@techsio/ui-kit/atoms/button";
import { LinkButton } from "@techsio/ui-kit/atoms/link-button";
import { toaster } from "@techsio/ui-kit/molecules/toast";
import { useCart } from "@/features/cart/cart-provider";
import type { Dictionary } from "@/i18n";
import { useDictionary, useStoreHref } from "@/ontos/market-context";
import { marketRequestHeaders } from "@/ontos/market-locale";
import { parseReorderResolution, prepareReorder, type ReorderResult } from "./reorder";

export type { ReorderResult } from "./reorder";

/** A service that owns line resolution, availability and updating the given cart (tests, future OntOS action). */
export type RepeatOrder = (orderId: string, cartId: string) => Promise<ReorderResult>;
const notificationId = "sf-reorder-feedback";

function showResult(cs: Dictionary, cartHref: string, orderNumber: string, result: ReorderResult) {
  toaster.create({
    id: notificationId,
    type: result.notices.length || result.addedLines === 0 ? "warning" : "success",
    title: cs.account.reorder.resultTitle(orderNumber),
    duration: result.notices.length ? Infinity : 6000,
    description: (
      <div data-sf-cart-notification className="grid gap-(--dimension-12)">
        <p>{cs.account.reorder.added(result.addedLines)}</p>
        {result.addedLines > 0 && <p>{cs.account.reorder.currentPrices}</p>}
        {result.notices.length > 0 && (
          <ul className="grid gap-(--dimension-8) wrap-anywhere">
            {result.notices.map((notice, index) => (
              <li key={index}>{notice}</li>
            ))}
          </ul>
        )}
        {result.addedLines > 0 && (
          <LinkButton
            as={NextLink}
            href={cartHref}
            prefetch={false}
            size="sm"
            theme="outlined"
            variant="primary"
            onClick={() => toaster.dismiss(notificationId)}
          >
            {cs.account.reorder.goToCart}
          </LinkButton>
        )}
      </div>
    ),
  });
}

/**
 * „Objednat znovu“: puts the exact variants of a saved OntOS order into the active cart at current prices.
 * Other carts and unrelated lines stay untouched; the cart quote re-checks prices and stock in OntOS.
 */
export function ReorderAction({
  orderId,
  orderNumber,
  lineCount,
  repeatOrder,
}: {
  orderId: string;
  orderNumber: string;
  /** Lines of the saved order; an order without lines cannot be repeated. */
  lineCount?: number;
  repeatOrder?: RepeatOrder;
}) {
  const cs = useDictionary();
  const storeHref = useStoreHref();
  const { activeCartId, ready, cart, dispatch } = useCart();
  const latestCart = useRef(cart);
  useEffect(() => {
    latestCart.current = cart;
  }, [cart]);
  const available = lineCount !== 0;
  const id = useId();
  const busy = useRef(false);
  const [pending, setPending] = useState(false);
  async function repeat() {
    if (!available || !ready || busy.current) return;
    busy.current = true;
    setPending(true);
    toaster.remove(notificationId);
    try {
      if (repeatOrder) {
        showResult(cs, storeHref("/kosik"), orderNumber, await repeatOrder(orderId, activeCartId));
      } else {
        const response = await fetch("/api/ontos/account/reorder", {
          method: "POST",
          headers: { "content-type": "application/json", ...marketRequestHeaders() },
          body: JSON.stringify({ orderId }),
          cache: "no-store",
          signal: AbortSignal.timeout(10_000),
        });
        const resolution = parseReorderResolution(await response.json());
        if (!response.ok || !resolution) throw new Error("Repeat order was not resolved");
        // Word the outcome against the cart the reducer will extend (it may have changed while loading).
        const prepared = prepareReorder(latestCart.current, resolution, cs);
        if (prepared.items.length) dispatch({ type: "reorder", items: prepared.items });
        showResult(cs, storeHref("/kosik"), orderNumber, prepared.result);
      }
    } catch {
      toaster.create({
        id: notificationId,
        type: "error",
        title: cs.account.reorder.failed,
        description: cs.account.reorder.retry,
        duration: Infinity,
      });
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  return (
    <div className="sf-reorder-action">
      <Button
        type="button"
        size="sm"
        variant="primary"
        disabled={!available || !ready}
        isLoading={pending}
        loadingText={cs.account.reorder.pending}
        aria-label={cs.account.reorder.actionLabel(orderNumber)}
        aria-describedby={!available ? id : undefined}
        onClick={(event) => {
          if (event.detail < 2) void repeat();
        }}
      >
        {cs.account.reorder.action}
      </Button>
      {!available && (
        <span id={id} className="sr-only">
          {cs.account.reorder.unavailable}
        </span>
      )}
    </div>
  );
}
