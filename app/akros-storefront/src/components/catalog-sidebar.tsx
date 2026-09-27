import NextLink from "next/link";

import { cs } from "@/i18n/cs";
import {
  getCategoryBySlug,
  getCategoryTrail,
  getChildCategories,
  getTopCategories,
} from "@/mock-storefront/catalog";

export function CatalogSidebar({ activeSlug }: { activeSlug?: string }) {
  const activeCategory = activeSlug ? getCategoryBySlug(activeSlug) : undefined;
  const activeTrail = activeCategory ? getCategoryTrail(activeCategory) : [];
  const activeIds = new Set(activeTrail.map((category) => category.id));
  const activeRootId = activeTrail.at(0)?.id;

  const navigation = () => (
    <nav className="akros-sidebar__nav" aria-label={cs.catalog.title}>
      {getTopCategories().map((category) => {
        const showChildren = category.id === activeRootId;

        return (
          <div className="akros-sidebar__branch" key={category.id}>
            <NextLink
              aria-current={activeCategory?.id === category.id ? "page" : undefined}
              className="akros-sidebar__link"
              data-active={activeIds.has(category.id) || undefined}
              href={`/kategorie/${category.slug}`}
            >
              <span>{category.name}</span>
              <span aria-hidden="true">›</span>
            </NextLink>
            {showChildren && (
              <div className="akros-sidebar__children">
                {getChildCategories(category.id).map((child) => (
                  <NextLink
                    aria-current={activeCategory?.id === child.id ? "page" : undefined}
                    className="akros-sidebar__child-link"
                    data-active={activeIds.has(child.id) || undefined}
                    href={`/kategorie/${child.slug}`}
                    key={child.id}
                  >
                    {child.name}
                  </NextLink>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </nav>
  );

  return (
    <aside className="akros-sidebar" aria-label={cs.catalog.title}>
      <div className="akros-sidebar__desktop">
        <h2>{cs.catalog.title}</h2>
        <p>{cs.catalog.description}</p>
        {navigation()}
      </div>
      <details className="akros-sidebar__mobile">
        <summary>{cs.catalog.title}</summary>
        <p>{cs.catalog.description}</p>
        {navigation()}
      </details>
    </aside>
  );
}
