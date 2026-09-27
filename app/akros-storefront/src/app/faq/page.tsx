import type { Metadata } from "next";
import { Badge } from "@techsio/ui-kit/atoms/badge";

import { FaqExplorer } from "@/components/faq-explorer";
import { MockContactForm } from "@/components/mock-contact-form";
import { StorefrontWideShell } from "@/components/storefront-shell";

export const metadata: Metadata = { title: "Často kladené otázky" };

export default function FaqPage() {
  return (
    <StorefrontWideShell>
      <article className="akros-faq-page">
        <header className="akros-faq-hero">
          <Badge size="sm" variant="primary">
            ZÁKAZNICKÁ PODPORA
          </Badge>
          <h1>Jak vám můžeme dnes pomoci?</h1>
        </header>
        <FaqExplorer />
        <section className="akros-faq-contact" aria-labelledby="faq-contact-title">
          <h2 id="faq-contact-title">Nenašli jste odpověď?</h2>
          <p>Napište nám svůj dotaz a naši specialisté na spojovací materiál se vám ozvou.</p>
          <MockContactForm compact />
        </section>
      </article>
    </StorefrontWideShell>
  );
}
