"use client";

import { useId, useRef, useState } from "react";
import NextLink from "next/link";
import { Button } from "@techsio/ui-kit/atoms/button";
import { LinkButton } from "@techsio/ui-kit/atoms/link-button";
import { toaster } from "@techsio/ui-kit/molecules/toast";
import { useCart } from "@/features/cart/cart-provider";
import { mockOrders } from "@/mock-storefront/fixtures/account";
import { prepareReorder } from "@/mock-storefront/reorder";

export interface ReorderResult {
  addedLines: number;
  notices: string[];
}

// The order service owns line resolution, availability and updating the active cart.
export type RepeatOrder = (orderNumber: string, cartId: string) => Promise<ReorderResult>;
export const reorderUnavailable = "Položky této objednávky nejsou dostupné.";
const notificationId = "akros-reorder-feedback";

function showResult(orderNumber: string, result: ReorderResult) {
  toaster.create({
    id: notificationId,
    type: result.notices.length || result.addedLines === 0 ? "warning" : "success",
    title: `Objednávka ${orderNumber}`,
    duration: result.notices.length ? Infinity : 6000,
    description: (
      <div data-akros-cart-notification className="grid gap-(--dimension-12)">
        <p>Přidáno položek: {result.addedLines}.</p>
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
            href="/kosik"
            size="sm"
            theme="outlined"
            variant="primary"
            onClick={() => toaster.dismiss(notificationId)}
          >
            Přejít do košíku
          </LinkButton>
        )}
      </div>
    ),
  });
}

export function ReorderAction({
  orderNumber,
  repeatOrder,
}: {
  orderNumber: string;
  repeatOrder?: RepeatOrder;
}) {
  const { activeCartId, ready, cart, dispatch } = useCart();
  const order = mockOrders.find((entry) => entry.number === orderNumber);
  const available = Boolean(repeatOrder || order);
  const id = useId();
  const busy = useRef(false);
  const [pending, setPending] = useState(false);
  async function repeat() {
    if (!available || !ready || busy.current) return;
    busy.current = true;
    setPending(true);
    toaster.remove(notificationId);
    try {
      if (repeatOrder) showResult(orderNumber, await repeatOrder(orderNumber, activeCartId));
      else if (order) {
        const prepared = prepareReorder(cart, order.lines);
        dispatch({ type: "reorder", items: prepared.items });
        showResult(orderNumber, prepared.result);
      }
    } catch {
      toaster.create({
        id: notificationId,
        type: "error",
        title: "Objednávku se nepodařilo zopakovat.",
        description: "Zkuste to znovu.",
        duration: Infinity,
      });
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  return (
    <div className="akros-reorder-action">
      <Button
        type="button"
        size="sm"
        variant="primary"
        disabled={!available || !ready}
        isLoading={pending}
        loadingText="Přidávám…"
        aria-label={`Objednat znovu ${orderNumber}`}
        aria-describedby={!available ? id : undefined}
        onClick={(event) => {
          if (event.detail < 2) void repeat();
        }}
      >
        Objednat znovu
      </Button>
      {!available && (
        <span id={id} className="sr-only">
          {reorderUnavailable}
        </span>
      )}
    </div>
  );
}
