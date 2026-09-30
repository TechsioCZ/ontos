"use client";

import { Icon } from "@techsio/ui-kit/atoms/icon";
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
  expandRoots: boolean;
}

const akrosProductionUrl = "https://www.akroscz.cz/";

function SpecialCategoriesNavigation({
  navigationId,
  expandRoots,
}: {
  navigationId: string;
  expandRoots: boolean;
}) {
  return (
    <VerticalNavigation.Branch defaultOpen={expandRoots} id={`${navigationId}-special-categories`}>
      <VerticalNavigation.Row data-akros-depth={0}>
        <VerticalNavigation.Link as="span">{cs.catalog.specialCategories}</VerticalNavigation.Link>
        <VerticalNavigation.BranchTrigger aria-label={cs.catalog.specialCategories}>
          <VerticalNavigation.BranchIndicator />
        </VerticalNavigation.BranchTrigger>
      </VerticalNavigation.Row>
      <VerticalNavigation.BranchContent indent>
        <VerticalNavigation.List>
          <VerticalNavigation.Item>
            <VerticalNavigation.Link href={akrosProductionUrl}>
              {cs.catalog.production}
            </VerticalNavigation.Link>
          </VerticalNavigation.Item>
        </VerticalNavigation.List>
      </VerticalNavigation.BranchContent>
    </VerticalNavigation.Branch>
  );
}

function CategoryNavigationItem({
  activeIds,
  category,
  currentCategoryId,
  depth = 0,
  navigationId,
  categories,
  expandRoots,
}: CategoryNavigationItemProps) {
  const children = categories.filter((candidate) => candidate.parentId === category.id);
  const href = `/kategorie/${category.slug}`;
  const isCurrent = currentCategoryId === category.id;
  const isOnCurrentPath = activeIds.has(category.id);
  const visualDepth = Math.min(depth, 4);

  if (children.length === 0) {
    if (category.hasChildren) {
      return (
        <VerticalNavigation.Item>
          <VerticalNavigation.Row data-akros-depth={visualDepth}>
            <VerticalNavigation.Link
              as={NextLink}
              className="justify-between"
              current={isCurrent}
              href={href}
            >
              {category.name}
              <Icon
                data-akros-branch-indicator=""
                icon="token-icon-vertical-navigation-chevron"
                size="current"
              />
            </VerticalNavigation.Link>
          </VerticalNavigation.Row>
        </VerticalNavigation.Item>
      );
    }

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
      defaultOpen={(expandRoots && depth === 0) || isOnCurrentPath}
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
              expandRoots={expandRoots}
            />
          ))}
        </VerticalNavigation.List>
      </VerticalNavigation.BranchContent>
    </VerticalNavigation.Branch>
  );
}

export function CatalogNavigation({
  activeSlug,
  categories,
  navigationId,
  expandRoots = true,
}: {
  activeSlug?: string;
  categories: CatalogCategory[];
  navigationId: string;
  expandRoots?: boolean;
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

  return (
    <VerticalNavigation
      aria-label={cs.catalog.title}
      data-akros-catalog=""
      key={`${navigationId}-${activeSlug ?? "catalog"}`}
      maxIndentDepth={3}
      size="sm"
    >
      <VerticalNavigation.Group tone="subtle">
        <VerticalNavigation.List>
          <SpecialCategoriesNavigation navigationId={navigationId} expandRoots={expandRoots} />
          {topCategories.map((category) => (
            <CategoryNavigationItem
              activeIds={activeIds}
              category={category}
              currentCategoryId={activeCategory?.id}
              key={category.id}
              navigationId={navigationId}
              categories={categories}
              expandRoots={expandRoots}
            />
          ))}
        </VerticalNavigation.List>
      </VerticalNavigation.Group>
    </VerticalNavigation>
  );
}

export function CatalogSidebar({
  activeSlug,
  categories,
}: {
  activeSlug?: string;
  categories: CatalogCategory[];
}) {
  return (
    <aside className="akros-sidebar" aria-label={cs.catalog.title}>
      <div className="akros-sidebar__desktop">
        <CatalogNavigation
          activeSlug={activeSlug}
          categories={categories}
          navigationId="catalog-desktop"
        />
      </div>
    </aside>
  );
}
