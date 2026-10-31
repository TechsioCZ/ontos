import type { Metadata } from "next";
import Image from "next/image";

import { ContactForm } from "@/components/contact-form";
import { StorefrontBreadcrumbs } from "@/components/storefront-breadcrumbs";
import { StorefrontShell } from "@/components/storefront-shell";
import { readProducts } from "@/ontos/catalog-server";
import { branches } from "@/content/editorial";

export const metadata: Metadata = { title: "Kontakty" };

export default async function ContactsPage({
  searchParams,
}: {
  searchParams: Promise<{ productId?: string }>;
}) {
  const { productId } = await searchParams;
  const product = productId
    ? (await readProducts({ productIds: [productId], pageSize: 1 }, "card", true)).products.find(
        (item) => item.id === productId,
      )
    : undefined;
  return (
    <StorefrontShell>
      <StorefrontBreadcrumbs items={[{ href: "/", label: "Domů" }, { label: "Kontakty" }]} />
      <article className="akros-content-page">
        <header className="akros-content-page__heading">
          <h1>Kontakty</h1>
          <nav className="akros-anchor-nav" aria-label="Pobočky a kontaktní formulář">
            {branches.map((branch) => (
              <a href={`#${branch.id}`} key={branch.id}>
                {branch.city}
              </a>
            ))}
            <a href="#primy-kontakt">Přímé kontakty</a>
          </nav>
        </header>

        {branches.map((branch) => (
          <section className="akros-branch" id={branch.id} key={branch.id}>
            <h2>{branch.title}</h2>
            <div className="akros-branch__body">
              <Image
                alt={`Mapa pobočky ${branch.city}`}
                height={420}
                loading="lazy"
                sizes="(max-width: 760px) 100vw, 520px"
                src={branch.mapSrc}
                width={760}
              />
              <address>
                <span>{branch.address}</span>
                {branch.details && <span>{branch.details}</span>}
                <a href={`tel:+420${branch.phone.replaceAll(" ", "")}`}>Telefon: {branch.phone}</a>
              </address>
            </div>
          </section>
        ))}

        <section className="akros-content-section" id="primy-kontakt">
          <h2>Kontaktní formulář</h2>
          <ContactForm
            kind={productId ? "PRODUCT_QUESTION" : "CONTACT"}
            {...(productId ? { productId } : {})}
            {...(product ? { productName: product.name } : {})}
          />
        </section>
      </article>
    </StorefrontShell>
  );
}
