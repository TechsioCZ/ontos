import type { CatalogCategory } from "@/ontos/catalog-types";

export function categoryDescription(value: string | null | undefined): string | undefined {
  const description = value?.trim();
  return description && !/^(null|undefined)$/i.test(description) ? description : undefined;
}

export function categoryImage(category: CatalogCategory): { src: string; alt: string } | undefined {
  if (!category.imageSrc) return undefined;
  // This source image is a confirmed 404. Do not send customers to the broken optimizer URL.
  if (category.imageSrc === "https://www.akros.cz/data/category/6622070c9b4c7.jpg") {
    return {
      src: "/akros/products/image-unavailable.svg",
      alt: `Fotografie kategorie ${category.name} není k dispozici`,
    };
  }
  return { src: category.imageSrc, alt: category.imageAlt ?? category.name };
}
