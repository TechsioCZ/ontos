import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AccountShell } from "@/components/account-shell";
import { AccountOrderDetail } from "@/features/account/account-order-detail";
import { mockOrders } from "@/mock-storefront/fixtures/account";

export const metadata: Metadata = { title: "Detail objednávky" };
export default async function OrderDetailPage({
  searchParams,
}: {
  searchParams: Promise<{ order?: string }>;
}) {
  const { order: number } = await searchParams;
  const order =
    number === undefined ? mockOrders[0] : mockOrders.find((item) => item.number === `#${number}`);
  if (!order) notFound();
  return (
    <AccountShell active="orders" title={`Objednávka ${order.number}`}>
      <AccountOrderDetail order={order} />
    </AccountShell>
  );
}
