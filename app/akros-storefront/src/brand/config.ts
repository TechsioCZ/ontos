import "server-only";
import { BRAND_IDS, type BrandId } from "./types";

const isBrandId = (value: string): value is BrandId =>
  (BRAND_IDS as readonly string[]).includes(value);

/** Server deployment identity, shared by catalog policy and the full brand profile. */
export function getBrandId(): BrandId {
  const configured = process.env.STOREFRONT_BRAND?.trim() || "akros";
  if (!isBrandId(configured))
    throw new Error(
      `STOREFRONT_BRAND=${JSON.stringify(configured)} is not a storefront brand (${BRAND_IDS.join(", ")})`,
    );
  return configured;
}
