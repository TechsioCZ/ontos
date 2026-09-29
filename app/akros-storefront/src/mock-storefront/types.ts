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
  id: string;
  sourceId: string;
  sku: string;
  label: string;
  minimumQuantity: number;
  packageQuantity?: number;
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
  stockCount: number;
  imageSrc: string;
  imageAlt: string;
  secondaryImageSrc?: string;
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

export type CatalogProductSummary = Omit<CatalogProduct, "detail" | "secondaryImageSrc"> & {
  hasVariants: boolean;
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
