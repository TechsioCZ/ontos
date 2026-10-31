"use client";

import StoreLink from "@/components/store-link";
import { LinkButton, type LinkButtonProps } from "@techsio/ui-kit/atoms/link-button";

export function AccountLink(props: Omit<LinkButtonProps<typeof StoreLink>, "as">) {
  return <LinkButton as={StoreLink} {...props} />;
}
