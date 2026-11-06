"use client";

import NextImage from "next/image";
import NextLink from "next/link";
import { useEffect, useRef, useState } from "react";
import { Option, Schema } from "effect";
import { Image } from "@techsio/ui-kit/atoms/image";
import { Link } from "@techsio/ui-kit/atoms/link";
import { Header } from "@techsio/ui-kit/organisms/header";
import { Popover } from "@techsio/ui-kit/molecules/popover";
import type { Dictionary } from "@/i18n";
import type { CatalogModel } from "@/ontos/catalog-model";
import { navigationArtwork } from "./navigation-artwork";

/** Native Popover composition: owner navigation, static N1 illustrations. */
export const DesktopCategoryNavigation = ({
  categories,
  dictionary: d,
  locale,
  onOpenChange,
  open,
}: {
  categories: readonly CatalogModel["categories"][number][];
  dictionary: Dictionary;
  locale: string;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) => {
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [keyboardFocus, setKeyboardFocus] = useState(false);
  const content = useRef<HTMLDivElement>(null);
  const roots = categories.filter((category) => category.parentId === null);
  const categoryLinks = categories.filter((category) => category.parentId === categoryId);
  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 48rem)");
    const closeOnMobile = () => {
      if (!desktop.matches) {
        onOpenChange(false);
      }
    };
    desktop.addEventListener("change", closeOnMobile);
    return () => desktop.removeEventListener("change", closeOnMobile);
  }, [onOpenChange]);
  return (
    <div
      className="n1-category-menu hidden w-full md:block"
      onPointerLeave={() => {
        if (content.current?.contains(document.activeElement) !== true) {
          onOpenChange(false);
        }
      }}
    >
      <Popover
        autoFocus={keyboardFocus}
        finalFocusEl={() =>
          document.activeElement?.closest<HTMLElement>(
            "a[href], button, input, select, textarea, [tabindex]",
          ) ?? null
        }
        gutter={0}
        id="n1-desktop-categories"
        initialFocusEl={() => content.current?.querySelector<HTMLAnchorElement>("a[href]") ?? null}
        offset={{ crossAxis: 0, mainAxis: 0 }}
        onFocusOutside={() => setKeyboardFocus(false)}
        onOpenChange={({ open: next }) => onOpenChange(next)}
        onPointerDownOutside={() => setKeyboardFocus(false)}
        onTriggerValueChange={({ value }) => setCategoryId(value)}
        open={open}
        overflowPadding={0}
        placement="bottom-start"
        portalled={false}
        restoreFocus={keyboardFocus}
        sameWidth
        shadow={false}
        triggerValue={categoryId}
      >
        <Popover.Context>
          {(api) => (
            <>
              <Popover.Anchor>
                <div className="overflow-x-auto overflow-y-hidden border-t border-highlight px-n1-nav-padding md:flex md:h-n1-nav-height md:items-center">
                  <Header.Nav aria-label={d.menu}>
                    <Header.NavItem size="md">
                      <Link as={NextLink} href={`/${locale}/novinky`}>
                        {d.news}
                      </Link>
                    </Header.NavItem>
                    {roots.map((category) => {
                      const hasChildren = categories.some(
                        (child) => child.parentId === category.id,
                      );
                      const triggerId = Schema.decodeUnknownOption(Schema.String)(
                        api.getTriggerProps({ value: category.id }).id,
                      );
                      const contentId = Schema.decodeUnknownOption(Schema.String)(
                        api.getContentProps().id,
                      );
                      const active = api.open && api.triggerValue === category.id;
                      return (
                        <div
                          className={active ? "n1-category-menu-active" : undefined}
                          key={category.id}
                        >
                          <Header.NavItem
                            active={active}
                            onPointerEnter={() => {
                              setKeyboardFocus(false);
                              api.setTriggerValue(category.id);
                              api.setOpen(hasChildren);
                            }}
                            size="md"
                          >
                            <Link
                              aria-controls={
                                hasChildren ? Option.getOrUndefined(contentId) : undefined
                              }
                              aria-expanded={hasChildren ? active : undefined}
                              aria-haspopup={hasChildren ? "dialog" : undefined}
                              as={NextLink}
                              data-ownedby="n1-desktop-categories"
                              data-part="trigger"
                              data-scope="popover"
                              data-value={category.id}
                              href={`/${locale}/kategorie/${encodeURIComponent(category.slug)}`}
                              id={Option.getOrUndefined(triggerId)}
                              onClick={() => api.setOpen(false)}
                              onFocus={() => {
                                api.setTriggerValue(category.id);
                                if (api.open) {
                                  api.setOpen(hasChildren);
                                }
                              }}
                              onKeyDown={(event) => {
                                if (hasChildren && event.key === "ArrowDown") {
                                  event.preventDefault();
                                  setKeyboardFocus(true);
                                  api.setTriggerValue(category.id);
                                  if (api.open) {
                                    content.current
                                      ?.querySelector<HTMLAnchorElement>("a[href]")
                                      ?.focus();
                                  }
                                  api.setOpen(true);
                                }
                              }}
                            >
                              {category.name}
                            </Link>
                          </Header.NavItem>
                        </div>
                      );
                    })}
                  </Header.Nav>
                </div>
              </Popover.Anchor>
              <Popover.Positioner>
                <Popover.Content
                  aria-label={d.menu}
                  onFocusCapture={() => setKeyboardFocus(true)}
                  ref={content}
                >
                  <div className="grid min-h-n1-category-menu-grid grid-cols-6 content-center items-end gap-2">
                    {categoryLinks.map((category) => {
                      const artwork = navigationArtwork.get(category.id);
                      return (
                        <div className="flex min-w-0 flex-col items-center gap-2" key={category.id}>
                          <Link
                            as={NextLink}
                            href={`/${locale}/kategorie/${encodeURIComponent(category.slug)}`}
                            onClick={() => api.setOpen(false)}
                          >
                            <div className="flex flex-col items-center gap-2 text-center">
                              {artwork !== undefined && (
                                <div className="relative size-24">
                                  <Image
                                    alt=""
                                    as={NextImage}
                                    fill
                                    objectFit="contain"
                                    size="full"
                                    sizes="96px"
                                    src={artwork}
                                  />
                                </div>
                              )}
                              <span className="text-sm font-bold">{category.name}</span>
                            </div>
                          </Link>
                        </div>
                      );
                    })}
                  </div>
                </Popover.Content>
              </Popover.Positioner>
            </>
          )}
        </Popover.Context>
      </Popover>
    </div>
  );
};
