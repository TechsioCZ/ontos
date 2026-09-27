"use client";

import NextLink from "next/link";
import { LinkButton } from "@techsio/ui-kit/atoms/link-button";

import type { ReactNode } from "react";

export function PrimaryLinkButton({ href, children }: { href: string; children: ReactNode }) {
  return (
    <LinkButton as={NextLink} href={href} size="md" uppercase variant="primary">
      {children}
    </LinkButton>
  );
}
