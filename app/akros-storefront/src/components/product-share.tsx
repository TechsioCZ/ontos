"use client";

import { useId, useRef, useState } from "react";
import { Button } from "@techsio/ui-kit/atoms/button";
import { Input } from "@techsio/ui-kit/atoms/input";
import { LinkButton } from "@techsio/ui-kit/atoms/link-button";
import { Popover } from "@techsio/ui-kit/molecules/popover";
import dynamic from "next/dynamic";
import { useOptionalBrand } from "@/brand/brand-context";
import { buildVariantDetailHref, buildVariantSelectionHref } from "@/lib/product-variant-links";
import { useDictionary, useStoreHref } from "@/ontos/market-context";

const VariantSelectionDialog = dynamic(() =>
  import("./variant-selection-dialog").then((module) => module.VariantSelectionDialog),
);

export function ProductShare({
  productId,
  productName,
  productSlug,
  variantId,
}: {
  productId: string;
  productName: string;
  productSlug: string;
  variantId?: string;
}) {
  const cs = useDictionary();
  const storeHref = useStoreHref();
  const brandName = useOptionalBrand()?.name;
  // The shared title names the store of this deployment (brand config), never a hard-coded brand.
  const shareTitle = brandName ? `${productName} | ${brandName}` : productName;
  const [open, setOpen] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [selection, setSelection] = useState<string[]>([]);
  const [url, setUrl] = useState("");
  const [message, setMessage] = useState("");
  const [manual, setManual] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const fallbackPending = useRef(false);
  const id = useId();
  async function share(ids: string[]) {
    // Shared links stay in the current market (`/sk/produkt/…`).
    const canonical = new URL(
      storeHref(
        variantId
          ? buildVariantDetailHref(productSlug, variantId)
          : buildVariantSelectionHref(productSlug, ids),
      ),
      window.location.origin,
    ).href;
    setUrl(canonical);
    setMessage("");
    setManual(false);
    if (navigator.share) {
      try {
        await navigator.share({ title: shareTitle, url: canonical });
        return false;
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          Error.prototype.isPrototypeOf(error) &&
          "name" in error &&
          error.name === "AbortError"
        )
          return false;
      }
    }
    return true;
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setMessage(cs.productActions.linkCopied);
      setManual(false);
    } catch {
      setManual(true);
      setMessage(cs.productActions.copyUnavailable);
    }
  }
  return (
    <Popover
      open={open}
      onOpenChange={({ open: next }) => {
        setOpen(next);
        if (!next) trigger.current?.focus();
      }}
      ids={{ trigger: `${id}-trigger`, content: `${id}-content` }}
      placement="bottom-start"
      size="md"
      portalled={!variantId}
    >
      <Popover.Anchor className="inline-flex">
        <Button
          ref={trigger}
          id={`${id}-trigger`}
          aria-haspopup="dialog"
          aria-expanded={open || selecting}
          aria-controls={open ? `${id}-content` : undefined}
          className="sf-product-actions__share hover:underline focus-visible:underline"
          icon="token-icon-sf-product-share"
          iconSize="sm"
          size="sm"
          theme="borderless"
          variant="secondary"
          onClick={async () => {
            setOpen(false);
            if (variantId) setOpen(await share([variantId]));
            else setSelecting(true);
          }}
        >
          {cs.productActions.share}
        </Button>
      </Popover.Anchor>
      <Popover.Positioner className="sf-share-positioner">
        <Popover.Content className="sf-share-content">
          <Popover.Title>
            {variantId ? cs.productActions.shareVariant : cs.productActions.shareSelection}
          </Popover.Title>
          <Button size="md" variant="secondary" theme="outlined" onClick={copy}>
            {cs.productActions.copyLink}
          </Button>
          <LinkButton
            size="md"
            variant="secondary"
            theme="outlined"
            href={`mailto:?subject=${encodeURIComponent(shareTitle)}&body=${encodeURIComponent(url)}`}
          >
            {cs.productActions.email}
          </LinkButton>
          {message && <output>{message}</output>}
          {manual && (
            <Input
              aria-label={cs.productActions.linkToCopy}
              readOnly
              value={url}
              onFocus={(event) => event.currentTarget.select()}
              size="md"
            />
          )}
          <Button
            size="sm"
            variant="secondary"
            theme="borderless"
            onClick={() => {
              setOpen(false);
              trigger.current?.focus();
            }}
          >
            {cs.productActions.close}
          </Button>
        </Popover.Content>
      </Popover.Positioner>
      {selecting && (
        <VariantSelectionDialog
          productId={productId}
          productName={productName}
          slug={productSlug}
          title={cs.productActions.shareVariants}
          confirmLabel={cs.productActions.shareSelection}
          initialSelection={selection}
          finalFocusEl={() => trigger.current}
          onClose={() => {
            setSelecting(false);
            if (fallbackPending.current) {
              fallbackPending.current = false;
              // Wait for the chooser's focus trap to restore focus before opening the popover.
              requestAnimationFrame(() => requestAnimationFrame(() => setOpen(true)));
            }
          }}
          onConfirm={async (selected, catalog) => {
            setSelection(selected.map((item) => item.id));
            fallbackPending.current = await share(
              catalog.product.hasVariants ? selected.map((item) => item.id) : [],
            );
          }}
        />
      )}
    </Popover>
  );
}
