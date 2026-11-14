import type { Metadata } from "next";

import { AccountShell } from "@/components/account-shell";
import { AccountOverview } from "@/features/account/account-overview";
import { requireCustomerAccount } from "@/ontos/account";
import { readCustomerOrders } from "@/ontos/customer-orders";
import { getDictionary } from "@/ontos/active-market";
import type { CustomerOrder } from "@/ontos/order-model";

const isError = (value: unknown): value is Error =>
  value !== null && value !== undefined && Error.prototype.isPrototypeOf(value);

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getDictionary()).account.shell.overview };
}

export const dynamic = "force-dynamic";

export default async function AccountPage() {
  const account = await requireCustomerAccount();
  // The newest saved OntOS order; an owner outage only hides the panel's order, never the overview.
  let latest: CustomerOrder | null | undefined;
  try {
    latest = (await readCustomerOrders(account)).orders[0] ?? null;
  } catch (error) {
    console.error("[AKROS] overview orders", isError(error) ? error.message : error);
  }
  return (
    <AccountShell active="overview">
      <AccountOverview account={account} latest={latest} />
    </AccountShell>
  );
}
