"use client";

import { Fragment, useState } from "react";
import { useRouter } from "next/navigation";
import NextLink from "next/link";
import NextImage from "next/image";
import { Image } from "@techsio/ui-kit/atoms/image";
import { Breadcrumb } from "@techsio/ui-kit/molecules/breadcrumb";
import { TreeView } from "@techsio/ui-kit/molecules/tree-view";
import { Button } from "@techsio/ui-kit/atoms/button";
import { LinkButton } from "@techsio/ui-kit/atoms/link-button";
import type { Dictionary } from "@/i18n";
import type { CatalogModel } from "@/ontos/catalog-model";
import { categoryTrail, categoryTree } from "@/ontos/catalog-navigation";
import { CatalogView } from "./catalog-view";
import { ListingCards } from "./listing-cards";
import { CatalogPagination } from "./catalog-pagination";
import { CategoryTreeNode } from "./category-tree-node";
import { CategoryProductCount } from "./category-product-count";

/** Category composition over the current owner page and its real navigation tree. */
export const CategoryView = ({
  catalog,
  dictionary: d,
  locale,
  slug,
}: {
  catalog: CatalogModel;
  dictionary: Dictionary;
  locale: string;
  slug: string;
}) => {
  const router = useRouter();
  const [browseOpen, setBrowseOpen] = useState(false);
  const trail = categoryTrail(catalog.categories, slug);
  const current = trail.at(-1);
  const title = current?.name ?? d.catalog;
  const children = catalog.categories.filter((item) => item.parentId === current?.id);
  const childRows: (typeof children)[] = [];
  for (let offset = 0; offset < children.length; offset += 2) {
    childRows.push(children.slice(offset, offset + 2));
  }
  const nodes = categoryTree(catalog.categories);
  const treeRoot = nodes.find((node) => node.id === trail[0]?.id);
  const browseNodes =
    treeRoot !== undefined && treeRoot.children.length > 0 ? treeRoot.children : nodes;
  const pathname = `/${locale}/kategorie/${encodeURIComponent(slug)}`;
  return (
    <section className="p-4">
      <div className="flex items-center gap-1">
        <div className="hidden size-n1-breadcrumb-icon shrink-0 md:block">
          <Image alt="" as={NextImage} height={14} src="/brand/breadcrumb-home.svg" width={14} />
        </div>
        <Breadcrumb aria-label={d.catalog} size="md">
          <Breadcrumb.List>
            <Breadcrumb.Item>
              <Breadcrumb.Link as={NextLink} href={`/${locale}`}>
                {d.home}
              </Breadcrumb.Link>
            </Breadcrumb.Item>
            {trail.map((category, index) => (
              <Fragment key={category.id}>
                <Breadcrumb.Separator />
                <Breadcrumb.Item>
                  {index === trail.length - 1 ? (
                    <Breadcrumb.CurrentLink>{category.name}</Breadcrumb.CurrentLink>
                  ) : (
                    <Breadcrumb.Link
                      as={NextLink}
                      href={`/${locale}/kategorie/${encodeURIComponent(category.slug)}`}
                    >
                      {category.name}
                    </Breadcrumb.Link>
                  )}
                </Breadcrumb.Item>
              </Fragment>
            ))}
          </Breadcrumb.List>
        </Breadcrumb>
      </div>
      <div className="mt-6 flex flex-col items-start md:mt-4 md:flex-row">
        {catalog.configured && nodes.length > 0 && (
          <aside
            className={`${browseOpen ? "block" : "hidden"} w-full shrink-0 md:block md:w-n1-category-sidebar`}
            id="category-tree"
          >
            <div className="border-t-2 border-border-primary bg-fill-hover p-2">
              <TreeView
                data={browseNodes}
                defaultExpandedValue={trail.map((item) => item.id)}
                expandOnClick={false}
                onSelectionChange={({ selectedValue }) => {
                  const category = catalog.categories.find((item) => item.id === selectedValue[0]);
                  if (category) {
                    setBrowseOpen(false);
                    router.push(`/${locale}/kategorie/${encodeURIComponent(category.slug)}`);
                  }
                }}
                selectedValue={current ? [current.id] : []}
                selectionMode="single"
                size="md"
              >
                <TreeView.Label>{treeRoot?.name ?? d.menu}</TreeView.Label>
                <TreeView.Tree>
                  {browseNodes.map((node, index) => (
                    <CategoryTreeNode indexPath={[index]} key={node.id} node={node} />
                  ))}
                </TreeView.Tree>
              </TreeView>
            </div>
          </aside>
        )}
        <div className="w-full min-w-0 flex-1 md:px-3">
          <div className="relative mb-6 md:mb-3">
            <h1 className="text-2xl font-bold md:text-xl md:leading-8">{title}</h1>
            <div
              aria-hidden="true"
              className="absolute bottom-0 hidden h-1 w-24 bg-primary md:block"
            />
          </div>
          {catalog.configured && nodes.length > 0 && (
            <div className="mb-6 md:hidden">
              <Button
                aria-controls="category-tree"
                aria-expanded={browseOpen}
                block
                onClick={() => setBrowseOpen(!browseOpen)}
                size="md"
                theme="outlined"
                variant="secondary"
              >
                {d.browseCategories}
              </Button>
            </div>
          )}
          {children.length > 0 && (
            <div className="mb-6 flex flex-col gap-6 md:mb-3 md:grid md:grid-cols-4 md:gap-1">
              {childRows.map((row) => (
                <div
                  className="flex flex-wrap gap-x-2 gap-y-6 md:contents"
                  key={row.map(({ id }) => id).join("|")}
                >
                  {row.map((category) => (
                    <div className="max-w-full md:min-w-0" key={category.id}>
                      <LinkButton
                        as={NextLink}
                        block
                        href={`/${locale}/kategorie/${encodeURIComponent(category.slug)}`}
                        size="md"
                        theme="outlined"
                        variant="secondary"
                      >
                        {category.name}
                      </LinkButton>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
          {catalog.configured && (
            <CategoryProductCount dictionary={d} locale={locale} total={catalog.total} />
          )}
          {catalog.configured && catalog.products.length > 0 ? (
            <>
              <div className="md:hidden">
                <ListingCards catalog={catalog} dictionary={d} locale={locale} />
              </div>
              <div className="hidden md:block">
                <CatalogView
                  catalog={catalog}
                  dictionary={d}
                  locale={locale}
                  presentation="listing"
                  title={title}
                />
              </div>
            </>
          ) : (
            <CatalogView
              catalog={catalog}
              dictionary={d}
              locale={locale}
              presentation="listing"
              title={title}
            />
          )}
          {catalog.configured && (
            <CatalogPagination
              count={catalog.total}
              dictionary={d}
              page={catalog.page}
              pageSize={catalog.pageSize}
              pathname={pathname}
            />
          )}
        </div>
      </div>
      {browseOpen && (
        <div className="mt-4 md:hidden">
          <Button onClick={() => setBrowseOpen(false)} theme="outlined" variant="secondary">
            {title}
          </Button>
        </div>
      )}
    </section>
  );
};
