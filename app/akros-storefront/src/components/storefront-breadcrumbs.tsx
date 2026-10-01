"use client";

import NextLink from "next/link";
import { Breadcrumb } from "@techsio/ui-kit/molecules/breadcrumb";
import { Fragment } from "react";

interface BreadcrumbItem {
  href?: string;
  label: string;
}

export function StorefrontBreadcrumbs({
  items,
  className,
}: {
  items: BreadcrumbItem[];
  className?: string;
}) {
  return (
    <Breadcrumb aria-label="Drobečková navigace" className={className} size="sm">
      <Breadcrumb.List>
        {items.map((item, index) => {
          const isCurrent = index === items.length - 1;

          return (
            <Fragment key={`${item.href ?? "current"}-${item.label}`}>
              <Breadcrumb.Item>
                {isCurrent || !item.href ? (
                  <Breadcrumb.CurrentLink>{item.label}</Breadcrumb.CurrentLink>
                ) : (
                  <Breadcrumb.Link as={NextLink} href={item.href}>
                    {item.label}
                  </Breadcrumb.Link>
                )}
              </Breadcrumb.Item>
              {!isCurrent && <Breadcrumb.Separator />}
            </Fragment>
          );
        })}
      </Breadcrumb.List>
    </Breadcrumb>
  );
}
