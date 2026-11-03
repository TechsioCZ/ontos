import { Schema } from "effect";
import { getDictionary } from "@/i18n";
import { getCatalog } from "@/ontos/catalog";
import { CatalogView } from "@/features/catalog-view";
import { CatalogPagination } from "@/features/catalog-pagination";

const SearchPage = async ({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ page?: string; q?: string | string[] }>;
}) => {
  const { locale } = await params;
  const d = getDictionary(locale);
  const search = await searchParams;
  const q = (Schema.is(Schema.String)(search.q) ? search.q : "").trim().slice(0, 200);
  const page = Number(search.page ?? 1);
  const result = await getCatalog(
    locale,
    JSON.stringify({ page: Number.isSafeInteger(page) && page > 0 ? page : 1, q }),
  );
  if (result.state === "unavailable") {
    return (
      <section className="mx-auto max-w-n1-content px-4 py-16">
        <h1 className="mb-4 text-xl font-bold">{d.unavailable}</h1>
        <output>{d.unavailableDescription}</output>
      </section>
    );
  }
  return (
    <>
      <CatalogView
        catalog={result.catalog}
        dictionary={d}
        locale={locale}
        title={q ? `${d.searchResults}: ${q}` : d.catalog}
      />
      {result.catalog.configured && (
        <div className="mx-auto max-w-n1-content px-4 pb-8">
          <CatalogPagination
            count={result.catalog.total}
            dictionary={d}
            page={result.catalog.page}
            pageSize={result.catalog.pageSize}
            pathname={`/${locale}/vyhledavani`}
            query={new URLSearchParams({ q }).toString()}
          />
        </div>
      )}
    </>
  );
};

export default SearchPage;
