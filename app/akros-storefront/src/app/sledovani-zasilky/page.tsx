import type { Metadata } from "next";
import { notFound } from "next/navigation";
import StoreLink from "@/components/store-link";
import { AccountShell } from "@/components/account-shell";
import { AccountHeading, AccountPanel } from "@/features/account/account-content";
import { requireCustomerAccount } from "@/ontos/account";
import { getDictionary } from "@/ontos/active-market";
import { readCustomerOrders } from "@/ontos/customer-orders";
import { orderHref } from "@/ontos/order-model";

export const dynamic = "force-dynamic";
export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getDictionary()).tracking.title };
}
export default async function TrackingPage({
  searchParams,
}: {
  searchParams: Promise<{ order?: string }>;
}) {
  const [account, dictionary] = await Promise.all([requireCustomerAccount(), getDictionary()]);
  const copy = dictionary.tracking;
  const statusLabel = (status: string) =>
    copy.statuses[status as keyof typeof copy.statuses] ?? status;
  const { order: id } = await searchParams;
  const { orders } = await readCustomerOrders(account, id);
  const order = orders[0];
  if (id && !order) notFound();
  return (
    <AccountShell active="tracking">
      <AccountHeading
        title={copy.title}
        description={order ? `${order.number} · ${statusLabel(order.status)}` : copy.noOrders}
      >
        {order && (
          <StoreLink className="underline" href={orderHref(order)}>
            {copy.details}
          </StoreLink>
        )}
      </AccountHeading>
      {order && (
        <AccountPanel title={copy.historyHeading}>
          <p className="mb-6">{copy.historyNote}</p>
          <ol className="grid gap-6">
            {(order.history ?? [])
              .filter((event) => event.kind === "CREATED" || event.kind === "STATUS")
              .map((event, index) => (
                <li
                  key={`${event.at}:${index}`}
                  className="border-b border-(--sf-account-list-divider) pb-6"
                >
                  <time dateTime={event.at} className="font-bold">
                    {new Date(event.at).toLocaleString(copy.dateLocale, {
                      timeZone: "Europe/Prague",
                    })}
                  </time>
                  <p>
                    {event.before ? `${statusLabel(event.before)} → ` : ""}
                    {event.after ? statusLabel(event.after) : ""}
                  </p>
                  {event.reason && <p>{event.reason}</p>}
                </li>
              ))}
          </ol>
          {!order.history?.some((event) => event.kind === "CREATED" || event.kind === "STATUS") && (
            <p>{copy.noHistory}</p>
          )}
        </AccountPanel>
      )}
    </AccountShell>
  );
}
