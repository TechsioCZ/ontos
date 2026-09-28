"use client";

import { useMemo, useState } from "react";
import { Button } from "@techsio/ui-kit/atoms/button";
import { NumericInput } from "@techsio/ui-kit/atoms/numeric-input";
import { FormCheckbox } from "@techsio/ui-kit/molecules/form-checkbox";
import { SearchForm } from "@techsio/ui-kit/molecules/search-form";
import { Table } from "@techsio/ui-kit/organisms/table";

import { useCart } from "@/features/cart/cart-provider";
import { cs } from "@/i18n/cs";
import { formatPrice } from "@/lib/format";
import type { CatalogProductVariant } from "@/mock-storefront/types";

interface ProductPurchaseFormProps {
  productId: string;
  variants?: CatalogProductVariant[];
}

const normalizeSearchTerm = (value: string) =>
  value
    .normalize("NFD")
    .replaceAll(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("cs-CZ")
    .trim();

export function ProductPurchaseForm({ productId, variants }: ProductPurchaseFormProps) {
  const { dispatch } = useCart();
  const [searchTerm, setSearchTerm] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [quantity, setQuantity] = useState(1);
  const normalizedSearchTerm = normalizeSearchTerm(searchTerm);
  const visibleVariants = useMemo(
    () =>
      normalizedSearchTerm
        ? (variants ?? []).filter((variant) =>
            normalizeSearchTerm(variant.label).includes(normalizedSearchTerm),
          )
        : (variants ?? []),
    [normalizedSearchTerm, variants],
  );

  const addVariant = (variant: CatalogProductVariant, quantity: number) => {
    dispatch({ type: "add", productId, variantId: variant.id, quantity });
    setConfirmation(`${variant.label} bylo přidáno do košíku.`);
  };

  if (!variants?.length) {
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

  return (
    <div className="akros-variant-purchase">
      <SearchForm
        aria-label="Vyhledání variant"
        className="akros-variant-purchase__search"
        gapped
        onValueChange={setSearchTerm}
        size="md"
      >
        <SearchForm.Control>
          <SearchForm.Input placeholder="Hledané slovo" />
          <SearchForm.Button>Hledat</SearchForm.Button>
        </SearchForm.Control>
      </SearchForm>

      <div className="akros-variant-purchase__consents">
        <FormCheckbox defaultChecked label="Souhlasím s obchodními podmínkami" size="sm" />
        <FormCheckbox
          helpText="Zaškrtnutím tohoto políčka souhlasíte s obchodními podmínkami"
          label="Souhlasím s obchodními podmínkami"
          size="sm"
        />
      </div>

      {visibleVariants.length > 0 ? (
        <div className="akros-variant-purchase__table-wrap">
          <Table aria-label="Varianty produktu" size="sm" variant="line">
            <Table.Header className="akros-visually-hidden">
              <Table.Row>
                <Table.ColumnHeader>Rozměr</Table.ColumnHeader>
                <Table.ColumnHeader>Balení</Table.ColumnHeader>
                <Table.ColumnHeader>Cena</Table.ColumnHeader>
                <Table.ColumnHeader>Nákup</Table.ColumnHeader>
                <Table.ColumnHeader>Celé balení</Table.ColumnHeader>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {visibleVariants.map((variant) => (
                <Table.Row key={variant.id}>
                  <Table.Cell data-label="Rozměr">{variant.label}</Table.Cell>
                  <Table.Cell data-label="Balení">
                    {variant.packageQuantity.toLocaleString("cs-CZ")} ks
                  </Table.Cell>
                  <Table.Cell data-label="Cena">{formatPrice(variant.priceMinor)}</Table.Cell>
                  <Table.Cell data-label="Nákup">
                    <Button
                      aria-label={`Koupit ${variant.label}`}
                      onClick={() => addVariant(variant, 1)}
                      size="sm"
                      theme="borderless"
                      variant="primary"
                    >
                      Koupit
                    </Button>
                  </Table.Cell>
                  <Table.Cell data-label="Celé balení">
                    <Button
                      aria-label={`Koupit celé balení ${variant.label}`}
                      onClick={() => addVariant(variant, variant.packageQuantity)}
                      size="sm"
                      theme="borderless"
                      variant="primary"
                    >
                      Koupit celé balení ({variant.packageQuantity.toLocaleString("cs-CZ")} ks)
                    </Button>
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        </div>
      ) : (
        <p className="akros-variant-purchase__empty">Pro zadaný výraz nebyla nalezena varianta.</p>
      )}

      <p aria-live="polite" className="akros-visually-hidden">
        {confirmation}
      </p>
    </div>
  );
}
