import type { Metadata } from "next";
import { AccountProfilePage } from "@/features/account/account-profile-page";

export const metadata: Metadata = { title: "Můj účet" };

export default function AccountPage() {
  return <AccountProfilePage />;
}
