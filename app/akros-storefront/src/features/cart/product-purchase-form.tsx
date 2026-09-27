"use client";

import { useState } from "react";
import { Button } from "@techsio/ui-kit/atoms/button";
import { NumericInput } from "@techsio/ui-kit/atoms/numeric-input";

import { useCart } from "@/features/cart/cart-provider";
import { cs } from "@/i18n/cs";

export function ProductPurchaseForm({ productId }: { productId: string }) {
  const { dispatch } = useCart();
  const [quantity, setQuantity] = useState(1);

  return (
    <div className="akros-purchase-form">
      <span className="akros-purchase-form__label">{cs.product.selectQuantity}</span>
      <NumericInput
        id={`quantity-${productId}`}
        min={1}
        onChange={(value) => setQuantity(Math.max(1, Math.trunc(value || 1)))}
        size="md"
        value={quantity}
      >
        <NumericInput.Control>
          <NumericInput.Input aria-label={cs.cart.quantity} />
          <NumericInput.TriggerContainer>
            <NumericInput.IncrementTrigger />
            <NumericInput.DecrementTrigger />
          </NumericInput.TriggerContainer>
        </NumericInput.Control>
      </NumericInput>
      <Button
        block
        onClick={() => dispatch({ type: "add", productId, quantity })}
        size="md"
        variant="primary"
      >
        {cs.actions.addToCart}
      </Button>
    </div>
  );
}
