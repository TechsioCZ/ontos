import { describe, expect, it } from "effect-rstest";
import { Schema } from "effect";
import { CatalogResponseSchema, projectCatalog } from "../src/ontos/catalog-model";

const sourceProductId = "n1legacy:sql:f7972caf6a5bac9f3050968baf274669fbdc9cbf:product:1965";
const brand = { label: "Značka", unit: "", value: "Fox Racing" };
const project = (source: string | undefined, parameters = [brand]) => {
  const product = { id: "owner-id", name: "Owner product", parameters, slug: "owner-product" };
  const owner = Schema.decodeUnknownSync(CatalogResponseSchema)({
    market: { configured: true, currency: "CZK", marketId: "N1-CZ" },
    products: [source === undefined ? product : { ...product, sourceProductId: source }],
  });
  return projectCatalog(owner, []).details[0];
};

describe("audited N1 producer projection", () => {
  it("retains the public source identity through decoding and uses the native producer text", () => {
    expect(project(sourceProductId).manufacturer).toBe("Fox Racing");
    expect(project(sourceProductId, [{ ...brand, value: "Northwave" }]).manufacturer).toBe(
      "Northwave",
    );
  });
  it("does not treat a generic brand or a different import as proved manufacturer provenance", () => {
    for (const source of [
      undefined,
      "original-demo-product",
      sourceProductId.replace("f7972", "a7972"),
      `${sourceProductId}:variant:1968`,
      `${sourceProductId}\n`,
      sourceProductId.replace("1965", "not-an-id"),
    ]) {
      expect(project(source).manufacturer).toBeUndefined();
    }
  });
  it("omits missing, ambiguous and noncanonical producer parameters", () => {
    for (const parameters of [
      [],
      [brand, brand],
      [{ ...brand, label: "Manufacturer" }],
      [{ ...brand, unit: "kg" }],
      [{ ...brand, value: "  " }],
      [{ ...brand, value: "Bez výrobce" }],
    ]) {
      expect(project(sourceProductId, parameters).manufacturer).toBeUndefined();
    }
  });
  it("preserves parameters and never leaks import identity into the presentation model", () => {
    const result = project(sourceProductId);
    expect(result.parameters).toEqual([brand]);
    expect(result).not.toHaveProperty("sourceProductId");
  });
});
