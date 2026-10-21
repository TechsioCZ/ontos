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

export interface CatalogProductDetail {
  descriptionParagraphs: string[];
  parameters: CatalogParameter[];
  priceTiers: CatalogPriceTier[];
  variants: CatalogProductVariant[];
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
  detail: CatalogProductDetail;
}

export interface CatalogPromotionItem {
  product: CatalogProduct;
  variant?: CatalogProductVariant;
  kind: "action" | "sale";
}

export interface CatalogSearchResult {
  product: CatalogProduct;
  matchingVariants: CatalogProductVariant[];
}

export type CatalogProductSummaryStock =
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
> & {
  priceExcludingVatMinor?: number;
  hasVariants: boolean;
  priceIsFrom: boolean;
  stock: CatalogProductSummaryStock;
};

export interface CatalogMetadata {
  sourceCategoryCount: number;
  sourceItemCount: number;
  productGroupCount: number;
}

export interface CatalogData {
  metadata: CatalogMetadata;
  homepageFeaturedProductIds: string[];
  products: CatalogProduct[];
}

export interface CategoryData {
  metadata: CatalogMetadata;
  categories: CatalogCategory[];
}
