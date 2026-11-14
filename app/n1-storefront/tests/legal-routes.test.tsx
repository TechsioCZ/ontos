import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, rs } from "@rstest/core";
import ContentPage from "../src/app/[locale]/[content]/page";
import { getFulfillment } from "../src/ontos/fulfillment";
import { getDictionary } from "../src/i18n";
import { Effect } from "effect";
import { readInquiryProduct } from "../src/ontos/inquiry-server";
import { InquiryFailure } from "../src/ontos/inquiry";
import { ContactView } from "../src/features/contact-view";

rs.mock("../src/features/auth-view", () => ({
  AuthView: () => <div>auth-view</div>,
}));
rs.mock("../src/features/contact-view", () => ({
  ContactView: rs.fn(() => <div>contact-view</div>),
}));
rs.mock("../src/ontos/inquiry-server", () => ({ readInquiryProduct: rs.fn() }));
rs.mock("../src/features/fulfillment-view", () => ({
  FulfillmentView: ({ kind }: { kind: string }) => <div>{kind}</div>,
}));
rs.mock("../src/ontos/fulfillment", () => ({
  getFulfillment: rs.fn(async () => ({ state: "unavailable" })),
}));

const renderPage = async (content: string, locale = "cs") =>
  renderToStaticMarkup(
    await ContentPage({
      params: Promise.resolve({ content, locale }),
      searchParams: Promise.resolve({}),
    }),
  );
beforeEach(() => {
  rs.clearAllMocks();
  rs.mocked(readInquiryProduct).mockReset();
});

const renderContact = async (query: {
  productId?: string | string[];
  variantIds?: string | string[];
}) =>
  renderToStaticMarkup(
    await ContentPage({
      params: Promise.resolve({ content: "kontakty", locale: "cs" }),
      searchParams: Promise.resolve(query),
    }),
  );

describe("contact product selectors fail closed at the route boundary", () => {
  it("reads the real selected identity and passes only canonical prefill to ContactView", async () => {
    const product = {
      productId: "product",
      productName: "Actual owner product",
      productSlug: "actual",
      variant: { id: "n1legacy:variant:12", name: "M", sku: "ACTUAL-M" },
    };
    rs.mocked(readInquiryProduct).mockReturnValue(Effect.succeed(product));
    expect(
      await renderContact({ productId: "product", variantIds: "n1legacy:variant:12" }),
    ).toContain("contact-view");
    expect(readInquiryProduct).toHaveBeenCalledExactlyOnceWith("cs", {
      productId: "product",
      variantIds: ["n1legacy:variant:12"],
    });
    expect(rs.mocked(ContactView).mock.calls[0]?.[0].question).toEqual({ product, state: "ready" });
  });
  it("shows a locked unavailable question rather than reverting to a generic contact", async () => {
    rs.mocked(readInquiryProduct).mockReturnValue(
      Effect.fail(new InquiryFailure({ reason: "unavailable" })),
    );
    expect(await renderContact({ productId: "product" })).toContain("contact-view");
    expect(rs.mocked(ContactView).mock.calls[0]?.[0].question).toEqual({ state: "unavailable" });
  });
  it("returns not-found for a product or variant that the public catalog no longer exposes", async () => {
    rs.mocked(readInquiryProduct).mockReturnValue(
      Effect.fail(new InquiryFailure({ reason: "invalid" })),
    );
    await expect(renderContact({ productId: "product", variantIds: "removed" })).rejects.toThrow(
      /404/u,
    );
    expect(ContactView).not.toHaveBeenCalled();
  });
  it.each([
    { productId: ["product", "other"] },
    { variantIds: "variant" },
    { productId: "product", variantIds: "first,second" },
  ])("rejects invalid selectors before performing a catalog read", async (query) => {
    await expect(renderContact(query)).rejects.toThrow(/404/u);
    expect(readInquiryProduct).not.toHaveBeenCalled();
  });
});

describe("legal routes retain the existing content dispatch boundary", () => {
  it.each(["obchodni-podminky", "ochrana-osobnich-udaju"])(
    "renders the same authored Czech document on both site locales: %s",
    async (slug) => {
      const czech = await renderPage(slug, "cs");
      const english = await renderPage(slug, "en");
      expect(english).toBe(czech);
      expect(english).toContain('lang="cs"');
      expect(english).not.toContain(getDictionary("en").featureUnavailable);
      expect(getFulfillment).not.toHaveBeenCalled();
    },
  );
  it("leaves the unimplemented news content as an explicit placeholder", async () => {
    const html = await renderPage("novinky");
    expect(html).toContain(getDictionary("cs").featureUnavailable);
    expect(html).not.toContain("N Distribution s.r.o.");
    expect(getFulfillment).not.toHaveBeenCalled();
  });
  it.each(["unpublished-page", "zasady-ochrany-osobnich-udaju"])(
    "preserves unknown-slug 404 rather than inventing a CMS page: %s",
    async (slug) => {
      await expect(renderPage(slug)).rejects.toThrow(/404/u);
      expect(getFulfillment).not.toHaveBeenCalled();
    },
  );
  it.each([
    ["prihlaseni", "auth-view"],
    ["registrace", "auth-view"],
    ["kontakty", "contact-view"],
  ])("preserves the existing %s dispatch", async (slug, sentinel) => {
    expect(await renderPage(slug)).toContain(sentinel);
    expect(getFulfillment).not.toHaveBeenCalled();
  });
  it.each([
    ["doprava", "shipping"],
    ["platba", "payment"],
  ])("preserves the real fulfillment read for %s", async (slug, kind) => {
    expect(await renderPage(slug, "en")).toContain(kind);
    expect(getFulfillment).toHaveBeenCalledExactlyOnceWith("en");
  });
});
