import StoreLink from "@/components/store-link";
import { LinkButton } from "@techsio/ui-kit/atoms/link-button";
import { AccountHeading, AccountPanel } from "./account-content";
import type { CustomerAccount } from "@/ontos/account";

export function AccountOverview({ account }: { account: CustomerAccount }) {
  return (
    <>
      <AccountHeading
        title={`Dobrý den, ${account.name}`}
        description="Váš zákaznický účet a historie nákupů na jednom místě."
      />
      <div className="grid gap-(--dimension-24) lg:grid-cols-2">
        <AccountPanel title="Váš účet">
          <p>{account.email}</p>
          <LinkButton
            as={StoreLink}
            href="/muj-ucet"
            className="mt-(--dimension-24)"
            size="sm"
            theme="outlined"
            variant="secondary"
          >
            Kontaktní údaje
          </LinkButton>
        </AccountPanel>
        <AccountPanel title="Objednávky">
          <p>Historie nákupů a podrobnosti vašich objednávek.</p>
          <LinkButton
            as={StoreLink}
            href="/historie-objednavek"
            className="mt-(--dimension-24)"
            size="sm"
            variant="primary"
          >
            Zobrazit objednávky
          </LinkButton>
        </AccountPanel>
      </div>
    </>
  );
}
