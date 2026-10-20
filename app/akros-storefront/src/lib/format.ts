export const formatPrice = (priceMinor: number, currency: "CZK" = "CZK") =>
  new Intl.NumberFormat("cs-CZ", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
  }).format(priceMinor / 100);
