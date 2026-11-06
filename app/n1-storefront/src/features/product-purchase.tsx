"use client";
import { useState } from "react";
import { Button } from "@techsio/ui-kit/atoms/button";
import { NumericInput } from "@techsio/ui-kit/atoms/numeric-input";
import { StatusText } from "@techsio/ui-kit/atoms/status-text";
import { QuantityField } from "@techsio/ui-kit/molecules/quantity-field";
import { useToast } from "@techsio/ui-kit/molecules/toast";
import type { Dictionary } from "@/i18n";
import type { ProductDetailModel } from "@/ontos/catalog-model";
import type { selectProductDetail } from "./product-selection";
import { useCart } from "./cart-provider";
import { validCartQuantity } from "./cart-state";

const purchaseGuidance = (d: Dictionary, purchasable: boolean) =>
  purchasable ? null : d.commerceUnavailable;

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
  const guidance = purchaseGuidance(d, purchasable);
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
      <>
        <div className="hidden md:block">
          <Button disabled size="md" theme="solid" variant="primary">
            {d.selectVariantAction}
          </Button>
        </div>
        <div className="md:hidden">
          <Button block disabled size="md" theme="solid" variant="primary">
            {d.selectVariantAction}
          </Button>
        </div>
      </>
    );
  }
  return (
    <div>
      <div className="n1-product-quantity-desktop hidden items-center gap-2 md:flex">
        <div className="w-26 shrink-0">
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
            value={quantity}
          >
            <div className="flex w-7 shrink-0">
              <NumericInput.DecrementTrigger
                aria-label={d.shopping.decreaseQuantity}
                icon="token-icon-minus"
                iconSize="sm"
              />
            </div>
            <div className="w-12 shrink-0">
              <NumericInput.Control>
                <NumericInput.Input
                  aria-describedby={
                    guidanceId === undefined
                      ? "purchase-quantity-error"
                      : `${guidanceId} purchase-quantity-error`
                  }
                  aria-label={`${d.quantity} (${current.unit})`}
                />
              </NumericInput.Control>
            </div>
            <div className="flex w-7 shrink-0">
              <NumericInput.IncrementTrigger
                aria-label={d.shopping.increaseQuantity}
                icon="token-icon-plus"
                iconSize="sm"
              />
            </div>
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
          {d.addToCartDetail}
        </Button>
      </div>
      <div className="flex flex-col gap-4 md:hidden">
        {current.stock !== "unavailable" && (
          <QuantityField
            disabled={!purchasable}
            error={showQuantityError ? d.shopping.invalidQuantity : undefined}
            helperText={`${d.minimumQuantity}: ${current.minimumQuantity} ${current.unit}`}
            label={d.quantity}
            locale={locale}
            max={1_000_000}
            min={current.minimumQuantity}
            onValueChange={({ value }) => setDraft({ key: selectionKey, value })}
            size="md"
            translations={{
              decrementLabel: d.shopping.decreaseQuantity,
              incrementLabel: d.shopping.increaseQuantity,
            }}
            unitLabel={current.unit}
            value={quantity}
          />
        )}
        <Button
          aria-describedby={guidanceId}
          block
          disabled={purchaseDisabled}
          onClick={addToCart}
          size="md"
          theme="solid"
          variant="primary"
        >
          {current.stock === "unavailable" ? d.stock.unavailable : d.addToCartDetail}
        </Button>
      </div>
      <div className="hidden md:block" id="purchase-quantity-error">
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
