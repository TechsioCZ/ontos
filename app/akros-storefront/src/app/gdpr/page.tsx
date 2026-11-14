import type { Metadata } from "next";
import { getBrand } from "@/brand";
import { SimpleContentPage } from "@/components/simple-content-page";
import { contentLocale } from "@/content/locale";
import { privacyPage } from "@/content/pages";
import { getDictionary } from "@/ontos/active-market";

export async function generateMetadata(): Promise<Metadata> {
  const page = privacyPage[await contentLocale()](getBrand().name);
  return { title: page.title };
}

export default async function PrivacyPage() {
  const [locale, { header }] = await Promise.all([contentLocale(), getDictionary()]);
  const page = privacyPage[locale](getBrand().name);
  return (
    <SimpleContentPage
      homeLabel={header.home}
      title={page.title}
      lead={page.lead}
      sections={page.sections}
    />
  );
}
