import type { Metadata } from "next";
import Image from "next/image";

import { ContactForm } from "@/components/contact-form";
import { ContentLink } from "@/components/content-link";
import { StorefrontBreadcrumbs } from "@/components/storefront-breadcrumbs";
import { StorefrontShell } from "@/components/storefront-shell";
import { getDictionary } from "@/ontos/active-market";
import { readProducts } from "@/ontos/catalog-server";
import { getBrand } from "@/brand";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getDictionary()).header.contacts };
}

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
/** `variantIds=a,b` (or repeated): unique, non-empty, bounded. */
const parseVariantIds = (value: string | string[] | undefined) =>
  [
    ...new Set(
      (Array.isArray(value) ? value : [value ?? ""])
        .flatMap((part) => part.split(","))
        .map((id) => id.trim())
        .filter(Boolean),
    ),
  ].slice(0, 50);

export default async function ContactsPage({
  searchParams,
}: {
  searchParams: Promise<{ productId?: string | string[]; variantIds?: string | string[] }>;
}) {
  const query = await searchParams;
  const productId = first(query.productId);
  const variantIds = productId ? parseVariantIds(query.variantIds) : [];
  // Product questions name the product and the selected variants as OntOS has them now.
  const product = productId
    ? (
        await readProducts(
          variantIds.length
            ? { productIds: [productId], variantIds, pageSize: 1 }
            : { productIds: [productId], pageSize: 1 },
          variantIds.length ? "full" : "card",
          true,
        )
      ).products.find((item) => item.id === productId)
    : undefined;
  const variants = product
    ? product.detail.variants.filter((variant) => variantIds.includes(variant.id))
    : [];
  const { contact, header } = await getDictionary();
  const defaultMessage = product
    ? [
        contact.productLine(product.name),
        contact.productCode(product.sku),
        ...variants.map((variant) => contact.variantLine(variant.sku, variant.label)),
        "",
        contact.question,
        "",
      ].join("\n")
    : undefined;
  const { branches } = getBrand().pages;
  return (
    <StorefrontShell>
      <StorefrontBreadcrumbs
        items={[{ href: "/", label: header.home }, { label: header.contacts }]}
      />
      <article className="sf-content-page">
        <header className="sf-content-page__heading">
          <h1>{header.contacts}</h1>
          <nav className="sf-anchor-nav" aria-label={contact.page.anchorNavigation}>
            {branches.map((branch) => (
              <ContentLink
                href={`#${branch.id}`}
                key={branch.id}
                theme="outlined"
                variant="secondary"
                size="sm"
                className="block"
              >
                {branch.city}
              </ContentLink>
            ))}
            <ContentLink
              href="#primy-kontakt"
              theme="outlined"
              variant="secondary"
              size="sm"
              className="block"
            >
              {contact.page.directContacts}
            </ContentLink>
          </nav>
        </header>

        {branches.map((branch) => (
          <section className="sf-branch" id={branch.id} key={branch.id}>
            <h2>{branch.title}</h2>
            <div className="sf-branch__body">
              {branch.mapSrc && (
                <Image
                  alt={contact.page.mapAlt(branch.city)}
                  height={420}
                  loading="lazy"
                  sizes="(max-width: 760px) 100vw, 520px"
                  src={branch.mapSrc}
                  width={760}
                />
              )}
              <address>
                <span>{branch.address}</span>
                {branch.details && <span>{branch.details}</span>}
                {branch.phone && (
                  <a href={`tel:+420${branch.phone.replaceAll(" ", "")}`}>
                    {contact.page.phone}: {branch.phone}
                  </a>
                )}
                {branch.email && (
                  <a href={`mailto:${branch.email}`}>
                    {contact.page.email}: {branch.email}
                  </a>
                )}
              </address>
            </div>
          </section>
        ))}

        <section className="sf-content-section" id="primy-kontakt">
          <h2>{contact.page.formTitle}</h2>
          <ContactForm
            key={`${product?.id ?? "general"}:${variants.map((item) => item.id).join(",")}`}
            kind={productId ? "PRODUCT_QUESTION" : "CONTACT"}
            {...(defaultMessage ? { defaultMessage } : {})}
            {...(productId ? { productId } : {})}
            {...(product ? { productName: product.name } : {})}
          />
        </section>
      </article>
    </StorefrontShell>
  );
}
