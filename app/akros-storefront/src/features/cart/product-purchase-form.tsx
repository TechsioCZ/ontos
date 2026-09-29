"use client";

import { useMemo, useState } from "react";
import { Button } from "@techsio/ui-kit/atoms/button";
import { NumericInput } from "@techsio/ui-kit/atoms/numeric-input";
import { FormCheckbox } from "@techsio/ui-kit/molecules/form-checkbox";
import { Pagination } from "@techsio/ui-kit/molecules/pagination";
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

const variantsPerPage = 5;
const variantCollator = new Intl.Collator("cs-CZ", { numeric: true, sensitivity: "base" });

const normalizeSearchTerm = (value: string) =>
  value
    .normalize("NFD")
    .replaceAll(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("cs-CZ")
    .trim();

const formatVariantLabel = (variant: CatalogProductVariant) => {
  const dimension = variant.label.match(/\bM\s*(\d+(?:[.,]\d+)?)\s*[x×]\s*(\d+(?:[.,]\d+)?)/i);
  if (!dimension) return variant.label;

  return `M ${dimension[1]} × ${dimension[2]}`;
};

export function ProductPurchaseForm({ product, variants }: ProductPurchaseFormProps) {
  const { dispatch } = useCart();
  const [searchTerm, setSearchTerm] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [quantity, setQuantity] = useState(product.minimumQuantity);
  const [page, setPage] = useState(1);
  const [inStockOnly, setInStockOnly] = useState(true);
  const [packageOnly, setPackageOnly] = useState(false);
  const normalizedSearchTerm = normalizeSearchTerm(searchTerm);
  const visibleVariants = useMemo(
    () =>
      (variants ?? [])
        .filter((variant) => {
          const matchesSearch = normalizedSearchTerm
            ? normalizeSearchTerm(`${variant.label} ${variant.sku}`).includes(normalizedSearchTerm)
            : true;
          const matchesStock = !inStockOnly || variant.stockCount >= variant.minimumQuantity;
          const packageQuantity = variant.packageQuantity ?? variant.minimumQuantity;
          const matchesPackage = !packageOnly || packageQuantity > variant.minimumQuantity;

          return matchesSearch && matchesStock && matchesPackage;
        })
        .sort((left, right) =>
          variantCollator.compare(formatVariantLabel(left), formatVariantLabel(right)),
        ),
    [inStockOnly, normalizedSearchTerm, packageOnly, variants],
  );
  const paginatedVariants = visibleVariants.slice(
    (page - 1) * variantsPerPage,
    page * variantsPerPage,
  );

  const addVariant = (variant: CatalogProductVariant, selectedQuantity: number) => {
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
        variantLabel: formatVariantLabel(variant),
      },
      quantity: selectedQuantity,
    });
    setConfirmation(`${formatVariantLabel(variant)} bylo přidáno do košíku.`);
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

  const updateSearch = (value: string) => {
    setSearchTerm(value);
    setPage(1);
  };

  return (
    <div className="akros-variant-purchase">
      <section className="akros-product-detail__surface akros-variant-purchase__controls">
        <h2>Vyhledání variant</h2>
        <SearchForm
          aria-label="Vyhledání variant"
          className="akros-variant-purchase__search"
          gapped
          onSubmit={(event) => event.preventDefault()}
          onValueChange={updateSearch}
          size="lg"
          value={searchTerm}
        >
          <SearchForm.Control>
            <SearchForm.Input placeholder="Hledané slovo" />
            <SearchForm.Button>Hledat</SearchForm.Button>
          </SearchForm.Control>
        </SearchForm>
        <div className="akros-variant-purchase__filters">
          <FormCheckbox
            checked={inStockOnly}
            label="Pouze varianty skladem"
            onCheckedChange={(checked) => {
              setInStockOnly(checked);
              setPage(1);
            }}
            size="md"
          />
          <FormCheckbox
            checked={packageOnly}
            label="Pouze varianty s celým balením"
            onCheckedChange={(checked) => {
              setPackageOnly(checked);
              setPage(1);
            }}
            size="md"
          />
        </div>
      </section>

      {paginatedVariants.length > 0 ? (
        <>
          <div className="akros-variant-purchase__table-wrap">
            <Table aria-label="Varianty produktu" size="sm" variant="line">
              <Table.Header className="akros-visually-hidden">
                <Table.Row>
                  <Table.ColumnHeader>Rozměr</Table.ColumnHeader>
                  <Table.ColumnHeader>Balení</Table.ColumnHeader>
                  <Table.ColumnHeader>Cena</Table.ColumnHeader>
                  <Table.ColumnHeader>Koupit minimum</Table.ColumnHeader>
                  <Table.ColumnHeader>Koupit celé balení</Table.ColumnHeader>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {paginatedVariants.map((variant) => {
                  const label = formatVariantLabel(variant);
                  const packageQuantity = variant.packageQuantity ?? variant.minimumQuantity;
                  const hasSeparatePackage = packageQuantity > variant.minimumQuantity;

                  return (
                    <Table.Row key={variant.id}>
                      <Table.Cell data-label="Rozměr">{label}</Table.Cell>
                      <Table.Cell data-label="Balení">
                        {packageQuantity.toLocaleString("cs-CZ")} {variant.unit}
                      </Table.Cell>
                      <Table.Cell data-label="Cena">{formatPrice(variant.priceMinor)}</Table.Cell>
                      <Table.Cell data-label="Koupit minimum">
                        <Button
                          aria-label={`Koupit ${label}`}
                          disabled={
                            variant.stockCount < variant.minimumQuantity || variant.priceMinor <= 0
                          }
                          onClick={() => addVariant(variant, variant.minimumQuantity)}
                          size="sm"
                          variant="primary"
                        >
                          Koupit
                        </Button>
                      </Table.Cell>
                      <Table.Cell data-label="Koupit celé balení">
                        {hasSeparatePackage ? (
                          <Button
                            aria-label={`Koupit celé balení ${label}`}
                            disabled={
                              variant.stockCount < packageQuantity || variant.priceMinor <= 0
                            }
                            onClick={() => addVariant(variant, packageQuantity)}
                            size="sm"
                            variant="primary"
                          >
                            Koupit celé balení ({packageQuantity.toLocaleString("cs-CZ")}{" "}
                            {variant.unit})
                          </Button>
                        ) : (
                          <span aria-hidden="true">—</span>
                        )}
                      </Table.Cell>
                    </Table.Row>
                  );
                })}
              </Table.Body>
            </Table>
          </div>
          {visibleVariants.length > variantsPerPage && (
            <Pagination
              aria-label="Stránkování variant"
              className="akros-pagination"
              count={visibleVariants.length}
              getPageUrl={() => "#product-variants"}
              onChange={setPage}
              page={page}
              pageSize={variantsPerPage}
              showPrevNext
              size="md"
              variant="filled"
            />
          )}
        </>
      ) : (
        <p className="akros-variant-purchase__empty">Pro zadané filtry nebyla nalezena varianta.</p>
      )}

      <p aria-live="polite" className="akros-visually-hidden">
        {confirmation}
      </p>
    </div>
  );
}
