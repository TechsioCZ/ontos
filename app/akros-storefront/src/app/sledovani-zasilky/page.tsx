import type { Metadata } from "next";
import { notFound } from "next/navigation";
import StoreLink from "@/components/store-link";
import { AccountShell } from "@/components/account-shell";
import { AccountHeading, AccountPanel } from "@/features/account/account-content";
import { requireCustomerAccount } from "@/ontos/account";
import { readCustomerOrders } from "@/ontos/customer-orders";
import { orderHref, orderStatusLabels } from "@/ontos/order-model";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Stav objednávky" };
export default async function TrackingPage({
  searchParams,
}: {
  searchParams: Promise<{ order?: string }>;
}) {
  const account = await requireCustomerAccount();
  const { order: id } = await searchParams;
  const { orders } = await readCustomerOrders(account, id);
  const order = orders[0];
  if (id && !order) notFound();
  return (
    <AccountShell active="tracking">
      <AccountHeading
        title="Stav objednávky"
        description={
          order
            ? `${order.number} · ${orderStatusLabels[order.status]}`
            : "Zatím nemáte žádnou objednávku."
        }
      >
        {order && (
          <StoreLink className="underline" href={orderHref(order)}>
            Detail objednávky
          </StoreLink>
        )}
      </AccountHeading>
      {order && (
        <AccountPanel title="Historie objednávky v OntOS">
          <p className="mb-6">
            OntOS neposkytuje sledování dopravce, polohu kurýra ani odhad doručení. Níže jsou
            skutečné uložené změny stavu objednávky.
          </p>
          <ol className="grid gap-6">
            {(order.history ?? [])
              .filter((event) => event.kind === "CREATED" || event.kind === "STATUS")
              .map((event, index) => (
                <li
                  key={`${event.at}:${index}`}
                  className="border-b border-(--akros-account-list-divider) pb-6"
                >
                  <time dateTime={event.at} className="font-bold">
                    {new Date(event.at).toLocaleString("cs-CZ", { timeZone: "Europe/Prague" })}
                  </time>
                  <p>
                    {event.before ? `${event.before} → ` : ""}
                    {event.after}
                  </p>
                  {event.reason && <p>{event.reason}</p>}
                </li>
              ))}
          </ol>
          {!order.history?.some((event) => event.kind === "CREATED" || event.kind === "STATUS") && (
            <p>Historie změn není u této objednávky uložená.</p>
          )}
        </AccountPanel>
      )}
    </AccountShell>
  );
}
