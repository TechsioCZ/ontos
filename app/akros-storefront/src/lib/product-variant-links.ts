import type { CatalogProductVariant } from "@/mock-storefront/types";

export function parseVariantIds(value: string | string[] | undefined): string[] {
  return [
    ...new Set(
      (Array.isArray(value) ? value : [value ?? ""])
        .flatMap((part) => part.split(","))
        .map((id) => id.trim())
        .filter(Boolean),
    ),
  ];
}

export function resolveVariantSelection(
  variants: CatalogProductVariant[],
  value: string | string[] | undefined,
) {
  const requested = new Set(parseVariantIds(value));
  return variants.filter((variant) => requested.has(variant.id));
}

export function buildVariantSelectionHref(slug: string, ids: string[]): string {
  const path = `/produkt/${encodeURIComponent(slug)}`;
  const unique = [...new Set(ids)];
  return unique.length
    ? `${path}?${new URLSearchParams({ variantIds: unique.join(",") })}#product-variants`
    : path;
}

export function buildVariantQuestionHref(slug: string, ids: string[]): string {
  const params = new URLSearchParams({ product: slug });
  if (ids.length) params.set("variantIds", [...new Set(ids)].join(","));
  return `/kontakty?${params}#primy-kontakt`;
}

/** Keep list selection and search intact when opening or closing one variant detail. */
export function buildVariantDetailHref(slug: string, id: string | null, search = ""): string {
  const params = new URLSearchParams(search);
  if (id) params.set("variantDetail", id);
  else params.delete("variantDetail");
  const query = params.toString();
  return `/produkt/${encodeURIComponent(slug)}${query ? `?${query}` : ""}#product-variants`;
}
