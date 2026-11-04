import type { Dictionary } from "@/i18n";

const countFormats = { cs: new Intl.NumberFormat("cs"), en: new Intl.NumberFormat("en") };
const countPlurals = { cs: new Intl.PluralRules("cs"), en: new Intl.PluralRules("en") };

/** Figma category count uses the owner's total, including products on other pages. */
export const CategoryProductCount = ({
  dictionary: d,
  locale,
  total,
}: {
  dictionary: Dictionary;
  locale: string;
  total: number;
}) => {
  const language = locale === "en" ? "en" : "cs";
  const plural = countPlurals[language].select(total);
  const unit = d.categoryProductCount[plural === "one" || plural === "few" ? plural : "other"];
  return (
    <p className="mb-6 text-sm text-fg-secondary md:mb-3 md:flex md:items-center md:gap-1 md:border md:border-warning-300 md:bg-warning-100 md:p-4 md:leading-normal md:text-fg-primary">
      <span className="md:hidden">{d.productsFound}</span>
      <span className="hidden md:inline">{d.productsShown}</span>{" "}
      <span className="md:font-bold">{countFormats[language].format(total)}</span>{" "}
      <span className="hidden md:inline">{unit}</span>
    </p>
  );
};
