import { notFound } from "next/navigation";
import { getDictionary } from "@/i18n";
import { ContactView } from "@/features/contact-view";
import { FulfillmentView } from "@/features/fulfillment-view";
import { getFulfillment } from "@/ontos/fulfillment";
import { AuthView } from "@/features/auth-view";
import { Effect, Schema } from "effect";
import { parseInquiryProductQuery } from "@/ontos/inquiry";
import { readInquiryProduct } from "@/ontos/inquiry-server";
import { storefrontRuntime } from "@/ontos/runtime";
import { PortalVerificationNoticeSchema } from "@/ontos/portal";
import { legalArticles } from "@/content/legal-content";
import { LegalView } from "@/features/legal-view";

const ContentPage = async ({
  params,
  searchParams,
}: {
  params: Promise<{ content: string; locale: string }>;
  searchParams: Promise<{
    productId?: string | string[];
    variantIds?: string | string[];
    verification?: string | string[];
  }>;
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
    const question = parseInquiryProductQuery(await searchParams);
    if (question.state === "none") {
      return <ContactView dictionary={d} />;
    }
    if (question.state === "invalid") {
      notFound();
    }
    const result = await storefrontRuntime.runPromise(
      readInquiryProduct(locale, question.selector).pipe(
        Effect.match({
          onFailure: (failure) =>
            failure.reason === "invalid"
              ? { state: "invalid" as const }
              : { state: "unavailable" as const },
          onSuccess: (product) => ({ product, state: "ready" as const }),
        }),
      ),
    );
    if (result.state === "invalid") {
      notFound();
    }
    return <ContactView dictionary={d} key={JSON.stringify(question.selector)} question={result} />;
  }

  if (content === "obchodni-podminky" || content === "ochrana-osobnich-udaju") {
    return <LegalView article={legalArticles[content]} />;
  }
  return (
    <article className="mx-auto w-full max-w-n1-content p-10">
      <h1 className="relative text-xl font-bold leading-8">
        {title}
        <span aria-hidden="true" className="absolute bottom-0 left-0 h-1 w-24 bg-primary" />
      </h1>
      <output className="mt-6 block py-20 text-center text-md leading-6 text-fg-secondary">
        {d.featureUnavailable}
      </output>
    </article>
  );
};

export default ContentPage;
