// Storefront brand, chosen per server instance by `STOREFRONT_BRAND` (read at request time, never at build time),
// so one build artifact serves every brand. Server-only: client components get `toClientBrand()` via
// BrandProvider, so no brand profile is bundled for the browser.
import "server-only";
import { akros } from "./akros";
import { sroubshop } from "./sroubshop";
import { getBrandId } from "./config";
import type { Brand, BrandId, BrandLocale, ClientBrand } from "./types";

const brands: Readonly<Record<BrandId, Brand>> = { akros, sroubshop };

/** The brand of this instance; unset means AKROS, an unknown value fails loudly instead of falling back. */
export function getBrand(): Brand {
  return brands[getBrandId()];
}

/** Brand copy language of a market locale (`cs`, `sk`); every other locale reads English. */
export const brandLocale = (locale: string | undefined): BrandLocale =>
  locale === "cs" || locale === "sk" ? locale : "en";

/** The chrome client components need, in the market's language. */
export function toClientBrand(brand: Brand, locale: string | undefined): ClientBrand {
  const copy = brand.copy[brandLocale(locale)];
  return {
    name: brand.name,
    logo: brand.logo,
    contact: {
      ...(brand.contact.phone ? { phone: brand.contact.phone } : {}),
      email: brand.contact.email,
    },
    copyright: copy.copyright,
    production:
      brand.production && copy.production
        ? {
            path: "/kategorie/akroscz-vyroba",
            externalUrl: brand.production.externalUrl,
            headerLabel: copy.production.headerLabel,
            sidebarLabel: copy.production.sidebarLabel,
          }
        : null,
  };
}

export type { Brand, ClientBrand } from "./types";
