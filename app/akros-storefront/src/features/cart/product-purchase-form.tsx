"use client";

import { useMemo, useState } from "react";
import { Button } from "@techsio/ui-kit/atoms/button";
import { NumericInput } from "@techsio/ui-kit/atoms/numeric-input";
import { SearchForm } from "@techsio/ui-kit/molecules/search-form";
import { Table } from "@techsio/ui-kit/organisms/table";

import { useCart } from "@/features/cart/cart-provider";
import { cs } from "@/i18n/cs";
import { formatPrice } from "@/lib/format";
import type { CatalogProduct, CatalogProductVariant } from "@/mock-storefront/types";

interface ProductPurchaseFormProps {
  product: CatalogProduct;
  variants?: CatalogProductVariant[];
}

const normalizeSearchTerm = (value: string) =>
  value
    .normalize("NFD")
    .replaceAll(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("cs-CZ")
    .trim();

export function ProductPurchaseForm({ product, variants }: ProductPurchaseFormProps) {
  const { dispatch } = useCart();
  const [searchTerm, setSearchTerm] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [quantity, setQuantity] = useState(product.minimumQuantity);
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
    dispatch({
      type: "add",
      item: {
        productId: product.id,
        variantId: variant.id,
        slug: product.slug,
        name: product.name,
        sku: variant.sku,
        imageSrc: variant.imageSrc ?? product.imageSrc,
        imageAlt: product.imageAlt,
        unit: variant.unit,
        stockCount: variant.stockCount,
        priceMinor: variant.priceMinor,
        variantLabel: variant.label,
      },
      quantity,
    });
    setConfirmation(`${variant.label} bylo přidáno do košíku.`);
  };

  if (!variants?.length) {
    return (
      <div className="akros-purchase-form">
        <span className="akros-purchase-form__label">{cs.product.selectQuantity}</span>
        <NumericInput
          id={`quantity-${product.id}`}
          min={product.minimumQuantity}
          onChange={(value) =>
            setQuantity(Math.max(product.minimumQuantity, Math.trunc(value || 1)))
          }
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
          disabled={product.stockCount < product.minimumQuantity || product.priceMinor <= 0}
          onClick={() =>
            dispatch({
              type: "add",
              item: {
                productId: product.id,
                slug: product.slug,
                name: product.name,
                sku: product.sku,
                imageSrc: product.imageSrc,
                imageAlt: product.imageAlt,
                unit: product.unit,
                stockCount: product.stockCount,
                priceMinor: product.priceMinor,
              },
              quantity,
            })
          }
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

      {visibleVariants.length > 0 ? (
        <div className="akros-variant-purchase__table-wrap">
          <Table aria-label="Varianty produktu" size="sm" variant="line">
            <Table.Header className="akros-visually-hidden">
              <Table.Row>
                <Table.ColumnHeader>Rozměr</Table.ColumnHeader>
                <Table.ColumnHeader>Minimum</Table.ColumnHeader>
                <Table.ColumnHeader>Cena</Table.ColumnHeader>
                <Table.ColumnHeader>Skladem</Table.ColumnHeader>
                <Table.ColumnHeader>Nákup</Table.ColumnHeader>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {visibleVariants.map((variant) => (
                <Table.Row key={variant.id}>
                  <Table.Cell data-label="Rozměr">{variant.label}</Table.Cell>
                  <Table.Cell data-label="Minimum">
                    {variant.minimumQuantity.toLocaleString("cs-CZ")} {variant.unit}
                  </Table.Cell>
                  <Table.Cell data-label="Cena">{formatPrice(variant.priceMinor)}</Table.Cell>
                  <Table.Cell data-label="Skladem">
                    {variant.stockCount.toLocaleString("cs-CZ")} {variant.unit}
                  </Table.Cell>
                  <Table.Cell data-label="Nákup">
                    <Button
                      aria-label={`Koupit ${variant.label}`}
                      disabled={
                        variant.stockCount < variant.minimumQuantity || variant.priceMinor <= 0
                      }
                      onClick={() => addVariant(variant, variant.minimumQuantity)}
                      size="sm"
                      theme="borderless"
                      variant="primary"
                    >
                      Koupit
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
