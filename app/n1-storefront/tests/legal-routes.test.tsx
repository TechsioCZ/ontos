import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, rs } from "@rstest/core";
import ContentPage from "../src/app/[locale]/[content]/page";
import { getFulfillment } from "../src/ontos/fulfillment";
import { getDictionary } from "../src/i18n";

rs.mock("../src/features/auth-view", () => ({
  AuthView: () => <div>auth-view</div>,
}));
rs.mock("../src/features/contact-view", () => ({
  ContactView: () => <div>contact-view</div>,
}));
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
