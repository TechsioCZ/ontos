import { createHash } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "@rstest/core";
import { legalArticles } from "../src/content/legal-content";
import { LegalView } from "../src/features/legal-view";

/** Independent checksums of the ordered legacy Heading/h2/h3/p/li text, whitespace normalized.
 * They protect transcription of the supplied copy; they are not runtime policy versions.
 */
const sourceCopies = [
  ["obchodni-podminky", 21, "5bc3f86de0e59720d2f6f932b535fc0a707f1255a92c2efb21c08ac525081f92"],
  [
    "ochrana-osobnich-udaju",
    18,
    "6f689af9103b46d6ed903ed5f62458d28b762f8160eecd45f7b3a21970976536",
  ],
] as const;

describe("provided static legal documents", () => {
  it.each(sourceCopies)(
    "preserves the complete ordered %s source copy",
    (slug, count, checksum) => {
      const html = renderToStaticMarkup(<LegalView article={legalArticles[slug]} />);
      const paragraphs = [
        ...html.matchAll(/<(?<tag>h1|h2|h3|p|li)\b[^>]*>(?<text>[\s\S]*?)<\/\k<tag>>/gu),
      ].map((match) =>
        (match.groups?.text ?? "")
          .replaceAll(/<[^>]+>/gu, "")
          .replaceAll(/\s+/gu, " ")
          .trim(),
      );
      expect(paragraphs).toHaveLength(count);
      expect(createHash("sha256").update(paragraphs.join("\n")).digest("hex")).toBe(checksum);
      expect(html).toContain('lang="cs"');
      expect(html.match(/<h1\b/gu)).toHaveLength(1);
      expect(html).not.toContain("<form");
      expect(html).not.toContain("<output");
      expect(html).not.toContain("<script");
    },
  );
  it("retains the supplied heading hierarchy and real semantic lists", () => {
    const terms = renderToStaticMarkup(<LegalView article={legalArticles["obchodni-podminky"]} />);
    const privacy = renderToStaticMarkup(
      <LegalView article={legalArticles["ochrana-osobnich-udaju"]} />,
    );
    expect(terms.match(/<h2\b/gu)).toHaveLength(1);
    expect(terms.match(/<h3\b/gu)).toHaveLength(4);
    expect(terms.match(/<li\b/gu)).toHaveLength(4);
    expect(privacy.match(/<h2\b/gu)).toHaveLength(5);
    expect(privacy).not.toContain("<h3");
    expect(privacy.match(/<li\b/gu)).toHaveLength(3);
  });
});
