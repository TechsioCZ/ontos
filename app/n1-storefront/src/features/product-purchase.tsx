"use client";
import { useState } from "react";
import NextLink from "next/link";
import { Button } from "@techsio/ui-kit/atoms/button";
import { LinkButton } from "@techsio/ui-kit/atoms/link-button";
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
      <div className="flex flex-wrap items-start gap-2">
        <div className="w-40">
          <QuantityField
            disabled={!purchasable}
            error={purchasable && invalidQuantity ? d.shopping.invalidQuantity : undefined}
            hideLabel
            label={d.quantity}
            max={1_000_000}
            min={current.minimumQuantity}
            onValueChange={({ value }) => setDraft({ key: selectionKey, value })}
            size="md"
            unitLabel={current.unit}
            value={quantity}
          />
        </div>
        <Button
          aria-describedby="purchase-unavailable"
          disabled={!purchasable || invalidQuantity}
          onClick={addToCart}
          size="md"
          theme="solid"
          variant="secondary"
        >
          {d.addToCart}
        </Button>
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
