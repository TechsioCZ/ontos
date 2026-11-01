import { describe, expect, it } from "vitest";
import { productMediaPath } from "@/ontos/media-path";

describe("productMediaPath", () => {
  it("serves uploaded OntOS photos from the storefront origin", () => {
    expect(productMediaPath("product-19408", "media:0192f3a0-0000-7000-8000-000000000001")).toBe(
      "/obrazky/product-19408/0192f3a0-0000-7000-8000-000000000001",
    );
  });

  it("leaves other references to the existing image rules", () => {
    expect(
      productMediaPath("product-1", "https://www.akros.cz/data/product/a.jpg"),
    ).toBeUndefined();
    expect(productMediaPath("product-1", "media:../../etc/passwd")).toBeUndefined();
    expect(productMediaPath("../x", "media:0192f3a0-0000-7000-8000-000000000001")).toBeUndefined();
  });
});
