import type { Metadata } from "next";

import { AccountShell } from "@/components/account-shell";
import { AccountOverview } from "@/features/account/account-overview";

export const metadata: Metadata = { title: "Přehled účtu" };

export default function AccountPage() {
  return (
    <AccountShell active="overview">
      <AccountOverview />
    </AccountShell>
  );
}
