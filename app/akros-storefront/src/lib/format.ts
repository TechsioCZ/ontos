export const formatPrice = (priceMinor: number, currency: "CZK" = "CZK") =>
  new Intl.NumberFormat("cs-CZ", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
  }).format(priceMinor / 100);

export const formatWeight = (weightKg?: number) =>
  weightKg !== undefined && Number.isFinite(weightKg) && weightKg > 0
    ? `${new Intl.NumberFormat("cs-CZ", { maximumFractionDigits: 6 }).format(weightKg)} kg`
    : null;
