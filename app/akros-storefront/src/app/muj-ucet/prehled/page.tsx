import type { Metadata } from "next";

import { AccountShell } from "@/components/account-shell";
import { AccountOverview } from "@/features/account/account-overview";
import { requireCustomerAccount } from "@/ontos/account";
import { getDictionary } from "@/ontos/active-market";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getDictionary()).account.shell.overview };
}

export default async function AccountPage() {
  const account = await requireCustomerAccount();
  return (
    <AccountShell active="overview">
      <AccountOverview account={account} />
    </AccountShell>
  );
}
