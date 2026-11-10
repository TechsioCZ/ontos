import NextImage from "next/image";
import { Image } from "@techsio/ui-kit/atoms/image";
import { Link } from "@/features/plain-link";
import { getDictionary } from "@/i18n";
import { getCatalog } from "@/ontos/catalog";
import { CatalogView } from "@/features/catalog-view";
import { StorefrontHero } from "@/features/hero";

const benefitSlots = [
  ["delivery", "w-n1-benefit-delivery"],
  ["payment", "w-n1-benefit-payment"],
  ["pickup", "w-n1-benefit-pickup"],
  ["selection", "w-n1-benefit-selection"],
] as const;

const promoSlots = ["helmet", "purevue", "ebikes", "shoes"] as const;

const HomePage = async ({ params }: { params: Promise<{ locale: string }> }) => {
  const { locale } = await params;
  const d = getDictionary(locale);
  const result = await getCatalog(locale, JSON.stringify({ featured: true }));
  return (
    <>
      <StorefrontHero dictionary={d} />
      <div className="mx-auto max-w-n1-content p-6">
        <ul className="grid grid-cols-2 gap-0 lg:grid-cols-4">
          {benefitSlots.map(([asset, width]) => (
            <li className="flex items-center gap-4" key={asset}>
              <div className={`${width} shrink-0`}>
                <Image
                  alt=""
                  as={NextImage}
                  height={50}
                  size="full"
                  src={`/brand/benefit-${asset}.png`}
                  width={50}
                />
              </div>
              <div className="min-w-0">
                <p className="text-sm font-medium leading-n1-copy">{d.benefits[asset].title}</p>
                <p className="text-xs leading-n1-copy text-fg-secondary">
                  {d.benefits[asset].description}
                </p>
              </div>
            </li>
          ))}
        </ul>
      </div>
      <section aria-labelledby="categories-title" className="bg-fill-hover py-6">
        <h2 className="mb-6 text-center text-lg font-bold leading-n1-copy" id="categories-title">
          {d.categories}
        </h2>
        <ul className="mx-auto grid max-w-n1-promo-content grid-cols-3 gap-x-2 gap-y-3 px-4 md:grid-cols-4 md:gap-x-3 md:px-0">
          {promoSlots.map((asset) => (
            <li className="flex min-w-0 flex-col items-center gap-1 md:gap-0" key={asset}>
              <div
                className={
                  asset === "helmet"
                    ? "w-full max-w-n1-promo-image"
                    : "w-full max-w-n1-promo-image px-1 md:px-0"
                }
              >
                <Image
                  alt=""
                  as={NextImage}
                  height={256}
                  size="full"
                  src={`/brand/promo-${asset}.png`}
                  width={256}
                />
              </div>
              <h3 className="w-full min-w-0 wrap-break-word text-center text-sm font-bold leading-n1-copy">
                <Link aria-disabled="true" title={d.featureUnavailable}>
                  {d.promos[asset]}
                </Link>
              </h3>
            </li>
          ))}
        </ul>
      </section>
      {result.state === "unavailable" ? (
        <section className="mx-auto max-w-n1-content px-4 py-16">
          <h1 className="mb-4 text-xl font-bold">{d.unavailable}</h1>
          <output>{d.unavailableDescription}</output>
        </section>
      ) : (
        <CatalogView catalog={result.catalog} dictionary={d} locale={locale} title={d.featured} />
      )}
    </>
  );
};

export default HomePage;
