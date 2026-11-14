import type { Metadata } from "next";
import { AccountShell } from "@/components/account-shell";
import StoreLink from "@/components/store-link";
import { AccountProfilePage } from "@/features/account/account-profile-page";
import { requireCustomerAccount } from "@/ontos/account";
import { readCustomerProfile } from "@/ontos/customer-profile";
import { getDictionary } from "@/ontos/active-market";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getDictionary()).account.shell.profile };
}

export default async function AccountPage() {
  const account = await requireCustomerAccount();
  const result = await readCustomerProfile().then(
    ({ profile }) => ({ state: "ready", profile }) as const,
    () => ({ state: "unavailable" }) as const,
  );
  if (result.state === "unavailable") {
    const { profile, shell } = (await getDictionary()).account;
    return (
      <AccountShell active="profile">
        <h1>{shell.profile}</h1>
        <p>{profile.loginEmailValue(account.email)}</p>
        <p role="alert">{profile.loadFailed}</p>
        <StoreLink href="/muj-ucet">{profile.retry}</StoreLink>
      </AccountShell>
    );
  }
  return <AccountProfilePage account={account} profile={result.profile} />;
}
