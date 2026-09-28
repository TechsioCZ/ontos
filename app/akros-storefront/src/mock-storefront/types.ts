export interface CatalogCategory {
  id: string;
  parentId: string | null;
  slug: string;
  name: string;
  position: number;
  imageSrc?: string;
  imageAlt?: string;
}

export interface CatalogProductVariant {
  id: string;
  label: string;
  packageQuantity: number;
  priceMinor: number;
  stockCount: number;
}

export interface CatalogProductDetail {
  salesHeading: string;
  salesCopy: string[];
  quantityTiers: Array<{ label: string; priceMinor: number }>;
  actions: string[];
  descriptionParagraphs: string[];
  parameters: Array<{ label: string; value: string }>;
  variants: CatalogProductVariant[];
  recommendationProductIds: string[];
}

export interface CatalogProduct {
  id: string;
  slug: string;
  categoryId: string;
  name: string;
  sku: string;
  description: string;
  priceMinor: number;
  currency: "CZK";
  unit: string;
  stockCount: number;
  imageSrc: string;
  imageAlt: string;
  secondaryImageSrc?: string;
  featuredPosition: number | null;
  detail?: CatalogProductDetail;
}

export interface CatalogFixture {
  homepageFeaturedProductIds: string[];
  categories: CatalogCategory[];
  products: CatalogProduct[];
}
