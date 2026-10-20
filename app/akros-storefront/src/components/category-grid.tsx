import Image from "next/image";
import NextLink from "next/link";

import { categoryImage } from "@/lib/category-presentation";
import type { CatalogCategory } from "@/mock-storefront/types";

export function CategoryGrid({ categories }: { categories: CatalogCategory[] }) {
  if (categories.length === 0) return null;

  return (
    <div className="akros-category-grid">
      {categories.map((category) => {
        const image = categoryImage(category);
        return (
          <NextLink
            className="akros-category-card"
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
          </NextLink>
        );
      })}
    </div>
  );
}
