import { expect, it } from "@rstest/core";
import { productShareHref } from "../src/features/product-share";

it("prepares an email draft with the actual product and selected variant", () => {
  const href = productShareHref({
    locale: "cs",
    name: "Triko & mikina – M",
    origin: "https://ontos-stage-n1.web-revolution.cz",
    slug: "triko-a-mikina",
    variant: { id: "owner-variant-m" },
  });
  expect(href).not.toBeNull();
  const draft = new URL(href ?? "mailto:");
  expect(draft.protocol).toBe("mailto:");
  expect(draft.pathname).toBe("");
  expect([...draft.searchParams.keys()]).toEqual(["subject", "body"]);
  expect(draft.searchParams.get("subject")).toBe("Triko & mikina – M");
  expect(draft.searchParams.get("body")).toBe(
    "https://ontos-stage-n1.web-revolution.cz/cs/produkt/triko-a-mikina?variantId=owner-variant-m",
  );
});

it("shares the current environment and locale without adding a variant for a plain product", () => {
  const href = productShareHref({
    locale: "en",
    name: "Owner product",
    origin: "http://localhost:3071",
    slug: "owner-product",
  });
  expect(new URL(href ?? "mailto:").searchParams.get("body")).toBe(
    "http://localhost:3071/en/produkt/owner-product",
  );
});

it("encodes product names as text and keeps header-like content out of mailto recipients", () => {
  const href = productShareHref({
    locale: "cs",
    name: "Triko\r\nBcc: nobody@example.test &bcc=other@example.test",
    origin: "https://shop.example.test",
    slug: "owner-product",
  });
  const draft = new URL(href ?? "mailto:");
  expect(draft.pathname).toBe("");
  expect(draft.searchParams.has("bcc")).toBe(false);
  expect(draft.searchParams.get("subject")).not.toMatch(/[\r\n]/u);
  expect(href).not.toContain("+nobody");
});

it.each([
  null,
  "",
  "not-a-url",
  "data:text/plain,example",
  "https://user:password@shop.example.test",
  "https://shop.example.test/path?token=private#fragment",
])("keeps the draft unavailable without a clean public origin: %s", (origin) => {
  expect(
    productShareHref({ locale: "cs", name: "Owner product", origin, slug: "owner-product" }),
  ).toBeNull();
});

it.each(["", ".", ".."])('rejects an empty or dot-segment product slug "%s"', (slug) => {
  expect(
    productShareHref({
      locale: "cs",
      name: "Owner product",
      origin: "https://shop.example.test",
      slug,
    }),
  ).toBeNull();
});
