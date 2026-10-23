import type { Metadata } from "next";

import { AccountShell } from "@/components/account-shell";
import { AccountOverview } from "@/features/account/account-overview";
import { requireCustomerAccount } from "@/ontos/account";

export const metadata: Metadata = { title: "Přehled účtu" };

export default async function AccountPage() {
  const account = await requireCustomerAccount();
  return (
    <AccountShell active="overview">
      <AccountOverview account={account} />
    </AccountShell>
  );
}
