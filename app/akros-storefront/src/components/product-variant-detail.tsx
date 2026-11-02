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
import { formatWeight } from "@/lib/format";
import { getProductDescriptionParagraphs } from "@/lib/product-description";
import { describeVariantAvailability } from "@/lib/variant-availability";
import type { CatalogPurchaseProduct, CatalogPurchaseVariant } from "@/ontos/catalog-types";
import { useDictionary, useFormatPrice, useMoney, useStoreHref } from "@/ontos/market-context";
import { ProductShare } from "./product-share";
import { ProductVariantActions } from "./product-variant-actions";
import { ProductVariantImage } from "./product-variant-image";

const subscribeToMount = () => () => {};
const clientMounted = () => true;
const serverMounted = () => false;

/**
 * The `?variantDetail=<id>` modal of a product with several variants. `variants` is the same array the
 * variant table renders (one RSC payload copy); OntOS has no variant description, so the product's is shown.
 */
export function ProductVariantDetail({
  product,
  variants,
  descriptionParagraphs,
}: {
  product: CatalogPurchaseProduct;
  variants: readonly CatalogPurchaseVariant[];
  descriptionParagraphs: readonly string[];
}) {
  const cs = useDictionary();
  const money = useMoney();
  const formatPrice = useFormatPrice();
  const storeHref = useStoreHref();
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
  const variant = variants.find((item) => item.id === id);
  function close() {
    if (fromList.current) router.back();
    else
      router.replace(storeHref(buildVariantDetailHref(product.slug, null, search.toString())), {
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
      : getProductDescriptionParagraphs(descriptionParagraphs);
  return (
    <Dialog
      open
      customTrigger
      hideCloseButton
      size="xl"
      placement="center"
      className="sf-variant-detail"
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
        <span ref={heading} tabIndex={-1} className="sf-variant-detail__title">
          {variant?.label ?? cs.variants.detailUnavailable}
        </span>
      }
      actions={
        <Button size="md" theme="outlined" variant="secondary" onClick={close}>
          {cs.variants.close}
        </Button>
      }
    >
      <ActionIcon
        className="sf-variant-detail__close"
        icon="token-icon-close"
        size="md"
        aria-label={cs.variants.closeDetail}
        onClick={close}
      />
      {variant ? (
        <div className="sf-variant-detail__body">
          <ProductVariantImage
            key={variant.id}
            src={variant.imageSrc}
            fallback={product.imageSrc}
            alt={variant.label}
          />
          <div className="sf-variant-detail__info">
            <p>{product.name}</p>
            <dl className="sf-variant-detail__parameters">
              <div>
                <dt>{cs.variants.variantSku}</dt>
                <dd data-variant-detail-sku>{variant.sku}</dd>
              </div>
              <div>
                <dt>{cs.product.measurementUnit}</dt>
                <dd>{variant.unit}</dd>
              </div>
              <div>
                <dt>{cs.product.minimumOrder}</dt>
                <dd>
                  {variant.minimumQuantity.toLocaleString(money.locale)} {variant.unit}
                </dd>
              </div>
              {variant.packageQuantity && (
                <div>
                  <dt>{cs.variants.packaging}</dt>
                  <dd>
                    {variant.packageQuantity.toLocaleString(money.locale)} {variant.unit}
                  </dd>
                </div>
              )}
              <div>
                <dt>{cs.productPage.weight}</dt>
                <dd>
                  {formatWeight(variant.sourceNetWeight, money.locale) ?? cs.variants.weightUnknown}
                </dd>
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
            <AvailabilityStatus {...describeVariantAvailability(cs, variant)} />
            <div className="sf-variant-detail__price">
              {variant.priceUnavailableReason || variant.priceMinor <= 0 ? (
                <>
                  <strong>{cs.product.priceUnavailable}</strong>
                  <span>{variant.priceUnavailableReason ?? cs.product.noValidPrice}</span>
                </>
              ) : (
                <>
                  <strong>
                    {formatPrice(variant.priceMinor)} / {variant.unit}
                  </strong>
                  {variant.priceTiers[0] && (
                    <span>
                      {formatPrice(variant.priceTiers[0].priceExcludingVatMinor)}{" "}
                      {cs.product.excludingVat}
                    </span>
                  )}
                </>
              )}
            </div>
            <ProductPurchaseForm key={variant.id} product={product} variant={variant} />
            <div
              className="sf-product-actions flex flex-wrap gap-x-(--sf-product-actions-column-gap) gap-y-(--dimension-8)"
              aria-label={cs.variants.actions}
            >
              <FavoriteButton {...common} variantId={variant.id} placement="action" />
              <ProductVariantActions {...common} variantId={variant.id} />
              <ProductShare {...common} productName={variant.label} variantId={variant.id} />
            </div>
            <p className="sf-variant-detail__note">{cs.variants.browserOnlyNote}</p>
          </div>
          <section
            className="sf-variant-detail__description"
            aria-label={cs.variants.variantDescription}
          >
            <h3>
              {variantDescription.length > 0
                ? cs.variants.variantDescription
                : cs.variants.sharedDescription}
            </h3>
            {description.length > 0 ? (
              description.map((paragraph) => <p key={paragraph}>{paragraph}</p>)
            ) : (
              <p>{cs.productPage.descriptionUnavailable}</p>
            )}
          </section>
        </div>
      ) : (
        <p role="alert">{cs.variants.notInCatalog}</p>
      )}
    </Dialog>
  );
}
