import { notFound } from "next/navigation";
import { getDictionary } from "@/i18n";
import { ContactView } from "@/features/contact-view";
import { FulfillmentView } from "@/features/fulfillment-view";
import { getFulfillment } from "@/ontos/fulfillment";
import { AuthView } from "@/features/auth-view";
import { Schema } from "effect";
import { PortalVerificationNoticeSchema } from "@/ontos/portal";
import { legalArticles } from "@/content/legal-content";
import { LegalView } from "@/features/legal-view";

const ContentPage = async ({
  params,
  searchParams,
}: {
  params: Promise<{ content: string; locale: string }>;
  searchParams: Promise<{ verification?: string | string[] }>;
}) => {
  const { content, locale } = await params;
  const d = getDictionary(locale);
  if (content === "prihlaseni" || content === "registrace") {
    const { verification } = await searchParams;
    return (
      <AuthView
        dictionary={d}
        key={content}
        locale={locale}
        mode={content === "registrace" ? "register" : "login"}
        verification={
          content === "prihlaseni" && Schema.is(PortalVerificationNoticeSchema)(verification)
            ? verification
            : undefined
        }
      />
    );
  }
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
  if (content === "doprava" || content === "platba") {
    return (
      <FulfillmentView
        dictionary={d}
        kind={content === "doprava" ? "shipping" : "payment"}
        locale={locale}
        result={await getFulfillment(locale)}
      />
    );
  }
  if (content === "kontakty") {
    return <ContactView dictionary={d} />;
  }
  if (content === "obchodni-podminky" || content === "ochrana-osobnich-udaju") {
    return <LegalView article={legalArticles[content]} />;
  }
  return (
    <article className="mx-auto max-w-n1-content px-4 py-12">
      <h1 className="mb-8 text-xl font-bold">{title}</h1>
      <output>{d.featureUnavailable}</output>
    </article>
  );
};

export default ContentPage;
