import Image from "next/image";
import StoreLink from "@/components/store-link";

import { categoryImage } from "@/lib/category-presentation";
import type { Dictionary } from "@/i18n";
import type { CatalogCategory } from "@/ontos/catalog-types";

export function CategoryGrid({
  categories,
  dictionary,
}: {
  categories: CatalogCategory[];
  /** The page's market dictionary (server component: no client context). */
  dictionary?: Dictionary;
}) {
  if (categories.length === 0) return null;

  return (
    <div className="sf-category-grid">
      {categories.map((category) => {
        const image = categoryImage(category, dictionary);
        return (
          <StoreLink
            className="sf-category-card"
            href={`/kategorie/${category.slug}`}
            key={category.id}
          >
            {image && (
              <Image
                alt={image.alt}
                height={144}
                loading="lazy"
                sizes="(max-width: 430px) 50vw, (max-width: 1100px) 25vw, 180px"
                src={image.src}
                width={180}
              />
            )}
            <strong>{category.name}</strong>
          </StoreLink>
        );
      })}
    </div>
  );
}
