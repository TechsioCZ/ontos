import type { Dictionary } from "@/i18n";
import { cs } from "@/i18n/cs";
import { imagePlaceholder } from "@/ontos/media-path";
import type { CatalogCategory } from "@/ontos/catalog-types";

export function categoryDescription(value: string | null | undefined): string | undefined {
  const description = value?.trim();
  return description && !/^(null|undefined)$/i.test(description) ? description : undefined;
}

export function categoryImage(
  category: CatalogCategory,
  t: Dictionary = cs,
): { src: string; alt: string } | undefined {
  if (!category.imageSrc) return undefined;
  // This source image is a confirmed 404. Do not send customers to the broken optimizer URL.
  if (category.imageSrc === "https://www.akros.cz/data/category/6622070c9b4c7.jpg") {
    return {
      src: imagePlaceholder,
      alt: t.catalog.categoryImageUnavailable(category.name),
    };
  }
  return { src: category.imageSrc, alt: category.imageAlt ?? category.name };
}
