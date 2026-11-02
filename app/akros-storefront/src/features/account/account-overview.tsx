"use client";

import StoreLink from "@/components/store-link";
import { LinkButton } from "@techsio/ui-kit/atoms/link-button";
import { AccountHeading, AccountPanel } from "./account-content";
import type { CustomerAccount } from "@/ontos/account";
import { useDictionary } from "@/ontos/market-context";

export function AccountOverview({ account }: { account: CustomerAccount }) {
  const { overview, shell } = useDictionary().account;
  return (
    <>
      <AccountHeading title={overview.greeting(account.name)} description={overview.description} />
      <div className="grid gap-(--dimension-24) lg:grid-cols-2">
        <AccountPanel title={overview.accountTitle}>
          <p>{account.email}</p>
          <LinkButton
            as={StoreLink}
            href="/muj-ucet"
            className="mt-(--dimension-24)"
            size="sm"
            theme="outlined"
            variant="secondary"
          >
            {overview.contactDetails}
          </LinkButton>
        </AccountPanel>
        <AccountPanel title={shell.orders}>
          <p>{overview.ordersText}</p>
          <LinkButton
            as={StoreLink}
            href="/historie-objednavek"
            className="mt-(--dimension-24)"
            size="sm"
            variant="primary"
          >
            {overview.showOrders}
          </LinkButton>
        </AccountPanel>
      </div>
    </>
  );
}
