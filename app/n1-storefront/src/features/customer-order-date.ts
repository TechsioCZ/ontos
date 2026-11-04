const formatters = {
  cs: new Intl.DateTimeFormat("cs-CZ", { dateStyle: "medium" }),
  en: new Intl.DateTimeFormat("en-GB", { dateStyle: "medium" }),
};

export const customerOrderDate = (value: string, locale: string, unavailable: string) => {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds)
    ? formatters[locale === "en" ? "en" : "cs"].format(milliseconds)
    : unavailable;
};
