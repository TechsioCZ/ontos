"use client";

import { LinkButton, type LinkButtonProps } from "@techsio/ui-kit/atoms/link-button";

// Keep kit handlers inside a client boundary while content pages render on the server.
export function ContentLink(props: Omit<LinkButtonProps, "as">) {
  return <LinkButton {...props} />;
}
