import type { ProductStockStatus } from "@/lib/product-stock";

export interface CatalogCategory {
  id: string;
  parentId: string | null;
  hasChildren: boolean;
  slug: string;
  name: string;
  position: number;
  heading?: string;
  description?: string;
  longDescription?: string;
  imageSrc?: string;
  imageAlt?: string;
}

export interface CatalogProductVariant {
  vatRate?: number;
  id: string;
  sourceId: string;
  sku: string;
  label: string;
  minimumQuantity: number;
  packageQuantity?: number;
  quantityStep?: number;
  priceMinor: number;
  originalPriceMinor?: number;
  stockCount: number;
  /** OntOS reports availability UNKNOWN (or untracked stock): shown as „nelze ověřit“, never sold. */
  availabilityUnknown?: boolean;
  /** Set when the OntOS price is missing, zero or in an unsupported currency: „cena není dostupná“ + reason. */
  priceUnavailableReason?: string;
  unit: string;
  priceTiers: CatalogPriceTier[];
  parameters: CatalogParameter[];
  imageSrc?: string;
  isAction: boolean;
  isRecommended: boolean;
  isSale: boolean;
  isNew: boolean;
}

export interface CatalogPriceTier {
  minimumQuantity: number;
  priceMinor: number;
  priceExcludingVatMinor: number;
}

export interface CatalogParameter {
  label: string;
  value: string;
  unit: string;
}

interface CatalogProductDetail {
  descriptionParagraphs: string[];
  parameters: CatalogParameter[];
  priceTiers: CatalogPriceTier[];
  variants: CatalogProductVariant[];
}

/** The owner's aggregate of a product's active, sellable variants (listing cards carry no variant records). */
export interface CatalogVariantSummary {
  count: number;
  minGrossPriceMinor: number | null;
  stockOnHand: number;
  units: string[];
}

export interface CatalogProduct {
  vatRate?: number;
  id: string;
  slug: string;
  categoryId: string;
  name: string;
  sku: string;
  description: string;
  priceMinor: number;
  originalPriceMinor?: number;
  currency: "CZK";
  unit: string;
  minimumQuantity: number;
  packageQuantity?: number;
  quantityStep?: number;
  netWeight?: number;
  stockCount: number;
  /** OntOS reports availability UNKNOWN (or untracked stock): shown as „nelze ověřit“, never sold. */
  availabilityUnknown?: boolean;
  /** Set when the OntOS price is missing, zero or in an unsupported currency: „cena není dostupná“ + reason. */
  priceUnavailableReason?: string;

  imageSrc: string;
  imageAlt: string;
  secondaryImageSrc?: string;
  /** Every gallery image after the main one, in the order staff set in OntOS (OntOS mode only). */
  additionalImageSrcs?: string[];
  featuredPosition: number | null;
  isAction: boolean;
  isRecommended: boolean;
  isSale: boolean;
  isNew: boolean;
  variantSummary: CatalogVariantSummary;
  /** Variant records, parameters and paragraphs are filled only by product detail (`fields: "full"`) reads. */
  detail: CatalogProductDetail;
}

/** The purchase form needs prices, constraints and cart identity, not descriptions or listing metadata. */
export type CatalogPurchaseProduct = Pick<
  CatalogProduct,
  | "vatRate"
  | "id"
  | "slug"
  | "name"
  | "sku"
  | "imageSrc"
  | "imageAlt"
  | "unit"
  | "minimumQuantity"
  | "packageQuantity"
  | "quantityStep"
  | "stockCount"
  | "priceMinor"
  | "availabilityUnknown"
  | "priceUnavailableReason"
> & { detail: Pick<CatalogProductDetail, "priceTiers"> };
export type CatalogPurchaseVariant = Omit<
  CatalogProductVariant,
  "sourceId" | "vatRate" | "originalPriceMinor" | "isAction" | "isRecommended" | "isSale" | "isNew"
>;

export interface CatalogPromotionItem {
  product: CatalogProduct;
  kind: "action" | "sale";
}

type CatalogProductSummaryStock =
  | {
      kind: "quantity";
      minimumQuantity: number;
      packageQuantity?: number;
      quantityStep?: number;
      status: ProductStockStatus;
      stockCount: number;
      unit: string;
    }
  | {
      kind: "variants";
      status: ProductStockStatus;
    };

export type CatalogProductSummary = Omit<
  CatalogProduct,
  | "additionalImageSrcs"
  | "detail"
  | "minimumQuantity"
  | "packageQuantity"
  | "secondaryImageSrc"
  | "stockCount"
  | "unit"
  | "variantSummary"
> & {
  priceExcludingVatMinor?: number;
  hasVariants: boolean;
  priceIsFrom: boolean;
  stock: CatalogProductSummaryStock;
};

export interface CatalogData {
  homepageFeaturedProductIds: string[];
  products: CatalogProduct[];
}

export interface CategoryData {
  categories: CatalogCategory[];
}
