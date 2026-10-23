import type { Metadata } from "next";
import { AccountShell } from "@/components/account-shell";
import StoreLink from "@/components/store-link";
import { AccountProfilePage } from "@/features/account/account-profile-page";
import { requireCustomerAccount } from "@/ontos/account";
import { readCustomerProfile } from "@/ontos/customer-profile";

export const metadata: Metadata = { title: "Můj účet" };

export default async function AccountPage() {
  const account = await requireCustomerAccount();
  const result = await readCustomerProfile().then(
    ({ profile }) => ({ state: "ready", profile }) as const,
    () => ({ state: "unavailable" }) as const,
  );
  if (result.state === "unavailable") {
    return (
      <AccountShell active="profile">
        <h1>Můj účet</h1>
        <p>Přihlašovací e-mail: {account.email}</p>
        <p role="alert">
          Kontaktní údaje se teď nepodařilo načíst z OntOS. Úpravy budou dostupné po načtení
          aktuálních údajů.
        </p>
        <StoreLink href="/muj-ucet">Zkusit načíst údaje znovu</StoreLink>
      </AccountShell>
    );
  }
  return <AccountProfilePage account={account} profile={result.profile} />;
}
