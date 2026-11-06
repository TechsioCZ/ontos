interface ProductShareInput {
  locale: string;
  name: string;
  origin: string | null;
  slug: string;
  variant?: { id: string } | undefined;
}

/** Share only the public product selector, never the current page's other query or hash. */
export const productShareHref = ({ locale, name, origin, slug, variant }: ProductShareInput) => {
  const base = origin === null ? null : URL.parse(origin);
  if (
    base === null ||
    !["http:", "https:"].includes(base.protocol) ||
    base.username !== "" ||
    base.password !== "" ||
    base.pathname !== "/" ||
    base.search !== "" ||
    base.hash !== "" ||
    (locale !== "cs" && locale !== "en") ||
    ["", ".", ".."].includes(slug)
  ) {
    return null;
  }
  const product = new URL(`/${locale}/produkt/${encodeURIComponent(slug)}`, base.origin);
  if (variant !== undefined) {
    product.searchParams.set("variantId", variant.id);
  }
  const subject = encodeURIComponent(name.replaceAll(/[\r\n]/gu, " "));
  return `mailto:?subject=${subject}&body=${encodeURIComponent(product.href)}`;
};

/** The origin is immutable within this document; the server has no browser origin. */
export const productShareOrigin = {
  getServerSnapshot: (): string | null => null,
  getSnapshot: () => window.location.origin,
  subscribe: () => () => {
    // There is no subscription to release: changing origin replaces this document.
  },
};
