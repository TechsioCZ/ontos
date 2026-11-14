import type { Metadata } from "next";
import { getBrand } from "@/brand";
import { SimpleContentPage } from "@/components/simple-content-page";
import { contentLocale } from "@/content/locale";
import { partnerPage } from "@/content/pages";
import { getDictionary } from "@/ontos/active-market";

export async function generateMetadata(): Promise<Metadata> {
  const page = partnerPage[await contentLocale()](getBrand().name);
  return { title: page.title };
}

export default async function PartnerPage() {
  const [locale, { header }] = await Promise.all([contentLocale(), getDictionary()]);
  const page = partnerPage[locale](getBrand().name);
  return (
    <SimpleContentPage
      homeLabel={header.home}
      title={page.title}
      lead={page.lead}
      sections={page.sections}
    />
  );
}
