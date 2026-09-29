import type { CatalogParameter, CatalogProductVariant } from "@/mock-storefront/types";

export const normalizeCatalogSearchTerm = (value: string) =>
  value
    .normalize("NFD")
    .replaceAll(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("cs-CZ")
    .trim();

export const formatCatalogParametersForSearch = (parameters: CatalogParameter[]) =>
  parameters.map(({ label, value, unit }) => `${label} ${value} ${unit}`).join(" ");

export const matchesProductVariantSearch = (
  variant: CatalogProductVariant,
  normalizedQuery: string,
) =>
  normalizeCatalogSearchTerm(
    `${variant.sku} ${variant.label} ${formatCatalogParametersForSearch(variant.parameters)}`,
  ).includes(normalizedQuery);
