"use client";

import NextLink from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Button } from "@techsio/ui-kit/atoms/button";
import { LinkButton } from "@techsio/ui-kit/atoms/link-button";
import { Tabs } from "@techsio/ui-kit/molecules/tabs";
import type { Dictionary } from "@/i18n";
import type { CustomerProfilePageState } from "@/ontos/customer-profile";
import { logoutPortal } from "@/ontos/portal-client";
import { usePortalAuth } from "./auth-view";
import { CustomerProfileForm } from "./customer-profile-form";
import { CustomerOrdersPanel } from "./customer-orders-panel";

const subscribeDesktop = (listener: () => void) => {
  const media = window.matchMedia("(min-width: 48rem)");
  media.addEventListener("change", listener);
  return () => media.removeEventListener("change", listener);
};
const desktopSnapshot = () => window.matchMedia("(min-width: 48rem)").matches;
const serverSnapshot = () => false;

/** A fresh native profile is bound to its verified Portal viewer, never to its editable contact email. */
export const AccountView = ({
  dictionary: d,
  initial,
  initialTab = "profile",
  locale,
}: {
  dictionary: Dictionary;
  initial: CustomerProfilePageState;
  initialTab?: "profile" | "addresses" | "orders";
  locale: string;
}) => {
  const router = useRouter();
  const auth = usePortalAuth({ mode: "login" });
  const desktop = useSyncExternalStore(subscribeDesktop, desktopSnapshot, serverSnapshot);
  const [tab, setTab] = useState<string>(initialTab);
  const viewerEmail = initial.state === "ready" ? initial.viewerEmail : null;
  const email = auth.outcome.state === "admitted" ? auth.outcome.email : null;
  useEffect(() => {
    if (
      auth.loaded &&
      ((viewerEmail !== null && viewerEmail !== email) ||
        (initial.state === "anonymous" && email !== null))
    ) {
      router.refresh();
    }
  }, [auth.loaded, email, initial.state, router, viewerEmail]);
  const admitted = auth.loaded && auth.outcome.state === "admitted";
  let content;
  if (!auth.loaded || (admitted && initial.state === "ready" && viewerEmail !== email)) {
    content = <output>{d.accountPage.loading}</output>;
  } else if (admitted) {
    content = (
      <Tabs
        onValueChange={setTab}
        orientation={desktop ? "vertical" : "horizontal"}
        size="sm"
        value={tab}
        variant="default"
      >
        <div className="flex w-full min-w-0 flex-col items-start gap-4 md:flex-row">
          <div className="flex w-full shrink-0 flex-wrap items-start gap-0.5 md:w-auto md:flex-col md:flex-nowrap">
            <Tabs.List>
              <Tabs.Trigger value="profile">{d.accountPage.profile}</Tabs.Trigger>
              <Tabs.Trigger value="addresses">{d.accountPage.addresses}</Tabs.Trigger>
              <Tabs.Trigger value="orders">{d.accountPage.orders}</Tabs.Trigger>
            </Tabs.List>
            <Button
              disabled={auth.pending}
              isLoading={auth.pending}
              loadingText={d.auth.checking}
              onClick={() => auth.run(logoutPortal())}
              size="sm"
              theme="solid"
              variant="primary"
            >
              {d.auth.signOut}
            </Button>
          </div>
          <div className="w-full min-w-0 flex-1">
            <Tabs.Content value="profile">
              <div className="flex min-w-0 flex-col gap-2">
                <h2 className="text-lg leading-normal font-semibold">{d.accountPage.profile}</h2>
                {initial.state === "ready" ? (
                  <CustomerProfileForm
                    dictionary={d}
                    disabled={auth.pending}
                    key={initial.profile.version}
                    profile={initial.profile}
                  />
                ) : (
                  <div className="flex flex-col items-start gap-4">
                    <output>
                      {initial.state === "forbidden"
                        ? d.accountPage.forbidden
                        : d.accountPage.unavailable}
                    </output>
                    <Button
                      onClick={() => router.refresh()}
                      size="md"
                      theme="outlined"
                      variant="secondary"
                    >
                      {d.accountPage.reload}
                    </Button>
                  </div>
                )}
              </div>
            </Tabs.Content>
            <Tabs.Content value="addresses">
              <h2 className="mb-2 text-lg leading-normal font-semibold">
                {d.accountPage.addresses}
              </h2>
              <p>{d.accountPage.addressUnavailable}</p>
            </Tabs.Content>
            <Tabs.Content value="orders">
              {tab === "orders" && (
                <CustomerOrdersPanel dictionary={d} key={email} locale={locale} />
              )}
            </Tabs.Content>
          </div>
        </div>
      </Tabs>
    );
  } else {
    content = (
      <div className="flex flex-col items-start gap-4">
        <p>
          {auth.outcome.state === "anonymous" ? d.accountPage.anonymous : d.accountPage.unavailable}
        </p>
        <LinkButton
          as={NextLink}
          href={`/${locale}/prihlaseni`}
          size="md"
          theme="solid"
          variant="primary"
        >
          {d.accountPage.login}
        </LinkButton>
        <Button
          disabled={auth.pending}
          onClick={() => router.refresh()}
          size="md"
          theme="outlined"
          variant="secondary"
        >
          {d.accountPage.reload}
        </Button>
      </div>
    );
  }
  return (
    <article className="mx-auto flex min-h-[424px] w-full max-w-5xl flex-col items-start gap-4 p-4">
      <h1 className="text-xl leading-normal font-bold">{d.accountPage.heading}</h1>
      {content}
    </article>
  );
};
