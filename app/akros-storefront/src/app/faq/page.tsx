import type { Metadata } from "next";

import { getBrand } from "@/brand";
import { FaqExplorer } from "@/components/faq-explorer";
import { ContactForm } from "@/components/contact-form";
import { StorefrontWideShell } from "@/components/storefront-shell";
import { contentLocale } from "@/content/locale";
import { faqCopy } from "@/content/editorial";

export async function generateMetadata(): Promise<Metadata> {
  const locale = await contentLocale();
  return { title: faqCopy[locale](getBrand().contact.inquiryEmail).chrome.pageTitle };
}

export default async function FaqPage() {
  const faq = faqCopy[await contentLocale()](getBrand().contact.inquiryEmail);
  return (
    <StorefrontWideShell fullBleed>
      <article className="sf-faq-page">
        <FaqExplorer faq={faq} />
        <section className="sf-faq-contact" aria-labelledby="faq-contact-title">
          <h2 id="faq-contact-title">{faq.chrome.contactHeading}</h2>
          <p>{faq.chrome.contactText}</p>
          <ContactForm compact />
        </section>
      </article>
    </StorefrontWideShell>
  );
}
