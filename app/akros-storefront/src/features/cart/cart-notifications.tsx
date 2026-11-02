"use client";

import StoreLink from "@/components/store-link";
import { useEffect, useId } from "react";
import { Button } from "@techsio/ui-kit/atoms/button";
import { LinkButton } from "@techsio/ui-kit/atoms/link-button";
import { Toaster, toaster } from "@techsio/ui-kit/molecules/toast";
import { formatQuantity, getMaximumOrderQuantity } from "@/features/cart/cart-state";
import { useDictionary } from "@/ontos/market-context";
import { useCart } from "./cart-provider";

export function CartNotifications() {
  const owner = useId();
  const feedbackId = `sf-cart-feedback-${owner}`;
  const removalId = `sf-cart-removal-${owner}`;
  const { purchaseError, feedback, removedItem, undoRemove, dismissRemove } = useCart();
  const toast = useDictionary().cart.toast;

  useEffect(() => {
    let active = true;
    // The UI kit synchronously flushes its store; update it outside React's commit phase.
    queueMicrotask(() => {
      if (!active) return;
      if (!feedback) {
        toaster.remove(feedbackId);
        return;
      }
      const { line, kind, quantity, limited } = feedback;
      toaster.create({
        id: feedbackId,
        type: kind === "limited" || limited ? "warning" : "success",
        title:
          kind === "limited"
            ? toast.limitedTitle
            : kind === "restored"
              ? toast.restoredTitle
              : toast.addedTitle,
        duration: 6000,
        description: (
          <div data-sf-cart-notification className="grid gap-3">
            <p className="wrap-anywhere">{line.variantLabel ?? line.name}</p>
            <p>
              {kind === "limited"
                ? getMaximumOrderQuantity(line) > 0
                  ? toast.alreadyAtMaximum
                  : toast.checkAvailability
                : (kind === "restored" ? toast.restored : toast.added)(
                    formatQuantity(quantity),
                    line.unit,
                  )}
            </p>
            {kind !== "limited" && limited && <p>{toast.partiallyAdded}</p>}
            <LinkButton
              as={StoreLink}
              href="/kosik"
              size="sm"
              variant="primary"
              onClick={() => toaster.dismiss(feedbackId)}
            >
              {toast.viewCart}
            </LinkButton>
          </div>
        ),
      });
    });
    return () => {
      active = false;
    };
  }, [feedback, feedbackId, toast]);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      if (!removedItem) {
        toaster.remove(removalId);
        return;
      }
      const { id, line } = removedItem;
      toaster.create({
        id: removalId,
        type: "info",
        title: toast.removedTitle,
        // Undo remains available until explicitly dismissed or replaced by another removal.
        duration: Infinity,
        onStatusChange: ({ status, src }) => {
          if (status === "dismissing" && (src === "user" || src === "keyboard")) dismissRemove(id);
        },
        description: (
          <div data-sf-cart-notification className="grid gap-3">
            <p className="wrap-anywhere">{line.variantLabel ?? line.name}</p>
            <p>
              {formatQuantity(line.quantity)} {line.unit}
            </p>
            <Button size="sm" variant="primary" onClick={() => undoRemove(id)}>
              {toast.undo}
            </Button>
          </div>
        ),
      });
    });
    return () => {
      active = false;
    };
  }, [removedItem, removalId, undoRemove, dismissRemove, toast]);

  useEffect(
    () => () => {
      queueMicrotask(() => {
        toaster.remove(feedbackId);
        toaster.remove(removalId);
      });
    },
    [feedbackId, removalId],
  );

  return (
    <>
      <Toaster />
      {purchaseError && (
        <p
          role="alert"
          className="fixed bottom-4 right-4 z-50 max-w-md rounded border border-(--color-danger) bg-(--color-base) p-4 shadow-lg"
        >
          {purchaseError}
        </p>
      )}
    </>
  );
}
