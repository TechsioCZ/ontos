"use client";

import { useState } from "react";
import { ActionIcon } from "@techsio/ui-kit/atoms/action-icon";
import { Button } from "@techsio/ui-kit/atoms/button";
import { Icon } from "@techsio/ui-kit/atoms/icon";
import { RadioGroup } from "@techsio/ui-kit/molecules/radio-group";
import { Dialog } from "@techsio/ui-kit/molecules/dialog";
import { FormInput } from "@/components/form-controls";
import { type NamedCart } from "@/features/cart/cart-collection";
import { useCart } from "./cart-provider";
import { useDictionary } from "@/ontos/market-context";

export function CartSelector() {
  const cs = useDictionary();
  const { carts, activeCartId, selectCart, addCart, removeCart, ready } = useCart();
  const [dialog, setDialog] = useState<"create" | NamedCart | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const create = () => {
    if (!name.trim()) {
      setError(cs.checkout.selector.nameMissing);
      return;
    }
    if (
      carts.some(
        (cart) => cart.name.toLocaleLowerCase("cs-CZ") === name.trim().toLocaleLowerCase("cs-CZ"),
      )
    ) {
      setError(cs.checkout.selector.nameTaken);
      return;
    }
    addCart(name);
    setDialog(null);
  };
  return (
    <section
      data-sf-cart-selector
      className="@container/cart-selector rounded-sm bg-base p-(--sf-checkout-panel-padding)"
      aria-labelledby="cart-selector-title"
    >
      <h2
        id="cart-selector-title"
        className="mb-(--dimension-32) flex items-center gap-(--dimension-16) text-(length:--sf-checkout-heading-size) leading-(--sf-checkout-heading-leading) font-medium"
      >
        <span className="flex size-(--dimension-45) shrink-0 items-center justify-center text-(length:--sf-checkout-cart-glyph-size)">
          <Icon icon="token-icon-sf-checkout-cart" size="current" />
        </span>
        {cs.checkout.selector.title}
      </h2>
      <RadioGroup
        name="active-cart"
        value={activeCartId}
        onValueChange={(value) => {
          if (value) selectCart(value);
        }}
        size="sm"
      >
        <RadioGroup.Label className="sr-only">{cs.checkout.selector.active}</RadioGroup.Label>
        <RadioGroup.ItemGroup>
          {carts.map((cart) => (
            <div
              key={cart.id}
              className="flex min-w-0 items-center justify-between gap-(--dimension-8)"
            >
              <RadioGroup.Item value={cart.id} className="min-w-0 flex-1">
                <RadioGroup.ItemHiddenInput />
                <RadioGroup.ItemControl />
                <RadioGroup.ItemContent>
                  <RadioGroup.ItemText className="wrap-anywhere leading-(--sf-checkout-heading-leading)! font-bold">
                    {cart.name}
                  </RadioGroup.ItemText>
                </RadioGroup.ItemContent>
              </RadioGroup.Item>
              <ActionIcon
                icon="token-icon-sf-checkout-remove"
                aria-label={cs.checkout.selector.removeAria(cart.name)}
                disabled={!ready || carts.length === 1}
                onClick={() => setDialog(cart)}
                size="md"
              />
            </div>
          ))}
        </RadioGroup.ItemGroup>
      </RadioGroup>
      <Button
        variant="secondary"
        theme="outlined"
        size="sm"
        block
        className="mt-(--dimension-32) leading-(--sf-checkout-heading-leading)"
        uppercase
        disabled={!ready}
        onClick={() => {
          setName("");
          setError("");
          setDialog("create");
        }}
      >
        {cs.checkout.selector.add}
      </Button>
      <Dialog
        customTrigger
        open={dialog !== null}
        onOpenChange={({ open }) => {
          if (!open) setDialog(null);
        }}
        size="sm"
        role={dialog === "create" ? "dialog" : "alertdialog"}
        title={dialog === "create" ? cs.checkout.selector.add : cs.checkout.selector.removeTitle}
        description={
          dialog && dialog !== "create"
            ? cs.checkout.selector.removeDescription(dialog.name)
            : undefined
        }
        actions={
          <>
            <Button variant="secondary" theme="outlined" onClick={() => setDialog(null)}>
              {cs.checkout.selector.cancel}
            </Button>
            <Button
              variant={dialog === "create" ? "primary" : "danger"}
              onClick={() => {
                if (dialog === "create") create();
                else if (dialog) {
                  removeCart(dialog.id);
                  setDialog(null);
                }
              }}
            >
              {dialog === "create" ? cs.checkout.selector.add : cs.checkout.selector.remove}
            </Button>
          </>
        }
      >
        {dialog === "create" && (
          <FormInput
            id="new-cart-name"
            label={cs.checkout.selector.name}
            required
            maxLength={80}
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setError("");
            }}
            validateStatus={error ? "error" : "default"}
            helpText={error}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                create();
              }
            }}
          />
        )}
      </Dialog>
    </section>
  );
}
