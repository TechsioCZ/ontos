import { randomUUID } from "node:crypto";
import { headers } from "next/headers";
import { Effect } from "effect";
import { AccountView } from "@/features/account-view";
import { getDictionary } from "@/i18n";
import { getCustomerProfile } from "@/ontos/customer-profile-server";
import { portalRequestContext } from "@/ontos/portal-server";
import { storefrontRuntime } from "@/ontos/runtime";

const AccountPage = async ({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ tab?: string | string[] }>;
}) => {
  const { locale } = await params;
  const incoming = await headers();
  const { tab } = await searchParams;
  const initialTab = tab === "orders" || tab === "addresses" ? tab : "profile";
  const origin = incoming.get("x-n1-request-origin");
  const initial =
    origin === null
      ? { state: "unavailable" as const }
      : await getCustomerProfile(portalRequestContext(origin, incoming.get("cookie") ?? undefined));
  const readId = await storefrontRuntime.runPromise(Effect.sync(randomUUID));
  return (
    <AccountView
      dictionary={getDictionary(locale)}
      initial={initial}
      initialTab={initialTab}
      key={readId}
      locale={locale}
    />
  );
};
export default AccountPage;
