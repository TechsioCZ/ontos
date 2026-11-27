"use client";

import StoreLink from "@/components/store-link";
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
    <LinkButton as={StoreLink} href={href} size={size} uppercase={uppercase} variant="primary">
      {children}
    </LinkButton>
  );
}
