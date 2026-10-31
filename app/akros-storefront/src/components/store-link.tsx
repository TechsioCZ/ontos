"use client";
import NextLink from "next/link";
import type { ComponentProps } from "react";

/** Catalog pages carry fresh prices and stock: fetch on navigation, never prefetch a price-bearing RSC. */
export default function StoreLink(props: ComponentProps<typeof NextLink>) {
  return <NextLink {...props} prefetch={false} />;
}
