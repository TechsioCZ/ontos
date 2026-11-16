"use client";
import { useState } from "react";
import { Button } from "@techsio/ui-kit/atoms/button";
import { NumericInput } from "@techsio/ui-kit/atoms/numeric-input";
import { StatusText } from "@techsio/ui-kit/atoms/status-text";
import { useToast } from "@techsio/ui-kit/molecules/toast";
import type { Dictionary } from "@/i18n";
import type { ProductDetailModel } from "@/ontos/catalog-model";
import type { selectProductDetail } from "./product-selection";
import { useCart } from "./cart-provider";
import { cartQuantityStep, validCartQuantity } from "./cart-state";

const purchaseGuidance = (d: Dictionary, purchasable: boolean, soldOut: boolean) =>
  purchasable || soldOut ? null : d.commerceUnavailable;

const canPurchaseSelection = (
  { current, selectionRequired }: ReturnType<typeof selectProductDetail>,
  cart: ReturnType<typeof useCart>,
) =>
  !selectionRequired &&
  current.priceMinor !== null &&
  (current.stock === "available" || current.stock === "limited") &&
  cart?.scope?.currency === current.currency &&
  cart.loaded &&
  !cart.error;

export const ProductPurchase = ({
  dictionary: d,
  locale,
  product,
  selection,
}: {
  dictionary: Dictionary;
  locale: string;
  product: ProductDetailModel;
  selection: ReturnType<typeof selectProductDetail>;
}) => {
  const { current, images, selectionRequired, variant } = selection;
  const cart = useCart();
  const toaster = useToast();
  const selectionKey = JSON.stringify([product.id, variant?.id ?? null]);
  const [draft, setDraft] = useState({ key: selectionKey, value: String(current.minimumQuantity) });
  const quantity = draft.key === selectionKey ? draft.value : String(current.minimumQuantity);
  const parsedQuantity = Number(quantity);
  const invalidQuantity = !validCartQuantity(
    parsedQuantity,
    current.minimumQuantity,
    current.packageQuantity,
  );
  const purchasable = canPurchaseSelection(selection, cart);
  const showQuantityError = purchasable && invalidQuantity;
  const purchaseDisabled = !purchasable || invalidQuantity;
  const guidance = purchaseGuidance(d, purchasable, current.stock === "unavailable");
  const guidanceId = guidance === null ? undefined : "purchase-unavailable";
  const addToCart = () => {
    if (!purchasable || invalidQuantity || current.priceMinor === null || cart === null) {
      return;
    }
    const entry = {
      expectedUnitPriceMinor: current.priceMinor,
      image: images[0] ?? null,
      minimumQuantity: current.minimumQuantity,
      name: product.name,
      packageQuantity: current.packageQuantity ?? null,
      productId: product.id,
      quantity: parsedQuantity,
      sku: current.sku,
      slug: product.slug,
      unit: current.unit,
      variantName: variant?.name ?? "",
    };
    const added =
      variant === undefined ? cart.add(entry) : cart.add({ ...entry, variantId: variant.id });
    if (added) {
      setDraft({ key: selectionKey, value: String(current.minimumQuantity) });
    }
    toaster.create({
      description: added ? `${parsedQuantity} × ${product.name}` : undefined,
      duration: 10_000,
      title: added ? d.shopping.added : d.shopping.addFailed,
      type: added ? "success" : "error",
    });
  };
  if (selectionRequired) {
    return (
      <Button density="compact" disabled size="md" theme="solid" variant="secondary">
        {d.selectVariantAction}
      </Button>
    );
  }
  return (
    <div>
      <div className="n1-product-quantity-desktop flex flex-wrap items-center gap-2">
        <div className="w-26 shrink-0 pointer-coarse:w-40">
          <NumericInput
            allowOverflow={false}
            clampValueOnBlur={false}
            density="compact"
            disabled={!purchasable}
            formatOptions={{ maximumFractionDigits: 20, useGrouping: false }}
            invalid={showQuantityError}
            locale={locale}
            max={1_000_000}
            min={current.minimumQuantity}
            onValueChange={({ value }) => setDraft({ key: selectionKey, value })}
            size="md"
            step={cartQuantityStep(current.packageQuantity)}
            value={quantity}
          >
            <NumericInput.Control>
              <NumericInput.DecrementTrigger
                aria-label={d.shopping.decreaseQuantity}
                icon="token-icon-minus"
                iconSize="sm"
              />
              <NumericInput.Input
                aria-describedby={
                  guidanceId === undefined
                    ? "purchase-quantity-error"
                    : `${guidanceId} purchase-quantity-error`
                }
                aria-label={`${d.quantity} (${current.unit})`}
              />
              <NumericInput.IncrementTrigger
                aria-label={d.shopping.increaseQuantity}
                icon="token-icon-plus"
                iconSize="sm"
              />
            </NumericInput.Control>
          </NumericInput>
        </div>
        <Button
          aria-describedby={guidanceId}
          density="compact"
          disabled={purchaseDisabled}
          onClick={addToCart}
          size="md"
          theme="solid"
          variant="secondary"
        >
          {current.stock === "unavailable" ? d.stock.unavailable : d.addToCartDetail}
        </Button>
      </div>
      <div id="purchase-quantity-error">
        {showQuantityError && <StatusText status="error">{d.shopping.invalidQuantity}</StatusText>}
      </div>
      {guidance !== null && (
        <p className="mt-2 text-sm text-fg-secondary" id="purchase-unavailable">
          {guidance}
        </p>
      )}
    </div>
  );
};
