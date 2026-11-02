import type { Metadata } from "next";

import { getBrand } from "@/brand";
import { ContactForm } from "@/components/contact-form";
import { StorefrontShell } from "@/components/storefront-shell";
import { contentLocale } from "@/content/locale";
import { claimsCopy } from "@/content/pages";

export async function generateMetadata(): Promise<Metadata> {
  return { title: claimsCopy[await contentLocale()].title };
}

export default async function ClaimsPage() {
  const copy = claimsCopy[await contentLocale()];
  return (
    <StorefrontShell>
      <article className="sf-content-page">
        <h1>{copy.title}</h1>
        <p>{copy.intro(getBrand().name)}</p>
        <ContactForm kind="COMPLAINT" />
      </article>
    </StorefrontShell>
  );
}
