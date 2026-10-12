/** Match the design's whole-crown prices while keeping non-zero haléře and allowing line wraps. */
export const formatCheckoutPrice = (priceMinor: number) =>
  new Intl.NumberFormat("cs-CZ", {
    style: "currency",
    currency: "CZK",
    minimumFractionDigits: priceMinor % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  })
    .format(priceMinor / 100)
    .replace(/[\u00a0\u202f]/g, " ");
