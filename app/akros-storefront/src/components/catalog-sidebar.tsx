"use client";

import { VerticalNavigation } from "@techsio/ui-kit/molecules/vertical-navigation";
import NextLink from "next/link";

import { cs } from "@/i18n/cs";
import type { CatalogCategory } from "@/mock-storefront/types";

interface CategoryNavigationItemProps {
  activeIds: ReadonlySet<string>;
  category: CatalogCategory;
  currentCategoryId?: string;
  depth?: number;
  navigationId: string;
  categories: CatalogCategory[];
}

function CategoryNavigationItem({
  activeIds,
  category,
  currentCategoryId,
  depth = 0,
  navigationId,
  categories,
}: CategoryNavigationItemProps) {
  const children = categories.filter((candidate) => candidate.parentId === category.id);
  const href = `/kategorie/${category.slug}`;
  const isCurrent = currentCategoryId === category.id;
  const isOnCurrentPath = activeIds.has(category.id);
  const visualDepth = Math.min(depth, 4);

  if (children.length === 0) {
    return (
      <VerticalNavigation.Item>
        <VerticalNavigation.Link
          as={NextLink}
          current={isCurrent}
          data-akros-depth={visualDepth}
          href={href}
        >
          {category.name}
        </VerticalNavigation.Link>
      </VerticalNavigation.Item>
    );
  }

  return (
    <VerticalNavigation.Branch
      containsCurrent={isOnCurrentPath}
      defaultOpen={isOnCurrentPath}
      id={`${navigationId}-${category.id}`}
    >
      <VerticalNavigation.Row data-akros-depth={visualDepth}>
        <VerticalNavigation.Link as={NextLink} current={isCurrent} href={href}>
          {category.name}
        </VerticalNavigation.Link>
        <VerticalNavigation.BranchTrigger aria-label={category.name}>
          <VerticalNavigation.BranchIndicator />
        </VerticalNavigation.BranchTrigger>
      </VerticalNavigation.Row>
      <VerticalNavigation.BranchContent indent>
        <VerticalNavigation.List>
          {children.map((child) => (
            <CategoryNavigationItem
              activeIds={activeIds}
              category={child}
              currentCategoryId={currentCategoryId}
              depth={depth + 1}
              key={child.id}
              navigationId={navigationId}
              categories={categories}
            />
          ))}
        </VerticalNavigation.List>
      </VerticalNavigation.BranchContent>
    </VerticalNavigation.Branch>
  );
}

export function CatalogSidebar({
  activeSlug,
  categories,
}: {
  activeSlug?: string;
  categories: CatalogCategory[];
}) {
  const activeCategory = activeSlug
    ? categories.find((category) => category.slug === activeSlug)
    : undefined;
  const activeTrail: CatalogCategory[] = [];
  let trailCategory = activeCategory;
  while (trailCategory) {
    activeTrail.unshift(trailCategory);
    trailCategory = trailCategory.parentId
      ? categories.find((category) => category.id === trailCategory?.parentId)
      : undefined;
  }
  const activeIds = new Set(activeTrail.map((category) => category.id));
  const topCategories = categories.filter((category) => category.parentId === null);

  const navigation = (navigationId: "catalog-desktop" | "catalog-mobile") => (
    <VerticalNavigation
      aria-label={cs.catalog.title}
      data-akros-catalog=""
      key={`${navigationId}-${activeSlug ?? "catalog"}`}
      maxIndentDepth={3}
      size="sm"
    >
      <VerticalNavigation.Group tone="plain">
        <VerticalNavigation.List>
          {topCategories.map((category) => (
            <CategoryNavigationItem
              activeIds={activeIds}
              category={category}
              currentCategoryId={activeCategory?.id}
              key={category.id}
              navigationId={navigationId}
              categories={categories}
            />
          ))}
        </VerticalNavigation.List>
      </VerticalNavigation.Group>
    </VerticalNavigation>
  );

  return (
    <aside className="akros-sidebar" aria-label={cs.catalog.title}>
      <div className="akros-sidebar__desktop">
        <h2>{cs.catalog.title}</h2>
        <p>{cs.catalog.description}</p>
        {navigation("catalog-desktop")}
      </div>
      <details className="akros-sidebar__mobile">
        <summary>{cs.catalog.title}</summary>
        <p>{cs.catalog.description}</p>
        {navigation("catalog-mobile")}
      </details>
    </aside>
  );
}
