"use client";

import { useState } from "react";
import { ActionIcon } from "@techsio/ui-kit/atoms/action-icon";
import { Button } from "@techsio/ui-kit/atoms/button";
import { Icon } from "@techsio/ui-kit/atoms/icon";
import { RadioGroup } from "@techsio/ui-kit/molecules/radio-group";
import { Dialog } from "@techsio/ui-kit/molecules/dialog";
import { FormInput } from "@techsio/ui-kit/molecules/form-input";
import { type NamedCart } from "@/mock-storefront/cart-collection";
import { useCart } from "./cart-provider";

export function CartSelector() {
  const { carts, activeCartId, selectCart, addCart, removeCart, ready } = useCart();
  const [dialog, setDialog] = useState<"create" | NamedCart | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const create = () => {
    if (!name.trim()) {
      setError("Zadejte název košíku.");
      return;
    }
    if (
      carts.some(
        (cart) => cart.name.toLocaleLowerCase("cs-CZ") === name.trim().toLocaleLowerCase("cs-CZ"),
      )
    ) {
      setError("Košík s tímto názvem již existuje.");
      return;
    }
    addCart(name);
    setDialog(null);
  };
  return (
    <section
      data-akros-cart-selector
      className="@container/cart-selector rounded-sm bg-base p-(--akros-checkout-panel-padding)"
      aria-labelledby="cart-selector-title"
    >
      <h2
        id="cart-selector-title"
        className="mb-(--dimension-32) flex items-center gap-(--dimension-16) text-(length:--akros-checkout-heading-size) leading-(--akros-checkout-heading-leading) font-medium"
      >
        <span className="flex size-(--dimension-45) shrink-0 items-center justify-center text-(length:--akros-checkout-cart-glyph-size)">
          <Icon icon="token-icon-akros-checkout-cart" size="current" />
        </span>
        Vaše košíky
      </h2>
      <RadioGroup
        name="active-cart"
        value={activeCartId}
        onValueChange={(value) => {
          if (value) selectCart(value);
        }}
        size="sm"
      >
        <RadioGroup.Label className="sr-only">Aktivní košík</RadioGroup.Label>
        <RadioGroup.ItemGroup className="gap-(--dimension-16)">
          {carts.map((cart) => (
            <div
              key={cart.id}
              className="flex min-w-0 items-center justify-between gap-(--dimension-8)"
            >
              <RadioGroup.Item value={cart.id} className="min-w-0 flex-1">
                <RadioGroup.ItemHiddenInput />
                <RadioGroup.ItemControl />
                <RadioGroup.ItemContent>
                  <RadioGroup.ItemText className="wrap-anywhere leading-(--akros-checkout-heading-leading)! font-bold text-(length:--akros-checkout-choice-size) @max-sm/cart-selector:text-(length:--akros-checkout-choice-compact-size)">
                    {cart.name}
                  </RadioGroup.ItemText>
                </RadioGroup.ItemContent>
              </RadioGroup.Item>
              <ActionIcon
                icon="token-icon-akros-checkout-remove"
                aria-label={`Odstranit košík ${cart.name}`}
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
        className="mt-(--dimension-32) w-full leading-(--akros-checkout-heading-leading)"
        uppercase
        disabled={!ready}
        onClick={() => {
          setName("");
          setError("");
          setDialog("create");
        }}
      >
        Přidat košík
      </Button>
      <Dialog
        customTrigger
        open={dialog !== null}
        onOpenChange={({ open }) => {
          if (!open) setDialog(null);
        }}
        size="sm"
        role={dialog === "create" ? "dialog" : "alertdialog"}
        title={dialog === "create" ? "Přidat košík" : "Odstranit košík?"}
        description={
          dialog && dialog !== "create"
            ? `Košík „${dialog.name}“ a jeho položky budou odstraněny.`
            : undefined
        }
        actions={
          <>
            <Button variant="secondary" theme="outlined" onClick={() => setDialog(null)}>
              Zrušit
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
              {dialog === "create" ? "Přidat košík" : "Odstranit košík"}
            </Button>
          </>
        }
      >
        {dialog === "create" && (
          <FormInput
            id="new-cart-name"
            label="Název košíku"
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
