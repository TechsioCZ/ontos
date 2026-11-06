import { describe, expect, it } from "@rstest/core";
import { renderToStaticMarkup } from "react-dom/server";
import { Image } from "@techsio/ui-kit/atoms/image";
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

  it("uses the published numeric trigger colour roles for both stepper buttons", () => {
    const html = renderToStaticMarkup(
      <NumericInput max={2} min={1} size="md" value="1">
        <NumericInput.Control>
          <NumericInput.DecrementTrigger />
          <NumericInput.Input />
          <NumericInput.IncrementTrigger />
        </NumericInput.Control>
      </NumericInput>,
    );
    const triggers =
      html.match(/<button[^>]*data-part="(?:decrement|increment)-trigger"[^>]*>/gu) ?? [];
    expect(triggers).toHaveLength(2);
    for (const trigger of triggers) {
      expect(trigger).toContain("bg-numeric-input-trigger-bg");
      expect(trigger).toContain("hover:bg-numeric-input-trigger-bg-hover");
      expect(trigger).toContain("text-numeric-input-trigger-fg");
      expect(trigger).not.toContain("bg-transparent");
      expect(trigger).toContain("active:bg-icon-control-bg-active");
    }
  });

  it("contains uncropped thumbnail adapters without changing ordinary images", () => {
    const ordinary = renderToStaticMarkup(<Image alt="Original" src="/photo.jpg" />);
    const contained = renderToStaticMarkup(
      <Image
        alt="Thumbnail"
        height={64}
        objectFit="contain"
        size="custom"
        src="/photo.jpg"
        width={64}
      />,
    );
    expect(ordinary).not.toContain("object-contain");
    expect(contained).toContain("object-contain");
    expect(contained).not.toContain("object-cover");
    expect(contained).not.toContain("objectFit=");
    expect(contained).toContain('width="64"');
    expect(contained).toContain('height="64"');
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

  it("isolates featured card tokens from the original listing presentation", () => {
    const ordinary = renderToStaticMarkup(
      <ProductCard>
        <ProductCard.Name>Product</ProductCard.Name>
        <ProductCard.Stock>Available</ProductCard.Stock>
      </ProductCard>,
    );
    const featured = renderToStaticMarkup(
      <ProductCard presentation="featured">
        <ProductCard.Name>Product</ProductCard.Name>
        <ProductCard.Stock>Available</ProductCard.Stock>
      </ProductCard>,
    );
    expect(ordinary).toContain("p-product-card-padding");
    expect(ordinary).toContain("font-product-card-name");
    expect(ordinary).not.toContain("product-card-featured");
    expect(featured).toContain("p-product-card-featured-padding");
    expect(featured).toContain("font-product-card-featured-name");
    expect(featured).toContain("font-product-card-featured-stock");
    expect(featured).not.toMatch(/\sp-product-card-padding(?:\s|")/u);
    expect(featured).not.toMatch(/\sfont-product-card-name(?:\s|")/u);
    expect(featured).not.toContain("presentation=");
  });
});
