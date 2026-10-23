import type { Metadata } from "next";
import { AccountProfilePage } from "@/features/account/account-profile-page";
import { requireCustomerAccount } from "@/ontos/account";

export const metadata: Metadata = { title: "Můj účet" };

export default async function AccountPage() {
  const account = await requireCustomerAccount();
  return <AccountProfilePage account={account} />;
}
