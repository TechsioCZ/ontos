"use client";

import NextImage from "next/image";
import { Image } from "@techsio/ui-kit/atoms/image";
import { Popover } from "@techsio/ui-kit/molecules/popover";
import type { Dictionary } from "@/i18n";
import { AuthContent, usePortalAuth } from "./auth-view";

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
  return (
    <Popover
      border
      onOpenChange={({ open: next }) => onOpenChange(next)}
      open={open}
      placement="bottom-end"
      shadow={false}
      size="sm"
    >
      <Popover.Trigger
        aria-label={dictionary.account}
        size="current"
        theme="unstyled"
        variant="tertiary"
      >
        <Image
          alt=""
          as={NextImage}
          height={28}
          size="custom"
          src="/brand/account-outline.svg"
          width={28}
        />
      </Popover.Trigger>
      <Popover.Positioner>
        <Popover.Content>
          <Popover.Arrow />
          <div className="flex w-n1-header-panel-content max-w-n1-header-panel-viewport flex-col gap-2">
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
