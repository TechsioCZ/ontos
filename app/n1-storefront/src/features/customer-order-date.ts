const formatters = {
  cs: {
    date: new Intl.DateTimeFormat("cs-CZ", { dateStyle: "medium" }),
    dateTime: new Intl.DateTimeFormat("cs-CZ", { dateStyle: "medium", timeStyle: "short" }),
    longDate: new Intl.DateTimeFormat("cs-CZ", { dateStyle: "long" }),
  },
  en: {
    date: new Intl.DateTimeFormat("en-GB", { dateStyle: "medium" }),
    dateTime: new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" }),
    longDate: new Intl.DateTimeFormat("en-GB", { dateStyle: "long" }),
  },
};

export const customerOrderDate = (
  value: string,
  locale: string,
  unavailable: string,
  format: "date" | "dateTime" | "longDate" = "date",
) => {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds)
    ? formatters[locale === "en" ? "en" : "cs"][format].format(milliseconds)
    : unavailable;
};
