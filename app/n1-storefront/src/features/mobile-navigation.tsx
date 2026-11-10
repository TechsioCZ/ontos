"use client";

import NextLink from "next/link";
import { useLayoutEffect, useState } from "react";
import type { RefObject } from "react";
import { Link } from "@/features/plain-link";
import { Accordion } from "@techsio/ui-kit/molecules/accordion";
import { Dialog } from "@techsio/ui-kit/molecules/dialog";
import { VerticalNavigation } from "@techsio/ui-kit/molecules/vertical-navigation";
import type { Dictionary } from "@/i18n";
import { categoryTree } from "@/ontos/catalog-navigation";
import type { CategoryNode } from "@/ontos/catalog-navigation";
import type { CatalogModel } from "@/ontos/catalog-model";

interface CategoryLinksProps {
  destinations: ReadonlyMap<string, string>;
  locale: string;
  nodes: readonly CategoryNode[];
  onNavigate: () => void;
}

/** Deeper owner branches use the kit navigation disclosure, never nested accordions. */
const CategoryDescendants = ({ destinations, locale, nodes, onNavigate }: CategoryLinksProps) => (
  <VerticalNavigation.List>
    {nodes.map((node) => {
      const slug = destinations.get(node.id);
      if (slug === undefined) {
        return null;
      }
      const link = (
        <VerticalNavigation.Link
          as={NextLink}
          href={`/${locale}/kategorie/${encodeURIComponent(slug)}`}
          onClick={onNavigate}
        >
          {node.name}
        </VerticalNavigation.Link>
      );
      return node.children.length === 0 ? (
        <VerticalNavigation.Item key={node.id}>{link}</VerticalNavigation.Item>
      ) : (
        <VerticalNavigation.Branch key={node.id}>
          <VerticalNavigation.Row>
            {link}
            <VerticalNavigation.BranchTrigger aria-label={node.name}>
              <VerticalNavigation.BranchIndicator />
            </VerticalNavigation.BranchTrigger>
          </VerticalNavigation.Row>
          <VerticalNavigation.BranchContent>
            <CategoryDescendants
              destinations={destinations}
              locale={locale}
              nodes={node.children}
              onNavigate={onNavigate}
            />
          </VerticalNavigation.BranchContent>
        </VerticalNavigation.Branch>
      );
    })}
  </VerticalNavigation.List>
);

/** Owner hierarchy only: no Figma category names or synthetic destinations. */
export const MobileCategoryLinks = ({
  destinations,
  locale,
  nodes,
  onNavigate,
}: CategoryLinksProps) => (
  <Accordion collapsible shadow="none" size="md" variant="borderless">
    {nodes.map((node) => {
      const slug = destinations.get(node.id);
      if (slug === undefined) {
        return null;
      }
      return node.children.length === 0 ? (
        <div className="border-b border-border-secondary px-4 py-2" key={node.id}>
          <Link
            as={NextLink}
            href={`/${locale}/kategorie/${encodeURIComponent(slug)}`}
            onClick={onNavigate}
          >
            {node.name}
          </Link>
        </div>
      ) : (
        <div className="border-b border-border-secondary" key={node.id}>
          <Accordion.Item value={node.id}>
            <Accordion.Header className="n1-mobile-category-heading">
              <Accordion.Title>{node.name}</Accordion.Title>
              <Accordion.Indicator />
            </Accordion.Header>
            <Accordion.Content>
              <VerticalNavigation aria-label={node.name} size="md">
                <CategoryDescendants
                  destinations={destinations}
                  locale={locale}
                  nodes={node.children}
                  onNavigate={onNavigate}
                />
              </VerticalNavigation>
            </Accordion.Content>
          </Accordion.Item>
        </div>
      );
    })}
  </Accordion>
);

export const MobileNavigation = ({
  categories,
  dictionary: d,
  headerRef,
  locale,
  onOpenChange,
  open,
}: {
  categories: readonly CatalogModel["categories"][number][];
  dictionary: Dictionary;
  headerRef: RefObject<HTMLElement | null>;
  locale: string;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) => {
  const [navigationTop, setNavigationTop] = useState(0);
  useLayoutEffect(() => {
    const header = headerRef.current;
    let observer: ResizeObserver | null = null;
    if (open && header !== null) {
      const updatePosition = () =>
        setNavigationTop(
          Math.min(window.innerHeight, Math.max(0, header.getBoundingClientRect().bottom)),
        );
      observer = new ResizeObserver(updatePosition);
      observer.observe(header);
      observer.observe(document.body);
      updatePosition();
    }
    return () => observer?.disconnect();
  }, [headerRef, open]);
  return (
    <div
      className={`n1-mobile-navigation fixed inset-x-0 bottom-0 z-(--z-dialog-positioner) md:hidden ${open ? "pointer-events-auto" : "pointer-events-none"}`}
      id="n1-mobile-navigation"
      style={{ top: navigationTop }}
    >
      <Dialog
        closeLabel={d.closeMenu}
        customTrigger
        hideCloseButton
        id="n1-mobile-navigation"
        modal={false}
        onOpenChange={({ open: next }) => onOpenChange(next)}
        open={open}
        placement="left"
        portal={false}
        position="absolute"
        preventScroll
        size="xs"
        title={<span className="sr-only">{d.menu}</span>}
        trapFocus={false}
      >
        <nav aria-label={d.menu}>
          <div className="border-b border-border-secondary px-4 py-2">
            <Link as={NextLink} href={`/${locale}/novinky`} onClick={() => onOpenChange(false)}>
              {d.news}
            </Link>
          </div>
          {categories.length === 0 ? (
            <output>{d.unavailableDescription}</output>
          ) : (
            <MobileCategoryLinks
              destinations={new Map(categories.map((category) => [category.id, category.slug]))}
              locale={locale}
              nodes={categoryTree(categories)}
              onNavigate={() => onOpenChange(false)}
            />
          )}
        </nav>
      </Dialog>
    </div>
  );
};
