import { notFound } from "next/navigation";
import { requireCustomerAccount } from "@/ontos/account";
import { readCustomerOrders } from "@/ontos/customer-orders";
export const dynamic = "force-dynamic";
import type { Metadata } from "next";
import { StorefrontWideShell } from "@/components/storefront-shell";
import { OrderConfirmation } from "@/features/checkout/order-confirmation";
export const metadata: Metadata = { title: "Potvrzení objednávky" };
export default async function OrderConfirmationPage({
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
    <StorefrontWideShell>
      <OrderConfirmation order={order} />
    </StorefrontWideShell>
  );
}
