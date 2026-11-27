"use client";

import NextImage from "next/image";
import NextLink from "next/link";
import { useEffect, useRef } from "react";
import { Image } from "@techsio/ui-kit/atoms/image";
import { Popover } from "@techsio/ui-kit/molecules/popover";
import type { Dictionary } from "@/i18n";
import { AuthContent, usePortalAuth } from "./auth-view";
import { Link } from "./plain-link";

/** Controlled header login shares page authentication, with credentials only in mounted controls. */
export const MiniLogin = ({
  dictionary,
  locale,
  onOpenChange,
  open,
}: {
  dictionary: Dictionary;
  locale: string;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) => {
  const controller = usePortalAuth({ mode: "login" });
  const admitted = controller.loaded && controller.outcome.state === "admitted";
  const accountLink = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    if (admitted && open) {
      onOpenChange(false);
      accountLink.current?.focus();
    }
  }, [admitted, onOpenChange, open]);

  const accountIcon = (
    <Image
      alt=""
      as={NextImage}
      height={28}
      size="custom"
      src="/brand/account-outline.svg"
      width={28}
    />
  );
  if (admitted) {
    return (
      <Link
        aria-label={dictionary.account}
        as={NextLink}
        className="inline-flex shrink-0 items-center"
        href={`/${locale}/ucet`}
        prefetch={false}
        ref={accountLink}
      >
        {accountIcon}
      </Link>
    );
  }

  return (
    <Popover
      border
      onOpenChange={({ open: next }) => onOpenChange(next)}
      open={open}
      placement="bottom-end"
      shadow={false}
      size="sm"
    >
      <Popover.Trigger aria-label={dictionary.account} size="current" unstyled severity="tertiary">
        {accountIcon}
      </Popover.Trigger>
      <Popover.Positioner>
        <Popover.Content className="n1-header-popover">
          <Popover.Arrow />
          <div className="flex w-n1-header-panel-content max-w-full flex-col gap-2">
            <Popover.Title>{dictionary.auth.loginHeading}</Popover.Title>
            <AuthContent
              controller={controller}
              dictionary={dictionary}
              locale={locale}
              mode="login"
              onNavigate={() => onOpenChange(false)}
            />
          </div>
        </Popover.Content>
      </Popover.Positioner>
    </Popover>
  );
};
