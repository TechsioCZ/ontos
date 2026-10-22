"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ActionIcon } from "@techsio/ui-kit/atoms/action-icon";
import { Button } from "@techsio/ui-kit/atoms/button";
import { AvailabilityStatus } from "@techsio/ui-kit/molecules/availability-status";
import { Dialog } from "@techsio/ui-kit/molecules/dialog";
import { ProductPurchaseForm } from "@/features/cart/product-purchase-form";
import { FavoriteButton } from "@/features/favorites/favorite-button";
import { buildVariantDetailHref } from "@/lib/product-variant-links";
import { formatPrice, formatWeight } from "@/lib/format";
import { getProductDescriptionParagraphs } from "@/lib/product-description";
import type { CatalogProduct } from "@/mock-storefront/types";
import { ProductShare } from "./product-share";
import { ProductVariantActions } from "./product-variant-actions";
import { ProductVariantImage } from "./product-variant-image";

const subscribeToMount = () => () => {};
const clientMounted = () => true;
const serverMounted = () => false;

export function ProductVariantDetail({ product }: { product: CatalogProduct }) {
  const router = useRouter();
  const search = useSearchParams();
  // The kit's portalled Dialog assigns different useId positions during SSR.
  const mounted = useSyncExternalStore(subscribeToMount, clientMounted, serverMounted);
  const id = search.get("variantDetail");
  // A direct URL/reload has no prior list entry to return to.
  const fromList = useRef(!id);
  const heading = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!id) fromList.current = true;
  }, [id]);
  if (!mounted || !id) return null;
  const variant = product.detail.variants.find((item) => item.id === id);
  function close() {
    if (fromList.current) router.back();
    else
      router.replace(buildVariantDetailHref(product.slug, null, search.toString()), {
        scroll: false,
      });
  }
  const common = { productId: product.id, productName: product.name, productSlug: product.slug };
  const variantDescription = getProductDescriptionParagraphs(
    variant?.description ? [variant.description] : [],
  );
  const description =
    variantDescription.length > 0
      ? variantDescription
      : getProductDescriptionParagraphs(product.detail.descriptionParagraphs);
  return (
    <Dialog
      open
      customTrigger
      hideCloseButton
      size="xl"
      placement="center"
      className="akros-variant-detail"
      closeOnInteractOutside={false}
      onOpenChange={({ open }) => {
        if (!open) close();
      }}
      initialFocusEl={() => heading.current}
      finalFocusEl={() =>
        document.querySelector<HTMLElement>(`[data-variant-detail-link="${CSS.escape(id)}"]`) ??
        document.getElementById("product-variants")
      }
      title={
        <span ref={heading} tabIndex={-1} className="akros-variant-detail__title">
          {variant?.label ?? "Varianta není dostupná"}
        </span>
      }
      actions={
        <Button size="md" theme="outlined" variant="secondary" onClick={close}>
          Zavřít
        </Button>
      }
    >
      <ActionIcon
        className="akros-variant-detail__close"
        icon="token-icon-close"
        size="md"
        aria-label="Zavřít detail varianty"
        onClick={close}
      />
      {variant ? (
        <div className="akros-variant-detail__body">
          <ProductVariantImage
            key={variant.id}
            src={variant.imageSrc}
            fallback={product.imageSrc}
            alt={variant.label}
          />
          <div className="akros-variant-detail__info">
            <p>{product.name}</p>
            <dl className="akros-variant-detail__parameters">
              <div>
                <dt>Kód varianty</dt>
                <dd data-variant-detail-sku>{variant.sku}</dd>
              </div>
              <div>
                <dt>Měrná jednotka</dt>
                <dd>{variant.unit}</dd>
              </div>
              <div>
                <dt>Minimální odběr</dt>
                <dd>
                  {variant.minimumQuantity.toLocaleString("cs-CZ")} {variant.unit}
                </dd>
              </div>
              {variant.packageQuantity && (
                <div>
                  <dt>Balení</dt>
                  <dd>
                    {variant.packageQuantity.toLocaleString("cs-CZ")} {variant.unit}
                  </dd>
                </div>
              )}
              <div>
                <dt>Hmotnost</dt>
                <dd>{formatWeight(variant.sourceNetWeight) ?? "Neuvedena"}</dd>
              </div>
              {variant.parameters.map((parameter) => (
                <div key={`${parameter.label}-${parameter.value}`}>
                  <dt>{parameter.label}</dt>
                  <dd>
                    {parameter.value} {parameter.unit}
                  </dd>
                </div>
              ))}
            </dl>
            <AvailabilityStatus
              status={variant.stockCount >= variant.minimumQuantity ? "available" : "unavailable"}
              label={variant.stockCount >= variant.minimumQuantity ? "Skladem" : "Není skladem"}
            />
            <div className="akros-variant-detail__price">
              <strong>
                {formatPrice(variant.priceMinor, product.currency)} / {variant.unit}
              </strong>
              {variant.priceTiers[0] && (
                <span>
                  {formatPrice(variant.priceTiers[0].priceExcludingVatMinor, product.currency)} bez
                  DPH
                </span>
              )}
            </div>
            <ProductPurchaseForm key={variant.id} product={product} variant={variant} />
            <div
              className="akros-product-actions flex flex-wrap gap-x-(--akros-product-actions-column-gap) gap-y-(--dimension-8)"
              aria-label="Akce varianty"
            >
              <FavoriteButton {...common} variantId={variant.id} placement="action" />
              <ProductVariantActions {...common} variantId={variant.id} />
              <ProductShare {...common} productName={variant.label} variantId={variant.id} />
            </div>
            <p className="akros-variant-detail__note">
              Oblíbené a hlídání se v této ukázce ukládají jen v tomto prohlížeči.
            </p>
          </div>
          <section className="akros-variant-detail__description" aria-label="Popis varianty">
            <h3>{variantDescription.length > 0 ? "Popis varianty" : "Společný popis produktu"}</h3>
            {description.length > 0 ? (
              description.map((paragraph) => <p key={paragraph}>{paragraph}</p>)
            ) : (
              <p>Popis není k dispozici.</p>
            )}
          </section>
        </div>
      ) : (
        <p role="alert">Požadovaná varianta již není v katalogu tohoto produktu.</p>
      )}
    </Dialog>
  );
}
