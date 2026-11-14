"use client";

import { LinkButton, type LinkButtonProps } from "@techsio/ui-kit/atoms/link-button";
import StoreLink from "@/components/store-link";

/**
 * Kit link button for server-rendered pages: handlers stay inside a client boundary and internal hrefs stay in
 * the current market (`/doprava-a-platba` → `/sk/doprava-a-platba`) through StoreLink.
 */
export function ContentLink(props: Omit<LinkButtonProps<typeof StoreLink>, "as">) {
  return <LinkButton as={StoreLink} {...props} />;
}
