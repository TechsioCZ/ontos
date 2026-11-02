import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AccountShell } from "@/components/account-shell";
import { AccountOrderDetail } from "@/features/account/account-order-detail";
import { requireCustomerAccount } from "@/ontos/account";
import { getDictionary } from "@/ontos/active-market";
import { readCustomerOrders } from "@/ontos/customer-orders";
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getDictionary()).account.shell.orderDetail };
}
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
    <AccountShell
      active="orders"
      title={(await getDictionary()).account.orderDetail.title(order.number)}
    >
      <AccountOrderDetail order={order} />
    </AccountShell>
  );
}
