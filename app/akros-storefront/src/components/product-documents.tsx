import type { CatalogDocument } from "@/ontos/catalog-types";

/** Downloadable product documents set by staff in OntOS. */
export function ProductDocuments({
  documents,
  title,
}: {
  documents: CatalogDocument[];
  title: string;
}) {
  if (!documents.length) return null;
  return (
    <section className="sf-product-detail__documents" aria-labelledby="product-documents-title">
      <h3 id="product-documents-title">{title}</h3>
      <ul>
        {documents.map((document) => (
          <li key={document.url}>
            <a href={document.url} target="_blank" rel="noopener">
              {document.label}
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
