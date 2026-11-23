import { FavoritesView } from "@/features/favorites-view";
import { getDictionary } from "@/i18n";

const FavoritesPage = async ({ params }: { params: Promise<{ locale: string }> }) => {
  const { locale } = await params;
  const marketLocale = locale === "en" ? "en" : "cs";
  return <FavoritesView dictionary={getDictionary(marketLocale)} locale={marketLocale} />;
};
export default FavoritesPage;
