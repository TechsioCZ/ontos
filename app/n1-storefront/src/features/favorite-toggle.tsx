"use client";

import { useRef, useState } from "react";
import { Button } from "@techsio/ui-kit/atoms/button";
import { Dialog } from "@techsio/ui-kit/molecules/dialog";
import { FormCheckbox } from "@techsio/ui-kit/molecules/form-checkbox";
import { useToast } from "@techsio/ui-kit/molecules/toast";
import type { Dictionary } from "@/i18n";
import type { ProductDetailModel } from "@/ontos/catalog-model";
import { favoriteKey, setFavorite, updateFavorites, useFavorites } from "./favorites-store";

export const FavoriteToggle = ({
  dictionary: d,
  product,
  variantId,
}: {
  dictionary: Dictionary;
  product: ProductDetailModel;
  variantId: string | undefined;
}) => {
  const { available, ready, references } = useFavorites();
  const toaster = useToast();
  const trigger = useRef<HTMLButtonElement>(null);
  const [draft, setDraft] = useState<ReadonlySet<string> | null>(null);
  const { favoriteItems: labels } = d;
  const { id: productId, slug } = product;
  const chosen =
    variantId === undefined && product.variantCount !== 0
      ? null
      : { productId, slug, variantId: variantId ?? null };
  const saved = references.some((item) =>
    chosen === null ? item.productId === productId : favoriteKey(item) === favoriteKey(chosen),
  );
  const announce = (success: boolean, label: string) =>
    toaster.create({
      title: success ? label : labels.saveFailed,
      type: success ? "success" : "error",
    });
  let actionLabel = saved ? labels.remove : d.addToFavorites;
  if (chosen === null) {
    actionLabel = labels.variants;
  }
  const change = () => {
    if (chosen !== null) {
      announce(setFavorite(chosen, !saved), saved ? labels.removed : labels.saved);
      return;
    }
    setDraft(
      new Set(
        references.flatMap((item) =>
          item.productId === productId && item.variantId !== null ? [item.variantId] : [],
        ),
      ),
    );
  };
  const saveSelection = () => {
    if (draft === null) {
      return;
    }
    const known = new Set(product.variants.map((variant) => variant.id));
    const success = updateFavorites((items) => [
      ...items.filter(
        (item) =>
          item.productId !== productId || item.variantId === null || !known.has(item.variantId),
      ),
      ...product.variants.flatMap(({ id }) =>
        draft.has(id) ? [{ productId, slug, variantId: id }] : [],
      ),
    ]);
    announce(success, labels.selectionSaved);
    if (success) {
      setDraft(null);
    }
  };
  return (
    <>
      <Button
        aria-haspopup={chosen === null ? "dialog" : undefined}
        aria-pressed={chosen === null ? undefined : saved}
        className="underline underline-offset-2"
        disabled={!ready || !available || (chosen === null && product.variants.length === 0)}
        icon={saved ? "icon-[mdi--heart]" : "icon-[mdi--heart-outline]"}
        iconSize="md"
        onClick={change}
        ref={trigger}
        severity="secondary"
        size="current"
        title={available ? undefined : labels.storageUnavailable}
        type="button"
        unstyled
      >
        {actionLabel}
      </Button>
      {chosen === null && (
        <Dialog
          actions={
            <Button onClick={saveSelection} severity="primary" type="button">
              {labels.saveSelection}
            </Button>
          }
          closeLabel={labels.close}
          customTrigger
          description={product.name}
          finalFocusEl={() => trigger.current}
          onOpenChange={({ open }) => {
            if (!open) {
              setDraft(null);
            }
          }}
          open={draft !== null}
          size="sm"
          title={labels.variants}
        >
          <div className="grid gap-3">
            {product.variants.map(({ id, name }) => (
              <FormCheckbox
                checked={draft?.has(id) ?? false}
                key={id}
                label={name}
                onCheckedChange={(checked) =>
                  setDraft((selection) => {
                    if (selection === null) {
                      return null;
                    }
                    const next = new Set(selection);
                    if (checked) {
                      next.add(id);
                    } else {
                      next.delete(id);
                    }
                    return next;
                  })
                }
              />
            ))}
          </div>
        </Dialog>
      )}
    </>
  );
};
