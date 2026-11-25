const countryNames = {
  cs: new Intl.DisplayNames("cs", { type: "region" }),
  en: new Intl.DisplayNames("en", { type: "region" }),
};

export const countryName = (code: string, locale: string) =>
  /^[A-Z]{2}$/u.test(code) ? (countryNames[locale === "en" ? "en" : "cs"].of(code) ?? code) : code;
