import type { Metadata } from "next";
import { getBrand } from "@/brand";
import { SimpleContentPage } from "@/components/simple-content-page";
import { contentLocale } from "@/content/locale";
import { termsPage } from "@/content/pages";
import { getDictionary } from "@/ontos/active-market";

export async function generateMetadata(): Promise<Metadata> {
  const page = termsPage[await contentLocale()](getBrand().name);
  return { title: page.title };
}

export default async function TermsPage() {
  const [locale, { header }] = await Promise.all([contentLocale(), getDictionary()]);
  const page = termsPage[locale](getBrand().name);
  return (
    <SimpleContentPage
      homeLabel={header.home}
      title={page.title}
      lead={page.lead}
      sections={page.sections}
    />
  );
}
