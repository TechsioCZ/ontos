import { describe, expect, it } from "@rstest/core";
import { renderToStaticMarkup } from "react-dom/server";
import { Button } from "@techsio/ui-kit/atoms/button";
import { LinkButton } from "@techsio/ui-kit/atoms/link-button";
import { NumericInput } from "@techsio/ui-kit/atoms/numeric-input";
import { ProductCard } from "@techsio/ui-kit/molecules/product-card";

describe("published UI-kit patch contract", () => {
  it("keeps ordinary button sizes and makes compact button sizing exclusive", () => {
    const ordinary = renderToStaticMarkup(<Button size="md">Buy</Button>);
    const compact = renderToStaticMarkup(
      <Button density="compact" size="md">
        Buy
      </Button>,
    );
    const link = renderToStaticMarkup(
      <LinkButton density="compact" href="/cs" size="sm">
        Detail
      </LinkButton>,
    );
    expect(ordinary).toContain("h-form-control-md");
    expect(ordinary).not.toContain("h-button-compact");
    expect(compact).toContain("h-button-compact-md");
    expect(compact).not.toContain("h-form-control-md");
    expect(compact).not.toMatch(/\sp-button-md(?:\s|")/u);
    expect(compact).not.toContain("density=");
    expect(link).toContain("h-button-compact-sm");
    expect(link).not.toContain("h-form-control-sm");
    expect(link).not.toContain("density=");
  });

  it("does not retain the ordinary height on compact numeric controls", () => {
    const html = renderToStaticMarkup(
      <NumericInput density="compact" size="md" value="1">
        <NumericInput.Control>
          <NumericInput.Input />
        </NumericInput.Control>
      </NumericInput>,
    );
    const [control] = html.match(/<div[^>]*data-part="control"[^>]*>/gu) ?? [];
    expect(control).toContain("h-numeric-input-compact-md");
    expect(control).toContain("border-numeric-input-compact-border");
    expect(control).not.toMatch(/\sborder-numeric-input-border(?:\s|")/u);
    expect(control).not.toContain("h-form-control-md");
    expect(html).not.toContain("density=");
  });

  it("opts into flat cards and uncropped photos without leaking appearance props", () => {
    const ordinary = renderToStaticMarkup(<ProductCard>Product</ProductCard>);
    const flat = renderToStaticMarkup(
      <ProductCard shadow={false}>
        <ProductCard.Image alt="Product" as="img" objectFit="contain" src="/photo.jpg" />
      </ProductCard>,
    );
    expect(ordinary).toContain("shadow-sm");
    expect(flat).toContain("shadow-none");
    expect(flat).not.toContain("shadow-sm");
    expect(flat).toContain("object-contain");
    expect(flat).not.toContain("object-cover");
    expect(flat).not.toContain("objectFit=");
    expect(flat).not.toContain("shadow=");
  });
});
