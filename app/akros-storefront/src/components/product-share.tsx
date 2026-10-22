"use client";

import { useId, useRef, useState } from "react";
import { Button } from "@techsio/ui-kit/atoms/button";
import { Input } from "@techsio/ui-kit/atoms/input";
import { LinkButton } from "@techsio/ui-kit/atoms/link-button";
import { Popover } from "@techsio/ui-kit/molecules/popover";
import dynamic from "next/dynamic";
import { buildVariantDetailHref, buildVariantSelectionHref } from "@/lib/product-variant-links";

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
    const canonical = new URL(
      variantId
        ? buildVariantDetailHref(productSlug, variantId)
        : buildVariantSelectionHref(productSlug, ids),
      window.location.origin,
    ).href;
    setUrl(canonical);
    setMessage("");
    setManual(false);
    if (navigator.share) {
      try {
        await navigator.share({ title: productName, url: canonical });
        return false;
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") return false;
      }
    }
    return true;
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setMessage("Odkaz zkopírován.");
      setManual(false);
    } catch {
      setManual(true);
      setMessage("Kopírování není dostupné. Zkopírujte odkaz z pole níže.");
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
          className="akros-product-actions__share hover:underline focus-visible:underline"
          icon="token-icon-akros-product-share"
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
          Sdílet
        </Button>
      </Popover.Anchor>
      <Popover.Positioner className="akros-share-positioner">
        <Popover.Content className="akros-share-content">
          <Popover.Title>{variantId ? "Sdílet variantu" : "Sdílet výběr"}</Popover.Title>
          <Button size="md" variant="secondary" theme="outlined" onClick={copy}>
            Kopírovat odkaz
          </Button>
          <LinkButton
            size="md"
            variant="secondary"
            theme="outlined"
            href={`mailto:?subject=${encodeURIComponent(productName)}&body=${encodeURIComponent(url)}`}
          >
            E-mail
          </LinkButton>
          {message && <output>{message}</output>}
          {manual && (
            <Input
              aria-label="Odkaz ke zkopírování"
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
            Zavřít
          </Button>
        </Popover.Content>
      </Popover.Positioner>
      {selecting && (
        <VariantSelectionDialog
          productId={productId}
          productName={productName}
          slug={productSlug}
          title="Sdílet varianty"
          confirmLabel="Sdílet výběr"
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
