"use client";
import { LinkButton } from "@techsio/ui-kit/atoms/link-button";

/** A full-page market switch from a server-rendered page; LinkButton attaches a click handler, so it renders on the client. */
export function MarketLinkButton({ href, label }: { href: string; label: string }) {
  return (
    <LinkButton href={href} size="sm" theme="outlined" variant="primary">
      {label}
    </LinkButton>
  );
}
