import { notFound } from "next/navigation";
import { getDictionary } from "@/i18n";
import { ContactView } from "@/features/contact-view";

const ContentPage = async ({
  params,
}: {
  params: Promise<{ content: string; locale: string }>;
}) => {
  const { content, locale } = await params;
  const d = getDictionary(locale);
  const titles = {
    doprava: d.shipping,
    kontakty: d.contacts,
    novinky: d.news,
    "obchodni-podminky": d.terms,
    "ochrana-osobnich-udaju": d.privacy,
    platba: d.payment,
  };
  const title = Object.entries(titles).find(([key]) => key === content)?.[1];
  if (title === undefined) {
    notFound();
  }
  if (content === "kontakty") {
    return <ContactView dictionary={d} />;
  }
  return (
    <article className="mx-auto max-w-n1-content px-4 py-12">
      <h1 className="mb-8 text-xl font-bold">{title}</h1>
      <output>{d.featureUnavailable}</output>
    </article>
  );
};

export default ContentPage;
