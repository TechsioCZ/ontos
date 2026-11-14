import type { Metadata } from "next";
import Image from "next/image";
import { Badge } from "@techsio/ui-kit/atoms/badge";
import { Input } from "@techsio/ui-kit/atoms/input";

import { PrimaryLinkButton } from "@/components/primary-link-button";
import { ContentLink } from "@/components/content-link";
import { StorefrontWideShell } from "@/components/storefront-shell";
import { brandLocale, getBrand } from "@/brand";
import { contentLocale } from "@/content/locale";
import { blogCopy } from "@/content/pages";

export async function generateMetadata(): Promise<Metadata> {
  return { title: blogCopy[await contentLocale()].title };
}

export default async function BlogPage() {
  const locale = await contentLocale();
  const { blog } = getBrand().pages;
  const copy = blogCopy[locale];
  const articles = blog.articles[brandLocale(locale)];
  return (
    <StorefrontWideShell>
      <article className="sf-blog-page">
        <section className="sf-blog-featured" aria-labelledby="featured-article-title">
          <Image
            alt={copy.featuredAlt}
            height={800}
            loading="eager"
            priority
            sizes="(max-width: 760px) 100vw, 46vw"
            src={blog.featuredImage}
            width={1200}
          />
          <div>
            <p className="sf-blog-meta">
              <Badge size="sm" variant="primary">
                {copy.badge}
              </Badge>
              <span>{copy.date}</span>
            </p>
            <h1 id="featured-article-title">{copy.featuredTitle}</h1>
            <p>{copy.featuredExcerpt}</p>
            <div className="sf-blog-featured__actions">
              <PrimaryLinkButton href="#nejnovejsi">{copy.readFull}</PrimaryLinkButton>
              <span>{copy.readingTime}</span>
            </div>
          </div>
        </section>

        <div className="sf-blog-layout" id="nejnovejsi">
          <section aria-labelledby="latest-posts-title">
            <h2 id="latest-posts-title">{copy.latest}</h2>
            <div className="sf-blog-grid">
              {articles.map((article) => (
                <article className="sf-blog-card" key={article.title}>
                  <Image
                    alt=""
                    height={360}
                    loading="lazy"
                    sizes="(max-width: 760px) 100vw, 440px"
                    src={article.imageSrc}
                    width={864}
                  />
                  <div className="sf-blog-card__content">
                    <p className="sf-blog-meta">
                      <Badge size="sm" variant="primary">
                        {article.category.toUpperCase()}
                      </Badge>
                      <span>{article.date}</span>
                    </p>
                    <h3>{article.title}</h3>
                    <p>{article.excerpt}</p>
                    <ContentLink
                      href="#featured-article-title"
                      theme="borderless"
                      variant="secondary"
                      size="current"
                      className="inline"
                    >
                      {copy.readMore}
                    </ContentLink>
                  </div>
                </article>
              ))}
            </div>
          </section>
          <aside className="sf-blog-sidebar" aria-label={copy.toolsLabel}>
            <section>
              <h2>{copy.searchHeading}</h2>
              <Input
                aria-label={copy.searchLabel}
                placeholder={copy.searchPlaceholder}
                type="search"
              />
            </section>
            <section>
              <h2>{copy.popularHeading}</h2>
              <ul>
                {copy.tags.map((tag) => (
                  <li key={tag}>{tag}</li>
                ))}
              </ul>
            </section>
          </aside>
        </div>
      </article>
    </StorefrontWideShell>
  );
}
