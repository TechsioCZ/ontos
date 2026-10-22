"use client";
import NextLink from "next/link";
import type { ComponentProps } from "react";

/**
 * Next.js Link that loads its page on click only. Every catalog page renders from OntOS on demand, so viewport
 * prefetch turned one page view into a render of each visible category and product link.
 */
export default function StoreLink({ prefetch = false, ...props }: ComponentProps<typeof NextLink>) {
  return <NextLink prefetch={prefetch} {...props} />;
}
