import type { Metadata } from "next";
import { AccountShell } from "@/components/account-shell";
import { AccountOrders } from "@/features/account/account-orders";

export const metadata: Metadata = { title: "Objednávky" };
export default function OrderHistoryPage() {
  return (
    <AccountShell active="orders">
      <AccountOrders />
    </AccountShell>
  );
}
