"use client";

import NextLink from "next/link";
import { useEffect, useRef, useState } from "react";
import type { FocusEvent, PointerEvent } from "react";
import { Effect, Exit, Schema } from "effect";
import { LinkButton } from "@techsio/ui-kit/atoms/link-button";
import { Popover } from "@techsio/ui-kit/molecules/popover";
import type { ProductCardModel } from "@/ontos/catalog-model";
import type { CardVariantsResult } from "@/ontos/card-variants";
import { loadCardVariants } from "@/ontos/card-variants-client";
import { clientRuntime } from "@/ontos/client-runtime";
import { makeCardVariantIntent } from "./card-variant-intent";

/** Figma214:3250 preview; historical N1 hover/focus expansion uses native Popover. */
export const CardVariants = ({
  locale,
  product,
}: {
  locale: string;
  product: ProductCardModel;
}) => {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [expanded, setExpanded] = useState<Extract<CardVariantsResult, { state: "ready" }> | null>(
    null,
  );
  const anchor = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const intent = useRef<ReturnType<typeof makeCardVariantIntent> | null>(null);
  const nativeRestoreFocus = useRef(true);
  const loading = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimeout(closeTimer.current);
    };
  }, []);
  const preview = product.variantPreview ?? [];
  const remaining = Math.max(0, (product.variantCount ?? 0) - preview.length);
  const href = `/${locale}/produkt/${encodeURIComponent(product.slug)}`;
  const cancelClose = () => clearTimeout(closeTimer.current);
  const expansionIntent = () => {
    if (intent.current !== null) {
      return intent.current;
    }
    const initialIntent = makeCardVariantIntent();
    intent.current = initialIntent;
    return initialIntent;
  };
  const close = (restoreFocus = true) => {
    expansionIntent().dismiss(restoreFocus);
    setOpen(false);
  };
  const requestExpansion = (source: "activation" | "focus" | "pointer") => {
    cancelClose();
    if (!expansionIntent().request(source)) {
      return;
    }
    if (
      loading.current ||
      remaining === 0 ||
      preview.length === 0 ||
      (locale !== "cs" && locale !== "en")
    ) {
      return;
    }
    loading.current = true;
    setOpen(false);
    setPending(true);
    const fiber = clientRuntime.runFork(
      loadCardVariants({
        locale,
        productId: product.id,
        slug: product.slug,
      }).pipe(
        Effect.match({
          onFailure: (): CardVariantsResult => ({ state: "unavailable" }),
          onSuccess: (result) => result,
        }),
      ),
    );
    fiber.addObserver((exit) => {
      loading.current = false;
      if (!mounted.current) {
        return;
      }
      setPending(false);
      if (
        Exit.isSuccess(exit) &&
        exit.value.state === "ready" &&
        exit.value.variants.length > preview.length
      ) {
        setExpanded(exit.value);
        setOpen(expansionIntent().isActive());
      }
    });
  };
  const containsTarget = (target: EventTarget | null) =>
    Schema.is(Schema.instanceOf(Node))(target) &&
    [anchor.current, content.current].some(
      (element) => element !== null && element.contains(target),
    );
  const leave = (event: PointerEvent<HTMLDivElement>) => {
    if (containsTarget(event.relatedTarget)) {
      return;
    }
    closeTimer.current = setTimeout(() => {
      if (!containsTarget(document.activeElement)) {
        close();
      }
    }, 150);
  };
  const blur = (event: FocusEvent<HTMLDivElement>) => {
    if (!containsTarget(event.relatedTarget)) {
      // Let the Popover's focus-outside policy retain the customer's Tab destination.
      // Pending reads have no mounted Popover layer, so their expansion intent ends here too.
      expansionIntent().leave();
    }
  };
  const links = (variants: readonly { id: string; name: string }[]) =>
    variants.map((variant) => (
      <LinkButton
        as={NextLink}
        density="compact"
        href={href}
        key={variant.id}
        prefetch={false}
        size="sm"
        theme="outlined"
        variant="tertiary"
      >
        {variant.name}
      </LinkButton>
    ));
  return (
    <Popover
      autoFocus={false}
      gutter={0}
      offset={{ crossAxis: 0, mainAxis: 0 }}
      onEscapeKeyDown={() => {
        nativeRestoreFocus.current = true;
      }}
      onInteractOutside={(event) => {
        nativeRestoreFocus.current = !(event.detail.focusable || event.detail.contextmenu);
      }}
      onOpenChange={({ open: next }) => {
        if (next) {
          requestExpansion("activation");
        } else {
          close(nativeRestoreFocus.current);
          nativeRestoreFocus.current = true;
        }
      }}
      open={open}
      placement="top"
      size="sm"
    >
      <Popover.Anchor
        onBlur={blur}
        onFocus={() => requestExpansion("focus")}
        onPointerEnter={() => requestExpansion("pointer")}
        onPointerLeave={leave}
        ref={anchor}
      >
        <div
          aria-busy={pending}
          className="flex min-h-7 flex-wrap items-center justify-center gap-1"
        >
          {links(preview)}
          {preview.length > 0 && remaining > 0 && (
            <Popover.Trigger
              aria-label={`${product.name} +${remaining}`}
              clickBehavior="manual"
              onClick={() => {
                if (open) {
                  close();
                } else {
                  requestExpansion("activation");
                }
              }}
              size="current"
              theme="unstyled"
              variant="tertiary"
            >
              <span className="text-xs font-normal text-fg-secondary">+{remaining}</span>
            </Popover.Trigger>
          )}
        </div>
      </Popover.Anchor>
      <Popover.Positioner>
        <Popover.Content
          aria-label={product.name}
          onBlur={blur}
          onFocus={cancelClose}
          onPointerEnter={cancelClose}
          onPointerLeave={leave}
          ref={content}
        >
          <div className="flex max-w-n1-product-image flex-wrap items-center justify-center gap-1">
            {expanded !== null && links(expanded.variants)}
          </div>
        </Popover.Content>
      </Popover.Positioner>
    </Popover>
  );
};
