import { describe, expect, it } from "vitest";

import { categoryDescription, categoryImage } from "@/lib/category-presentation";
import type { CatalogCategory } from "@/ontos/catalog-types";

const category: CatalogCategory = {
  id: "washers-sale",
  parentId: "washers",
  hasChildren: false,
  slug: "akce",
  name: "AKCE",
  position: 1,
  imageSrc: "https://www.akros.cz/data/category/6622070c9b4c7.jpg",
  imageAlt: "AKCE",
};

describe("category presentation", () => {
  it.each([undefined, null, "", "  ", "NULL", " null ", "undefined"])(
    "omits missing descriptions (%s)",
    (description) => expect(categoryDescription(description)).toBeUndefined(),
  );

  it("preserves meaningful Czech descriptions", () => {
    expect(categoryDescription("  Nerezový spojovací materiál. ")).toBe(
      "Nerezový spojovací materiál.",
    );
    expect(categoryDescription("Hodnota NULL se nezobrazuje samostatně.")).toBe(
      "Hodnota NULL se nezobrazuje samostatně.",
    );
  });

  it("replaces the known missing AKCE image with an honest local fallback", () => {
    expect(categoryImage(category)).toEqual({
      src: "/akros/products/image-unavailable.svg",
      alt: "Fotografie kategorie AKCE není k dispozici",
    });
  });

  it("preserves real category images and handles missing optional fields", () => {
    expect(categoryImage({ ...category, imageSrc: "/category.jpg" })).toEqual({
      src: "/category.jpg",
      alt: "AKCE",
    });
    expect(categoryImage({ ...category, imageSrc: "/category.jpg", imageAlt: undefined })).toEqual({
      src: "/category.jpg",
      alt: "AKCE",
    });
    expect(categoryImage({ ...category, imageSrc: undefined })).toBeUndefined();
  });
});
