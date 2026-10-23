import { requireCustomerAccount } from "@/ontos/account";
import { readCustomerOrders } from "@/ontos/customer-orders";
import type { Metadata } from "next";
import { AccountShell } from "@/components/account-shell";
import { AccountOrders } from "@/features/account/account-orders";

export const metadata: Metadata = { title: "Objednávky" };
export const dynamic = "force-dynamic";
export default async function OrderHistoryPage({
  searchParams,
}: {
  searchParams: Promise<{ offset?: string }>;
}) {
  const account = await requireCustomerAccount();
  const params = await searchParams;
  const parsed = Number(params.offset ?? 0);
  const offset = Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
  const { orders, total } = await readCustomerOrders(account, undefined, offset);
  return (
    <AccountShell active="orders">
      <AccountOrders orders={orders} total={total} offset={offset} />
    </AccountShell>
  );
}
