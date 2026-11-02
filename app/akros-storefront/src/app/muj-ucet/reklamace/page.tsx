import type { Metadata } from "next";
import { AccountLink } from "@/features/account/account-link";
import { AccountShell } from "@/components/account-shell";
import { AccountHeading, AccountPanel } from "@/features/account/account-content";
import { getDictionary } from "@/ontos/active-market";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getDictionary()).account.claims.pageTitle };
}
export default async function AccountClaimsPage() {
  const { claims, shell } = (await getDictionary()).account;
  return (
    <AccountShell active="claims">
      <AccountHeading title={shell.claims} description={claims.description} />
      <div className="grid gap-(--dimension-24) md:grid-cols-2">
        <AccountPanel title={claims.findOrder}>
          <p className="mb-(--dimension-24)">{claims.findOrderText}</p>
          <AccountLink
            href="/historie-objednavek"
            data-account-action
            size="sm"
            theme="outlined"
            variant="secondary"
          >
            {claims.openOrders}
          </AccountLink>
        </AccountPanel>
        <AccountPanel title={claims.contactSupport}>
          <p className="mb-(--dimension-24)">{claims.contactSupportText}</p>
          <AccountLink href="/kontakty" data-account-action size="sm" variant="primary">
            {claims.goToContacts}
          </AccountLink>
        </AccountPanel>
      </div>
    </AccountShell>
  );
}
