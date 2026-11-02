import type { Metadata } from "next";

import { getBrand } from "@/brand";
import { FaqExplorer } from "@/components/faq-explorer";
import { ContactForm } from "@/components/contact-form";
import { StorefrontWideShell } from "@/components/storefront-shell";
import { faqGroups } from "@/content/editorial";

export const metadata: Metadata = { title: "Často kladené otázky" };

export default function FaqPage() {
  return (
    <StorefrontWideShell fullBleed>
      <article className="sf-faq-page">
        <FaqExplorer faqGroups={faqGroups(getBrand().contact.inquiryEmail)} />
        <section className="sf-faq-contact" aria-labelledby="faq-contact-title">
          <h2 id="faq-contact-title">Nenašli jste odpověď?</h2>
          <p>Napište nám svůj dotaz a naši specialisté na spojovací materiál se vám ozvou.</p>
          <ContactForm compact />
        </section>
      </article>
    </StorefrontWideShell>
  );
}
