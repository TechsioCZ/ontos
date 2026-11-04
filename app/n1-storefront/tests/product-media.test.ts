import { describe, expect, it } from "effect-rstest";
import { publicImage } from "../src/ontos/catalog-model";
import { isStorefrontMediaPath, productMediaPath } from "../src/ontos/media-path";

const asset = "a973f79c-0f97-476f-a003-f6db822156fb";
const product = "product-20532";

describe("uploaded product photos", () => {
  it("serve a media reference from this storefront's own /obrazky address", () => {
    expect(productMediaPath(product, `media:${asset}`)).toBe(`/obrazky/${product}/${asset}`);
  });

  it("leave external and malformed references without a storefront address", () => {
    expect(
      productMediaPath(product, "https://ontos-stage-n1.web-revolution.cz/demo/n1/x.jpg"),
    ).toBeUndefined();
    expect(productMediaPath(product, "media:not-a-uuid")).toBeUndefined();
    expect(productMediaPath("bad product id!", `media:${asset}`)).toBeUndefined();
  });

  it("accept exactly the storefront addresses that productMediaPath produces", () => {
    expect(isStorefrontMediaPath(`/obrazky/${product}/${asset}`)).toBe(true);
    expect(isStorefrontMediaPath(`/obrazky/${product}/${asset}/extra`)).toBe(false);
    expect(isStorefrontMediaPath(`/obrazky/${product}/not-an-asset`)).toBe(false);
    expect(isStorefrontMediaPath("https://ontos-stage-n1.web-revolution.cz/obrazky/x")).toBe(false);
  });

  it("keep the cart and listing images on the storefront origin", () => {
    const path = `/obrazky/${product}/${asset}`;
    expect(publicImage(path, [])).toBe(path);
    expect(
      publicImage("https://ontos-stage-n1.web-revolution.cz/demo/n1/x.jpg", [
        "ontos-stage-n1.web-revolution.cz",
      ]),
    ).toBe("https://ontos-stage-n1.web-revolution.cz/demo/n1/x.jpg");
    expect(
      publicImage("https://elsewhere.example/x.jpg", ["ontos-stage-n1.web-revolution.cz"]),
    ).toBeNull();
  });
});
