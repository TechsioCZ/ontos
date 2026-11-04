"use client";

import NextLink from "next/link";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@techsio/ui-kit/atoms/button";
import { Badge } from "@techsio/ui-kit/atoms/badge";
import { LinkButton } from "@techsio/ui-kit/atoms/link-button";
import { ProductCard } from "@techsio/ui-kit/molecules/product-card";
import { TotalsSummary } from "@techsio/ui-kit/molecules/totals-summary";
import type { Dictionary } from "@/i18n";
import type { CustomerOrder, CustomerOrdersView } from "@/ontos/customer-orders";
import { usePortalAuth } from "./auth-view";
import { CustomerOrderStatus } from "./customer-orders-panel";
import { customerOrderDate } from "./customer-order-date";
import { formatMarketAmount } from "./price-props";

type Detail = NonNullable<CustomerOrder["detail"]>;
const OrderAddress = ({ address }: { address: NonNullable<Detail["deliveryAddress"]> }) => (
  <p className="text-sm text-fg-secondary">
    {address.street}
    <br />
    {address.postalCode} {address.city}
    <br />
    {address.country}
  </p>
);
export const CustomerOrderContent = ({
  dictionary: d,
  locale,
  order,
}: {
  dictionary: Dictionary;
  locale: string;
  order: CustomerOrder;
}) => {
  const { detail } = order;
  if (detail === null) {
    return <p>{d.accountPage.notFound}</p>;
  }
  const money = (amount: number) => formatMarketAmount(amount, locale, order.currency);
  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h1 className="text-xl leading-normal font-bold wrap-break-word">
            {d.accountPage.orderNumber} {order.number}
          </h1>
          <p className="text-sm text-fg-secondary">
            {customerOrderDate(order.createdAt, locale, d.accountPage.unknown)}
          </p>
        </div>
        <CustomerOrderStatus dictionary={d} status={order.status} />
      </div>
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">{d.accountPage.items}</h2>
        <div className="grid min-w-0 gap-3 md:grid-cols-3">
          {detail.lines.map((line) => (
            <ProductCard
              key={`${line.productId}-${line.variantId ?? ""}-${line.sku}`}
              layout="column"
              shadow={false}
            >
              <div>
                <Badge size="sm" variant="secondary">{`${line.quantity}×`}</Badge>
              </div>
              <ProductCard.Name>{line.productName}</ProductCard.Name>
              {line.variantName !== undefined && line.variantName !== "" && (
                <p className="text-sm text-fg-secondary">{line.variantName}</p>
              )}
              <p className="text-xs text-fg-secondary">{d.accountPage.unitPrice}</p>
              <ProductCard.Price>{money(line.unitPriceMinor)}</ProductCard.Price>
            </ProductCard>
          ))}
        </div>
      </section>
      <div className="grid min-w-0 gap-4 md:grid-cols-2">
        <section className="flex min-w-0 flex-col gap-2 rounded-xs border border-border-secondary p-4">
          <h2 className="text-lg font-semibold">{d.accountPage.total}</h2>
          <TotalsSummary
            rows={[
              ...(order.pricesIncludeVat === true
                ? [
                    {
                      id: "net",
                      label: d.accountPage.net,
                      value: money(order.totalMinor - order.totalVatMinor),
                    },
                  ]
                : []),
              { id: "vat", label: d.accountPage.vat, value: money(order.totalVatMinor) },
              {
                id: "shipping",
                label: d.accountPage.shipping,
                value:
                  order.shipping === null
                    ? d.accountPage.unknown
                    : money(order.shipping.priceMinor),
              },
            ]}
            totalLabel={d.accountPage.total}
            totalValue={money(order.totalMinor)}
          />
        </section>
        <section className="flex min-w-0 flex-col gap-2 rounded-xs border border-border-secondary p-4">
          <h2 className="text-lg font-semibold">{d.accountPage.detail}</h2>
          <div>
            <p className="text-xs text-fg-secondary">{d.accountPage.orderId}</p>
            <p className="text-sm wrap-break-word">{order.id}</p>
          </div>
          <div>
            <p className="text-xs text-fg-secondary">{d.accountPage.createdAt}</p>
            <p className="text-sm">
              {customerOrderDate(order.createdAt, locale, d.accountPage.unknown)}
            </p>
          </div>
          {order.updatedAt !== null && (
            <div>
              <p className="text-xs text-fg-secondary">{d.accountPage.updatedAt}</p>
              <p className="text-sm">
                {customerOrderDate(order.updatedAt, locale, d.accountPage.unknown)}
              </p>
            </div>
          )}
          {detail.contact !== null && (
            <div>
              <p className="text-xs text-fg-secondary">{d.accountPage.contact}</p>
              <p className="text-sm wrap-break-word">
                {detail.contact.name}
                <br />
                {detail.contact.email}
                {detail.contact.phone !== undefined && detail.contact.phone !== "" && (
                  <>
                    <br />
                    {detail.contact.phone}
                  </>
                )}
              </p>
            </div>
          )}
        </section>
        {detail.billingAddress !== null && (
          <section className="flex min-w-0 flex-col gap-2 rounded-xs border border-border-secondary p-4">
            <h2 className="text-lg font-semibold">{d.accountPage.billingAddress}</h2>
            <OrderAddress address={detail.billingAddress} />
          </section>
        )}
        {detail.deliveryAddress !== null && (
          <section className="flex min-w-0 flex-col gap-2 rounded-xs border border-border-secondary p-4">
            <h2 className="text-lg font-semibold">{d.accountPage.deliveryAddress}</h2>
            <OrderAddress address={detail.deliveryAddress} />
          </section>
        )}
        {detail.note !== null && detail.note !== "" && (
          <section className="flex min-w-0 flex-col gap-2 rounded-xs border border-border-secondary p-4">
            <h2 className="text-lg font-semibold">{d.accountPage.note}</h2>
            <p className="text-sm whitespace-pre-wrap wrap-break-word">{detail.note}</p>
          </section>
        )}
      </div>
    </>
  );
};

export const CustomerOrderDetailView = ({
  dictionary: d,
  initial,
  locale,
}: {
  dictionary: Dictionary;
  initial: CustomerOrdersView;
  locale: string;
}) => {
  const auth = usePortalAuth({ mode: "login" });
  const router = useRouter();
  const viewerEmail = initial.state === "ready" ? initial.viewerEmail : null;
  const email = auth.outcome.state === "admitted" ? auth.outcome.email : null;
  useEffect(() => {
    if (
      auth.loaded &&
      ((viewerEmail !== null && viewerEmail !== email) ||
        (initial.state === "anonymous" && email !== null))
    ) {
      router.refresh();
    }
  }, [auth.loaded, email, initial.state, router, viewerEmail]);
  let body;
  if (!auth.loaded || (initial.state === "ready" && email !== null && email !== viewerEmail)) {
    body = <output>{d.accountPage.loading}</output>;
  } else if (email === null) {
    body = (
      <div className="flex flex-col items-start gap-4">
        <p>{d.accountPage.anonymous}</p>
        <LinkButton
          as={NextLink}
          href={`/${locale}/prihlaseni`}
          size="md"
          theme="solid"
          variant="primary"
        >
          {d.accountPage.login}
        </LinkButton>
      </div>
    );
  } else if (initial.state === "ready") {
    const [order] = initial.data.orders;
    body =
      order === undefined ? (
        <p>{d.accountPage.notFound}</p>
      ) : (
        <CustomerOrderContent dictionary={d} locale={locale} order={order} />
      );
  } else {
    body = (
      <div className="flex flex-col items-start gap-4">
        <output>
          {initial.state === "forbidden"
            ? d.accountPage.forbidden
            : d.accountPage.ordersUnavailable}
        </output>
        <Button onClick={() => router.refresh()} size="md" theme="outlined" variant="secondary">
          {d.accountPage.reload}
        </Button>
      </div>
    );
  }
  return (
    <article className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-4 md:p-8">
      <div>
        <LinkButton
          as={NextLink}
          href={`/${locale}/ucet?tab=orders`}
          size="sm"
          theme="borderless"
          variant="tertiary"
        >
          {d.accountPage.backToOrders}
        </LinkButton>
      </div>
      {body}
    </article>
  );
};
