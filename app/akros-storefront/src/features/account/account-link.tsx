"use client";

import NextLink from "next/link";
import { LinkButton, type LinkButtonProps } from "@techsio/ui-kit/atoms/link-button";

export function AccountLink(props: Omit<LinkButtonProps<typeof NextLink>, "as">) {
  return <LinkButton as={NextLink} {...props} />;
}
