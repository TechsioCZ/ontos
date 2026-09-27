import type { Metadata } from "next";
import Image from "next/image";
import { Badge } from "@techsio/ui-kit/atoms/badge";
import { Input } from "@techsio/ui-kit/atoms/input";

import { PrimaryLinkButton } from "@/components/primary-link-button";
import { StorefrontWideShell } from "@/components/storefront-shell";
import { blogArticles } from "@/mock-storefront/fixtures/content";

export const metadata: Metadata = { title: "Blog" };

export default function BlogPage() {
  return (
    <StorefrontWideShell>
      <article className="akros-blog-page">
        <section className="akros-blog-featured" aria-labelledby="featured-article-title">
          <Image
            alt="Nerezové šrouby třídy A2 a A4"
            height={800}
            loading="eager"
            priority
            sizes="(max-width: 760px) 100vw, 46vw"
            src="/akros/content/blog-featured.png"
            width={1200}
          />
          <div>
            <p className="akros-blog-meta">
              <Badge size="sm" variant="primary">
                NÁVODY A RADY
              </Badge>
              <span>12. února 2026</span>
            </p>
            <h1 id="featured-article-title">
              Nerezová ocel A2 vs A4: Kompletní průvodce pro správnou volbu
            </h1>
            <p>
              Často se setkáváme s otázkou, který nerezový spojovací materiál zvolit. Je pro
              venkovní terasu lepší A2, nebo kyselinovzdorná A4? Podíváme se na odolnost vůči solím
              a praktické příklady z praxe.
            </p>
            <div className="akros-blog-featured__actions">
              <PrimaryLinkButton href="#nejnovejsi">Přečíst celý článek</PrimaryLinkButton>
              <span>Doba čtení: 6 min</span>
            </div>
          </div>
        </section>

        <div className="akros-blog-layout" id="nejnovejsi">
          <section aria-labelledby="latest-posts-title">
            <h2 id="latest-posts-title">Nejnovější příspěvky</h2>
            <div className="akros-blog-grid">
              {blogArticles.map((article) => (
                <article className="akros-blog-card" key={article.title}>
                  <Image
                    alt=""
                    height={360}
                    loading="lazy"
                    sizes="(max-width: 760px) 100vw, 440px"
                    src={article.imageSrc}
                    width={864}
                  />
                  <div className="akros-blog-card__content">
                    <p className="akros-blog-meta">
                      <Badge size="sm" variant="primary">
                        {article.category.toUpperCase()}
                      </Badge>
                      <span>{article.date}</span>
                    </p>
                    <h3>{article.title}</h3>
                    <p>{article.excerpt}</p>
                    <a href="#featured-article-title">Číst více →</a>
                  </div>
                </article>
              ))}
            </div>
          </section>
          <aside className="akros-blog-sidebar" aria-label="Nástroje blogu">
            <section>
              <h2>Hledat v článcích</h2>
              <Input
                aria-label="Hledat v článcích"
                placeholder="Zadejte hledané slovo…"
                type="search"
              />
            </section>
            <section>
              <h2>Populární témata</h2>
              <ul>
                <li># nerez-a2-vs-a4</li>
                <li># fotovoltaika-montaz</li>
                <li># utahovaci-momenty</li>
                <li># normy-din-iso</li>
              </ul>
            </section>
          </aside>
        </div>
      </article>
    </StorefrontWideShell>
  );
}
