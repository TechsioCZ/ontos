"use client";
import { useState } from "react";
import NextLink from "next/link";
import { Button } from "@techsio/ui-kit/atoms/button";
import { LinkButton } from "@techsio/ui-kit/atoms/link-button";
import { NumericInput } from "@techsio/ui-kit/atoms/numeric-input";
import { StatusText } from "@techsio/ui-kit/atoms/status-text";
import { QuantityField } from "@techsio/ui-kit/molecules/quantity-field";
import type { Dictionary } from "@/i18n";
import type { ProductDetailModel } from "@/ontos/catalog-model";
import type { selectProductDetail } from "./product-selection";
import { useCart } from "./cart-provider";

const validPurchaseQuantity = (quantity: number, minimum: number) =>
  Number.isFinite(quantity) && quantity >= Math.max(0.001, minimum) && quantity <= 1_000_000;

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
  const selectionKey = JSON.stringify([product.id, variant?.id ?? null]);
  const [draft, setDraft] = useState({ key: selectionKey, value: String(current.minimumQuantity) });
  const [notice, setNotice] = useState<{ added: boolean; key: string } | null>(null);
  const quantity = draft.key === selectionKey ? draft.value : String(current.minimumQuantity);
  const parsedQuantity = Number(quantity);
  const invalidQuantity = !validPurchaseQuantity(parsedQuantity, current.minimumQuantity);
  const purchasable =
    !selectionRequired &&
    current.priceMinor !== null &&
    (current.stock === "available" || current.stock === "limited") &&
    cart?.scope?.currency === current.currency &&
    cart.loaded &&
    !cart.error;
  const showQuantityError = purchasable && invalidQuantity;
  const purchaseDisabled = !purchasable || invalidQuantity;
  const addToCart = () => {
    if (!purchasable || invalidQuantity || current.priceMinor === null || cart === null) {
      return;
    }
    const entry = {
      expectedUnitPriceMinor: current.priceMinor,
      image: images[0] ?? null,
      name: product.name,
      productId: product.id,
      quantity: parsedQuantity,
      sku: current.sku,
      slug: product.slug,
      unit: current.unit,
      variantName: variant?.name ?? "",
    };
    const added =
      variant === undefined ? cart.add(entry) : cart.add({ ...entry, variantId: variant.id });
    setNotice({ added, key: selectionKey });
  };
  return (
    <div>
      <div className="hidden items-center gap-2 md:flex">
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
                  aria-describedby="purchase-unavailable purchase-quantity-error"
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
          aria-describedby="purchase-unavailable"
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
          unitLabel={current.unit}
          value={quantity}
        />
        <Button
          aria-describedby="purchase-unavailable"
          block
          disabled={purchaseDisabled}
          onClick={addToCart}
          size="md"
          theme="solid"
          variant="primary"
        >
          {d.addToCartDetail}
        </Button>
      </div>
      <div className="hidden md:block" id="purchase-quantity-error">
        {showQuantityError && <StatusText status="error">{d.shopping.invalidQuantity}</StatusText>}
      </div>
      <p className="mt-2 text-sm text-fg-secondary" id="purchase-unavailable">
        {purchasable ? d.shopping.unverified : d.commerceUnavailable}
      </p>
      {notice?.key === selectionKey && (
        <div className="mt-3 flex flex-col items-start gap-2">
          <output>{notice.added ? d.shopping.added : d.shopping.addFailed}</output>
          <LinkButton
            as={NextLink}
            href={`/${locale}/kosik`}
            size="md"
            theme="outlined"
            variant="secondary"
          >
            {d.cart}
          </LinkButton>
        </div>
      )}
    </div>
  );
};
