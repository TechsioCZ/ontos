import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AccountShell } from "@/components/account-shell";
import { AccountOrderDetail } from "@/features/account/account-order-detail";
import { requireCustomerAccount } from "@/ontos/account";
import { readCustomerOrders } from "@/ontos/customer-orders";
export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Detail objednávky" };
export default async function OrderDetailPage({
  searchParams,
}: {
  searchParams: Promise<{ order?: string }>;
}) {
  const account = await requireCustomerAccount();
  const { order: id } = await searchParams;
  if (!id) notFound();
  const { orders } = await readCustomerOrders(account, id);
  const order = orders[0];
  if (!order) notFound();
  return (
    <AccountShell active="orders" title={`Objednávka ${order.number}`}>
      <AccountOrderDetail order={order} />
    </AccountShell>
  );
}
