"use client";

import NextLink from "next/link";
import { LinkButton } from "@techsio/ui-kit/atoms/link-button";

import type { ReactNode } from "react";

export function PrimaryLinkButton({
  href,
  children,
  size = "md",
  uppercase = true,
}: {
  href: string;
  children: ReactNode;
  size?: "sm" | "md" | "lg";
  uppercase?: boolean;
}) {
  return (
    <LinkButton as={NextLink} href={href} size={size} uppercase={uppercase} variant="primary">
      {children}
    </LinkButton>
  );
}
