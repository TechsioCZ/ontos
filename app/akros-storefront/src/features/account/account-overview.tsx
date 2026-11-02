"use client";

import StoreLink from "@/components/store-link";
import { LinkButton } from "@techsio/ui-kit/atoms/link-button";
import { AccountHeading, AccountPanel } from "./account-content";
import type { CustomerAccount } from "@/ontos/account";
import { formatPrice } from "@/lib/format";
import { useDictionary, useMarket } from "@/ontos/market-context";
import { orderHref, orderMoney, type CustomerOrder } from "@/ontos/order-model";

/**
 * Kai's overview layout (latest order, account, four shortcuts) on OntOS data: the latest order is the newest
 * saved OntOS order of the signed-in customer (`null` = none yet, `undefined` = the read failed).
 */
export function AccountOverview({
  account,
  latest,
}: {
  account: CustomerAccount;
  latest?: CustomerOrder | null;
}) {
  const cs = useDictionary();
  const { overview, shell, orders, orderDetail, orderStatus, profile } = cs.account;
  const locale = useMarket()?.formatLocale ?? "cs-CZ";
  const shortcuts = [
    {
      title: shell.orders,
      text: overview.shortcuts.ordersText,
      href: "/historie-objednavek",
      action: overview.showOrders,
    },
    {
      title: shell.favorites,
      text: overview.shortcuts.favoritesText,
      href: "/oblibene",
      action: overview.shortcuts.favoritesAction,
    },
    {
      title: overview.contactDetails,
      text: overview.shortcuts.contactText,
      href: "/muj-ucet",
      action: overview.shortcuts.contactAction,
    },
    {
      title: shell.claims,
      text: overview.shortcuts.claimsText,
      href: "/muj-ucet/reklamace",
      action: overview.shortcuts.claimsAction,
    },
  ];
  return (
    <>
      <AccountHeading title={overview.greeting(account.name)} description={overview.description} />
      <div className="grid gap-(--dimension-24) lg:grid-cols-2">
        <AccountPanel title={overview.latestTitle}>
          {latest ? (
            <>
              <div className="flex flex-wrap items-start justify-between gap-(--dimension-16)">
                <div>
                  <p className="font-bold">{latest.number}</p>
                  <p className="mt-(--dimension-8) text-(--sf-account-muted)">
                    {new Date(latest.createdAt).toLocaleDateString(locale)}
                  </p>
                </div>
                <p
                  className={`font-bold ${latest.status === "CANCELLED" ? "text-(--color-danger)" : "text-(--color-fg-status-success)"}`}
                >
                  {orderStatus[latest.status]}
                </p>
              </div>
              <dl className="mt-(--dimension-24) grid grid-cols-2 gap-(--dimension-16)">
                <div>
                  <dt className="text-(length:--dimension-16) text-(--sf-account-muted)">
                    {overview.itemCount}
                  </dt>
                  <dd className="mt-(--dimension-8) font-bold tabular-nums">
                    {latest.lines.length.toLocaleString(locale)}
                  </dd>
                </div>
                <div>
                  <dt className="text-(length:--dimension-16) text-(--sf-account-muted)">
                    {overview.total}
                  </dt>
                  <dd className="mt-(--dimension-8) font-bold tabular-nums">
                    {formatPrice(latest.totalMinor, orderMoney(latest))}
                  </dd>
                </div>
              </dl>
              <div className="mt-(--dimension-32) flex flex-wrap gap-(--dimension-16)">
                <LinkButton
                  as={StoreLink}
                  href={`/sledovani-zasilky?order=${encodeURIComponent(latest.id)}`}
                  data-account-action
                  size="sm"
                  variant="primary"
                >
                  {latest.status === "SHIPPED" ? orderDetail.trackShipment : orderDetail.orderState}
                </LinkButton>
                <LinkButton
                  as={StoreLink}
                  href={orderHref(latest)}
                  data-account-action
                  size="sm"
                  theme="outlined"
                  variant="secondary"
                >
                  {orders.detail}
                </LinkButton>
              </div>
            </>
          ) : (
            <>
              <p
                className="text-(--sf-account-muted)"
                role={latest === undefined ? "alert" : undefined}
              >
                {latest === undefined ? overview.latestUnavailable : orders.empty}
              </p>
              <LinkButton
                as={StoreLink}
                href={latest === undefined ? "/historie-objednavek" : "/"}
                data-account-action
                className="mt-(--dimension-32)"
                size="sm"
                variant="primary"
              >
                {latest === undefined ? overview.showOrders : cs.favorites.browse}
              </LinkButton>
            </>
          )}
        </AccountPanel>
        <AccountPanel title={overview.accountTitle}>
          <dl className="grid gap-(--dimension-16)">
            <div>
              <dt className="text-(length:--dimension-16) text-(--sf-account-muted)">
                {profile.name}
              </dt>
              <dd className="break-words">{account.name}</dd>
            </div>
            <div>
              <dt className="text-(length:--dimension-16) text-(--sf-account-muted)">
                {profile.loginEmail}
              </dt>
              <dd className="break-words">{account.email}</dd>
            </div>
          </dl>
          <LinkButton
            as={StoreLink}
            href="/muj-ucet"
            data-account-action
            className="mt-(--dimension-32)"
            size="sm"
            theme="outlined"
            variant="secondary"
          >
            {overview.editAccount}
          </LinkButton>
        </AccountPanel>
      </div>
      <nav
        aria-label={overview.shortcutsLabel}
        className="mt-(--dimension-32) grid gap-(--dimension-24) md:grid-cols-2 xl:grid-cols-4"
      >
        {shortcuts.map((item) => (
          <AccountPanel key={item.href} title={item.title}>
            <p className="text-(--sf-account-muted)">{item.text}</p>
            <LinkButton
              as={StoreLink}
              href={item.href}
              size="sm"
              theme="unstyled"
              className="mt-(--dimension-16) justify-start p-0 underline underline-offset-4 hover:no-underline"
            >
              {item.action}
            </LinkButton>
          </AccountPanel>
        ))}
      </nav>
    </>
  );
}
