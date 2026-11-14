import type { LegalArticle } from "@/content/legal-content";

/** Semantic rendering of the supplied static document; site chrome owns its own locale. */
export const LegalView = ({ article }: { article: LegalArticle }) => {
  const SectionHeading = article.kind === "privacy" ? "h2" : "h3";
  return (
    <article
      className="mx-auto w-full max-w-n1-content p-10 text-md leading-6 text-fg-secondary"
      lang={article.language}
    >
      <div className={article.kind === "privacy" ? "space-y-6 pt-12" : "space-y-6"}>
        <h1 className="relative text-xl leading-8 font-bold text-fg-primary">
          {article.title}
          <span aria-hidden="true" className="absolute bottom-0 left-0 h-1 w-24 bg-primary" />
        </h1>
        {article.subtitle !== undefined && (
          <h2 className="text-lg leading-normal font-semibold text-fg-primary">
            {article.subtitle}
          </h2>
        )}
        {article.sections.map((section) => (
          <section className="space-y-4" key={section.heading ?? article.title}>
            {section.heading !== undefined && (
              <SectionHeading
                className={
                  article.kind === "privacy"
                    ? "text-lg leading-normal font-semibold text-fg-primary"
                    : "text-lg leading-normal font-normal text-fg-primary"
                }
              >
                {section.heading}
              </SectionHeading>
            )}
            {section.blocks.map((block) => {
              if (block.kind === "paragraph") {
                return <p key={block.text}>{block.text}</p>;
              }
              if (block.kind === "group") {
                return (
                  <div className="space-y-2" key={block.paragraphs[0]}>
                    {block.paragraphs.map((paragraph) => (
                      <p key={paragraph}>{paragraph}</p>
                    ))}
                  </div>
                );
              }
              return (
                <ul
                  className={
                    article.kind === "privacy"
                      ? "ml-4 list-inside list-disc space-y-2"
                      : "list-inside list-disc space-y-2"
                  }
                  key={block.items[0]}
                >
                  {block.items.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              );
            })}
          </section>
        ))}
      </div>
    </article>
  );
};
