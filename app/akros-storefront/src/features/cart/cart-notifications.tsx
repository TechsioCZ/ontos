"use client";

import NextLink from "next/link";
import { useEffect, useId } from "react";
import { Button } from "@techsio/ui-kit/atoms/button";
import { LinkButton } from "@techsio/ui-kit/atoms/link-button";
import { Toaster, toaster } from "@techsio/ui-kit/molecules/toast";
import { formatQuantity, getMaximumOrderQuantity } from "@/mock-storefront/cart";
import { useCart } from "./cart-provider";

export function CartNotifications() {
  const owner = useId();
  const feedbackId = `akros-cart-feedback-${owner}`;
  const removalId = `akros-cart-removal-${owner}`;
  const { feedback, removedItem, undoRemove, dismissRemove } = useCart();

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
            ? "Nelze přidat další množství"
            : kind === "restored"
              ? "Položka obnovena"
              : "Přidáno do košíku",
        duration: 6000,
        description: (
          <div data-akros-cart-notification className="grid gap-3">
            <p className="wrap-anywhere">{line.variantLabel ?? line.name}</p>
            <p>
              {kind === "limited"
                ? getMaximumOrderQuantity(line) > 0
                  ? "Dostupné množství už máte v košíku."
                  : "Zkontrolujte dostupnost a minimální odběr produktu."
                : `${kind === "restored" ? "Obnoveno" : "Přidáno"} ${formatQuantity(quantity)} ${line.unit}.`}
            </p>
            {kind !== "limited" && limited && (
              <p>Skladový limit umožnil přidat jen část požadovaného množství.</p>
            )}
            <LinkButton
              as={NextLink}
              href="/kosik"
              size="sm"
              variant="primary"
              onClick={() => toaster.dismiss(feedbackId)}
            >
              Zobrazit košík
            </LinkButton>
          </div>
        ),
      });
    });
    return () => {
      active = false;
    };
  }, [feedback, feedbackId]);

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
        title: "Položka odebrána",
        // Undo remains available until explicitly dismissed or replaced by another removal.
        duration: Infinity,
        onStatusChange: ({ status, src }) => {
          if (status === "dismissing" && (src === "user" || src === "keyboard")) dismissRemove(id);
        },
        description: (
          <div data-akros-cart-notification className="grid gap-3">
            <p className="wrap-anywhere">{line.variantLabel ?? line.name}</p>
            <p>
              {formatQuantity(line.quantity)} {line.unit}
            </p>
            <Button size="sm" variant="primary" onClick={() => undoRemove(id)}>
              Obnovit
            </Button>
          </div>
        ),
      });
    });
    return () => {
      active = false;
    };
  }, [removedItem, removalId, undoRemove, dismissRemove]);

  useEffect(
    () => () => {
      queueMicrotask(() => {
        toaster.remove(feedbackId);
        toaster.remove(removalId);
      });
    },
    [feedbackId, removalId],
  );

  return <Toaster />;
}
