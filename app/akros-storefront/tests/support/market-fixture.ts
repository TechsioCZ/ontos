/** The Czech AKROS market as `getActiveMarket()` resolves it (tests run outside a Next request). */
export const testMarket = {
  marketId: "0b3d6c1e-2f4a-4c5b-8d6e-7f8091a2b3c4",
  marketCode: "AKROS-CZ",
  locale: "cs",
  formatLocale: "cs",
  currency: "CZK" as const,
  configured: true,
};

/** The storefront's only market before any market exists (no `marketId`, see market.ts). */
export const unmarketedMarket = {
  marketCode: "",
  locale: "cs",
  formatLocale: "cs-CZ",
  currency: "CZK" as const,
  configured: true,
};
