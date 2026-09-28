"use client";

import { VerticalNavigation } from "@techsio/ui-kit/molecules/vertical-navigation";
import NextLink from "next/link";

import { cs } from "@/i18n/cs";
import {
  getCategoryBySlug,
  getCategoryTrail,
  getChildCategories,
  getTopCategories,
} from "@/mock-storefront/catalog";
import type { CatalogCategory } from "@/mock-storefront/types";

interface CategoryNavigationItemProps {
  activeIds: ReadonlySet<string>;
  category: CatalogCategory;
  currentCategoryId?: string;
  depth?: number;
  navigationId: string;
}

function CategoryNavigationItem({
  activeIds,
  category,
  currentCategoryId,
  depth = 0,
  navigationId,
}: CategoryNavigationItemProps) {
  const children = getChildCategories(category.id);
  const href = `/kategorie/${category.slug}`;
  const isCurrent = currentCategoryId === category.id;
  const isOnCurrentPath = activeIds.has(category.id);

  if (children.length === 0) {
    return (
      <VerticalNavigation.Item>
        <VerticalNavigation.Link as={NextLink} current={isCurrent} href={href}>
          {category.name}
        </VerticalNavigation.Link>
      </VerticalNavigation.Item>
    );
  }

  const nestedTone = depth === 0 ? "subtle" : "accent";
  const nestedVariant = depth > 1 && depth % 2 === 0 ? "secondary" : "primary";

  return (
    <VerticalNavigation.Branch
      containsCurrent={isOnCurrentPath}
      defaultOpen={isOnCurrentPath}
      id={`${navigationId}-${category.id}`}
    >
      <VerticalNavigation.Row>
        <VerticalNavigation.Link as={NextLink} current={isCurrent} href={href}>
          {category.name}
        </VerticalNavigation.Link>
        <VerticalNavigation.BranchTrigger aria-label={category.name}>
          <VerticalNavigation.BranchIndicator />
        </VerticalNavigation.BranchTrigger>
      </VerticalNavigation.Row>
      <VerticalNavigation.BranchContent indent tone={nestedTone} variant={nestedVariant}>
        <VerticalNavigation.List>
          {children.map((child) => (
            <CategoryNavigationItem
              activeIds={activeIds}
              category={child}
              currentCategoryId={currentCategoryId}
              depth={depth + 1}
              key={child.id}
              navigationId={navigationId}
            />
          ))}
        </VerticalNavigation.List>
      </VerticalNavigation.BranchContent>
    </VerticalNavigation.Branch>
  );
}

export function CatalogSidebar({ activeSlug }: { activeSlug?: string }) {
  const activeCategory = activeSlug ? getCategoryBySlug(activeSlug) : undefined;
  const activeTrail = activeCategory ? getCategoryTrail(activeCategory) : [];
  const activeIds = new Set(activeTrail.map((category) => category.id));
  const topCategories = getTopCategories();
  const groupLabel = topCategories.find((category) => category.id === "category-special");
  const navigationCategories = topCategories.filter((category) => category.id !== groupLabel?.id);

  const navigation = (navigationId: "catalog-desktop" | "catalog-mobile") => (
    <VerticalNavigation
      aria-label={cs.catalog.title}
      key={`${navigationId}-${activeSlug ?? "catalog"}`}
      maxIndentDepth={3}
      size="sm"
    >
      <VerticalNavigation.Group tone="plain">
        {groupLabel && (
          <VerticalNavigation.GroupLabel>{groupLabel.name}</VerticalNavigation.GroupLabel>
        )}
        <VerticalNavigation.List>
          {navigationCategories.map((category) => (
            <CategoryNavigationItem
              activeIds={activeIds}
              category={category}
              currentCategoryId={activeCategory?.id}
              key={category.id}
              navigationId={navigationId}
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
