import { StorefrontBreadcrumbs } from "@/components/storefront-breadcrumbs";
import { StorefrontShell } from "@/components/storefront-shell";

export function SimpleContentPage({
  homeLabel,
  title,
  lead,
  sections,
}: {
  homeLabel: string;
  title: string;
  lead: string;
  sections: readonly { title: string; paragraphs: readonly string[] }[];
}) {
  return (
    <StorefrontShell>
      <StorefrontBreadcrumbs items={[{ href: "/", label: homeLabel }, { label: title }]} />
      <article className="sf-content-page">
        <header className="sf-content-page__heading">
          <h1>{title}</h1>
          <p>{lead}</p>
        </header>
        {sections.map((section) => (
          <section className="sf-content-panel" key={section.title}>
            <h2>{section.title}</h2>
            {section.paragraphs.map((paragraph) => (
              <p key={paragraph}>{paragraph}</p>
            ))}
          </section>
        ))}
      </article>
    </StorefrontShell>
  );
}
